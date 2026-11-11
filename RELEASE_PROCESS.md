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

- Canary: `v10.0.0-canary.1`, `v10.0.0-canary.2`, ...
- Beta: `v10.0.0-beta.1`, `v10.0.0-beta.2`, ...
- Release candidate, only once the build is intended to be final: `v10.0.0-rc.1`, `v10.0.0-rc.2`, ...
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

Create and push the canary/prerelease tag from the devnet-validated `main` commit. Tags **must be signed** (`git tag -s`): the `release:verify-tag` publish preflight in §6a rejects any tag without a PGP/SSH signature block, so an unsigned `git tag -a` tag cannot be published — it fails the release run at the first step.

```bash
git tag -s v10.0.0-canary.1 -m "DKG v10.0.0 canary 1"
git push origin v10.0.0-canary.1
```

## 6) Publishing to npm (fully manual)

npm publishing is **fully manual**. There is **no automated npm-publish or tag-triggered release workflow**: npm's mandatory 2FA/OTP makes token-based CI publishing unworkable, and the old GitHub Release workflow was removed so the repository does not carry two competing release paths. Everything below is done by a maintainer from a clean checkout of the signed tag.

### 6a) Prepare and certify immutable package bytes

Use Node 22 and the repository-pinned pnpm. Docker must be available. Day-to-day
implementation PRs target `testnet-canary` per `.github/CONTRIBUTING.md`; real
release authorization still requires the signed tag on `main` described above.
A local rehearsal uses the candidate's **existing version**, without a tag,
version bump, npm credentials, public publication or channel mutation.

From a clean commit (keep output directories outside the checkout):

```bash
COMMIT=$(git rev-parse HEAD)
VERSION=$(node -p "require('./package.json').version")
BUNDLE=/tmp/dkg-package-set-unique
ATTEMPT=/tmp/dkg-package-attempt-unique
node scripts/release-packages.mjs prepare-packages --version "$VERSION" --out "$BUNDLE"
pnpm release:certify-install --bundle "$BUNDLE" --commit "$COMMIT" --version "$VERSION" \
  --profile installed-local-rdf-v1 --out "$ATTEMPT"
pnpm release:verify-package-certificate --bundle "$BUNDLE" --certificate "$ATTEMPT/receipt.json" \
  --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1
```

Preparation owns a **new** directory. It performs frozen dependency installation,
the full UI-inclusive build, version/runtime-guard checks, unconditional CLI asset
materialization, and `pnpm pack` on every package from the existing public-package
discovery. `pnpm pack` rewrites workspace dependencies; `npm pack` is not an
interchangeable substitute. Actual tarball manifests are checked for escaped
workspace/link/local-file references and exact internal versions. Private
build-only workspaces may appear as rewritten development dependencies; runtime,
optional and peer dependencies must resolve within the public prepared set. The compiler
stamps build identity once during the build; preparation retains that stamp.
Later commands never regenerate it. Its historical `distTag: monorepo` field is
build provenance, **not the deployed channel**. npm dist-tags remain deployment
metadata and can change without changing the tarball.

`manifest.json` schema 1 records the full source commit, tracked-input digest,
lockfile/config hashes and copies, actual tools, full expected package set and
relationships, per-tarball byte size/SHA-256/SHA-512 integrity, packaged file
hashes, asset contract, compiler identity, lockfile baseline, family pin policy
and build/install/pack elapsed milliseconds. `packageSetDigest` is SHA-256 of UTF-8
JSON with object keys recursively sorted, no whitespace, array order preserved,
and the top-level `packageSetDigest` field omitted. This certifies the actual
bytes; it does not claim reproducibility across machines. Tracked source must
remain clean and unchanged across preparation; ignored generated build outputs
are allowed. Uncommitted source cannot produce a certifying bundle.

