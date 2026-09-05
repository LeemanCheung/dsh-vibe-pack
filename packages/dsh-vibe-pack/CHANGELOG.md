# Changelog

All notable changes to this project are documented in this file.

## [1.0.1] - 2026-09-05

### Fixed

- Reject managed reads, writes, backups, exports, and ledger access when a symbolic link or Windows junction escapes the configured DSH root.
- Validate existing ancestors before creating destination directories, preventing a junction from redirecting even preliminary directory creation.
- Migrate the browser client from the removed `dsh-client-runtime` package to the DSH 0.1.2 Renderer/Cordis API.
- Make Host and Client builds independent of the invoking directory, use stable chunk names and CSS module inputs, and reject stale or machine-specific release artifacts.
- Rebuild committed release artifacts on Windows and Linux CI and fail when tracked or untracked output differs.
- Record `web` compatibility with DSH 0.1.2-rc.1 after Windows Host, Client, Remote, Settings, and empty-ledger UI verification on the QA and existing local profiles.

## [1.0.0] - 2026-03-09

### Added

- Transactional, data-only DSH configuration packs with bilingual documentation, integrity checks, rollback, ownership tracking, and security acceptance coverage.
