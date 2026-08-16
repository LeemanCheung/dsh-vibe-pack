import { describe, expect, it } from 'vitest'
import { OwnershipGraph } from '../src/core/ownership.js'
import { parseSafeYaml } from '../src/core/safe-yaml.js'
import { assertSafeRelativePath, SecurityError } from '../src/core/security.js'
import { Transaction } from '../src/core/transaction.js'

describe('Vibe Pack security primitives', () => {
  it('rejects YAML aliases and prototype pollution', () => {
    expect(() => parseSafeYaml('x: &anchor value')).toThrow()
    expect(() => parseSafeYaml('__proto__: bad')).toThrow()
  })

  it('rejects traversal paths', () => {
    expect(() => assertSafeRelativePath('../outside')).toThrow(SecurityError)
    expect(() => assertSafeRelativePath('a/../b')).toThrow(SecurityError)
  })

  it('rolls back the currently failing transaction step', async () => {
    let value = 0
    const transaction = new Transaction<number>().add('mutate then fail', {
      snapshot: async () => value,
      apply: async () => { value = 1; throw new Error('boom') },
      restore: async snapshot => { value = snapshot },
    })
    await expect(transaction.commit()).rejects.toThrow()
    expect(value).toBe(0)
  })

  it('reports foreign ownership', () => {
    const graph = new OwnershipGraph({ first: ['settings.yaml'] })
    expect(graph.ownerOf('settings.yaml')).toBe('first')
    expect(graph.conflicts('second', ['settings.yaml'])).toEqual([{ owner: 'first', path: 'settings.yaml' }])
  })
})
