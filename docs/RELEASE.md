# Release process

This document describes how to cut a new release of the DKG V9 node so that users can install and track specific versions.

## Versioning

- **Single version**: The repo uses one version for the node as a product. It is set in:
  - **Root** `package.json` → `version` (e.g. `9.0.0`)
  - **CLI** `packages/cli/package.json` → `version` (must match; this is what `dkg --version` shows)
- **Semantic Versioning**: `MAJOR.MINOR.PATCH`
  - **MAJOR**: Breaking changes (config, protocol, or API)
  - **MINOR**: New features, backward compatible
  - **PATCH**: Bug fixes, docs, no behavior change

## How users get a specific version

1. **From GitHub Releases**  
   Go to [Releases](https://github.com/OriginTrail/dkg-v9/releases), pick a version (e.g. v9.0.0), download "Source code (zip)" or "Source code (tar.gz)".

2. **From git**  
   ```bash
   git clone --depth 1 --branch v9.0.0 https://github.com/OriginTrail/dkg-v9.git
   cd dkg-v9
   pnpm install --frozen-lockfile
   pnpm build
   pnpm dkg start
   ```

   On supported platforms, source installs can also stage the standalone MarkItDown
   converter into `packages/cli/bin` with:

   ```bash
   cd packages/cli
   node ./scripts/bundle-markitdown-binaries.mjs --build-current-platform
   ```

3. **Check version**  
   ```bash
   pnpm dkg --version
   ```

## Cutting a release (maintainers)

### 1. Prepare the release

- Bump version in **root** `package.json` and **packages/cli/package.json` to the new version (e.g. `9.0.1`).
- Update **CHANGELOG.md**:
  - Move items from `[Unreleased]` into a new section `## [X.Y.Z] - YYYY-MM-DD`.
  - Add a link at the bottom: `[X.Y.Z]: https://github.com/OriginTrail/dkg-v9/releases/tag/vX.Y.Z`.
  - Update the `[Unreleased]` link to `...compare/vX.Y.Z...HEAD`.
- Commit:
  ```bash
  git add package.json packages/cli/package.json CHANGELOG.md
  git commit -m "chore: release v9.0.1"
  ```

### 2. Tag and push

- Create an annotated tag (must match the version in package.json):
  ```bash
  git tag -a v9.0.1 -m "Release v9.0.1"
  git push origin main
  git push origin v9.0.1
  ```

- Pushing the tag triggers the **Release** workflow (`.github/workflows/release.yml`):
  - Checkout, install, build, run tests.
  - Build and upload the standalone MarkItDown binaries for Linux x64, macOS arm64,
    and Windows x64.
  - Create a GitHub Release with:
    - Name: `v9.0.1`
    - Body: section from CHANGELOG for that version (plus auto-generated release notes from commits).
    - Release assets for the MarkItDown binaries plus the default source zip/tar downloads.

- After the release exists, publish npm packages from the tagged commit. The
  `@origintrail-official/dkg` package runs a best-effort postinstall hook that
  downloads the matching current-platform MarkItDown binary from the GitHub Release
  into the installed package `bin/` directory.

### 3. Verify

- Open **Releases** on GitHub and confirm the new release exists and the description looks correct.
- Optionally clone at the tag and run `pnpm install && pnpm build && pnpm dkg --version` to confirm (e.g. `9.0.1`).

## Optional: pre-built artifacts

To ship a tarball that includes built `dist/` and `node_modules` (so users don’t need Node/pnpm), you can extend the release workflow to:

- Run `pnpm install --frozen-lockfile --prod` in a clean directory.
- Run `pnpm build`.
- Tar the result and upload it as a release asset (e.g. `dkg-node-v9.0.1-linux-x64.tar.gz`).

That is not set up by default; the current process relies on source + lockfile for reproducible installs.
