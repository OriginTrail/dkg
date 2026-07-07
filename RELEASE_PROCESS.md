# DKG Release Process

This document defines the release and rollout workflow for the blue-green auto-update system.

## 1) Source of truth and branch flow

- Work is merged to `main` via pull requests.
- Release tags are created from commits already on `main`.
- Nodes update either:
  - by branch/ref (`dkg update`), or
  - by explicit version (`dkg update <version>`).

To land current work on `main`:

1. Ensure PR branch is up to date and CI green.
2. Get review approval.
3. Merge the PR into `main` (squash/rebase/merge per repo policy).
4. Create the release tag from the chosen `main` commit.

## 2) Versioning and tag naming (SemVer)

Use `v`-prefixed tags:

- Beta: `v9.0.0-beta.1`, `v9.0.0-beta.2`, ...
- Release candidate: `v9.0.0-rc.1`, `v9.0.0-rc.2`, ...
- Stable: `v9.0.0`, `v9.0.1`, ...

Rule: a stable release tag (`vX.Y.Z`) should only be created for production-ready builds.

## 3) Package version alignment

This is a **single-version monorepo**: every workspace `package.json` moves in lockstep to the release version. Before tagging, bump the `version` field in **all** of them — the root (`dkg-v10`) plus every `packages/*` (~20 files, including the two private packages, so the workspace stays aligned). Internal dependencies use `workspace:*`, which pnpm rewrites to the concrete version at publish time, so a partial bump would ship a skewed dependency graph.

They are all aligned today, so a scoped find-and-replace is safe:

```bash
# review, then bump (macOS sed shown; drop the '' on GNU/Linux)
grep -rl '"version": "<OLD>"' package.json packages/*/package.json
sed -i '' 's/"version": "<OLD>"/"version": "<NEW>"/' package.json packages/*/package.json
git diff --stat   # expect ~20 package.json, version-only
```

