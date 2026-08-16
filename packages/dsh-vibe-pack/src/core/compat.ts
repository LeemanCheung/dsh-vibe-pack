import { satisfies, validRange } from 'semver'
import type { PackV1 } from './schema.js'

export interface RuntimeVersions { dsh?: string; node?: string }
export interface CompatibilityResult { compatible: boolean; reasons: string[] }
export function checkCompatibility(pack: Pick<PackV1, 'compatibility'> | { dsh?: string; node?: string }, runtime: RuntimeVersions): CompatibilityResult {
  const reasons: string[] = []
  for (const key of ['dsh', 'node'] as const) {
    const range = 'compatibility' in pack ? pack.compatibility[key] : pack[key]
    if (!range) continue
    const version = runtime[key]
    if (!version) reasons.push(`runtime does not report ${key} version required by ${range}`)
    else if (!validRange(range)) reasons.push(`invalid ${key} compatibility range: ${range}`)
    else if (!satisfies(version, range, { includePrerelease: true })) reasons.push(`${key} ${version} does not satisfy ${range}`)
  }
  return { compatible: reasons.length === 0, reasons }
}

export function assertCompatibility(requirements: { dsh?: string; node?: string }, runtime: RuntimeVersions): void {
  const result = checkCompatibility(requirements, runtime)
  if (!result.compatible) throw new Error(`incompatible pack: ${result.reasons.join('; ')}`)
}
