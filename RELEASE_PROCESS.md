# DKG Release Process

This document defines the release and rollout workflow for the blue-green auto-update system.

## 1) Source of truth, branch flow, and release gates

- Work is merged to `main` via pull requests.
- Release tags are created from commits already on `main`.
- Nodes update either:
  - by branch/ref (`dkg update`), or
  - by explicit version (`dkg update <version>`).

The release order is:

1. Merge all release-bound work to `main`, resolving every bug found by code review and CI before merge.
2. Run the comprehensive devnet test suite against the resulting `main` commit.
3. If devnet passes, publish a canary/prerelease and promote it to the `testnet` update channel; run the testnet smoke test.
4. If the testnet smoke test passes, publish the stable release and promote the `mainnet` update channel.
5. Run the mainnet smoke test and validate the published packages, GitHub Release, and update channel.

If any gate fails, fix it through a reviewed PR into `main` and restart from the relevant gate. Do not tag or publish from a feature branch.

## 2) Versioning and tag naming (SemVer)

Use `v`-prefixed tags:

- Beta: `v10.0.0-beta.1`, `v10.0.0-beta.2`, ...
- Release candidate: `v10.0.0-rc.1`, `v10.0.0-rc.2`, ...
- Stable: `v10.0.0`, `v10.0.1`, ...

Rule: a stable release tag (`vX.Y.Z`) should only be created for production-ready builds.

## 3) Package version alignment

This is a **single-version release set**: every release `package.json` moves in lockstep to the release version. Before tagging, bump the `version` field in **all** of them — the root (`dkg-v10`) plus every `packages/*` (~20 files, including the two private packages, so the publish graph stays aligned). Internal dependencies use `workspace:*`, which pnpm rewrites to the concrete version at publish time, so a partial bump would ship a skewed dependency graph.

They are all aligned today, so a scoped find-and-replace is safe:

```bash
# review, then bump (macOS sed shown; drop the '' on GNU/Linux)
grep -rl '"version": "<OLD>"' package.json packages/*/package.json
sed -i '' 's/"version": "<OLD>"/"version": "<NEW>"/' package.json packages/*/package.json
git diff --stat   # expect ~20 package.json, version-only
```

