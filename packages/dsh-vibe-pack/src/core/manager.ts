import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { zipSync } from 'fflate'
import { dump as dumpYaml } from 'js-yaml'
import { assertCompatibility } from './compat.js'
import { checkpoint, diffCheckpoints, type Change, type Checkpoint } from './lifecycle.js'
import { OwnershipGraph } from './ownership.js'
import { parseSafeYaml } from './safe-yaml.js'
import { parsePackV1, type PackV1 } from './schema.js'
import { assertDataOnlySource, assertNoSecrets, assertSafeRelativePath, containedPath, containedWritablePath, hashesEqual, sha256, SecurityError } from './security.js'
import { resolveSource, type SourceSpec } from './source.js'

export type PlanItem = { path: string; action: 'create' | 'replace' | 'merge'; conflict?: string }
export type InstallPlan = { pack: Pick<PackV1, 'id' | 'version'>; sourceDigest: string; items: PlanItem[]; warnings: string[] }
export type PackLedgerEntry = { version: string; sourceDigest: string; files: Record<string, string>; checkpoint: Checkpoint }
export type PackLedger = { version: 1; packs: Record<string, PackLedgerEntry> }

const emptyPackLedger = (): PackLedger => ({ version: 1, packs: {} })

/** Filesystem-backed data-only pack lifecycle with one durable mutation lock. */
export class PackManager {
  private mutations: Promise<void> = Promise.resolve()

  constructor(readonly root: string, readonly runtime = { dsh: '0.1.0-rc.6', node: process.versions.node }) {}

  private get stateRoot(): string { return join(this.root, '.dsh-vibe-pack') }
  private get statePath(): string { return join(this.stateRoot, 'ledger.json') }

  async inspect(source: SourceSpec): Promise<{ pack: PackV1; files: Map<string, Uint8Array>; digest: string }> {
    const resolved = await resolveSource(source)
    const manifestNames = ['dshpack.yaml', 'dshpack.yml'].filter(name => resolved.files.has(name))
    if (manifestNames.length !== 1) throw new SecurityError('pack must contain exactly one dshpack.yaml or dshpack.yml manifest')
    const manifest = resolved.files.get(manifestNames[0]!)!
    const raw = decodeText(manifest, manifestNames[0]!)
    assertDataOnlySource(raw, 'manifest')
    const parsed = parseSafeYaml(raw)
    assertNoSecrets(parsed)
    const pack = parsePackV1(parsed)
    assertCompatibility(pack.compatibility, this.runtime)
    const declared = new Set(pack.files.map(entry => assertSafeRelativePath(entry.path)))
    const extras = [...resolved.files.keys()].filter(path => !manifestNames.includes(path) && !declared.has(path))
    if (extras.length > 0) throw new SecurityError(`undeclared pack payloads are forbidden: ${extras.sort().join(', ')}`)
    for (const entry of pack.files) {
      const path = assertSafeRelativePath(entry.path)
      const bytes = resolved.files.get(path)
      if (bytes === undefined) throw new SecurityError(`manifest file missing: ${path}`)
      if (!hashesEqual(sha256(bytes), entry.sha256)) throw new SecurityError(`hash mismatch: ${path}`)
      validatePayload(path, bytes)
    }
    return { pack, files: resolved.files, digest: resolved.digest }
  }

  async plan(source: SourceSpec): Promise<InstallPlan> {
    const info = await this.inspect(source)
    return this.planInspected(info, await this.ledger())
  }

  private async planInspected(info: Awaited<ReturnType<PackManager['inspect']>>, ledger: PackLedger): Promise<InstallPlan> {
    const graph = new OwnershipGraph(Object.fromEntries(Object.entries(ledger.packs).map(([id, entry]) => [id, Object.keys(entry.files)])))
    const items: PlanItem[] = []
    for (const file of info.pack.files) {
      const target = containedPath(this.root, file.path)
      const existing = await readOptional(target)
      const owner = graph.ownerOf(file.path)
      let conflict: string | undefined
      if (existing !== undefined) {
        if (owner === undefined) conflict = 'existing unowned resource'
        else if (owner !== info.pack.id) conflict = `owned by ${owner}`
        else if (ledger.packs[owner]?.files[file.path] !== sha256(existing)) conflict = 'resource was modified after installation'
        else if (file.mode === 'create') conflict = 'create mode refuses an existing resource'
      }
      items.push({ path: file.path, action: file.mode, ...(conflict === undefined ? {} : { conflict }) })
    }
    return {
      pack: { id: info.pack.id, version: info.pack.version },
      sourceDigest: info.digest,
      items,
      warnings: items.flatMap(item => item.conflict === undefined ? [] : [`${item.path}: ${item.conflict}`]),
    }
  }

