/**
 * dsh-session-log-import: make a DSH session-log export readable and portable.
 *
 * The plugin adds three model-facing tools over one archive: a handoff brief, a Markdown
 * transcript, and attachment extraction. It reads the export and never writes into the
 * Harness session store, so nothing it does can alter stored sessions.
 *
 * Deliberately dependency-free: no `@deepseek-ai/*` import, so the package resolves
 * from any install shape and survives Harness internals changing.
 * @module dsh-session-log-import
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, dirname, join, resolve } from 'node:path'
import { ImportError, ZipError, findSessionEntry, parseLog, assertContiguousSeq } from './lib/importer.js'
import { openArchive } from './lib/zip.js'
import { buildBrief, DEFAULT_MAX_CHARS, MAX_CHARS_CEILING } from './lib/digest.js'
import { buildTranscript, TRANSCRIPT_DEFAULT_MAX_CHARS, TRANSCRIPT_MAX_CHARS_CEILING } from './lib/transcript.js'
import { AttachmentError, extractAttachments, resolveOutputDir } from './lib/attachments.js'

export const name = 'dsh-session-log-import'
export const inject = ['tools']

/** Fixed deployment limits. Deliberately not configurable: one archive is one operation. */
const LIMITS = {
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalInflatedBytes: 512 * 1024 * 1024,
  maxEvents: 500000,
  maxAttachmentFiles: 500,
  maxAttachmentBytes: 512 * 1024 * 1024,
  maxTranscriptChars: TRANSCRIPT_DEFAULT_MAX_CHARS,
}

/** Extraction bounds handed to the ZIP reader and log parser. */
const EXTRACT_LIMITS = {
  maxEntryBytes: LIMITS.maxEntryBytes,
  maxTotalInflatedBytes: LIMITS.maxTotalInflatedBytes,
  maxEvents: LIMITS.maxEvents,
}

/**
 * Root directory, inside the workspace, that holds every file the plugin writes.
 * One subdirectory per tool, so three kinds of output never mix.
 */
const OUTPUT_ROOT = '_会话日志'

/** The subdirectory each tool writes into. */
const OUTPUT_KINDS = {
  briefs: '交接简报',
  transcripts: '转录稿',
  attachments: '附件',
}

/**
 * Build an absolute path under the plugin's output root.
 * @param {string} cwd - the workspace directory.
 * @param {'briefs'|'transcripts'|'attachments'} kind - whose folder.
 * @param {...string} parts - trailing segments.
 * @returns {string} the absolute path.
 */
function outputPath(cwd, kind, ...parts) {
  return join(cwd, OUTPUT_ROOT, OUTPUT_KINDS[kind], ...parts)
}

/**
 * Write a file, treating a failure as non-fatal: the main operation already succeeded.
 * @param {string} file - absolute destination.
 * @param {string} body - UTF-8 content.
 * @returns {Promise<boolean>} whether the write landed.
 */
