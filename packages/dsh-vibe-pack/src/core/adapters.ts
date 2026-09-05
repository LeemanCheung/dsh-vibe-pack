import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertSafeRelativePath, containedExistingPath, containedWritablePath } from './security.js'
import type { TransactionAdapter } from './transaction.js'

export interface FileMutation { path: string; content?: Uint8Array }
type Prior = { content?: Uint8Array }
/** One root-contained, reversible filesystem mutation. Undefined content deletes a file. */
export class FileMutationAdapter implements TransactionAdapter<Prior> {
  constructor(private readonly root: string, mutation: FileMutation) {
    assertSafeRelativePath(mutation.path); this.mutation = mutation
  }
  private readonly mutation: FileMutation
  async snapshot(): Promise<Prior> { try { return { content: new Uint8Array(await readFile(await containedExistingPath(this.root, this.mutation.path))) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error } }
  async restore(snapshot: Prior): Promise<void> { const target = await containedWritablePath(this.root, this.mutation.path); if (snapshot.content) await this.writeAtomic(target, snapshot.content); else await rm(target, { force: true }) }
  async apply(): Promise<void> { const target = await containedWritablePath(this.root, this.mutation.path); if (this.mutation.content) await this.writeAtomic(target, this.mutation.content); else await rm(target, { force: true }) }
  private async writeAtomic(target: string, content: Uint8Array): Promise<void> {
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.dsh-pack-${process.pid}-${Date.now()}.tmp`
    await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, target)
  }
}