Certification installs the CLI into both an empty Core-style hoisted release slot
and an actual `npm install --global --prefix` Edge prefix, with fresh homes,
caches and npm configuration. Lifecycle scripts and native setup remain enabled.
A disposable registry overlay serves candidate tarballs and refuses all fallback
for `@origintrail-official/*`, including public packages at the same version.
Unrelated dependencies use the npm registry upstream. Both physical dependency
trees, npm's full `ls` output, versions, available integrities and explicit
permitted non-family drift from pnpm are retained. Global npm does not emit a lockfile: the observer hashes candidate archives
actually fetched into the fresh npm cache and retains the archive index; local
installs also use npm's hidden lockfile. Every installed internal file
must match its prepared tarball. The current libp2p family must have exactly one
copy of each pinned version. These pins do **not** freeze unrelated transitives.

The installed product container never mounts the checkout, workspace modules or
build outputs. Before runtime execution it is disconnected from the install
network and attached only to an internal Docker network. Its sole fixture gateway
then exposes only an owned local Hardhat chain started through the existing chain
harness. The shipped testnet genesis overlay is read unchanged, with relay and
bootstrap access disabled, all RPC/wallet endpoints explicitly set to the local
fixture, and auto-update/telemetry disabled. No public network is joined. Each layout declares these required cases before execution: `install`,
`dependency-policy`, `cli-identity`, `runtime-assets`, `daemon-status`,
`rdf-readback`, `graceful-restart`. The CLI binary, UI/config/helper assets,
`/api/status`, an editable RDF draft (`finalize: false`) written/queried through
public APIs, and graceful restart
with the same data directory are checked. No store override is applied: this
profile exercises the default persistent `oxigraph-worker` store. Both layouts
run a single edge-role daemon; layout coverage is not a multi-role topology test.

Every attempt gets a fresh ID and directory; failed attempts are never rewritten
to PASS. `receipt.json` binds the package digest, subject, tool revision,
OS/architecture/Node/npm, layouts, required cases, tree digests, times and hashed
reports/logs, including both raw query responses. In CI it also records workflow/run/attempt. `FAIL` means an observed
case failed; `INCOMPLETE` means execution or evidence is incomplete. Missing,
skipped, cancelled, timed-out and zero-case reports cannot pass. The read-only
verifier accepts the intended commit/version/profile from the caller and derives
the expected package/asset/pin policy from that candidate checkout, rather than
trusting the receipt's own subject. Paths inside portable evidence are relative.
This local consistency check is **not cryptographic proof of who executed it**;
retain authenticated Actions artifacts for CI runs. There is no new signing PKI.

Global npm installs do not produce a lockfile. The versioned `npm10-cacache19-v1`
adapter reads the fresh installer's bundled cacache 19 through npm 10 and hashes
the fetched candidate archives; its exact npm/cacache versions are recorded and
verified in each report. This is an explicit tooling dependency on the pinned
container image. A different npm/cache major requires an adapter compatibility
update and a new rehearsal. Cache acquisition and record interpretation are
separate from installed-tree policy validation.

Exercise the actual installation boundary with a separate negative attempt:

```bash
pnpm release:certify-install --bundle "$BUNDLE" --commit "$COMMIT" --version "$VERSION" \
  --profile installed-local-rdf-v1 --out /tmp/dkg-negative-unique --negative-control missing-ui
# Expected: nonzero exit and FAIL receipt, after deleting the installed UI index.
```

Logs and diagnostic data survive failures; owned containers, networks and chain
processes are stopped. SIGINT/SIGTERM cancel active commands, attempt every owned
resource cleanup and retain an `INCOMPLETE` receipt; cleanup errors are recorded.
Final verification checks a prospective PASS receipt in memory; only successful
verification permits atomically replacing the durable INCOMPLETE receipt with PASS.
The initial receipt is written before execution, so SIGKILL or host loss also
leaves non-passing evidence, but cannot guarantee cleanup. Inspect resources
named `dkg-cert-<receipt.runId>-*` after a forced termination. `*-data/` contains disposable local wallet keys and is
local diagnosis only: exclude it from uploads. Portable evidence is the complete
bundle plus attempt top-level JSON/JSONL/log files. The separately named
`package-certification.yml` workflow runs automatically on every push to `main`,
including release PR merges, and certifies the exact pushed commit. It prepares
the full package set, certifies both installation layouts, verifies the receipt,
and runs the missing-UI negative control. Package bytes and attempt evidence are
uploaded for 14 days, including evidence from failed attempts, with no npm
credentials or publication. A failed run marks that commit's certification check
as failed; it does not undo the merge or automatically promote a release.

