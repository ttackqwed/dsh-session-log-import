/**
 * Copy the attachment entries of a session-log export into an ordinary directory.
 *
 * The importer deliberately never writes into the session store: its layout is private
 * and may change. Attachments are the one part of an export that has real bytes, so the
 * plugin offers them as plain files in a directory the caller names — the store's
 * private content-addressed tree stays out of the picture.
 *
 * @module dsh-session-log-import/lib/attachments
 */

import { realpathSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** A refusal that carries a machine-readable reason for the tool result. */
export class AttachmentError extends Error {
  /**
   * @param {string} reason - stable reason code.
   * @param {string} message - operator-facing explanation.
   */
  constructor(reason, message) {
    super(message)
    this.name = 'AttachmentError'
    this.reason = reason
  }
}

/** A media attachment entry inside an export. */
const MEDIA_ENTRY = /^media\/(.+)$/u
/** A generic file attachment entry inside an export. */
const FILE_ENTRY = /^files\/(.+)$/u
/** Names Windows refuses regardless of extension. */
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu
/** Characters that are illegal or confusing in a file name on either platform. */
const UNSAFE_CHARS = /[\u0000-\u001f<>:"|?*\u007f]/gu

/**
 * List the archive entries that are attachments.
 * @param {{names: string[]}} archive - opened archive.
 * @returns {{entry: string, kind: 'media'|'file', raw: string}[]} attachment entries.
 */
export function listAttachments(archive) {
  const items = []
  for (const name of archive.names) {
    const media = MEDIA_ENTRY.exec(name)
    if (media !== null) {
      items.push({ entry: name, kind: 'media', raw: media[1] })
      continue
    }
    const file = FILE_ENTRY.exec(name)
    if (file !== null) items.push({ entry: name, kind: 'file', raw: file[1] })
  }
  return items
}

/**
 * Turn an entry path into a safe file name.
 *
 * Directory components are dropped: an export cannot steer a write out of the target
 * directory, and two attachments that differ only by folder simply land side by side.
 *
 * @param {string} raw - the path part of the entry name.
 * @returns {string|null} a safe file name, or null when nothing usable survives.
 */
export function safeAttachmentName(raw) {
  const base = String(raw).split(/[\\/]/u).pop() ?? ''
  // Content-addressed media names arrive as `sha256:<hex>.<ext>`; strip the prefix
  // before sanitising, otherwise the colon would be replaced and the name becomes noise.
  let name = base.normalize('NFC').replace(/^sha256[:：]/iu, '')
  name = name.replace(UNSAFE_CHARS, '_').replace(/[\s.]+$/u, '').trim()
  if (name === '' || name === '.' || name === '..') return null
  if (RESERVED_NAME.test(name)) name = `_${name}`
  if (name.length > 180) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : ''
    name = name.slice(0, 180 - ext.length) + ext
  }
  return name === '' ? null : name
}

/**
 * Resolve a path to its real location, tolerating segments that do not exist yet.
 *
 * `realpath` alone throws on a missing directory, and a plain string comparison is
 * blind to junctions and symlinks: a link inside the workspace that points outside it
 * would pass a `relative()` check and still write outside. Walking up to the nearest
 * existing ancestor and resolving that closes the gap without requiring the caller to
 * pre-create the directory.
 *
 * @param {string} target - absolute path, possibly not yet created.
 * @returns {string} the real path, with any missing tail re-appended.
 */
function realpathAllowMissing(target) {
  const missing = []
  let current = target
  for (let depth = 0; depth < 64; depth++) {
    try {
      return join(realpathSync(current), ...missing.slice().reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return target
      missing.push(basename(current))
      current = parent
    }
  }
  return target
}

/**
 * Resolve and police the output directory.
 *
 * Writing files is a broader capability than reading them, so by default the target
 * must sit inside the calling session's working directory. The comparison runs on
 * real paths, so a junction or symlink that points out of the workspace is refused
 * even though its literal path looks internal.
 *
 * @param {string} raw - caller-supplied directory.
 * @param {string|undefined} cwd - the calling session's working directory.
 * @param {boolean} allowAny - whether the row config lifted the workspace restriction.
 * @returns {string} the absolute directory.
 * @throws {AttachmentError} when the path is relative or outside the workspace.
 */
export function resolveOutputDir(raw, cwd, allowAny) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AttachmentError('invalid-output', 'outputDir must be a non-empty string')
  }
  const trimmed = raw.trim().replace(/^"(.*)"$/u, '$1')
  if (!isAbsolute(trimmed)) {
    throw new AttachmentError('invalid-output', `outputDir must be absolute, got ${JSON.stringify(raw)}`)
  }
  const absolute = resolve(trimmed)
  if (allowAny) return absolute
  if (typeof cwd !== 'string' || cwd === '') {
    throw new AttachmentError('output-not-allowed', 'cannot tell the workspace directory; set allowAnyOutputDir to write outside it')
  }
  const base = realpathAllowMissing(resolve(cwd))
  const real = realpathAllowMissing(absolute)
  const rel = relative(base, real)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new AttachmentError('output-not-allowed', `outputDir must stay inside the workspace ${base}`)
  }
  return absolute
}