A version-only bump does **not** touch `pnpm-lock.yaml` (the lockfile records only third-party versions), so `pnpm install --frozen-lockfile` stays valid. Do the bump on a branch and land it via a reviewed PR (matches every prior release — e.g. #1497 for 10.0.3). The release helper below hard-gates that every release package version equals the tag, including private `packages/*` workspaces and the root package.

Before tagging or publishing, verify the single-version invariant across the root package and every release package:

```bash
pnpm release:verify-versions --version X.Y.Z
```

## 4) Comprehensive devnet gate on `main`

Before any canary tag is created, verify the exact `main` commit that will be tagged:

From repo root:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git rev-parse --short HEAD
```

Run the comprehensive devnet suite on that checkout:

```bash
./scripts/devnet.sh clean
DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6
./scripts/devnet-comprehensive.sh
./scripts/devnet.sh stop
```

Keep the generated devnet report with the release notes. If this gate fails, fix `main` through PR review and rerun the gate before tagging.

## 5) Canary tagging workflow

Create and push the canary/prerelease tag from the devnet-validated `main` commit:

```bash
git tag -a v10.0.0-rc.1 -m "DKG v10.0.0 rc 1"
git push origin v10.0.0-rc.1
```

For signed tags (recommended for production-grade verification):

```bash
git tag -s v10.0.0-rc.1 -m "DKG v10.0.0 rc 1"
git push origin v10.0.0-rc.1
```

## 6) Publishing to npm (fully manual)

npm publishing is **fully manual**. There is **no automated npm-publish or tag-triggered release workflow**: npm's mandatory 2FA/OTP makes token-based CI publishing unworkable, and the old GitHub Release workflow was removed so the repository does not carry two competing release paths. Everything below is done by a maintainer from a clean checkout of the signed tag.

### 6a) Publish the package set

From a clean checkout at the tagged commit:

```bash
pnpm release:verify-tag --tag vX.Y.Z --version X.Y.Z
git checkout vX.Y.Z            # detached HEAD at the tag
pnpm install --frozen-lockfile
pnpm build                     # must fully succeed (UI bundle included)
pnpm release:verify-versions --version X.Y.Z
pnpm release:build-info --dist-tag latest
pnpm -r publish --no-git-checks --tag latest
```

`release:verify-tag` restores the tag gates the old tag-triggered workflow enforced, now as a publish preflight: the tag must be an annotated object carrying a PGP/SSH signature block, it must exist on `origin` at the same object (an unpushed or moved tag fails), and its commit must be reachable from `origin/main` (override with `--base` for a release branch). Signer identity is enforced server-side by the signed-tag ruleset; this gate checks structure and ancestry so a publish can never start from a mislabeled or foreign commit.

npm prompts for your **OTP** (2FA). All publishable public `@origintrail-official/*` packages publish in one command; private workspaces are skipped automatically. `pnpm` skips versions already on the registry, so a re-run after a partial publish is safe. `pnpm release:build-info` writes `packages/cli/build-info.json` before packaging, so npm-installed daemons report the tag commit, build time, and publish dist-tag through `/api/status`.

For a canary/prerelease, use the prerelease npm tag and move only the `testnet` update channel:

```bash
pnpm release:verify-tag --tag vX.Y.Z-rc.1 --version X.Y.Z-rc.1
git checkout vX.Y.Z-rc.1
pnpm install --frozen-lockfile
pnpm build
pnpm release:verify-versions --version X.Y.Z-rc.1
pnpm release:build-info --dist-tag rc
pnpm -r publish --no-git-checks --tag rc
pnpm release:promote --version X.Y.Z-rc.1 --tags testnet --otp <fresh 2FA code>
```

Use `beta` or `alpha` in place of `rc` when that is the prerelease channel. The prerelease npm tag (`rc` / `beta` / `alpha`) is for humans and direct installs; `testnet` is what `network/testnet.json` auto-update follows.

After promoting `testnet`, update a real testnet node to the canary and run the testnet smoke test. Do not continue to the stable/mainnet release until the smoke test passes.

### 6b) Move the mainnet dist-tag (stable production promotion)

`--tag latest` only sets `latest`. Mainnet node auto-update channels + SDK pins follow the `mainnet` dist-tag, which is carried on **every** published package — so move it on all of them, not just the flagship:

```bash
pnpm release:packages
pnpm release:promote --version X.Y.Z --tags mainnet --otp <fresh 2FA code>
```

One OTP covers the batch; a TOTP code can expire mid-loop, so if some fail, re-run with a fresh code (`npm dist-tag add` is idempotent). Moving `mainnet` is the **production go-live** — do it only after the testnet canary smoke test and stable package verification have passed.

### 6c) Create the GitHub Release (manual)

Because there is no tag-triggered release workflow, make the Release by hand from the signed tag, with notes taken from the matching `CHANGELOG.md` section (theme header, npm + channel line, PR-tagged bullets, a `compare/vPREV...vNEW` link):

```bash
gh release create vX.Y.Z --repo OriginTrail/dkg --verify-tag \
  --title vX.Y.Z --notes-file <notes.md> --latest
```

Use `--latest=false` when back-filling an older version so it doesn't steal the "Latest" badge. MarkItDown binaries are not attached by this manual process; the published `@origintrail-official/dkg` postinstall downloads them best-effort, so `npm i` is unaffected if they're absent.

### 6d) Verify and smoke test

```bash
pnpm release:verify-published --version X.Y.Z --tags latest,mainnet
# prerelease example:
pnpm release:verify-published --version X.Y.Z-rc.1 --tags rc,testnet
gh release view vX.Y.Z --repo OriginTrail/dkg
```

After the `mainnet` dist-tag moves, update at least one mainnet node, execute the mainnet smoke test, and validate `/api/status` reports the expected version, commit, dist-tag, and package build metadata.

## 7) Node update policy

- Stable cohort:
  - follow stable tags/branch
  - `allowPrerelease=false`
- Canary cohort:
  - allowed to run beta/rc versions
  - `allowPrerelease=true`

Update commands:

```bash
dkg update --check
dkg update 10.0.0-rc.1 --check
dkg update 10.0.0-rc.1 --allow-prerelease
```

Tag verification:

- Default for tag updates is verify-on.
- For local/dev unsigned tags only, use:

```bash
dkg update 10.0.0-rc.1 --allow-prerelease --no-verify-tag
```

## 8) Post-update verification

Git-based blue-green updates run runtime packages and the Node UI static bundle as separate timed build steps, then verify `packages/node-ui/dist-ui/index.html` before activation. `build:runtime` remains a UI-inclusive compatibility wrapper so nodes updating from an older updater still prepare the UI through the target ref's build script.

> **Note on EVM contracts**: nodes never run `hardhat compile` during install or auto-update. The committed `packages/evm-module/abi/*.json` files are the runtime contract surface (consumed by `packages/chain` via `require()`). The `abi-freshness` CI job (`.github/workflows/ci.yml`) blocks any PR that changes Solidity sources without committing the regenerated ABIs, so by the time a tag exists on `main` the committed ABIs are guaranteed to match. **Release implication**: when contract source changes are part of a release, the contributor MUST regenerate ABIs (`pnpm --filter @origintrail-official/dkg-evm-module build && git add packages/evm-module/abi/`) and commit them with the source change. CI enforces this; releases cut from `main` cannot ship with stale ABIs.

After each update:

```bash
readlink "$DKG_HOME/releases/current"
cat "$DKG_HOME/releases/active"
cat "$DKG_HOME/.current-commit"
cat "$DKG_HOME/.current-version"
test ! -f "$DKG_HOME/.update-pending.json" && echo "pending state cleared"
SLOT="$(readlink -f "$DKG_HOME/releases/current")"
test -f "$SLOT/packages/node-ui/dist-ui/index.html" && echo "Node UI static bundle ready"
```

## 9) Rollback

If issues are detected:

```bash
dkg rollback
readlink "$DKG_HOME/releases/current"
cat "$DKG_HOME/releases/active"
```

Then start node again:

```bash
dkg start
```

## 10) Builder upgrade guides (per release)

Every breaking or builder-impacting release ships a focused upgrade guide alongside the CHANGELOG entry. The guide lives at `docs/UPGRADE_<PRIOR>_TO_<NEW>.md` (e.g. `docs/UPGRADE_RC11_TO_RC12.md`).

A good upgrade guide:

- Opens with an agent-prompt template builders can paste into Cursor / Claude Code / Codex CLI / any AGENTS.md-honouring tool to drive the migration end-to-end.
- Includes a breaking-change matrix at the top so a reader can grep for what affects them in 30 seconds.
- Provides mechanical search-and-replace tables for the TS and Solidity surfaces (sed / git-grep examples are fine — most rename work is regex-shaped).
- Documents every economic / contract / wire-format change a downstream caller could trip on, with concrete `tokenAmount`, ABI, and Hub-registration steps.
- Cross-links the relevant `CHANGELOG.md` section for per-PR detail.

Cross-link the new guide from [`docs/RELEASE.md`](docs/RELEASE.md) § "Upgrading from a prior release" before tagging.

## 11) Promotion policy

Required progression:

1. Merge release-bound PRs to `main` only after review feedback and CI failures are resolved.
2. Run the comprehensive devnet test suite on `main`.
3. Publish a canary/prerelease to `testnet` and pass the testnet smoke test.
4. Publish/promote the stable version to `mainnet` only after the testnet smoke test passes.
5. Run the mainnet smoke test and final package/channel validation (`pnpm release:verify-published ...`).
