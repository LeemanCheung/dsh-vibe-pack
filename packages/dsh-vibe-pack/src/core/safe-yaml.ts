import { JSON_SCHEMA, load } from 'js-yaml'

export class SafeYamlError extends Error {}

/** Parse data-only YAML. Anchors, custom tags, functions, and aliases are rejected. */
export function parseSafeYaml(input: string): unknown {
  if (input.length > 1_000_000) throw new SafeYamlError('YAML exceeds 1 MiB limit')
  if (/(^|[\s:[{,])(?:!|&|\*)[^\s]*/m.test(input)) throw new SafeYamlError('YAML tags, anchors, and aliases are not allowed')
  let value: unknown
  try {
    value = load(input, { schema: JSON_SCHEMA, json: false })
  } catch (error) {
    throw new SafeYamlError(`invalid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  assertPlainData(value)
  return value
}

function assertPlainData(value: unknown, seen = new Set<object>()): void {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return
  if (Array.isArray(value)) { for (const item of value) assertPlainData(item, seen); return }
  if (typeof value !== 'object') throw new SafeYamlError(`unsupported YAML value: ${typeof value}`)
  if (seen.has(value as object)) throw new SafeYamlError('recursive YAML structures are not allowed')
  seen.add(value as object)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new SafeYamlError('YAML must contain plain objects only')
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new SafeYamlError(`unsafe key: ${key}`)
    assertPlainData(item, seen)
  }
  seen.delete(value as object)
}
