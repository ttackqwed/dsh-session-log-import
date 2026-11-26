/**
 * Convert a DSH session-log export archive back into a stored Session.
 *
 * The importer never writes files itself: it validates the exported event log and
 * hands it to `ctx.sessionPersistence`, so the backend owns encoding, paths, and locks.
 * @module dsh-session-log-import/lib/importer
 */

import { openArchive, ZipError } from './zip.js'

/** Root entry of a v0 export. */
const V0_ENTRY = /^session\.jsonl$/u
/** Root entry of a versioned export, e.g. `session.v4.jsonl`. */
const VERSIONED_ENTRY = /^session\.v(\d+)\.jsonl$/u
/** A media attachment path inside the archive. */
const MEDIA_ENTRY = /^media\/([^/]+)$/u
/** A generic file attachment path inside the archive. */
const FILE_ENTRY = /^files\//u
/** A sub-session log, which this version reports but does not import. */
const SUB_SESSION_ENTRY = /^sub-?sessions?\//u

/** Failure that carries a machine-readable reason for the tool result. */
export class ImportError extends Error {
  /**
   * @param {string} reason - stable reason code.
   * @param {string} message - operator-facing explanation.
   */
  constructor(reason, message) {
    super(message)
    this.name = 'ImportError'
    this.reason = reason
  }
}

/**
 * Pick the session log entry of an export archive.
 * @param {{names: string[]}} archive - opened archive.
 * @returns {{entry: string, version: number}} the log entry and its format version.
 */
function findSessionEntry(archive) {
  const candidates = []
  for (const name of archive.names) {
    if (name.includes('/')) continue
    if (V0_ENTRY.test(name)) {
      candidates.push({ entry: name, version: 0 })
      continue
    }
    const match = VERSIONED_ENTRY.exec(name)
    if (match !== null) candidates.push({ entry: name, version: Number(match[1]) })
  }
  if (candidates.length === 0) {
    throw new ImportError('missing-session-log', 'the archive holds no session log (expected session.vN.jsonl at its root)')
  }
  if (candidates.length > 1) {
    throw new ImportError(
      'ambiguous-session-log',
      `the archive holds several session logs (${candidates.map(c => c.entry).join(', ')}); it must hold exactly one`,
    )
  }
  return candidates[0]
}

/**
 * Split an exported log into its header line and event records.
 * @param {Buffer} bytes - uncompressed log bytes.
 * @param {number} maxEvents - largest accepted event count.
 * @returns {{header: object, events: object[]}} parsed records.
 */
function parseLog(bytes, maxEvents) {
  const text = bytes.toString('utf8')
  const lines = text.split('\n')
  const records = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    let value
    try {
      value = JSON.parse(line)
    } catch {
      throw new ImportError('invalid-log', `line ${i + 1} of the session log is not valid JSON`)
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ImportError('invalid-log', `line ${i + 1} of the session log is not a JSON object`)
    }
    records.push(value)
  }
  if (records.length === 0) throw new ImportError('invalid-log', 'the session log is empty')
  const header = records[0]
  if (header.type !== 'session') {
    throw new ImportError('invalid-log', 'the first log line is not a session header')
  }
  const events = records.slice(1)
  if (events.length === 0) throw new ImportError('invalid-log', 'the session log holds no events')
  if (events.length > maxEvents) {
    throw new ImportError('too-many-events', `the session log holds ${events.length} events, over the ${maxEvents} limit`)
  }
  return { header, events }
}

/**
 * Verify the event log is a contiguous, append-only sequence starting at zero.
 * @param {object[]} events - parsed event records.
 * @returns {void}
 * @throws {ImportError} naming the first record whose `seq` breaks the sequence.
 */
function assertContiguousSeq(events) {
  for (let i = 0; i < events.length; i++) {
    const seq = events[i].seq
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
      throw new ImportError('invalid-seq', `event ${i} has no usable seq (${JSON.stringify(seq)})`)
    }
    if (seq !== i) {
      throw new ImportError(
        'non-contiguous-seq',
        `event ${i} has seq ${seq}, so the log is not a contiguous export (expected ${i}); it may have been edited or truncated`,
      )
    }
  }
}

/**
 * Learn the format version this Harness stores, from any already-stored session.
 * @param {{list(): Promise<object[]>}} persistence - session store.
 * @returns {Promise<number>} the stored format version, or 4 when nothing is stored yet.
 */
async function resolveCurrentFormatVersion(persistence) {
  let snapshots = []
  try {
    snapshots = await persistence.list()
  } catch {
    snapshots = []
  }
  for (const snapshot of snapshots) {
    const version = snapshot?.header?.version
    if (Number.isInteger(version)) return version
  }
  return 4
}

/**
 * List the archive contents worth reporting to the caller.
 * @param {{names: string[]}} archive - opened archive.
 * @returns {{media: number, files: number, subSessions: number}} counts by category.
 */
function summarizeExtras(archive) {
  let media = 0
  let files = 0
  let subSessions = 0
  for (const name of archive.names) {
    if (MEDIA_ENTRY.test(name)) media++
    else if (FILE_ENTRY.test(name)) files++
    else if (SUB_SESSION_ENTRY.test(name)) subSessions++
  }
  return { media, files, subSessions }
}