  async install(source: SourceSpec, options: { force?: boolean; expectedDigest?: string } = {}): Promise<InstallPlan> {
    return this.serialize(() => this.withLock(async () => {
      const info = await this.inspect(source)
      if (options.expectedDigest !== undefined && !hashesEqual(info.digest, options.expectedDigest)) throw new SecurityError('pack source changed after preview; review the plan again')
      const ledger = await this.ledger()
      const plan = await this.planInspected(info, ledger)
      if (plan.warnings.length > 0 && !options.force) throw new SecurityError(`conflicts require force: ${plan.warnings.join('; ')}`)
      const paths = info.pack.files.map(file => file.path)
      const before = await this.capture(paths, ledger)
      const backup = await this.backup(paths)
      try {
        for (const file of info.pack.files) {
          const sourceBytes = info.files.get(file.path)
          if (sourceBytes === undefined) throw new SecurityError(`manifest file missing: ${file.path}`)
          const target = await containedWritablePath(this.root, file.path)
          const content = file.mode === 'merge' ? await mergeContent(target, sourceBytes) : sourceBytes
          await writeAtomic(target, content)
        }
        if (options.force) {
          for (const [owner, entry] of Object.entries(ledger.packs)) {
            if (owner === info.pack.id) continue
            for (const path of paths) delete entry.files[path]
          }
        }
        const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(containedPath(this.root, path)))] as const)))
        ledger.packs[info.pack.id] = { version: info.pack.version, sourceDigest: info.digest, files, checkpoint: before }
        await this.save(ledger)
        return plan
      } catch (error) {
        const rollback = await this.restoreBackup(backup)
        if (rollback !== undefined) throw new Error('install failed and rollback was partial', { cause: { error, rollback } })
        throw error
      }
    }))
  }

  async uninstall(id: string, options: { force?: boolean } = {}): Promise<void> {
    await this.serialize(() => this.withLock(async () => {
      const ledger = await this.ledger()
      const installed = ledger.packs[id]
      if (installed === undefined) throw new Error(`pack not installed: ${id}`)
      const backup = await this.backup(Object.keys(installed.files))
      try {
        for (const [path, expected] of Object.entries(installed.files)) {
          const target = await containedWritablePath(this.root, path)
          const current = await readOptional(target)
          if (current !== undefined && sha256(current) !== expected && !options.force) throw new SecurityError(`modified resource protected: ${path}`)
          await rm(target, { force: true })
        }
        delete ledger.packs[id]
        await this.save(ledger)
      } catch (error) {
        const rollback = await this.restoreBackup(backup)
        if (rollback !== undefined) throw new Error('uninstall failed and rollback was partial', { cause: { error, rollback } })
        throw error
      }
    }))
  }

  async history(): Promise<PackLedger> {
    return structuredClone(await this.ledger())
  }

  async diff(id: string): Promise<Change[]> {
    const ledger = await this.ledger()
    const installed = ledger.packs[id]
    if (installed === undefined) throw new Error(`pack not installed: ${id}`)
    return diffCheckpoints(installed.checkpoint, await this.capture(Object.keys(installed.files), ledger))
  }

  async export(id: string): Promise<string> {
    const ledger = await this.ledger()
    const installed = ledger.packs[id]
    if (installed === undefined) throw new Error(`pack not installed: ${id}`)
    const payloads: Record<string, Uint8Array> = {}
    const files = []
    for (const [path, expected] of Object.entries(installed.files)) {
      const content = await readOptional(containedPath(this.root, path))
      if (content === undefined) throw new SecurityError(`installed resource is missing: ${path}`)
      const digest = sha256(content)
      if (digest !== expected) throw new SecurityError(`modified resource protected: ${path}`)
      payloads[path] = content
      files.push({ path, sha256: digest, mode: 'replace' as const, secret: false as const })
    }
    const manifest = dumpYaml({ schemaVersion: 1, id, version: installed.version, compatibility: {}, files, ownership: { [id]: Object.keys(installed.files) }, metadata: { name: id } }, { noRefs: true, sortKeys: true, lineWidth: 120 })
    const archive = zipSync({ 'dshpack.yaml': new TextEncoder().encode(manifest), ...payloads }, { level: 6 })
    return `dshpack/base64/v1:${Buffer.from(archive).toString('base64')}`
  }

  private async ledger(): Promise<PackLedger> {
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown
      if (!isLedger(parsed)) throw new SecurityError('Vibe Pack ledger is invalid')
      return parsed
    } catch (error) {
      if (isMissing(error)) return emptyPackLedger()
      throw error
    }
  }

  private async save(ledger: PackLedger): Promise<void> {
    const target = await containedWritablePath(this.root, '.dsh-vibe-pack/ledger.json')
    await writeAtomic(target, new TextEncoder().encode(`${JSON.stringify(ledger, null, 2)}\n`))
  }

  private async capture(paths: Iterable<string>, ledger: PackLedger): Promise<Checkpoint> {
    const owners: Record<string, string[]> = {}
    for (const [id, entry] of Object.entries(ledger.packs)) owners[id] = Object.keys(entry.files)
    const files: Array<{ path: string; content: Uint8Array }> = []
    for (const path of paths) {
      const content = await readOptional(containedPath(this.root, path))
      if (content !== undefined) files.push({ path, content })
    }
    return checkpoint(files, owners)
  }

  private async backup(paths: Iterable<string>): Promise<Map<string, Uint8Array | undefined>> {
    const result = new Map<string, Uint8Array | undefined>()
    for (const path of paths) result.set(path, await readOptional(containedPath(this.root, path)))
    return result
  }

  private async restoreBackup(backup: Map<string, Uint8Array | undefined>): Promise<unknown | undefined> {
    let failure: unknown
    for (const [path, content] of [...backup].reverse()) {
      try {
        const target = await containedWritablePath(this.root, path)
        if (content === undefined) await rm(target, { force: true })
        else await writeAtomic(target, content)
      } catch (error) {
        failure ??= error
      }
    }
    return failure
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = await containedWritablePath(this.root, '.dsh-vibe-pack/transaction.lock')
    try {
      await mkdir(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SecurityError('another Vibe Pack transaction is active')
      throw error
    }
    try {
      return await operation()
    } finally {
      await rm(lockPath, { recursive: true, force: true })
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }
}

async function writeAtomic(target: string, content: Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.dsh-pack-${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

const STRUCTURED_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.dshskin'])
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.toml', '.ini'])
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

function decodeText(bytes: Uint8Array, path: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new SecurityError(`${path} must contain valid UTF-8 text`) }
}

function validatePayload(path: string, bytes: Uint8Array): void {
  const extension = extname(path).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return
  if (!STRUCTURED_EXTENSIONS.has(extension) && !TEXT_EXTENSIONS.has(extension)) throw new SecurityError(`unsupported data-only file type: ${path}`)
  const text = decodeText(bytes, path)
  assertDataOnlySource(text, path)
  if (extension === '.json' || extension === '.dshskin') {
    try { assertNoSecrets(JSON.parse(text)) }
    catch (error) { if (error instanceof SecurityError) throw error; throw new SecurityError(`${path} must contain valid JSON`) }
  } else if (extension === '.yaml' || extension === '.yml') {
    assertNoSecrets(parseSafeYaml(text))
  } else {
    assertNoSecrets(text)
  }
}

async function mergeContent(target: string, incoming: Uint8Array): Promise<Uint8Array> {
  const existing = await readOptional(target)
  if (existing === undefined) return incoming
  const beforeText = new TextDecoder().decode(existing)
  const incomingText = new TextDecoder().decode(incoming)
  const before = parseMaybeYaml(beforeText)
  const next = parseMaybeYaml(incomingText)
  if (!isPlainRecord(before) || !isPlainRecord(next)) throw new SecurityError('merge mode requires JSON or YAML objects')
  const merged = mergeRecords(before, next)
  assertNoSecrets(merged)
  const text = extname(target).toLowerCase() === '.json'
    ? `${JSON.stringify(merged, null, 2)}\n`
    : dumpYaml(merged, { noRefs: true, sortKeys: true, lineWidth: 120 })
  return new TextEncoder().encode(text)
}

function mergeRecords(before: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...before }
  for (const [key, value] of Object.entries(next)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new SecurityError(`unsafe merge key: ${key}`)
    const current = result[key]
    result[key] = isPlainRecord(current) && isPlainRecord(value) ? mergeRecords(current, value) : value
  }
  return result
}

function parseMaybeYaml(text: string): unknown {
  try {
    return parseSafeYaml(text)
  } catch {
    return text
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function isLedger(value: unknown): value is PackLedger {
  if (!isPlainRecord(value) || value.version !== 1 || !isPlainRecord(value.packs)) return false
  return Object.entries(value.packs).every(([id, entry]) => /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)
    && isPlainRecord(entry)
    && typeof entry.version === 'string'
    && typeof entry.sourceDigest === 'string'
    && isPlainRecord(entry.files)
    && Object.entries(entry.files).every(([path, digest]) => {
      try { assertSafeRelativePath(path) } catch { return false }
      return typeof digest === 'string' && /^[a-f0-9]{64}$/i.test(digest)
    })
    && isPlainRecord(entry.checkpoint))
}
