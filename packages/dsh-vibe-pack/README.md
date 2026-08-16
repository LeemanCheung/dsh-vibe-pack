# dsh-vibe-pack

English | [中文](README.zh-CN.md)

A transactional, data-only configuration pack manager for DeepSeek Harness. It previews, installs, diffs, exports, and uninstalls independently versioned resources under `$DSH_HOME` while tracking ownership and protecting user modifications.

## Pack format

A source is a local directory or a ZIP-compatible `.dshpack`/`.zip` archive containing `dshpack.yaml` and every manifest-listed payload. The strict version-1 manifest contains an id, version, compatibility ranges, 1–10,000 files, SHA-256 for every file, create/replace/merge modes, ownership metadata, and bounded display metadata.

Pack files are data only. Accepted payload extensions are JSON/YAML/`.dshskin`, Markdown/text/TOML/INI, and PNG/JPEG/WebP/GIF images; executable or unknown extensions are rejected. No script, hook, shell command, JavaScript module, URL fetch, symlink, YAML alias/tag/anchor, embedded credential, traversal path, duplicate archive path, or undeclared payload executes or installs. Archives are checked against compressed, expanded, per-file, byte, and entry limits before payload use.

## Transactions and ownership

Preview reports create/replace/merge actions and conflicts. Existing unowned files, files owned by another pack, create-mode collisions, and resources modified after installation require an explicit force choice. Force transfers only manifest-listed ownership; it is never implied.

Install and uninstall are serialized and guarded by an on-disk transaction lock. Each target is backed up before fixed-order atomic writes. Failed operations restore targets in reverse order and report partial rollback errors. The ledger is written atomically at `$DSH_HOME/.dsh-vibe-pack/ledger.json`. Uninstall protects modified resources unless force is explicit.

Merge mode accepts JSON or YAML objects, recursively merges object keys, replaces arrays/scalars, rejects prototype keys and secrets, and emits deterministic data. Export verifies that installed resources still match the ledger and produces a portable `.dshpack` archive.

## UI and CLI

Settings → **Vibe Pack** provides mandatory preview, digest-bound install, ledger history, Diff, independently confirmed Uninstall, and `.dshpack` download. The generated Typert namespace is `vibePack`. The CLI defaults `--root` to `$DSH_HOME`; pass it only to manage an explicit test root.

```powershell
dsh-pack --root $env:DSH_HOME inspect ./my-pack
dsh-pack --root $env:DSH_HOME plan ./my-pack.dshpack
dsh-pack --root $env:DSH_HOME install ./my-pack.dshpack
dsh-pack --root $env:DSH_HOME history
dsh-pack --root $env:DSH_HOME diff my-pack
dsh-pack --root $env:DSH_HOME export my-pack > my-pack.dshpack
dsh-pack --root $env:DSH_HOME uninstall my-pack
```

Use `--force` only after reviewing reported ownership or modification conflicts.

## Install

```powershell
npm pack . --pack-destination ../../dist
dsh plugin --profile web add ../../dist/dsh-vibe-pack-1.0.0.tgz
```

Restart the existing DSH Web process and refresh its page. See the suite [installation guide](../../INSTALL.md).

## Model Experience

This plugin adds no model prompt, tools, messages, token usage, or KV-cache content. Pack inspection and mutation happen on the Host through explicit UI or CLI operations.

## Known limitations

The transaction lock fails loud after an unclean process exit and may need manual removal after confirming no Vibe Pack process is active. Remote operations are shared with trusted clients in the same DSH Web composition. The format provides SHA-256 integrity and ownership checks, not publisher signatures or network distribution.

## Development

From the workspace root run `corepack pnpm typecheck`, `corepack pnpm test`, `corepack pnpm build`, and `corepack pnpm pack:check`. See [TEST_PLAN.md](TEST_PLAN.md) for security acceptance cases.

MIT. See [LICENSE](LICENSE).
