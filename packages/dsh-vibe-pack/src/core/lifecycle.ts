import { sha256 } from './security.js'

export interface FileState { path: string; digest: string; owner?: string }
export interface Checkpoint { version: 1; createdAt: string; files: FileState[]; ownership: Record<string, string[]> }
export type Change = { type: 'create' | 'update' | 'delete' | 'unchanged'; path: string; before?: FileState; after?: FileState }
export function checkpoint(files: Iterable<{ path: string; content: Uint8Array; owner?: string }>, ownership: Record<string, string[]>): Checkpoint {
  return { version: 1, createdAt: new Date().toISOString(), files: [...files].map((f) => ({ path: f.path, digest: sha256(f.content), owner: f.owner })).sort((a, b) => a.path.localeCompare(b.path)), ownership }
}
export function diffCheckpoints(before: Checkpoint, after: Checkpoint): Change[] {
  const old = new Map(before.files.map((f) => [f.path, f])), next = new Map(after.files.map((f) => [f.path, f]))
  return [...new Set([...old.keys(), ...next.keys()])].sort().map((path) => {
    const a = old.get(path), b = next.get(path)
    return { path, before: a, after: b, type: !a ? 'create' : !b ? 'delete' : a.digest === b.digest && a.owner === b.owner ? 'unchanged' : 'update' }
  })
}
export function exportCheckpoint(checkpoint: Checkpoint): string { return `${JSON.stringify(checkpoint, null, 2)}\n` }
