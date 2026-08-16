# Vibe Pack security and recovery test plan

## Preconditions

- Use a fresh temporary `--root` and fixture pack for each destructive case.
- Snapshot the managed root and `.dsh-vibe-pack/ledger.json` before the operation.
- Capture exit status, diagnostic, final files, and ledger state without storing fixture secrets.

## Acceptance cases

| ID | Fixture or action | Expected result |
| --- | --- | --- |
| IN-01 | Change one payload byte after calculating its manifest SHA-256. | Hash mismatch before writes; root and ledger unchanged. |
| IN-02 | Use malformed YAML, an unknown schema version, an unknown field, or a missing per-file digest. | Strict validation failure; no ledger entry. |
| AR-01 | Use traversal, absolute, empty-segment, duplicate case-folded, oversized, or excess ZIP entries. | Archive rejection before payload use; no write outside root. |
| AR-02 | Use a source directory containing a symlink or a target parent symlink escaping the root. | Symlink rejection; external target unchanged. |
| DA-01 | Include script/process/import syntax, a YAML alias/tag/anchor, prototype key, or credential-like key/value. | Data-only validation failure; no process, network, module, or write side effect. |
| OW-01 | Install Pack A owning `R`; plan Pack B over `R`. | Conflict names Pack A; install requires explicit force. |
| OW-02 | Place an unowned file at `R`; plan a replacing pack. | Conflict reports an existing unowned resource; default install rejects. |
| OW-03 | Modify Pack A resource after install, then update/export/uninstall. | Modification is detected; default operation rejects and preserves the resource. |
| OW-04 | Force Pack B over Pack A after review. | Only manifest-listed resources transfer ownership; unrelated Pack A resources remain. |
| TX-01 | Inject a write or ledger failure after at least one resource changes. | Backups restore in reverse order; a restoration failure is reported as partial rollback. |
| TX-02 | Start two mutating operations against one root. | Operations serialize in one process; another process sees the transaction lock and fails loud. |
| MG-01 | Merge two JSON/YAML objects. | Objects merge recursively; arrays and scalars replace; prototype keys and secrets reject. |
| EX-01 | Export an unchanged installed pack and inspect the result. | A valid portable `.dshpack` ZIP is produced with regenerated required SHA-256 values. |

## Automated coverage

`tests/security.test.ts` covers YAML, traversal, transaction rollback, and ownership primitives. `tests/manager.test.ts` covers verified install, durable history, modification protection, unowned conflicts, hash mismatch, and export/import round-trip. Run all package tests with `corepack pnpm test` from the workspace root.

## Release checks

Run `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`, and `corepack pnpm pack:check`. Inspect `npm pack --dry-run` output and run the remaining filesystem, concurrent-process, forced-transfer, and injected-failure cases against an isolated root before publishing.
