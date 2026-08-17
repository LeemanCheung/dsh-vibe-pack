import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { PackManager } from './core/manager.js'
import type { InstallPlan, PackLedger } from './core/manager.js'
import type { Change } from './core/lifecycle.js'
import type { SourceSpec } from './core/source.js'
export * from './core/schema.js'
export * from './core/safe-yaml.js'
export * from './core/security.js'
export * from './core/source.js'
export * from './core/compat.js'
export * from './core/ownership.js'
export * from './core/transaction.js'
export * from './core/adapters.js'
export * from './core/lifecycle.js'
export * from './core/manager.js'

declare module '@deepseek-ai/cordis' { interface Context { vibePack: VibePackService } }
const domainSpec = defineDomain({ name: 'dsh_vibe_pack', version: 1, tables: { history: domainTable<string, { at: string; action: string; detail: string }>(z.object({ at: z.string(), action: z.string(), detail: z.string() })) } })
/** Remote façade. Unknown/non-public DSH resources are deliberately not mutated. */
export default class VibePackService extends TypertRemoteService {
  static inject = ['storageDomain']
  private manager!: PackManager
  private history?: { put(key: string, value: { at: string; action: string; detail: string }): Promise<void> }
  constructor(ctx: Context, config?: { root?: string }) { super(ctx, 'vibePack'); this.manager = new PackManager(config?.root ?? dshHomePath()) }
  protected async [Service.init](): Promise<void> { const domain = await this.ctx.storageDomain.open(domainSpec); this.history = domain.table('history'); this.ctx.effect(() => () => domain.close(), 'vibe-pack: close storage domain') }
  @Remote('history') async historyList(): Promise<PackLedger> { return this.manager.history() }
  @Remote('plan') async plan(source: SourceSpec): Promise<InstallPlan> { return this.manager.plan(source) }
  @Remote('installPack') async install(source: SourceSpec, force: boolean, expectedDigest: string): Promise<InstallPlan> { const result = await this.manager.install(source, { force, expectedDigest }); await this.audit('install', result.pack.id); return result }
  @Remote('uninstall') async uninstall(id: string, force: boolean): Promise<void> { await this.manager.uninstall(id, { force }); await this.audit('uninstall', id) }
  @Remote('diff') async diff(id: string): Promise<Change[]> { return this.manager.diff(id) }
  @Remote('export') async exportPack(id: string): Promise<string> { return this.manager.export(id) }
  private async audit(action: string, detail: string): Promise<void> { await this.history?.put(`${Date.now()}-${Math.random()}`, { at: new Date().toISOString(), action, detail }) }
}