/**
 * Inspect an export archive without writing anything.
 * @param {Buffer} buf - archive bytes.
 * @param {{maxEntryBytes: number, maxTotalInflatedBytes: number, maxEvents: number}} limits - extraction bounds.
 * @returns {{sessionFile: string, formatVersion: number, sourceId: string, sourceCwd: string, createdAt: number|null, isSeeded: boolean, eventCount: number, media: number, files: number, subSessions: number}}
 */
export function inspectArchive(buf, limits) {
  const archive = openArchive(buf, limits)
  const { entry, version } = findSessionEntry(archive)
  const { header, events } = parseLog(archive.read(entry), limits.maxEvents)
  assertContiguousSeq(events)
  const extras = summarizeExtras(archive)
  return {
    sessionFile: entry,
    formatVersion: version,
    sourceId: typeof header.id === 'string' ? header.id : '',
    sourceCwd: typeof header.cwd === 'string' ? header.cwd : '',
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    isSeeded: header.isSeeded === true,
    eventCount: events.length,
    ...extras,
  }
}

/**
 * Import one export archive into the current Workspace as a new stored Session.
 *
 * @param {Buffer} buf - archive bytes.
 * @param {object} deps - services the write path needs.
 * @param {{create(header: object, options: {signal: AbortSignal}): Promise<object>, list(): Promise<object[]>, stat(id: string): Promise<object>}} deps.persistence - session store.
 * @param {{get(id: string): object|undefined}} deps.workspaceRegistry - workspace registry.
 * @param {{coldSnapshot(header: object, offset: unknown, events: object[]): unknown}|undefined} deps.projectionCache - list projection cache.
 * @param {string} deps.workspaceId - target Workspace id.
 * @param {boolean} deps.keepSourceId - reuse the exported Session id instead of minting one.
 * @param {() => string} deps.createId - mints a fresh Session id.
 * @param {{maxEntryBytes: number, maxTotalInflatedBytes: number, maxEvents: number}} limits - extraction bounds.
 * @param {AbortSignal} signal - caller cancellation.
 * @returns {Promise<{sessionId: string, workspaceId: string, eventCount: number, media: number, files: number, subSessions: number, skippedAttachments: string}>}
 */
export async function importArchive(buf, deps, limits, signal) {
  const archive = openArchive(buf, limits)
  const { entry, version } = findSessionEntry(archive)
  const { header: sourceHeader, events } = parseLog(archive.read(entry), limits.maxEvents)
  assertContiguousSeq(events)

  if (sourceHeader.version !== version) {
    throw new ImportError(
      'version-mismatch',
      `the session header declares version ${JSON.stringify(sourceHeader.version)} but the file is ${entry}`,
    )
  }

  // Learn the live format version from a stored session instead of hard-coding it,
  // so a Harness upgrade that changes the format refuses the export rather than misreading it.
  const currentVersion = await resolveCurrentFormatVersion(deps.persistence)
  if (sourceHeader.version !== currentVersion) {
    throw new ImportError(
      'unsupported-version',
      `the export is session format v${sourceHeader.version}; this Harness stores v${currentVersion}`,
    )
  }

  const workspace = deps.workspaceRegistry.get(deps.workspaceId)
  if (workspace === undefined) {
    throw new ImportError('workspace-not-found', `workspace ${deps.workspaceId} is not registered`)
  }

  const sourceId = typeof sourceHeader.id === 'string' ? sourceHeader.id : ''
  // Only accept an id that looks like a Session id, so an archive cannot name a
  // path-shaped or otherwise hostile id that the store would then have to escape.
  const usableSourceId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(sourceId) ? sourceId : ''
  const id = deps.keepSourceId && usableSourceId !== '' ? usableSourceId : deps.createId()
  const createdAt = typeof sourceHeader.createdAt === 'number' ? sourceHeader.createdAt : Date.now()
  const header = {
    version: currentVersion,
    id,
    createdAt,
    cwd: workspace.path,
    isSeeded: sourceHeader.isSeeded === true,
  }

  signal.throwIfAborted()

  const existing = await deps.persistence.stat(id).catch(() => undefined)
  if (existing !== undefined) {
    throw new ImportError(
      'session-exists',
      `a session with id ${id} already exists; import again without keepSourceId to write a new one`,
    )
  }

  const handle = await deps.persistence.create(header, { signal })
  try {
    await handle.append(events)
    await handle.flush()
  } finally {
    await handle.close()
  }

  try {
    await workspace.attachSession(id)
  } catch (error) {
    throw new ImportError(
      'attach-failed',
      `stored as session ${id} but not added to the workspace: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  deps.projectionCache?.coldSnapshot(header, 0, events)

  const extras = summarizeExtras(archive)
  const notes = []
  if (extras.media > 0) notes.push(`${extras.media} media attachment(s)`)
  if (extras.files > 0) notes.push(`${extras.files} file attachment(s)`)
  const skippedAttachments = notes.length === 0 ? 'none' : `${notes.join(' and ')} were not restored`

  return {
    sessionId: id,
    workspaceId: workspace.id,
    eventCount: events.length,
    media: extras.media,
    files: extras.files,
    subSessions: extras.subSessions,
    skippedAttachments,
  }
}

export { ZipError }
