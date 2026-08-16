import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { assertSafeRelativePath, containedPath } from './security.js'
import type { TransactionAdapter } from './transaction.js'

export interface FileMutation { path: string; content?: Uint8Array }
type Prior = { content?: Uint8Array }
/** One root-contained, reversible filesystem mutation. Undefined content deletes a file. */
export class FileMutationAdapter implements TransactionAdapter<Prior> {
  private readonly target: string
  constructor(private readonly root: string, mutation: FileMutation) {
    this.target = containedPath(root, assertSafeRelativePath(mutation.path)); this.mutation = mutation
  }
  private readonly mutation: FileMutation
  async snapshot(): Promise<Prior> { try { return { content: new Uint8Array(await readFile(this.target)) } } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error } }
  async restore(snapshot: Prior): Promise<void> { if (snapshot.content) await this.writeAtomic(snapshot.content); else await rm(this.target, { force: true }) }
  async apply(): Promise<void> { if (this.mutation.content) await this.writeAtomic(this.mutation.content); else await rm(this.target, { force: true }) }
  private async writeAtomic(content: Uint8Array): Promise<void> {
    await mkdir(dirname(this.target), { recursive: true })
    const temporary = `${this.target}.dsh-pack-${process.pid}-${Date.now()}.tmp`
    await writeFile(temporary, content, { flag: 'wx' }); await rename(temporary, this.target)
  }
}
