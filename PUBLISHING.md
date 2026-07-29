# Publishing `@cronvello/sdk`

Releases are built by `.github/workflows/publish.yml` and published through npm Trusted
Publishing. GitHub Actions receives a short-lived OIDC credential for each release, so this
repository does not need an `NPM_TOKEN`.

## One-time npm setup

In the npm settings for `@cronvello/sdk`, configure a GitHub Actions trusted publisher:

- Organization or user: `niccasWilliams`
- Repository: `cronvello-sdk`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The package settings and GitHub fields are case-sensitive. The workflow uses a GitHub-hosted
runner, Node 24, npm 11+, and the required `id-token: write` permission.

## Releasing a version

1. Bump `package.json` using semantic versioning.
2. Add the release notes to `CHANGELOG.md`.
3. Run `npm run check` and `npm pack --dry-run`.
4. Commit and push the change.
5. Tag the exact package version and push the tag:

```bash
git tag v0.2.1
git push origin main
git push origin v0.2.1
```

The workflow verifies that the tag and `package.json` version match before publishing. Trusted
Publishing automatically attaches npm provenance because this package and repository are public.

## Rehearse without publishing

Run the **Publish @cronvello/sdk** workflow manually in GitHub Actions. Manual runs always execute
`npm publish --dry-run`; only a matching `v*` tag can publish a real release.

## Local release check

```bash
npm install --no-package-lock --no-audit --no-fund
npm run check
npm pack --dry-run
```