Maintainers can also dispatch a manual rehearsal for a full candidate SHA once
the workflow reaches the default branch. The workflow does not run on unrelated
PRs. Both automatic and manual runs use the selected SHA consistently for checkout,
certification, verification and artifact naming. This post-merge check does not
change the immutable planner, required checks or branch protections.
Required script tests continue through `pnpm test:scripts`; any activation as a
required candidate gate needs a separately reviewed trusted-controller pin/route
update and maintainer branch-protection decision.

### 6a.1) Verify the complete release decision

Package installation alone does not qualify promotion. Before changing a dist-tag,
assemble a portable `decision.json` next to all harness `suite-state.json`
attempts (and the downloaded nightly receipt, when the decision names a nightly
run), then run:

```bash
pnpm release:verify-evidence --bundle "$BUNDLE" --certificate "$ATTEMPT/receipt.json" \
  --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1 \
  --evidence "$EVIDENCE/decision.json"
```

Promotion completes fresh authenticated CI history and artifact acquisition before asking for an OTP. Immediately after the prompt, it rechecks the installed-package certificate, decision bytes and every local evidence receipt against that qualified snapshot before the first registry write. This local check performs no GitHub requests; changed evidence requires a new qualification. CI history is qualified as of the pre-prompt acquisition, not continuously monitored while the maintainer enters a code.

The version-1 decision has these fields (full object IDs and SHA-256 file hashes
are required; placeholders below are explanatory and cannot certify):

```json
{
  "schemaVersion": 1,
  "candidate": {
    "commit": "<final product commit>", "tree": "<git tree>", "version": "<version>",
    "sourceInputsDigest": "<manifest source input digest>", "packageSetDigest": "<manifest package set digest>"
  },
  "ci": { "runId": "<successful CI run>", "attempt": 1 },
  "nightly": {
    "runId": "<successful full nightly run>", "attempt": 1,
    "receipt": { "file": "nightly-profile-summary.json", "sha256": "<file hash>" }
  },
  "harness": {
    "commit": "<full harness commit>", "profile": "local-release-v1",
    "attempts": [{ "id": "qualification-1", "receipt": { "file": "qualification-1/suite-state.json", "sha256": "<file hash>" } }]
  },
  "priorCiFailures": []
}
```

The `nightly` entry is optional. Leave it out (or set it to `null`) to release on
the CI run and the harness profile alone: `release:verify-evidence` then reports
`"nightly": null`, and promotion logs that the evidence names no nightly run. A
decision that names a nightly run must name it completely, and that run is
checked in full as described below.

Use the integrated harness profile from OriginTrail/dkg-blackbox-harness #47.
It requires eight registration/policy cells, eight functional scenarios and the
overlap leg, all with verified builds and successful process/run identities.
Keep raw child runs with suite-state. The release helper verifies their recorded
contract and identities; local harness evidence still relies on the trusted
operator/executor, like locally produced package certificates. It is not a
cryptographic attestation that an arbitrary operator ran the tests.

The helper queries GitHub using `gh` credentials: CI must be complete/successful
on the final commit. When the decision names a nightly run, its receipt must
byte-match the authenticated `nightly-profile-summary` artifact of the latest run
attempt, and the helper recomputes the nightly completeness check (all seven browser shards, mandatory lifecycle cases
and 1,000 property trials). Deleted/expired artifacts are a qualification gap;
archive them before the workflow retention expires, and re-run if the online
source required for verification is no longer available.

Every failed CI attempt found for that commit must appear in `priorCiFailures`
with `runId`, `attempt`, `classification` (`product`, `test`, `environment` or
`unknown`), an owning GitHub `issue`, and a later successful
`supersededBy: {runId, attempt}` matching the selected CI run (or the nightly run,
when the decision names one). Keep every
local harness attempt in order. A failed attempt requires
`resolution: {classification, issue, supersededBy}`; classification is `product`,
`test`, `environment` or `unknown`, and supersededBy identifies a later complete
passing harness attempt. A failure cannot be dismissed solely by relabeling it.
Local attempt history is operator supplied; the verifier does not claim to
discover unarchived private runs.

