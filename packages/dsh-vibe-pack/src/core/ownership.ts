export interface OwnershipClaim { owner: string; path: string }
/** Bidirectional ownership index. Constructor accepts owner -> paths mappings. */
export class OwnershipGraph {
  private readonly owners = new Map<string, Set<string>>()
  constructor(initial: Record<string, Iterable<string>> = {}) { for (const [owner, paths] of Object.entries(initial)) for (const path of paths) this.claim(owner, path) }
  claim(owner: string, path: string): void { (this.owners.get(path) ?? this.owners.set(path, new Set()).get(path)!).add(owner) }
  release(owner: string, path: string): void { const set = this.owners.get(path); if (!set) return; set.delete(owner); if (!set.size) this.owners.delete(path) }
  replace(owner: string, paths: Iterable<string>): void { for (const [path, set] of this.owners) if (set.has(owner)) this.release(owner, path); for (const path of paths) this.claim(owner, path) }
  ownersOf(path: string): readonly string[] { return [...(this.owners.get(path) ?? [])].sort() }
  ownerOf(path: string): string | undefined { return this.ownersOf(path)[0] }
  pathsOf(owner: string): readonly string[] { return [...this.owners].filter(([, owners]) => owners.has(owner)).map(([path]) => path).sort() }
  conflicts(owner: string, paths: Iterable<string>): OwnershipClaim[] { return [...paths].flatMap((path) => this.ownersOf(path).filter((existing) => existing !== owner).map((existing) => ({ owner: existing, path }))) }
  toJSON(): Record<string, string[]> { return Object.fromEntries([...this.owners].map(([path, owners]) => [path, [...owners].sort()])) }
  static fromJSON(value: Record<string, string[]>): OwnershipGraph { const graph = new OwnershipGraph(); for (const [path, owners] of Object.entries(value)) for (const owner of owners) graph.claim(owner, path); return graph }
}
