# Auto-Update Local Testing (Practical Runbook)

This runbook is for validating blue-green auto-update on your local machine before merge.

## 0) Use an isolated DKG home

```bash
export DKG_HOME="$HOME/.dkg-autoupdate-test"
rm -rf "$DKG_HOME"
```

## 1) Build and install from current branch

From repo root:

```bash
pnpm --filter @dkg/cli build
DKG_HOME="$DKG_HOME" ./install.sh
```

## 2) Configure auto-update

```bash
DKG_HOME="$DKG_HOME" dkg init
```

When prompted:
- Enable auto-update: `y`
- GitHub repo: your test repo (or `OriginTrail/dkg-v9`)
- Branch: `main` (stable cohort) or `pre-release` (canary cohort)
- Allow pre-release versions: `n` for stable nodes, `y` for canary nodes

## 3) Verify baseline state

```bash
readlink "$DKG_HOME/releases/current"
cat "$DKG_HOME/releases/active"
cat "$DKG_HOME/.current-commit" 2>/dev/null || true
cat "$DKG_HOME/.current-version" 2>/dev/null || true
```

## 4) Test checks and updates

### Branch/ref check only

```bash
DKG_HOME="$DKG_HOME" dkg update --check
```

### Target a specific released version

```bash
DKG_HOME="$DKG_HOME" dkg update 9.0.5 --check
DKG_HOME="$DKG_HOME" dkg update 9.0.5
```

### Test pre-release gating

```bash
# Expected: blocked if allowPrerelease=false
DKG_HOME="$DKG_HOME" dkg update 9.0.6-rc.1

# Expected: allowed only when explicitly enabled
DKG_HOME="$DKG_HOME" dkg update 9.0.6-rc.1 --allow-prerelease
```

### If local/dev tags are unsigned

Tag updates verify signatures by default. For local testing:

```bash
DKG_HOME="$DKG_HOME" dkg update 9.0.5 --no-verify-tag
```

## 5) Validate swap and metadata after each update

```bash
readlink "$DKG_HOME/releases/current"
cat "$DKG_HOME/releases/active"
cat "$DKG_HOME/.current-commit"
cat "$DKG_HOME/.current-version"
test ! -f "$DKG_HOME/.update-pending.json" && echo "pending state cleared"
```

## 6) Rollback test

```bash
DKG_HOME="$DKG_HOME" dkg rollback
readlink "$DKG_HOME/releases/current"
cat "$DKG_HOME/releases/active"
```

## 7) Canary rollout recommendation

- Stable nodes:
  - branch: `main`
  - allow prerelease: `false`
- Canary nodes:
  - branch: `pre-release`
  - allow prerelease: `true`

Keep at least one canary node per environment before promoting to stable.
