# Contributing

Bug reports, focused feature proposals, documentation fixes, and pull requests are welcome.

## Local setup

```bash
git clone https://github.com/niccasWilliams/cronvello-sdk.git
cd cronvello-sdk
npm install --no-package-lock --no-audit --no-fund
npm run check
```

The project intentionally has zero runtime dependencies and supports Node 20 or newer. Keep public
API changes backward-compatible where practical, add tests for behavior changes, and document
user-visible changes in `CHANGELOG.md`.

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

For vulnerabilities, follow `SECURITY.md` instead of opening a public issue.
