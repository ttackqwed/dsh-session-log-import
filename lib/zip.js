/**
 * Minimal read-only ZIP reader: central-directory based, stored (0) and deflate (8) only.
 * Nothing is written to disk; every entry is bounded by the caller's limits.
 * @module dsh-session-log-import/lib/zip
 */

import { inflateRaw as inflateRawAsync } from 'node:zlib'
import { promisify } from 'node:util'

/** Asynchronous inflate, so a large entry never blocks the host's event loop. */
const inflateRaw = promisify(inflateRawAsync)

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

/** ZIP format violation or an entry outside the accepted limits. */
export class ZipError extends Error {
  /** @param {string} message - operator-facing reason. */
  constructor(message) {
    super(message)
    this.name = 'ZipError'
  }
}

/**
 * Locate the end-of-central-directory record by scanning backwards.
 * @param {Buffer} buf - complete archive bytes.
 * @returns {number} byte offset of the EOCD record.
 * @throws {ZipError} when no EOCD record is present.
 */
function findEocd(buf) {
  const stop = Math.max(0, buf.length - EOCD_MIN - MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= stop; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  throw new ZipError('not a readable ZIP archive: no end-of-central-directory record')
}

/**
 * Read every central-directory entry.
 * @param {Buffer} buf - complete archive bytes.
 * @returns {Array<{name: string, method: number, compSize: number, uncompSize: number, localOffset: number, flags: number}>}
 * @throws {ZipError} on a truncated or inconsistent directory.
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf)
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)

  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported by this importer')
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipError('not a readable ZIP archive: central directory exceeds the file')
  }

  const entries = []
  let p = cdOffset
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new ZipError(`not a readable ZIP archive: central directory entry ${n} is damaged`)
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const nameStart = p + 46
    const nameEnd = nameStart + nameLen
    if (nameEnd > buf.length) {
      throw new ZipError(`not a readable ZIP archive: entry ${n} name exceeds the file`)
    }
    // Bit 11 marks UTF-8 names; the export writer always uses UTF-8.
    const name = buf.toString('utf8', nameStart, nameEnd)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError(`ZIP64 entry "${name}" is not supported by this importer`)
    }
    entries.push({ name, method, compSize, uncompSize, localOffset, flags })
    p = nameEnd + extraLen + commentLen
  }
  return entries
}

/**
 * Extract one entry's uncompressed bytes.
 * @param {Buffer} buf - complete archive bytes.
 * @param {{name: string, method: number, compSize: number, uncompSize: number, localOffset: number}} entry - central-directory row.
 * @param {number} maxEntryBytes - largest accepted uncompressed size.
 * @returns {Promise<Buffer>} the entry payload.
 * @throws {ZipError} when the entry is oversized, unsupported, or truncated.
 */
async function readEntry(buf, entry, maxEntryBytes) {
  if (entry.uncompSize > maxEntryBytes) {
    throw new ZipError(`entry "${entry.name}" declares ${entry.uncompSize} bytes, over the ${maxEntryBytes} byte limit`)
  }
  if (entry.uncompSize > 0 && entry.compSize === 0) {
    throw new ZipError(`entry "${entry.name}" declares a size but carries no data`)
  }
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`entry "${entry.name}" uses unsupported compression method ${entry.method}`)
  }
  const p = entry.localOffset
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== SIG_LOCAL) {
    throw new ZipError(`entry "${entry.name}" has no readable local header`)
  }
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const dataStart = p + 30 + nameLen + extraLen
  const dataEnd = dataStart + entry.compSize
  if (dataEnd > buf.length) {
    throw new ZipError(`entry "${entry.name}" data exceeds the archive`)
  }
  const raw = buf.subarray(dataStart, dataEnd)
  if (entry.method === 0) {
    if (raw.length !== entry.uncompSize) {
      throw new ZipError(`stored entry "${entry.name}" size does not match its header`)
    }
    return Buffer.from(raw)
  }
  let out
  try {
    out = await inflateRaw(raw, { maxOutputLength: Math.max(entry.uncompSize, 1) })
  } catch (error) {
    throw new ZipError(`entry "${entry.name}" cannot be inflated: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (out.length !== entry.uncompSize) {
    throw new ZipError(`entry "${entry.name}" inflated to ${out.length} bytes, not the declared ${entry.uncompSize}`)
  }
  return out
}

/**
 * Open an archive and expose its entries plus bounded extraction.
 * @param {Buffer} buf - complete archive bytes.
 * @param {{maxEntryBytes: number, maxTotalInflatedBytes: number}} limits - extraction bounds.
 * @returns {{entries: Array<object>, read: (name: string) => Promise<Buffer>, has: (name: string) => boolean, names: string[]}}
 * @throws {ZipError} when the archive is unreadable or two entries share a name.
 */
export function openArchive(buf, limits) {
  const entries = readCentralDirectory(buf)
  const byName = new Map()
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      throw new ZipError(`not a readable ZIP archive: duplicate entry "${entry.name}"`)
    }
    byName.set(entry.name, entry)
  }
  let inflated = 0
  return {
    entries,
    names: [...byName.keys()],
    has: name => byName.has(name),
    async read(name) {
      const entry = byName.get(name)
      if (entry === undefined) throw new ZipError(`entry "${name}" is not in the archive`)
      if (inflated + entry.uncompSize > limits.maxTotalInflatedBytes) {
        throw new ZipError(`the archive expands past the ${limits.maxTotalInflatedBytes} byte import limit`)
      }
      const bytes = await readEntry(buf, entry, limits.maxEntryBytes)
      inflated += bytes.length
      return bytes
    },
  }
}