A version-only bump does **not** touch `pnpm-lock.yaml` (the lockfile records only third-party versions), so `pnpm install --frozen-lockfile` stays valid. Do the bump on a branch and land it via a reviewed PR (matches every prior release — e.g. #1497 for 10.0.3). CI hard-gates that the flagship `@origintrail-official/dkg` package version equals the tag.

## 4) Pre-release tagging workflow

From repo root:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
git rev-parse --short HEAD
```

Create and push prerelease tag:

```bash
git tag -a v9.0.0-beta.2 -m "DKG v9.0.0 beta 2"
git push origin v9.0.0-beta.2
```

For signed tags (recommended for production-grade verification):

```bash
git tag -s v9.0.0-beta.2 -m "DKG v9.0.0 beta 2"
git push origin v9.0.0-beta.2
```

## 5) Publishing to npm (fully manual)

npm publishing is **fully manual**. There is **no automated npm-publish workflow** — it was removed, because npm's mandatory 2FA/OTP makes token-based CI publishing unworkable and leaving a disabled secret-bearing workflow in the tree is a standing supply-chain liability. The `Release` workflow (`release.yml`) that fires on a tag currently **always fails** at its "structurally signed tag" preflight gate (an `actions/checkout` peeled-ref quirk makes the runner see the annotated tag as a lightweight ref), so it does **not** create a GitHub Release or build the MarkItDown binaries. **Do not wait on CI** — everything below is done by hand.

### 5a) Publish the packages

From a clean checkout at the tagged commit:

```bash
git checkout vX.Y.Z            # detached HEAD at the tag
pnpm install --frozen-lockfile
pnpm build                     # must fully succeed (UI bundle included)
pnpm -r publish --no-git-checks --tag latest
```

npm prompts for your **OTP** (2FA). All publishable packages publish in one command; the private packages (`@origintrail-official/dkg-evm-module`, `@origintrail-official/dkg-network-sim`) are skipped automatically. `pnpm` skips versions already on the registry, so a re-run after a partial publish is safe. For a prerelease, publish under `--tag rc` / `beta` / `alpha` and **skip 5b**.

### 5b) Move the network dist-tags (production promotion)

`--tag latest` only sets `latest`. Node auto-update channels + SDK pins follow the `mainnet` (Base / Gnosis / NeuroWeb) and `testnet` dist-tags, which are carried on **every** published package — so move them on all of them, not just the flagship. In zsh:

```zsh
PKGS=(${(f)"$(node -e 'const fs=require("fs");const files=["package.json",...fs.readdirSync("packages").map(d=>"packages/"+d+"/package.json").filter(f=>fs.existsSync(f))];for(const f of files){try{const p=JSON.parse(fs.readFileSync(f,"utf8"));if(p.name&&p.name.startsWith("@origintrail-official/")&&p.private!==true)console.log(p.name);}catch(e){}}')"})
OTP=<fresh 2FA code>
for p in $PKGS; do for t in mainnet testnet; do npm dist-tag add "$p@X.Y.Z" "$t" --otp=$OTP; done; done
```

One OTP covers the batch; a TOTP code can expire mid-loop, so if some fail, re-run with a fresh code (`npm dist-tag add` is idempotent). Moving `mainnet` is the **production go-live** — do it only after 5a is verified.

### 5c) Create the GitHub Release (manual)

Because `release.yml` does not create it, make the Release by hand from the signed tag, with notes taken from the matching `CHANGELOG.md` section (theme header, npm + channel line, PR-tagged bullets, a `compare/vPREV...vNEW` link):

```bash
gh release create vX.Y.Z --repo OriginTrail/dkg --verify-tag \
  --title vX.Y.Z --notes-file <notes.md> --latest
```

Use `--latest=false` when back-filling an older version so it doesn't steal the "Latest" badge. The MarkItDown binaries are not attached (the workflow that builds them fails); the published `@origintrail-official/dkg` postinstall downloads them best-effort, so `npm i` is unaffected if they're absent.

### 5d) Verify

```bash
npm view @origintrail-official/dkg version        # X.Y.Z
npm view @origintrail-official/dkg dist-tags      # latest / mainnet / testnet = X.Y.Z
gh release view vX.Y.Z --repo OriginTrail/dkg
```

## 6) Node update policy

- Stable cohort:
  - follow stable tags/branch
  - `allowPrerelease=false`
- Canary cohort:
  - allowed to run beta/rc versions
  - `allowPrerelease=true`

Update commands:

```bash
dkg update --check
dkg update 9.0.0-beta.2 --check
dkg update 9.0.0-beta.2 --allow-prerelease
```

Tag verification:

- Default for tag updates is verify-on.
- For local/dev unsigned tags only, use:

```bash
dkg update 9.0.0-beta.2 --allow-prerelease --no-verify-tag
```

## 7) Post-update verification

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

## 8) Rollback

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

## 9) Builder upgrade guides (per release)

Every breaking or builder-impacting release ships a focused upgrade guide alongside the CHANGELOG entry. The guide lives at `docs/UPGRADE_<PRIOR>_TO_<NEW>.md` (e.g. `docs/UPGRADE_RC11_TO_RC12.md`).

A good upgrade guide:

- Opens with an agent-prompt template builders can paste into Cursor / Claude Code / Codex CLI / any AGENTS.md-honouring tool to drive the migration end-to-end.
- Includes a breaking-change matrix at the top so a reader can grep for what affects them in 30 seconds.
- Provides mechanical search-and-replace tables for the TS and Solidity surfaces (sed / git-grep examples are fine — most rename work is regex-shaped).
- Documents every economic / contract / wire-format change a downstream caller could trip on, with concrete `tokenAmount`, ABI, and Hub-registration steps.
- Cross-links the relevant `CHANGELOG.md` section for per-PR detail.

Cross-link the new guide from [`docs/RELEASE.md`](docs/RELEASE.md) § "Upgrading from a prior release" before tagging.

## 10) Promotion policy

Recommended progression:

1. `beta.N` on canary nodes
2. `rc.N` on wider non-critical cohort
3. stable `vX.Y.Z` for full rollout

Promote only after successful:

- automated tests
- isolated local update run
- canary network runtime validation
- release-asset verification (`markitdown-*` binaries present on the GitHub Release)
