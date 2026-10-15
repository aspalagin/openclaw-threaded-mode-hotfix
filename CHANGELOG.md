# Changelog

## v2026.9.7-2 - 2026-10-15

- Added the `subagent-owner-scope` hotfix for OpenClaw `2026.9.7`: a sub-agent
  spawned with `sessions_spawn` from an owner's run is launched with
  `scopes: ["operator.admin"]`, so the gateway treats the child as an owner
  run and no longer denies it the owner-only core tools (`nodes`, `computer`,
  `mobile_ui`, `sessions`, `terminal`, `portal`, `conversations_*`, `openclaw`,
  `screen`). Non-owner parents (group chats, other senders) are unchanged.
  Scripts: `apply-subagent-owner-scope-hotfix-2026-9-7.mjs` (two bundles,
  all-or-nothing, `--package-root`, `--backup-dir`, `--dry-run`, marker
  guards, backups, `node --check` before replacing each bundle),
  `check-subagent-owner-scope-hotfix-2026-9-7.mjs` (10 signature assertions
  across both bundles) and `test-subagent-owner-scope-hotfix-2026-9-7.mjs`
  (20 scenarios: syntax of the patched copies, the three patched object
  literals evaluated with synthetic inputs, end-to-end owner / non-owner /
  unknown flows, version guard).
- The `verify-2026-9-7` CI job now also runs the new scripts (dry run must not
  write, checker fails on vanilla, functional test, apply + checker + test,
  re-apply is a no-op, version guard) and finally checks both `2026.9.7`
  hotfixes on the same install.
- `npm run check:syntax`, `dry-run:9.7`, `check:installed:9.7` and `test:9.7`
  cover both `2026.9.7` hotfixes; per-hotfix variants are suffixed
  `:dm-topic-adopt` / `:subagent-owner-scope`.

## v2026.9.7-1 - 2026-10-12

- Added the `dm-topic-adopt` hotfix for OpenClaw `2026.9.7`: a private-chat
  message that arrives without `message_thread_id` within 3 seconds after the
  same user's `forum_topic_created` service message is routed into that topic
  instead of the root DM. Scripts: `apply-dm-topic-adopt-hotfix-2026-9-7.mjs`
  (`--package-root`, `--backup-dir`, `--dry-run`, marker guard, backup,
  `node --check` before replacing the bundle),
  `check-dm-topic-adopt-hotfix-2026-9-7.mjs` (8 signature assertions) and
  `test-dm-topic-adopt-hotfix-2026-9-7.mjs` (13 functional scenarios against a
  temporary copy of the bundle).
- CI now has a job for OpenClaw `2026.9.7`: dry run must not write, checker must
  fail on vanilla, functional test, apply + checker + test, re-apply is a
  no-op, version guard. The job runs on Node.js 24 because the functional test
  imports the OpenClaw bundle. The `2026.7.1-2` job is retained.
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
