# Changelog

## Unreleased

- Removed the legacy OpenClaw `2026.6.10` and `2026.6.11` scripts and the
  `2026.6.10` reference patch from `main`; they remain in git history and under
  tag `v2026.6.11-1`.
- Removed host-specific defaults: backups now go to
  `./openclaw-hotfix-backups/...` unless `OPENCLAW_HOTFIX_BACKUP_DIR` is set.

## v2026.7.1-2 - 2026-08-08

- Added a focused, guarded hotfix for OpenClaw `2026.7.1-2`.
- Prevented Telegram DM topics from inheriting model overrides from the parent
  DM session.
- Made `/new` clear user model overrides while `/reset` preserves them.
- Added an idempotent checker, backup-on-write behavior, smoke-test guidance,
  and CI coverage against a disposable npm installation.
- Included pending legacy Telegram Guest Mode hardening for the `2026.6.10`
  reference scripts.

## v2026.6.11-1 - 2026-07-14

- Released the OpenClaw 2026.6.11 hotfix scripts with guarded version checks.
- Added CI syntax checks and a non-writing dry run against the npm OpenClaw 2026.6.11 build.
- Documented the supported-version boundary and verification mechanism.
- Made dry-run transformations cumulative in memory, matching the apply order
  without writing package files.
- Preserved guarded patch matching for the published bundle's indentation.
