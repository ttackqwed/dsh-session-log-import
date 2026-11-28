/**
 * Read an exported DSH session log: find the log entry inside an archive and parse it
 * into a header plus an ordered event list.
 *
 * Nothing here writes. The module validates what an export claims and hands the parsed
 * records to the caller, which decides what to do with them.
 * @module dsh-session-log-import/lib/importer
 */

import { ZipError } from './zip.js'

/** Root entry of a v0 export. */
const V0_ENTRY = /^session\.jsonl$/u
/** Root entry of a versioned export, e.g. `session.v4.jsonl`. */
const VERSIONED_ENTRY = /^session\.v(\d+)\.jsonl$/u

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
export { ZipError, findSessionEntry, parseLog, assertContiguousSeq }
