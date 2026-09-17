# npm publishing

This project publishes `@amr-m-abdelgawad/devctl` as a free public npm package through npm Trusted Publishing. The release workflow uses GitHub's short-lived OpenID Connect identity; the repository must not contain an npm access token.

## Bootstrap status

The one-time bootstrap is complete: `0.1.2-bootstrap.0` was published under the `bootstrap` tag and the GitHub Actions Trusted Publisher was configured. Do not publish that version again. These are the historical commands that established the package name:

```bash
cd app
bun install --frozen-lockfile
bun run build:npm 0.1.2-bootstrap.0
cd ../dist/npm
npm login
npm publish --access public --tag bootstrap
```

The prerelease established the npm package so Trusted Publishing could be configured. Normal releases now use GitHub OIDC and do not need an npm token.

The configured Trusted Publisher uses these exact values:

- Provider: GitHub Actions
- Organization or user: `amr-m-abdelgawad`
- Repository: `devctl`
- Workflow filename: `release.yml`
- Environment: `npm`

The repository also has a GitHub Actions environment named `npm`. No npm secret is needed. The workflow uses Node 24 and npm 11.5.1, satisfying npm's Node 22.14+/npm 11.5.1+ requirement for trusted publication.

In the repository's Actions settings, enable the option that allows GitHub Actions to create pull requests. This is needed for the automated Homebrew checksum update; npm and GitHub Release publication do not depend on that optional PR succeeding.

## Normal release

Before tagging, update both version sources and confirm all CI checks pass:

```bash
# app/package.json and app/src/version.ts must contain the same version
git tag vX.Y.Z
git push origin vX.Y.Z
```

The release workflow then:

1. Builds the npm tarball and native binaries once.
2. Tests that exact tarball on supported macOS, Linux/glibc, Linux/musl, and Windows runners.
3. Generates `SHA256SUMS` and GitHub build-provenance attestations.
4. Publishes the npm version with provenance if it is not already present.
5. Finalizes the GitHub Release and opens a Homebrew checksum update pull request.

Publication is idempotent: rerunning a completed or partially completed workflow skips an npm version that is already on the registry and continues release finalization.

GitHub's uploads API can return `HTTP 500: Error saving asset` when several large binaries are sent at once. The publish job creates the draft without assets, then uploads each file sequentially with retries. If a tag's Release run still fails after that:

1. Re-run the failed jobs on that tag workflow, or
2. After this retry logic is on `main`, run **Release → Run workflow** and pass the existing tag (for example `v0.13.1`). That rebuilds from the tag using the workflow on the branch you dispatched from, so a publish fix does not require moving the tag.

A draft left with only some assets is expected after a mid-upload 500; the next successful run replaces them with `--clobber`.

## Trust model

npm provenance shows that the JavaScript package was published by this repository's workflow. GitHub attestations and `SHA256SUMS` establish the origin and integrity of standalone release files. They are free, but they do not replace Apple Developer ID notarization or Windows Authenticode signing; standalone binaries remain explicitly unsigned.