Selected CI must be a successful push, scheduled or dispatched run of the
candidate itself. Pull-request and merge-queue runs are ineligible here: GitHub's
API head SHA alone does not prove the synthetic merge tree they checked out.
The same complete dispatched nightly may satisfy both CI and nightly entries.

Promotion and direct `latest`/`mainnet` publication require `--evidence`, including
dry-runs. Canary publication can precede qualification. The package, registry and
signed-tag checks still apply. A new candidate requires fresh receipts at its
exact commit; this first implementation does not reuse receipts across equal
trees. Run `pnpm qa:check-regressions` and `pnpm qa:incident-status` to inspect
proven detectors and explicitly unresolved incident gaps before the human release
decision. Archive the decision, package bundle/certificate and raw campaign
records with the release; credentials and OTPs must not enter those artifacts.

### 6b) Publish the same bytes, verify the registry, then promote manually

After the existing devnet gate and signed-tag policy are satisfied, use the same
bundle/receipt. A real publication requires `v$VERSION` to resolve to exactly
`$COMMIT`, be signature-bearing and unchanged on origin, and be reachable from
`origin/main`. Local preparation/certification does not require registry existence.
Post-publication integrity checks are separate, so the gate is not circular.

```bash
# Dry run still verifies bytes, certificate, authorization and registry metadata.
pnpm release:publish-prepared --bundle "$BUNDLE" --certificate "$ATTEMPT/receipt.json" \
  --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1 \
  --tag "v$VERSION" --dist-tag canary --dry-run
# Repeat without --dry-run when authorized. npm can prompt for OTP; alternatively
# provide NPM_CONFIG_OTP in the maintainer's environment. Logs never echo it.
pnpm release:publish-prepared --bundle "$BUNDLE" --certificate "$ATTEMPT/receipt.json" \
  --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1 \
  --tag "v$VERSION" --dist-tag canary
pnpm release:verify-published --bundle "$BUNDLE" --commit "$COMMIT" --version "$VERSION" \
  --profile installed-local-rdf-v1 --tags canary
# Promotion reads every package's dist-tags first, then asks for one npm
# one-time code (typing is hidden) and moves every remaining tag with it.
# --otp or NPM_CONFIG_OTP skips the question; --dry-run shows the plan only.
pnpm release:promote --bundle "$BUNDLE" --certificate "$ATTEMPT/receipt.json" \
  --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1 \
  --tag "v$VERSION" --tags testnet --evidence "$EVIDENCE/decision.json"
```

Choose `latest` only for the stable release at the existing human-controlled
release stage; this procedure does not move it earlier. Move `mainnet` with the
same promotion command **only after** the existing testnet/functional release
gates. Package-smoke PASS is additional evidence, never a replacement for
comprehensive devnet, testnet or mainnet acceptance. This profile does not certify
crash durability, previous-version upgrades, multi-peer sharing, every platform,
or distributed/network readiness.

Source cleanliness includes comparing every tracked file with its Git blob in the
claimed commit, independently of index flags and content filters. Preparation also
checks that tracked contents remain unchanged through building and packing. Ignored
generated outputs remain permitted.