/**
 * Write one attachment's bytes, refusing to leave the target directory.
 * @param {string} dir - resolved output directory.
 * @param {string} name - safe file name.
 * @param {Buffer} bytes - payload.
 * @returns {Promise<void>}
 * @throws {AttachmentError} when the joined path would escape the directory.
 */
async function writeInside(dir, name, bytes) {
  // Join on the real directory, so a link swapped in after the policy check cannot
  // redirect the write; `name` has no separators left after safeAttachmentName.
  const realDir = realpathAllowMissing(dir)
  const dest = join(realDir, name)
  const rel = relative(realDir, dest)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new AttachmentError('unsafe-name', `${name} resolves outside ${dir}`)
  }
  await writeFile(dest, bytes)
}

/**
 * Extract every attachment of an archive into a directory.
 *
 * Existing files are skipped unless `overwrite` is set, so a second run never clobbers
 * something the user edited.
 *
 * @param {{names: string[], entries: object[], read(name: string): Promise<Buffer>}} archive - opened archive.
 * @param {object} options - `{outputDir, overwrite, maxFiles, maxBytes, signal}`.
 * @returns {Promise<{outputDir: string, total: number, written: object[], skipped: object[], bytes: number}>} the outcome.
 * @throws {AttachmentError} when the directory cannot be created.
 */
export async function extractAttachments(archive, options) {
  const {
    outputDir,
    overwrite = false,
    maxFiles = 500,
    maxBytes = 512 * 1024 * 1024,
    signal,
  } = options

  const target = resolve(outputDir)
  const items = listAttachments(archive)
  if (items.length === 0) return { outputDir: target, total: 0, written: [], skipped: [], bytes: 0 }

  const sizes = new Map(archive.entries.map(entry => [entry.name, entry.uncompSize]))
  try {
    await mkdir(target, { recursive: true })
  } catch (error) {
    throw new AttachmentError('invalid-output', `cannot create ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const used = new Set()
  const written = []
  const skipped = []
  let bytes = 0

  for (const item of items) {
    signal?.throwIfAborted()
    if (written.length >= maxFiles) {
      skipped.push({ entry: item.entry, reason: 'file-limit' })
      continue
    }
    const baseName = safeAttachmentName(item.raw)
    if (baseName === null) {
      skipped.push({ entry: item.entry, reason: 'unsafe-name' })
      continue
    }
    const declared = sizes.get(item.entry) ?? 0
    if (bytes + declared > maxBytes) {
      skipped.push({ entry: item.entry, reason: 'byte-limit' })
      continue
    }

    let name = baseName
    for (let n = 2; used.has(name.toLowerCase()); n++) {
      const dot = baseName.lastIndexOf('.')
      name = dot > 0 ? `${baseName.slice(0, dot)}-${n}${baseName.slice(dot)}` : `${baseName}-${n}`
    }
    used.add(name.toLowerCase())

    if (!overwrite) {
      let exists = false
      try {
        exists = (await stat(join(target, name))).isFile()
      } catch {
        exists = false
      }
      if (exists) {
        skipped.push({ entry: item.entry, reason: 'exists' })
        continue
      }
    }

    const payload = await archive.read(item.entry)
    await writeInside(target, name, payload)
    bytes += payload.length
    written.push({ entry: item.entry, name, kind: item.kind, bytes: payload.length })
  }

  return { outputDir: target, total: items.length, written, skipped, bytes }
}
