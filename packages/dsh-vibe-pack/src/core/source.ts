import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { unzipSync } from 'fflate'
import { assertSafeRelativePath, containedExistingPath, sha256, SecurityError } from './security.js'

const MAX_FILES = 10_000
const MAX_BYTES = 50 * 1024 * 1024
const MAX_FILE_BYTES = 2_000_000

export interface ResolvedSource {
  origin: string
  files: Map<string, Uint8Array>
  digest: string
}

export type SourceSpec = { kind: 'directory'; path: string } | { kind: 'archive'; path: string }

export async function resolveSource(spec: SourceSpec): Promise<ResolvedSource> {
  const files = spec.kind === 'directory' ? await readDirectory(spec.path) : await readArchive(spec.path)
  if (files.size === 0) throw new SecurityError('source contains no files')
  let bytes = 0
  for (const [path, value] of files) {
    assertSafeRelativePath(path)
    bytes += value.byteLength
  }
  if (files.size > MAX_FILES || bytes > MAX_BYTES) throw new SecurityError('source exceeds file or byte limit')
  const digest = sha256([...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, data]) => `${path}\0${sha256(data)}\n`).join(''))
  return { origin: `${spec.kind}:${spec.path}`, files, digest }
}

async function readDirectory(root: string): Promise<Map<string, Uint8Array>> {
  const output = new Map<string, Uint8Array>()
  let bytes = 0
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new SecurityError(`symlinks are not permitted: ${entry.name}`)
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) {
        const safe = relative(root, absolute).replace(/\\/g, '/')
        const existing = await containedExistingPath(root, safe)
        const info = await stat(existing)
        bytes += info.size
        if (output.size + 1 > MAX_FILES || bytes > MAX_BYTES || info.size > MAX_FILE_BYTES) throw new SecurityError('source exceeds file or byte limit')
        output.set(assertSafeRelativePath(safe), new Uint8Array(await readFile(existing)))
      }
    }
  }
  await walk(root)
  return output
}

async function readArchive(path: string): Promise<Map<string, Uint8Array>> {
  const extension = extname(path).toLowerCase()
  if (extension !== '.zip' && extension !== '.dshpack') throw new SecurityError('archives must use .dshpack or .zip')
  const content = new Uint8Array(await readFile(path))
  if (content.byteLength > MAX_BYTES) throw new SecurityError('compressed archive exceeds byte limit')
  let files = 0
  let bytes = 0
  const names = new Set<string>()
  const decoded = unzipSync(content, { filter: entry => {
    if (entry.name.endsWith('/')) return false
    const safe = assertSafeRelativePath(entry.name)
    const folded = safe.toLowerCase()
    if (names.has(folded)) throw new SecurityError(`duplicate archive path: ${safe}`)
    names.add(folded)
    files += 1
    bytes += entry.originalSize
    if (files > MAX_FILES || bytes > MAX_BYTES || entry.originalSize > MAX_FILE_BYTES) throw new SecurityError('archive exceeds file or byte limit')
    return true
  } })
  return new Map(Object.entries(decoded).map(([name, data]) => [assertSafeRelativePath(name), data]))
}
