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

Before tagging, ensure package versions reflect intended release channel.

Current process keeps these aligned:

- `package.json`
- `packages/cli/package.json`
- `packages/evm-module/package.json`
- `packages/mcp-server/package.json`

## 4) Pre-release tagging workflow

> **Gate:** do not run the tag commands below until the **RC cut checklist
> (§11)** is green. Tagging is the mechanical step at the *end* of a release;
> the checklist is what makes the tag trustworthy. Cutting RCs faster than they
> can be validated is how rc.13 → rc.14 → rc.15 ended up tagged inside two days,
> with rc.14 a same-day emergency for an `eth_getLogs` request storm.

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

## 5) Publishing to npm

After pushing a tag, the GitHub Actions release workflow builds, tests, and creates a
GitHub Release automatically. It also builds and uploads the standalone MarkItDown
binaries for the currently supported node platforms:

- `markitdown-linux-x64`
- `markitdown-darwin-arm64`
- `markitdown-win32-x64.exe`

npm publishing is done manually to keep full control.

From a clean `main` checkout at the tagged commit:

```bash
git checkout v9.0.0-beta.3
pnpm install --frozen-lockfile
pnpm build
pnpm -r publish --no-git-checks --tag latest
```

npm will prompt for your OTP code. All publishable packages in the monorepo are
published in one command. Private packages (`@origintrail-official/dkg-evm-module`,
`@origintrail-official/dkg-network-sim`) are skipped automatically.

The published `@origintrail-official/dkg` package now runs a best-effort postinstall
step that downloads the current-platform MarkItDown binary from the matching GitHub
Release into the installed package `bin/` directory (for example
`node_modules/@origintrail-official/dkg/bin`). Make sure the GitHub Release for the
same version already exists before publishing to npm.

Verify after publishing:

```bash
npm view @origintrail-official/dkg version
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

## 11) RC cut checklist (stabilization gate)

Run this before tagging **every** `beta.N` / `rc.N`. Copy it into the release
tracking issue (or the release PR description) and tick each box on the exact
`main` commit you intend to tag. If a box can't be ticked, the RC is not ready —
fix the cause, don't tag around it.

**Cadence rule (read first):** do **not** cut a new RC while the *previous* RC
still has an open sev-1, an unresolved revert, or has not completed its soak
window. The point of an RC is to be exercised; back-to-back same-day RCs (rc.13
→ rc.15 in two days) mean nothing soaked long enough to surface the next
regression. One RC in flight at a time.

### A. Stabilization (the previous RC earned this one)

- [ ] Previous RC soaked on the canary/devnet cohort for the agreed window
      (default **≥ 48h**) with **no new sev-1**.
- [ ] Every revert and explicit "regression" fix from this window has a
      regression test landed **in the same PR that fixed it** (so it cannot
      silently come back — see the rc.15 "restore SPARQL filterability" and the
      `#904/#905/#913/#915` QA-found UI bugs for what escapes without this).
- [ ] No open sev-1 / data-loss / chain-state issues against the target commit.
- [ ] Rollback verified: `dkg rollback` returns the node to the prior slot
      cleanly (don't discover this during an incident).

### B. Correctness gates (all green on the tagged commit, not "mostly")

- [ ] `ci.yml` green on the exact commit: build, Tornado unit
      (core + storage + chain), Blazegraph live integration, **Kosava node-ui
      Playwright devnet e2e**, and the EVM integration matrix.
- [ ] `pnpm check:file-size` green — no god-file regressions
      (`scripts/audit-file-size.mjs`; budgets in `scripts/file-size-baseline.json`).
- [ ] Deliberately-red PROD-BUG sentinels reviewed against
      `.test-audit/BUGS_FOUND.md` — **no newly-red sentinel** beyond the known
      inventory, and any sentinel that went green is converted to a normal
      passing test.
- [ ] Devnet release-validation run passed for this RC (the
      `scripts/devnet-rc<N>-release-validation.sh` analog), and the validation
      script itself is current — not patched mid-run.

### C. Review hygiene (stop the round-N treadmill)

- [ ] No PR merged into this RC with **unresolved Codex / reviewer threads**.
- [ ] Any PR that needed **≥ 5 review rounds** carries a one-paragraph design
      note (or was re-scoped/split) — 5+ rounds means the design was wrong, not
      that the diff needed more polish. ~17% of this window's commits were
      "address review round N"; that is the cost being controlled here.
- [ ] No PR over ~400 lines of diff merged without an explicit reviewer waiver.

### D. Versioning & release artifacts

- [ ] Package versions aligned for the channel (§3): `package.json`,
      `packages/cli/package.json`, `packages/evm-module/package.json`,
      `packages/mcp-server/package.json`.
- [ ] ABIs regenerated and committed if any Solidity source changed (§7);
      `abi-freshness` CI green.
- [ ] `CHANGELOG.md` curated for the full `<prev>..<this>` range (not a raw
      commit dump).
- [ ] Builder-impacting changes ship an upgrade guide
      `docs/UPGRADE_<PRIOR>_TO_<NEW>.md` (§9), cross-linked from
      `docs/RELEASE.md`.
- [ ] Named **release owner** recorded on the tracking issue, and a one-line
      rollback/abort plan stated.

> **Track the trend, not just the boxes.** The signal that this gate is working
> is the `fix:` vs `feat:` commit ratio falling over successive RCs (it ran
> ~4:1 across rc.8 → rc.15). If it isn't moving, the defects are being created
> upstream of this checklist — reinforce design review and PR sizing, not the
> gate.