Publication passes the exact manifest-bound tarball paths to npm, never workspace
directories. Before its first mutation it verifies every existing registry
version's `dist.integrity`; a matching version can be reused after partial
publication, but a same-version integrity mismatch aborts the entire operation.
Publication orders internal runtime dependencies before their consumers, so an
exposed CLI tag never depends on candidate packages still awaiting publication.
Cycles fail before mutation. Dry-run and execution use the same ordered plan.
Promotion requires all versions to exist with matching integrity before its first
tag update. It then reads every package's dist-tags and plans only the tags not on
the version yet, reporting how many already are. Only after those reads does it
ask for the one-time code, so the code is fresh when the writes start; it asks in
a terminal, unless `--otp` or `NPM_CONFIG_OTP` supplies one. npm runs with stdin
closed, so it cannot fall back to its web authentication prompt, and receives the
code in its environment, never its arguments. The first write goes alone, so a
stale or mistyped code is refused once; then eight packages are written at a time,
each package's tags in sequence (two writes to one package's dist-tags at once can
fail with E409 Conflict). On a stale code (EOTP) or a rate limit (E429) no new write
starts, and the command reports what moved and what to do: take a fresh code, or
wait about ten minutes. It then reads the registry again and lists every tag still
not on the version, because npm has accepted tag writes before that never showed.
Both paths recheck package/evidence bytes immediately before mutation.
Cross-package changes are **not atomic**: failures report exact completed/reused
packages and tags, and re-running promotion after the complete integrity preflight
moves only the tags still missing. Dry-run performs reads only, asks for no code
and never prints OTPs or registry credentials. The supported wrapper cannot prevent
a credential holder bypassing it with direct npm commands.

### 6c) Create the GitHub Release (manual)

Because there is no tag-triggered release workflow, make the Release by hand from the signed tag. **This section owns GitHub Release note generation.** The notes are the matching `CHANGELOG.md` section copied *verbatim* — including its `### Upgrading from <PRIOR>` matrix, if §10 put one there — with only fixed metadata added around it. Do not reword, reorder, or drop bullets while assembling; if the notes need to say something the CHANGELOG does not, fix the CHANGELOG first so the two cannot drift.

Assemble `notes.md` as:

1. A `# DKG vX.Y.Z` title line.
2. The CHANGELOG section body verbatim, minus its own `## [X.Y.Z] - DATE` heading.
3. An npm + channel line directly under the theme paragraph: ``**npm:** `@origintrail-official/dkg@X.Y.Z` — dist-tags `latest`, `testnet`, `mainnet``, naming only the tags this release actually moved.
4. A closing `**Full changelog:** https://github.com/OriginTrail/dkg/compare/vPREV...vX.Y.Z` link.

```bash
gh release create vX.Y.Z --repo OriginTrail/dkg --verify-tag \
  --title vX.Y.Z --notes-file <notes.md> --latest
```

Use `--latest=false` when back-filling an older version so it doesn't steal the "Latest" badge. MarkItDown binaries are not attached by this manual process; the published `@origintrail-official/dkg` postinstall downloads them best-effort, so `npm i` is unaffected if they're absent.

### 6d) Verify and smoke test

```bash
pnpm release:verify-published --bundle "$BUNDLE" --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1 --tags latest,mainnet
# prerelease example:
pnpm release:verify-published --bundle "$BUNDLE" --commit "$COMMIT" --version "$VERSION" --profile installed-local-rdf-v1 --tags canary,testnet
gh release view vX.Y.Z --repo OriginTrail/dkg
```

After the `mainnet` dist-tag moves, update at least one mainnet node, execute the mainnet smoke test, and validate `/api/status` reports the expected version, commit, dist-tag, and package build metadata.

## 7) Node update policy

- Stable cohort:
  - follow stable tags/branch
  - `allowPrerelease=false`
- Canary cohort:
  - allowed to run canary/beta/rc versions
  - `allowPrerelease=true`

Update commands:

```bash
dkg update --check
dkg update 10.0.0-canary.1 --check
dkg update 10.0.0-canary.1 --allow-prerelease
```

Tag verification:

- Default for tag updates is verify-on.
- For local/dev unsigned tags only, use:

