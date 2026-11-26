/**
 * dsh-session-log-import: restore a DSH session-log export ZIP as a stored Session.
 *
 * The plugin adds one model-facing tool. It validates the archive and the exported
 * event log, then writes through `ctx.sessionPersistence` so the storage backend owns
 * encoding, paths, and single-writer locking.
 *
 * Deliberately dependency-free: no `@deepseek-ai/*` import, so the package resolves
 * from any install shape and survives Harness internals changing.
 * @module dsh-session-log-import
 */

import { stat, readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { ImportError, ZipError, importArchive, inspectArchive } from './lib/importer.js'

export const name = 'dsh-session-log-import'
export const inject = ['tools', 'sessionPersistence', 'workspaceRegistry']

/** Fixed deployment limits. Deliberately not configurable: an import is a one-shot restore. */
const LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalInflatedBytes: 512 * 1024 * 1024,
  maxEvents: 500000,
}

/** Extraction bounds handed to the ZIP reader and log parser. */
const EXTRACT_LIMITS = {
  maxEntryBytes: LIMITS.maxEntryBytes,
  maxTotalInflatedBytes: LIMITS.maxTotalInflatedBytes,
  maxEvents: LIMITS.maxEvents,
}

/** The tool description shown to the model. */
const DESCRIPTION = [
  'Restore a DeepSeek Harness session-log export (`dsh-session-<id>.zip`) as a stored session, so the conversation appears in the sidebar and can be continued.',
  'The archive must come from "Download session log" or the `/export` command.',
  'The session keeps the exported history and title, gets a new session id unless keepSourceId is set, and is written with the target workspace directory.',
  'Media and generic file attachments are counted but not restored.',
  'Use dryRun first to inspect an archive without writing anything.',
].join(' ')

/**
 * Resolve the archive path and enforce the path policy.
 * @param {string} raw - caller-supplied path.
 * @param {string[]} allowedRoots - absolute directories the path must stay inside; empty accepts any.
 * @returns {string} the absolute path.
 * @throws {ImportError} when the path is relative or outside the allowed roots.
 */
function resolveArchivePath(raw, allowedRoots) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ImportError('invalid-path', 'archivePath must be a non-empty string')
  }
  const trimmed = raw.trim().replace(/^"(.*)"$/u, '$1')
  if (!isAbsolute(trimmed)) {
    throw new ImportError('invalid-path', `archivePath must be absolute, got ${JSON.stringify(raw)}`)
  }
  const absolute = resolve(trimmed)
  if (allowedRoots.length > 0) {
    const inside = allowedRoots.some((root) => {
      const resolvedRoot = resolve(root).replace(/[\\/]+$/u, '')
      return absolute === resolvedRoot || absolute.startsWith(resolvedRoot + '\\') || absolute.startsWith(resolvedRoot + '/')
    })
    if (!inside) {
      throw new ImportError('path-not-allowed', `archivePath must stay inside ${allowedRoots.join(', ')}`)
    }
  }
  return absolute
}

/**
 * Read the archive after checking that it is a regular file within the size limit.
 * @param {string} path - absolute archive path.
 * @returns {Promise<Buffer>} the archive bytes.
 */
