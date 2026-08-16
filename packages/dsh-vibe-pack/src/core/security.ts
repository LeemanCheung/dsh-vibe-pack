import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export class SecurityError extends Error {}

export function sha256(data: string | Uint8Array): string { return createHash('sha256').update(data).digest('hex') }
export function hashesEqual(actual: string, expected: string): boolean {
  if (!/^[a-f\d]{64}$/i.test(actual) || !/^[a-f\d]{64}$/i.test(expected)) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}
export function assertSafeRelativePath(path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new SecurityError(`unsafe path: ${path}`)
  const normalized = path.replace(/\\/g, '/')
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) throw new SecurityError(`unsafe path: ${path}`)
  return normalized
}
export function containedPath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root), resolvedCandidate = resolve(root, candidate)
  const rel = relative(resolvedRoot, resolvedCandidate)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SecurityError(`path escapes root: ${candidate}`)
  return resolvedCandidate
}
/** Creates and resolves a destination parent, rejecting symlink escapes before writes. */
export async function containedWritablePath(root: string, candidate: string): Promise<string> {
  const resolvedRoot = resolve(root)
  await mkdir(resolvedRoot, { recursive: true })
  const lexical = containedPath(resolvedRoot, candidate)
  await mkdir(dirname(lexical), { recursive: true })
  const realRoot = await realpath(resolvedRoot)
  const realParent = await realpath(dirname(lexical))
  const rel = relative(realRoot, realParent)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SecurityError(`destination parent escapes root: ${candidate}`)
  return join(realParent, basename(lexical))
}

/** Resolves symlinks and verifies the resulting existing file is still inside root. */
export async function containedExistingPath(root: string, candidate: string): Promise<string> {
  const realRoot = await realpath(root)
  const realCandidate = await realpath(containedPath(realRoot, candidate))
  const rel = relative(realRoot, realCandidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new SecurityError(`symlink escapes root: ${candidate}`)
  return realCandidate
}

const SECRET_KEY = /(?:^|[_-])(token|secret|password|passwd|api[_-]?key|private[_-]?key)(?:$|[_-])/i
const SECRET_VALUE = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----)/
const SECRET_ASSIGNMENT = /(?:^|[\s{,[;])(?:token|secret|password|passwd|api[_-]?key|private[_-]?key)\s*[:=]\s*["']?[^\s,"'};]{4,}/im
export interface SecretFinding { path: string; reason: string }
export function findSecrets(value: unknown, path = '$'): SecretFinding[] {
  if (typeof value === 'string') return SECRET_VALUE.test(value) || SECRET_ASSIGNMENT.test(value) ? [{ path, reason: 'credential-like value' }] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => findSecrets(v, `${path}[${i}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`
    return SECRET_KEY.test(key) && typeof child === 'string' && child.length > 0
      ? [{ path: childPath, reason: 'secret-like key' }]
      : findSecrets(child, childPath)
  })
}
export function assertNoSecrets(value: unknown): void {
  const findings = findSecrets(value)
  if (findings.length) throw new SecurityError(`embedded secrets are forbidden: ${findings.map((x) => x.path).join(', ')}`)
}
export function assertDataOnlySource(text: string, filename = 'source'): void {
  if (text.length > 2_000_000) throw new SecurityError(`${filename} exceeds 2 MiB limit`)
  if (/(?:^#!|<script\b|\b(?:child_process|subprocess|eval|Function|require\s*\(|import\s*\(|process\.env|console\.|os\.system|Invoke-Expression|Start-Process|curl\b|wget\b|rm\s+-rf))/im.test(text)) throw new SecurityError(`${filename} appears to contain executable source`)
}
