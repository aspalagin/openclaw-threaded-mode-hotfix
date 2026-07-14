# Contributing

Changes must remain scoped to a specific, verified OpenClaw build. Do not
broaden a signature match merely to make a new version pass: add a
version-specific review, test, and support-matrix entry instead.

Before opening a pull request, run:

```bash
npm run check:syntax
OPENCLAW_PACKAGE_ROOT=/path/to/reviewed-openclaw npm run dry-run:6.11
```

The dry run must not modify the package and must complete successfully only for
the reviewed build. Never commit package backups, local OpenClaw bundles,
tokens, or host-specific paths.
