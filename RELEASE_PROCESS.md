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

## 5) Node update policy

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

## 6) Post-update verification

After each update:

```bash
readlink "$DKG_HOME/releases/current"
cat "$DKG_HOME/releases/active"
cat "$DKG_HOME/.current-commit"
cat "$DKG_HOME/.current-version"
test ! -f "$DKG_HOME/.update-pending.json" && echo "pending state cleared"
```

## 7) Rollback

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

## 8) Promotion policy

Recommended progression:

1. `beta.N` on canary nodes
2. `rc.N` on wider non-critical cohort
3. stable `vX.Y.Z` for full rollout

Promote only after successful:

- automated tests
- isolated local update run
- canary network runtime validation