```bash
dkg update 10.0.0-canary.1 --allow-prerelease --no-verify-tag
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

### 8a) Watch the rollout

A node can pass the checks above within minutes and still need more than an hour to catch up, so keep watching a mainnet rollout until it settles.

All of these checks are read-only:

- **When to check.** At about 20 min, 45 min and 2 h after the first node updates.
- **What to check.** On every node: version and commit, restarts and out-of-memory kills, errors since the update, the memory trend, and the catch-up counters from #2063 once they exist.
- **How to read trends.** Judge them on full 10-minute windows over at least 30 minutes. Catch-up noise can ease and then peak again, so one quiet window doesn't mean it has ended.
- **Rotated logs.** Read rotated log files too. Heavy logging can rotate a log within hours and hide the update line.
- **Lines that are normal during catch-up.** On their own, these don't point to a regression, and they stop when catch-up ends:
  - `Deferring durable sync at CG <graph> due to local backpressure`, or a `Sync backpressure rejected` summary: the graph waits for a free sync slot.
  - `Network identity probe for <peer> failed retryably`: recovery asked a peer it can't reach and moves on to other peers.
  - `Poll lane collectionUpdates` with `Store scheduler queue wait timeout`, a few per node: the lane scans that range again on a later poll.
- **When it's settled.** Call the rollout settled at 2 h, or later if a node is still catching up. Treat anything else these checks find, or one of these lines that continues after catch-up has ended, as a possible regression (§9 covers rollback).

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

Every breaking or builder-impacting release ships upgrade guidance alongside the CHANGELOG entry. Scale the artifact to the migration:

This section defines **when** upgrade guidance is required and **where it is written**. §6c owns how it reaches the GitHub Release: it copies the matching CHANGELOG section verbatim, so anything placed in that section ships to builders automatically and the two cannot drift.

**Small migrations (a handful of discrete changes) — default.** Put an `### Upgrading from <PRIOR>` section directly in the release's `CHANGELOG.md` entry, immediately after the theme paragraph, as a `Change | Impact | Action` matrix. No standalone document is required.

**Large migrations (mass renames, contract/ABI changes, economic changes).** Write a standalone guide at `docs/release-notes/<version>.md` (e.g. `docs/release-notes/v10-1-0.md`) and link it from the `### Upgrading from <PRIOR>` section. One file per release, never a growing shared file: shipped notes are immutable, per-release files stay directly linkable from the CHANGELOG and the GitHub Release, and they do not conflict on every release. A good standalone guide:

- Opens with an agent-prompt template builders can paste into Cursor / Claude Code / Codex CLI / any AGENTS.md-honouring tool to drive the migration end-to-end.
- Includes a breaking-change matrix at the top so a reader can grep for what affects them in 30 seconds.
- Provides mechanical search-and-replace tables for the TS and Solidity surfaces (sed / git-grep examples are fine — most rename work is regex-shaped).
- Documents every economic / contract / wire-format change a downstream caller could trip on, with concrete `tokenAmount`, ABI, and Hub-registration steps.
- Cross-links the relevant `CHANGELOG.md` section for per-PR detail.

**Keep release notes out of GitBook.** GitBook syncs the `docs/` tree and builds its navigation from `docs/SUMMARY.md`, so a file under `docs/` that is **not** listed in `SUMMARY.md` is not published. `docs/release-notes/` must stay unlisted, matching `docs/reports/`, `docs/rfcs/`, and `docs/adr/`, which already live in `docs/` outside the navigation. Do not add a `SUMMARY.md` entry when adding a release-notes file.

This document is the authoritative release runbook. Superseded V9-era material — the old `RELEASE.md` runbook and the rc-line `UPGRADE_RC11_TO_*.md` guides — is retained under `docs/archive/internal/` for history only and should not be followed or extended.

## 11) Promotion policy

Required progression:

1. Merge release-bound PRs to `main` only after review feedback and CI failures are resolved.
2. Run the comprehensive devnet test suite on `main`.
3. Publish a canary/prerelease to `testnet` and pass the testnet smoke test.
4. Publish/promote the stable version to `mainnet` only after the testnet smoke test passes.
5. Run the mainnet smoke test and final package/channel validation (`pnpm release:verify-published ...`).

### Builder documentation release checks

Run the [documentation checks and released-package smoke](scripts/docs/README.md) for the release candidate. Refresh `scripts/docs/capabilities.json`, including source-only features becoming available. Verify the representative builder and agent workflows and record any unexecuted checks explicitly. After the normal reviewed promotion, verify GitBook navigation and `llms.txt`; a repo merge alone is not proof that the site updated. Keep validation reports out of `docs/SUMMARY.md`.
