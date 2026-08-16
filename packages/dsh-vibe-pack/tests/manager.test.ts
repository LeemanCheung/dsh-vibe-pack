import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PackManager } from '../src/core/manager.js'
import { sha256 } from '../src/core/security.js'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture(content = '{"enabled":true}\n'): Promise<{ root: string; source: string; manager: PackManager }> {
  const root = await mkdtemp(join(tmpdir(), 'vibe-target-'))
  const source = await mkdtemp(join(tmpdir(), 'vibe-source-'))
  temporary.push(root, source)
  await mkdir(join(source, 'config'))
  await writeFile(join(source, 'config', 'demo.json'), content)
  await writeFile(join(source, 'dshpack.yaml'), [
    'schemaVersion: 1',
    'id: demo-pack',
    'version: 1.0.0',
    'files:',
    '  - path: config/demo.json',
    `    sha256: ${sha256(content)}`,
    '    mode: replace',
    'ownership: {}',
    'metadata:',
    '  name: Demo',
    '',
  ].join('\n'))
  return { root, source, manager: new PackManager(root) }
}

describe('PackManager lifecycle', () => {
  it('installs a verified pack and records ownership history', async () => {
    const { root, source, manager } = await fixture()
    const plan = await manager.install({ kind: 'directory', path: source })
    expect(plan.warnings).toEqual([])
    expect(await readFile(join(root, 'config', 'demo.json'), 'utf8')).toBe('{"enabled":true}\n')
    expect((await manager.history()).packs['demo-pack']?.files['config/demo.json']).toMatch(/^[a-f0-9]{64}$/)
    const encoded = await manager.export('demo-pack')
    const exported = join(source, 'demo-pack.dshpack')
    await writeFile(exported, Buffer.from(encoded.slice('dshpack/base64/v1:'.length), 'base64'))
    expect((await manager.inspect({ kind: 'archive', path: exported })).pack.id).toBe('demo-pack')
  })

  it('protects post-install modifications unless force is explicit', async () => {
    const { root, source, manager } = await fixture()
    await manager.install({ kind: 'directory', path: source })
    await writeFile(join(root, 'config', 'demo.json'), '{"user":true}\n')
    await expect(manager.uninstall('demo-pack')).rejects.toThrow('modified resource protected')
    await manager.uninstall('demo-pack', { force: true })
  })

  it('rejects a source that changed after the reviewed plan', async () => {
    const { source, manager } = await fixture()
    const plan = await manager.plan({ kind: 'directory', path: source })
    const changed='{"changed":true}\n'
    await writeFile(join(source, 'config', 'demo.json'), changed)
    const manifest=await readFile(join(source, 'dshpack.yaml'),'utf8')
    await writeFile(join(source, 'dshpack.yaml'),manifest.replace(sha256('{"enabled":true}\n'),sha256(changed)))
    await expect(manager.install({ kind: 'directory', path: source }, { expectedDigest: plan.sourceDigest })).rejects.toThrow('changed after preview')
  })

  it('does not silently overwrite an unowned resource', async () => {
    const { root, source, manager } = await fixture()
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config', 'demo.json'), '{"mine":true}\n')
    const plan = await manager.plan({ kind: 'directory', path: source })
    expect(plan.warnings[0]).toContain('unowned')
    await expect(manager.install({ kind: 'directory', path: source })).rejects.toThrow('conflicts require force')
  })

  it('rejects a changed payload whose hash no longer matches', async () => {
    const { source, manager } = await fixture()
    await writeFile(join(source, 'config', 'demo.json'), '{"tampered":true}\n')
    await expect(manager.inspect({ kind: 'directory', path: source })).rejects.toThrow('hash mismatch')
  })

  it('rejects undeclared and executable payloads', async () => {
    const extra = await fixture()
    await writeFile(join(extra.source, 'config', 'surprise.txt'), 'undeclared')
    await expect(extra.manager.inspect({ kind: 'directory', path: extra.source })).rejects.toThrow('undeclared pack payloads')

    const executable = await fixture('console.log("run")\n')
    await expect(executable.manager.inspect({ kind: 'directory', path: executable.source })).rejects.toThrow('executable source')
  })

  it('rejects secret-like raw text and inconsistent ownership declarations', async () => {
    const secret = await fixture('password: definitely-secret\n')
    await expect(secret.manager.inspect({ kind: 'directory', path: secret.source })).rejects.toThrow()

    const ownership = await fixture()
    const manifest = await readFile(join(ownership.source, 'dshpack.yaml'), 'utf8')
    await writeFile(join(ownership.source, 'dshpack.yaml'), manifest.replace('ownership: {}', 'ownership:\n  another-pack:\n    - config/demo.json'))
    await expect(ownership.manager.inspect({ kind: 'directory', path: ownership.source })).rejects.toThrow('ownership may declare only')
  })

  it('rejects unsupported executable file extensions', async () => {
    const item = await fixture('export default 1\n')
    await writeFile(join(item.source, 'config', 'demo.js'), 'export default 1\n')
    const manifest = await readFile(join(item.source, 'dshpack.yaml'), 'utf8')
    await writeFile(join(item.source, 'dshpack.yaml'), manifest.replaceAll('config/demo.json', 'config/demo.js').replace(sha256('export default 1\n'), sha256('export default 1\n')))
    await rm(join(item.source, 'config', 'demo.json'))
    await expect(item.manager.inspect({ kind: 'directory', path: item.source })).rejects.toThrow('unsupported data-only file type')
  })
})
