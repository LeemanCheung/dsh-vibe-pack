import { Context, Service } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";
//#region src/core/lifecycle.d.ts
interface FileState {
  path: string;
  digest: string;
  owner?: string;
}
interface Checkpoint {
  version: 1;
  createdAt: string;
  files: FileState[];
  ownership: Record<string, string[]>;
}
type Change = {
  type: 'create' | 'update' | 'delete' | 'unchanged';
  path: string;
  before?: FileState;
  after?: FileState;
};
declare function checkpoint(files: Iterable<{
  path: string;
  content: Uint8Array;
  owner?: string;
}>, ownership: Record<string, string[]>): Checkpoint;
declare function diffCheckpoints(before: Checkpoint, after: Checkpoint): Change[];
declare function exportCheckpoint(checkpoint: Checkpoint): string;
//#endregion
//#region src/core/schema.d.ts
declare const PackFileSchema: z.ZodObject<{
  path: z.ZodString;
  sha256: z.ZodString;
  mode: z.ZodDefault<z.ZodEnum<{
    create: "create";
    replace: "replace";
    merge: "merge";
  }>>;
  secret: z.ZodDefault<z.ZodLiteral<false>>;
}, z.core.$strict>;
declare const PackSchemaV1: z.ZodObject<{
  schemaVersion: z.ZodLiteral<1>;
  id: z.ZodString;
  version: z.ZodString;
  compatibility: z.ZodDefault<z.ZodObject<{
    dsh: z.ZodOptional<z.ZodString>;
    node: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
  files: z.ZodArray<z.ZodObject<{
    path: z.ZodString;
    sha256: z.ZodString;
    mode: z.ZodDefault<z.ZodEnum<{
      create: "create";
      replace: "replace";
      merge: "merge";
    }>>;
    secret: z.ZodDefault<z.ZodLiteral<false>>;
  }, z.core.$strict>>;
  ownership: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodArray<z.ZodString>>>;
  metadata: z.ZodDefault<z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    source: z.ZodOptional<z.ZodString>;
  }, z.core.$strict>>;
}, z.core.$strict>;
type PackV1 = z.infer<typeof PackSchemaV1>;
type PackFile = z.infer<typeof PackFileSchema>;
declare const parsePackV1: (value: unknown) => PackV1;
//#endregion
//#region src/core/source.d.ts
interface ResolvedSource {
  origin: string;
  files: Map<string, Uint8Array>;
  digest: string;
}
type SourceSpec = {
  kind: 'directory';
  path: string;
} | {
  kind: 'archive';
  path: string;
};
declare function resolveSource(spec: SourceSpec): Promise<ResolvedSource>;
//#endregion
//#region src/core/manager.d.ts
type PlanItem = {
  path: string;
  action: 'create' | 'replace' | 'merge';
  conflict?: string;
};
type InstallPlan = {
  pack: Pick<PackV1, 'id' | 'version'>;
  sourceDigest: string;
  items: PlanItem[];
  warnings: string[];
};
type PackLedgerEntry = {
  version: string;
  sourceDigest: string;
  files: Record<string, string>;
  checkpoint: Checkpoint;
};
type PackLedger = {
  version: 1;
  packs: Record<string, PackLedgerEntry>;
};
/** Filesystem-backed data-only pack lifecycle with one durable mutation lock. */
declare class PackManager {
  readonly root: string;
  readonly runtime: {
    dsh: string;
    node: string;
  };
  private mutations;
  constructor(root: string, runtime?: {
    dsh: string;
    node: string;
  });
  private get stateRoot();
  private get statePath();
  inspect(source: SourceSpec): Promise<{
    pack: PackV1;
    files: Map<string, Uint8Array>;
    digest: string;
  }>;
  plan(source: SourceSpec): Promise<InstallPlan>;
  private planInspected;
  install(source: SourceSpec, options?: {
    force?: boolean;
    expectedDigest?: string;
  }): Promise<InstallPlan>;
  uninstall(id: string, options?: {
    force?: boolean;
  }): Promise<void>;
  history(): Promise<PackLedger>;
  diff(id: string): Promise<Change[]>;
  export(id: string): Promise<string>;
  private ledger;
  private save;
  private capture;
  private backup;
  private restoreBackup;
  private withLock;
  private serialize;
}
//#endregion
//#region src/core/safe-yaml.d.ts
declare class SafeYamlError extends Error {}
/** Parse data-only YAML. Anchors, custom tags, functions, and aliases are rejected. */
declare function parseSafeYaml(input: string): unknown;
//#endregion
//#region src/core/security.d.ts
declare class SecurityError extends Error {}
declare function sha256(data: string | Uint8Array): string;
declare function hashesEqual(actual: string, expected: string): boolean;
declare function assertSafeRelativePath(path: string): string;
declare function containedPath(root: string, candidate: string): string;
/** Creates and resolves a destination parent, rejecting symlink escapes before writes. */
declare function containedWritablePath(root: string, candidate: string): Promise<string>;
/** Resolves symlinks and verifies the resulting existing file is still inside root. */
declare function containedExistingPath(root: string, candidate: string): Promise<string>;
interface SecretFinding {
  path: string;
  reason: string;
}
declare function findSecrets(value: unknown, path?: string): SecretFinding[];
declare function assertNoSecrets(value: unknown): void;
declare function assertDataOnlySource(text: string, filename?: string): void;
//#endregion
//#region src/core/compat.d.ts
interface RuntimeVersions {
  dsh?: string;
  node?: string;
}
interface CompatibilityResult {
  compatible: boolean;
  reasons: string[];
}
declare function checkCompatibility(pack: Pick<PackV1, 'compatibility'> | {
  dsh?: string;
  node?: string;
}, runtime: RuntimeVersions): CompatibilityResult;
declare function assertCompatibility(requirements: {
  dsh?: string;
  node?: string;
}, runtime: RuntimeVersions): void;
//#endregion
//#region src/core/ownership.d.ts
interface OwnershipClaim {
  owner: string;
  path: string;
}
/** Bidirectional ownership index. Constructor accepts owner -> paths mappings. */
declare class OwnershipGraph {
  private readonly owners;
  constructor(initial?: Record<string, Iterable<string>>);
  claim(owner: string, path: string): void;
  release(owner: string, path: string): void;
  replace(owner: string, paths: Iterable<string>): void;
  ownersOf(path: string): readonly string[];
  ownerOf(path: string): string | undefined;
  pathsOf(owner: string): readonly string[];
  conflicts(owner: string, paths: Iterable<string>): OwnershipClaim[];
  toJSON(): Record<string, string[]>;
  static fromJSON(value: Record<string, string[]>): OwnershipGraph;
}
//#endregion
//#region src/core/transaction.d.ts
interface TransactionAdapter<S> {
  snapshot(): Promise<S>;
  restore(snapshot: S): Promise<void>;
  apply(): Promise<void>;
}
declare class TransactionError extends Error {
  readonly cause?: unknown | undefined;
  readonly rollbackError?: unknown | undefined;
  constructor(message: string, cause?: unknown | undefined, rollbackError?: unknown | undefined);
}
/** Applies registered steps atomically from the caller's perspective. */
declare class Transaction<S> {
  private readonly steps;
  add(name: string, adapter: TransactionAdapter<S>): this;
  commit(): Promise<void>;
}
declare class MemoryAdapter<T> implements TransactionAdapter<T> {
  private value;
  private readonly next;
  constructor(value: T, next: () => T);
  snapshot(): Promise<T>;
  restore(snapshot: T): Promise<void>;
  apply(): Promise<void>;
  get current(): T;
}
//#endregion
//#region src/core/adapters.d.ts
interface FileMutation {
  path: string;
  content?: Uint8Array;
}
type Prior = {
  content?: Uint8Array;
};
/** One root-contained, reversible filesystem mutation. Undefined content deletes a file. */
declare class FileMutationAdapter implements TransactionAdapter<Prior> {
  private readonly root;
  private readonly target;
  constructor(root: string, mutation: FileMutation);
  private readonly mutation;
  snapshot(): Promise<Prior>;
  restore(snapshot: Prior): Promise<void>;
  apply(): Promise<void>;
  private writeAtomic;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    vibePack: VibePackService;
  }
}
/** Remote façade. Unknown/non-public DSH resources are deliberately not mutated. */
declare class VibePackService extends TypertRemoteService {
  static inject: string[];
  private manager;
  private history?;
  constructor(ctx: Context, config?: {
    root?: string;
  });
  protected [Service.init](): Promise<void>;
  historyList(): Promise<PackLedger>;
  plan(source: SourceSpec): Promise<InstallPlan>;
  install(source: SourceSpec, force: boolean, expectedDigest: string): Promise<InstallPlan>;
  uninstall(id: string, force: boolean): Promise<void>;
  diff(id: string): Promise<Change[]>;
  exportPack(id: string): Promise<string>;
  private audit;
}
//#endregion
export { Change, Checkpoint, CompatibilityResult, FileMutation, FileMutationAdapter, FileState, InstallPlan, MemoryAdapter, OwnershipClaim, OwnershipGraph, PackFile, PackFileSchema, PackLedger, PackLedgerEntry, PackManager, PackSchemaV1, PackV1, PlanItem, ResolvedSource, RuntimeVersions, SafeYamlError, SecretFinding, SecurityError, SourceSpec, Transaction, TransactionAdapter, TransactionError, assertCompatibility, assertDataOnlySource, assertNoSecrets, assertSafeRelativePath, checkCompatibility, checkpoint, containedExistingPath, containedPath, containedWritablePath, VibePackService as default, diffCheckpoints, exportCheckpoint, findSecrets, hashesEqual, parsePackV1, parseSafeYaml, resolveSource, sha256 };
//# sourceMappingURL=index.d.ts.map