# Changelog

## v2026.6.11-1 - 2026-07-14

- Released the OpenClaw 2026.6.11 hotfix scripts with guarded version checks.
- Added CI syntax checks and a non-writing dry run against the npm OpenClaw 2026.6.11 build.
- Documented the supported-version boundary and verification mechanism.
- Made dry-run transformations cumulative in memory, matching the apply order
  without writing package files.
- Preserved guarded patch matching for the published bundle's indentation.