async function readArchive(path) {
  let info
  try {
    info = await stat(path)
  } catch {
    throw new ImportError('archive-not-found', `no file at ${path}`)
  }
  if (!info.isFile()) {
    throw new ImportError('archive-not-found', `${path} is not a regular file`)
  }
  if (info.size === 0) {
    throw new ImportError('unreadable-archive', `${path} is empty`)
  }
  if (info.size > LIMITS.maxArchiveBytes) {
    throw new ImportError('too-large', `${path} is ${info.size} bytes, over the ${LIMITS.maxArchiveBytes} byte limit`)
  }
  try {
    return await readFile(path)
  } catch (error) {
    throw new ImportError('unreadable-archive', `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Choose the target workspace: an explicit id, else this agent session's workspace, else the only one.
 * @param {{get(id: string): object|undefined, list(): object[]}} registry - workspace registry.
 * @param {string|undefined} requestedId - caller-supplied workspace id.
 * @param {string|undefined} sessionCwd - working directory of the calling session.
 * @returns {{id: string, path: string}} the chosen workspace identity.
 */
function pickWorkspace(registry, requestedId, sessionCwd) {
  if (typeof requestedId === 'string' && requestedId !== '') {
    const found = registry.get(requestedId)
    if (found === undefined) throw new ImportError('workspace-not-found', `workspace ${requestedId} is not registered`)
    return { id: found.id, path: found.path }
  }
  const all = registry.list()
  if (all.length === 0) throw new ImportError('workspace-not-found', 'no workspace is registered')
  if (typeof sessionCwd === 'string' && sessionCwd !== '') {
    const normalized = resolve(sessionCwd)
    const match = all.find(workspace => resolve(workspace.path) === normalized)
    if (match !== undefined) return { id: match.id, path: match.path }
  }
  if (all.length === 1) return { id: all[0].id, path: all[0].path }
  throw new ImportError(
    'workspace-ambiguous',
    `several workspaces are registered (${all.map(w => w.id).join(', ')}); pass workspaceId explicitly`,
  )
}

/** Render one tool result as a short text card. */
function renderResult(_args, value) {
  if (value.dryRun === true) {
    return [{
      type: 'text',
      text: `Archive ${value.archivePath} is importable: ${value.sessionFile}, ${value.eventCount} events, source session ${value.sourceId || '(none)'}. Media ${value.media}, files ${value.files}, sub-sessions ${value.subSessions}. Nothing was written.`,
    }]
  }
  const body = `Imported session ${value.sessionId} into workspace ${value.workspaceId} with ${value.eventCount} events.`
  const notes = value.skippedAttachments === 'none' ? '' : ` Not restored: ${value.skippedAttachments}.`
  const subs = value.subSessions > 0 ? ` ${value.subSessions} sub-session log(s) stayed out of this import.` : ''
  return [{ type: 'text', text: body + notes + subs }]
}

/**
 * Register the import tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - the row's config, read defensively because no schema is declared.
 * @returns {void}
 */
export function apply(ctx, config) {
  const allowedRoots = Array.isArray(config?.allowedRoots)
    ? config.allowedRoots.filter(root => typeof root === 'string' && isAbsolute(root))
    : []

  ctx.tools.register({
    name: 'session_import',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        archivePath: {
          type: 'string',
          description: 'Absolute path to a dsh-session-<id>.zip export archive.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what the archive holds without writing a session. Defaults to false.',
        },
        keepSourceId: {
          type: 'boolean',
          description: 'Reuse the exported session id. It fails when that id already exists; the default mints a new id.',
        },
        workspaceId: {
          type: 'string',
          description: 'Workspace to import into. Defaults to the workspace of this session.',
        },
      },
      required: ['archivePath'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          archivePath: { type: 'string' },
          dryRun: { type: 'boolean' },
          sessionId: { type: 'string' },
          workspaceId: { type: 'string' },
          sessionFile: { type: 'string' },
          sourceId: { type: 'string' },
          eventCount: { type: 'integer' },
          media: { type: 'integer' },
          files: { type: 'integer' },
          subSessions: { type: 'integer' },
          skippedAttachments: { type: 'string' },
        },
      },
      render: renderResult,
    },
    async execute(args, exec) {
      const archivePath = resolveArchivePath(args.archivePath, allowedRoots)
      const buf = await readArchive(archivePath)
      const dryRun = args.dryRun === true

      if (dryRun) {
        const info = inspectArchive(buf, EXTRACT_LIMITS)
        return { archivePath, dryRun: true, eventCount: info.eventCount, ...info }
      }

      const sessionCwd = typeof exec.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : undefined
      const workspace = pickWorkspace(ctx.workspaceRegistry, args.workspaceId, sessionCwd)

      const result = await importArchive(
        buf,
        {
          persistence: ctx.sessionPersistence,
          workspaceRegistry: ctx.workspaceRegistry,
          projectionCache: ctx.get('sessionProjectionCache'),
          workspaceId: workspace.id,
          keepSourceId: args.keepSourceId === true,
          createId: () => `session-${globalThis.crypto.randomUUID()}`,
        },
        EXTRACT_LIMITS,
        exec.signal ?? new AbortController().signal,
      )
      ctx.logger.info(`session-import: imported ${result.sessionId} (${result.eventCount} events) into ${result.workspaceId}`)
      return { archivePath, dryRun: false, ...result }
    },
    presentCall: args => ({
      card: 'generic',
      title: args.dryRun === true ? 'Inspect session export' : 'Import session export',
      kind: 'other',
      rawInput: args.archivePath,
    }),
  })
}

export { ImportError, ZipError, resolveArchivePath }