async function tryWrite(file, body) {
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, body, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * The handoff tool description shown to the model.
 *
 * The point of the tool is that its result lands in *this* conversation, so the reader
 * can continue the other session's work without switching to it.
 */
const HANDOFF_DESCRIPTION = [
  'Summarize an exported session log (`dsh-session-<id>.zip`) into a handoff brief that arrives in THIS conversation, so work can continue here without opening the other session.',
  'The brief is assembled from the log itself: title, working directory, what the user asked for, which tools ran, which files were written, what failed or was interrupted, open todos, deliverables, compaction summaries, and the last progress.',
  'Credentials-looking strings are always masked; an operator can lift that with the row config `allowUnredacted: true`, never from the tool call. Attachments are never included — only text; call session_extract_attachments for the files themselves.',
].join(' ')

/** The attachment-extraction tool description shown to the model. */
const EXTRACT_DESCRIPTION = [
  'Copy the attachments of a session-log export (`dsh-session-<id>.zip`) into a directory as ordinary files.',
  'Neither a brief nor a transcript carries attachments; this tool is how the bytes are recovered.',
  'Names are reduced to their base name, unsafe characters are replaced, and nothing is written outside outputDir.',
  'outputDir defaults to `_会话日志/附件/<archive name>` inside the workspace, and must stay inside the workspace unless the row config sets allowAnyOutputDir.',
  'Existing files are skipped unless overwrite is set.',
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

/** The transcript tool description shown to the model. */
const VIEW_DESCRIPTION = [
  'Render a session-log export (`dsh-session-<id>.zip`) as a Markdown transcript file, so a human can read the whole conversation in the right sidebar.',
  'Unlike a brief it keeps every message and tool call instead of condensing them.',
  'The file is written to the workspace (default `_会话日志/转录稿`) and its path is returned; open it with the sidebar file browser or the slash command `/session-view`.',
].join(' ')

/**
 * Render an export to a Markdown transcript file.
 *
 * The caller resolves `outputDir`, because the tool path and the slash-command path
 * learn the workspace differently.
 *
 * @param {Buffer} buf - archive bytes.
 * @param {{outputDir: string, maxChars?: number, redact?: boolean}} options - destination and limits.
 * @returns {Promise<{path: string, bytes: number, stats: object, truncated: boolean}>} the written file.
 */
async function writeTranscript(buf, options) {
  const archive = openArchive(buf, EXTRACT_LIMITS)
  const { entry } = findSessionEntry(archive)
  const { header, events } = parseLog(await archive.read(entry), LIMITS.maxEvents)
  assertContiguousSeq(events)

  const rendered = buildTranscript(events, header, { maxChars: options.maxChars, redact: options.redact })
  const rawId = typeof header.id === 'string' && header.id !== '' ? header.id : 'session'
  const base = rawId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120)
  try {
    await mkdir(options.outputDir, { recursive: true })
  } catch (error) {
    throw new AttachmentError(
      'invalid-output',
      `cannot create ${options.outputDir}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const file = join(options.outputDir, `${base}.md`)
  await writeFile(file, rendered.text, 'utf8')
  return {
    path: file,
    bytes: Buffer.byteLength(rendered.text, 'utf8'),
    stats: rendered.stats,
    truncated: rendered.truncated,
  }
}

/**
 * Register the tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [config] - the row's config, read defensively because no schema is declared.
 * @returns {void}
 */
export function apply(ctx, config) {
  const allowedRoots = Array.isArray(config?.allowedRoots)
    ? config.allowedRoots.filter(root => typeof root === 'string' && isAbsolute(root))
    : []
  const allowAnyOutputDir = config?.allowAnyOutputDir === true
  // Unredacted output is an operator decision, not a model one: the switch lives in the
  // row config so a hostile export cannot talk a model into quoting credentials verbatim.
  const allowUnredacted = config?.allowUnredacted === true

  ctx.tools.register({
    name: 'session_handoff',
    description: HANDOFF_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        archivePath: {
          type: 'string',
          description: 'Absolute path to a dsh-session-<id>.zip export archive.',
        },
        focus: {
          type: 'string',
          description: 'What this session should pay attention to when resuming. Shown at the top of the brief.',
        },
        maxChars: {
          type: 'integer',
          description: `Brief size budget in characters. Defaults to ${DEFAULT_MAX_CHARS}, capped at ${MAX_CHARS_CEILING}.`,
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
          sessionId: { type: 'string' },
          title: { type: 'string' },
          eventCount: { type: 'integer' },
          turns: { type: 'integer' },
          chars: { type: 'integer' },
          truncated: { type: 'boolean' },
          brief: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.chars > 1800
          ? `${value.brief.slice(0, 1800)}\n…（共 ${value.chars} 字符，完整简报已在工具结果中）`
          : value.brief,
      }],
    },
    async execute(args, exec) {
      const archivePath = resolveArchivePath(args.archivePath, allowedRoots)
      const buf = await readArchive(archivePath)
      exec.signal?.throwIfAborted()

      const archive = openArchive(buf, EXTRACT_LIMITS)
      const { entry } = findSessionEntry(archive)
      const { header, events } = parseLog(await archive.read(entry), LIMITS.maxEvents)
      assertContiguousSeq(events)

      const brief = buildBrief(events, header, {
        maxChars: args.maxChars,
        focus: args.focus,
        redact: !allowUnredacted,
      })

      ctx.logger.info(`session-import: briefed ${header.id ?? '(unknown)'} (${brief.text.length} chars)`)
      const sessionCwd = typeof exec.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : ''
      let briefPath = ''
      if (sessionCwd !== '') {
        const rawId = typeof header.id === 'string' && header.id !== '' ? header.id : 'brief'
        const base = rawId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120)
        const target = outputPath(sessionCwd, 'briefs', `${base}.md`)
        if (await tryWrite(target, brief.text)) briefPath = target
      }
      return {
        archivePath,
        sessionId: typeof header.id === 'string' ? header.id : '',
        title: brief.stats.title,
        eventCount: events.length,
        turns: brief.stats.turns,
        chars: brief.text.length,
        truncated: brief.truncated,
        briefPath,
        brief: brief.text,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Summarize session export',
      kind: 'other',
      rawInput: args.archivePath,
    }),
  })

  ctx.tools.register({
    name: 'session_extract_attachments',
    description: EXTRACT_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        archivePath: {
          type: 'string',
          description: 'Absolute path to a dsh-session-<id>.zip export archive.',
        },
        outputDir: {
          type: 'string',
          description: 'Absolute directory to write the attachments into. Defaults to `_会话日志/附件/<archive name>` inside the workspace. Must stay inside the workspace unless allowAnyOutputDir is configured.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace files that already exist. Defaults to false, which skips them.',
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
          outputDir: { type: 'string' },
          total: { type: 'integer' },
          written: { type: 'integer' },
          bytes: { type: 'integer' },
          skipped: { type: 'integer' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                bytes: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.total === 0) {
          return [{ type: 'text', text: `Archive ${value.archivePath} holds no attachments.` }]
        }
        const notes = value.skipped > 0 ? ` ${value.skipped} skipped (exists, unsafe name, or over a limit).` : ''
        return [{
          type: 'text',
          text: `Wrote ${value.written} of ${value.total} attachment(s) (${value.bytes} bytes) into ${value.outputDir}.${notes}`,
        }]
      },
    },
    async execute(args, exec) {
      const archivePath = resolveArchivePath(args.archivePath, allowedRoots)
      const buf = await readArchive(archivePath)
      exec.signal?.throwIfAborted()

      const archive = openArchive(buf, EXTRACT_LIMITS)
      const sessionCwd = typeof exec.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : undefined

      let outputDir
      if (typeof args.outputDir === 'string' && args.outputDir.trim() !== '') {
        outputDir = resolveOutputDir(args.outputDir, sessionCwd, allowAnyOutputDir)
      } else if (typeof sessionCwd === 'string' && sessionCwd !== '') {
        // Name the folder after the archive, not the session id: reading the log just to
        // learn the id would inflate the whole entry again.
        const folder = basename(archivePath).replace(/\.zip$/iu, '').replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 120)
        outputDir = outputPath(sessionCwd, 'attachments', folder === '' ? 'attachments' : folder)
      } else {
        throw new AttachmentError('invalid-output', 'set outputDir explicitly: this session has no working directory')
      }

      const result = await extractAttachments(archive, {
        outputDir,
        overwrite: args.overwrite === true,
        maxFiles: LIMITS.maxAttachmentFiles,
        maxBytes: LIMITS.maxAttachmentBytes,
        signal: exec.signal,
      })

      ctx.logger.info(`session-import: wrote ${result.written.length}/${result.total} attachment(s) into ${result.outputDir}`)
      return {
        archivePath,
        outputDir: result.outputDir,
        total: result.total,
        written: result.written.length,
        bytes: result.bytes,
        skipped: result.skipped.length,
        files: result.written.map(item => ({ name: item.name, bytes: item.bytes })),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Extract session attachments',
      kind: 'other',
      rawInput: args.archivePath,
    }),
  })

  ctx.tools.register({
    name: 'session_view',
    description: VIEW_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        archivePath: {
          type: 'string',
          description: 'Absolute path to a dsh-session-<id>.zip export archive.',
        },
        outputDir: {
          type: 'string',
          description: 'Absolute directory for the transcript. Defaults to `_会话日志/转录稿` inside the workspace.',
        },
        maxChars: {
          type: 'integer',
          description: `Transcript budget in characters. Defaults to ${TRANSCRIPT_DEFAULT_MAX_CHARS}, capped at ${TRANSCRIPT_MAX_CHARS_CEILING}.`,
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
          transcriptPath: { type: 'string' },
          bytes: { type: 'integer' },
          turns: { type: 'integer' },
          userMessages: { type: 'integer' },
          toolCalls: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Transcript written: ${value.transcriptPath} (${value.turns} turns, ${value.toolCalls} tool calls, ${value.bytes} bytes)`,
      }],
    },
    async execute(args, exec) {
      const archivePath = resolveArchivePath(args.archivePath, allowedRoots)
      const buf = await readArchive(archivePath)
      exec.signal?.throwIfAborted()

      const sessionCwd = typeof exec.agent?.session?.header?.cwd === 'string' ? exec.agent.session.header.cwd : undefined
      let outputDir
      if (typeof args.outputDir === 'string' && args.outputDir.trim() !== '') {
        outputDir = resolveOutputDir(args.outputDir, sessionCwd, allowAnyOutputDir)
      } else if (typeof sessionCwd === 'string' && sessionCwd !== '') {
        outputDir = outputPath(sessionCwd, 'transcripts')
      } else {
        throw new AttachmentError('invalid-output', 'set outputDir explicitly: this session has no working directory')
      }

      const result = await writeTranscript(buf, {
        outputDir,
        maxChars: args.maxChars,
        redact: !allowUnredacted,
      })
      ctx.logger.info(`session-import: transcript ${result.path} (${result.bytes} bytes)`)
      return {
        archivePath,
        transcriptPath: result.path,
        bytes: result.bytes,
        turns: result.stats.turns,
        userMessages: result.stats.userMessages,
        toolCalls: result.stats.toolCalls,
        truncated: result.truncated,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Render session transcript',
      kind: 'other',
      rawInput: args.archivePath,
    }),
  })

  // The slash command is the human-facing door to the same rendering. Injected
  // optionally: a composition without the commands service still gets the tools.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], scope => {
      scope.commands.register({
        name: 'session-view',
        description: '把会话导出包渲染成 Markdown 转录稿，供右栏查看',
        input: { hint: '<导出包的绝对路径>' },
        handler: async ({ agent, rawInput }) => {
          const raw = String(rawInput ?? '').trim().replace(/^"(.*)"$/u, '$1')
          if (raw === '') return { kind: 'error', text: '用法：/session-view <导出包的绝对路径>' }
          try {
            const archivePath = resolveArchivePath(raw, allowedRoots)
            const buf = await readArchive(archivePath)
            const cwd = typeof agent?.session?.header?.cwd === 'string' ? agent.session.header.cwd : ''
            if (cwd === '') return { kind: 'error', text: '当前会话没有工作目录，无法决定输出位置' }
            const result = await writeTranscript(buf, { outputDir: outputPath(cwd, 'transcripts') })
            return { kind: 'success', text: `转录稿已生成：${result.path}（${result.stats.turns} 轮）` }
          } catch (error) {
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          }
        },
      })
    })
  }
}

export { ImportError, ZipError, AttachmentError, resolveArchivePath }
