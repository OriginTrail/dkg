---
status: deprecated
version: v10
audience: human+agent
doc_type: how-to
---

> **Applies to `10.0.0-rc.11` and earlier.** The `dkg migrate-to-npm` command was removed in `10.0.0-rc.17`. On current releases the git-checkout → npm migration runs automatically on the first `dkg start`, so this manual procedure is no longer needed. Keep this page only for operators running a node pinned to rc.11 or older.

# Migrate a git-checkout install to the npm-pinned auto-update path

This guide is for operators currently running a DKG node from a `git clone`d checkout (typical layout: `~/dkg/` with `.git`, `packages/`, `node_modules/`, `pnpm-lock.yaml`, `package.json`). It walks through converting that install to use the npm-pinned auto-update path without re-installing.

The end-state: the daemon's auto-updater fetches pre-built artifacts of a specific `@origintrail-official/dkg` version from npm into `~/.dkg/releases/{a,b}/`, instead of building from source against the tracked git branch on every update cycle.

## Why migrate

The build-from-source auto-update path (active when the CLI detects a monorepo checkout) is fragile for long-running production daemons:

- **It runs `tsc` + dependent build steps on every update**, exposing the daemon to any regression that lands on the tracked branch between two polling cycles. A previous release retrospective for beacon-01 traced a shutdown deadlock to exactly this pattern: a regression merged to `main`, the next auto-update cycle built it, and the deadlock fired on the worker's first SIGTERM.
- **It is harder to pin to a known-good version.** With the npm path, the operator can set `autoUpdate.npmVersion = "10.0.0-rc.11"` (or just track `latest`) and know exactly what they'll get. With the git path, "latest" means "whatever `main` happens to look like at polling time".
- **It pulls a much larger dependency surface.** `pnpm install --frozen-lockfile` for the full monorepo runs hardhat, the EVM module's solidity tooling, and all dev dependencies. The npm path installs only the `production` dependency set.

## What the migration actually does

The `dkg migrate-to-npm` subcommand performs two changes:

1. **Renames `<repoRoot>/package.json`** to `<repoRoot>/package.json.pre-npm-migration-<timestamp>`.
   This is the **load-bearing** change. The auto-updater calls `findPackageRepoDir()` (in `packages/core/src/blue-green.ts`), which walks the directory tree looking for the marker pair `package.json + packages/`. Renaming `package.json` is sufficient to break that walker; the walker then returns `null`, `isStandaloneInstall()` returns `true`, and the auto-updater routes through `performNpmUpdate` on the next polling cycle.
2. **Renames `<repoRoot>/.git`** to `<repoRoot>/.git.pre-npm-migration-<timestamp>`.
   This is **cosmetic** — the walker doesn't look at `.git`. We rename it anyway because (a) it eliminates the operator-confusion failure mode (the original incident driver: operator sees `.git`, runs `git pull` thinking that's how updates work, fork happens), and (b) it prevents stray cron jobs or CI that watch for `.git` from doing anything unexpected.
3. **Writes `autoUpdate.source = "npm"`** into `~/.dkg/config.json`.
   Forward-compat with the `autoUpdate.source` config flag (PR #659). Until that flag merges this is silently ignored. Once it merges, this becomes the explicit pin and the renames in steps 1–2 become belt-and-braces.

### What the migration does NOT touch

- **`packages/` and `packages/cli/dist/`.** The operator's `dkg` PATH symlink typically points into this tree. Renaming would break the ability to invoke `dkg` at all until the operator runs `npm install -g @origintrail-official/dkg`. The runbook recommends that as a follow-up step (see [Optional cleanup](#optional-cleanup-after-soak) below) once the operator has confirmed the npm-pinned daemon is healthy.
- **`node_modules/` and `pnpm-lock.yaml`.** Same reason — the current `packages/cli/dist/cli.js` runtime resolves modules from this `node_modules/`. Until the operator detaches the `dkg` invocation path, both must stay in place.
- **The blue-green slot tree under `~/.dkg/releases/{a,b}/`.** That is state, not source-tree. The auto-updater manages those slots itself.

## Pre-migration checklist

Before running `dkg migrate-to-npm --apply`:

- [ ] **Note the current commit hash** for rollback reference: `curl -s http://localhost:<api-port>/api/status | jq '.commit, .version'`.
- [ ] **Back up `~/.dkg/config.json`**: `cp ~/.dkg/config.json ~/.dkg/config.json.pre-migration`.
- [ ] **Back up `~/.dkg/` state** if you have anything worth preserving (decryption keys, custom agents, etc.). The migration does not touch `~/.dkg/`, but a snapshot before any operational change is good hygiene: `tar -czf ~/dkg-state-backup-$(date +%s).tar.gz -C ~ .dkg`.
- [ ] **Stop the daemon cleanly**: `dkg stop`. The migration script refuses to mutate the source tree while a worker process holds files open (override with `--force` only if the daemon is already wedged and you've SIGKILLed it manually).
- [ ] **Confirm there is no `~/.dkg-dev/` directory.** If your state lives there (typical for nodes that were originally set up by `pnpm dkg start` inside a fresh monorepo checkout without a pre-existing `~/.dkg/config.json`), the migration script will **hard-refuse** with a state-directory orphan blocker — see [Orphan state-directory handling](#orphan-state-directory-handling) below.

## Step-by-step

### 1. Dry-run

Always start with a dry run. No flags = no mutation:

```bash
dkg migrate-to-npm
```

The output lists each action prefixed by `[LOAD-BEARING]`, `[cosmetic]`, or `[CONFIG]` along with the reason. Read through them. If there are blockers (`✗` lines), resolve them before proceeding.

### 2. Apply

When you're satisfied with the dry-run output:

```bash
dkg migrate-to-npm --apply
```

The command performs the renames in order, then the config write, then prints exact next-step commands.

### 3. Restart and verify

```bash
dkg start
```

Verify the daemon picked up the new install mode:

```bash
curl -s http://localhost:<api-port>/api/status | jq '.installMode // .version'
```

Wait one auto-update polling cycle (`checkIntervalMinutes`, default 30 min). On the first npm-path cycle, the daemon will install a fresh artifact into the inactive blue-green slot:

```bash
ls -la ~/.dkg/releases/
ls -la ~/.dkg/releases/{a,b}/node_modules/@origintrail-official/dkg/package.json
```

You should see one of `a/` or `b/` containing the npm-style layout (`node_modules/@origintrail-official/dkg/`) rather than the old git-style layout (`packages/cli/dist/`).

## Rollback

If something goes wrong before the first auto-update cycle has swapped slots:

```bash
dkg stop
mv ~/dkg/package.json.pre-npm-migration-<timestamp> ~/dkg/package.json
mv ~/dkg/.git.pre-npm-migration-<timestamp> ~/dkg/.git
# Remove or revert autoUpdate.source in ~/.dkg/config.json:
cp ~/.dkg/config.json.pre-migration ~/.dkg/config.json
dkg start
```

The next polling cycle will resume the git-path auto-update.

If the rollback is post-swap (the daemon already wrote an npm-style artifact to a blue-green slot), the rollback above will succeed but the daemon will need one more cycle to re-build the git-style artifact in the OTHER slot. That extra cycle is normal and harmless.

## Orphan state-directory handling

DKG resolves the active state directory (`dkgDir()`) by checking whether the running CLI is inside a monorepo:

- **In a monorepo checkout** AND `~/.dkg/config.json` does not exist → use `~/.dkg-dev/`
- Otherwise → use `~/.dkg/`

After this migration, `findPackageRepoDir` returns `null` (we renamed `package.json`), so the CLI looks at `~/.dkg/`. If your state was in `~/.dkg-dev/`, the migration script detects this and **hard-refuses** (no `--force` override; this case is genuinely unsafe — proceeding would silently make the CLI read from an empty `~/.dkg/` and behave like a fresh install).

The script's blocker message tells you the exact remediation. The two options:

**Option A: Move state.**

```bash
dkg stop
mv ~/.dkg-dev ~/.dkg
dkg migrate-to-npm --apply
dkg start
```

**Option B: Pin DKG_HOME.**

If you prefer to keep state at `~/.dkg-dev/`:

```bash
echo 'export DKG_HOME=$HOME/.dkg-dev' >> ~/.zshrc   # or ~/.bashrc, ~/.config/fish/config.fish, etc.
# Open a NEW shell so the env var is picked up
exec $SHELL -l
dkg migrate-to-npm --apply
```

`DKG_HOME` overrides the auto-resolution unconditionally (rule 1 in `resolveDkgConfigHome`), so the CLI continues to use `~/.dkg-dev/` after migration.

## Daemon-alive bypass (`--force`)

The migration script refuses to mutate the source tree while the daemon is alive, because:

- The worker process holds file descriptors open against `~/dkg/packages/cli/dist/`. A rename mid-flight on POSIX systems is generally safe (the inode survives), but any in-flight write to `package.json` (highly unlikely but possible from a worker auto-update routine) would be lost.
- The next worker spawn would see the renamed tree and behave unexpectedly — the supervisor would either crash or boot from a half-migrated state.

If the daemon is wedged and `dkg stop` doesn't work:

```bash
kill -9 $(cat ~/.dkg/daemon.pid)
dkg migrate-to-npm --apply --force
```

`--force` downgrades the alive-check blocker to a warning. It does NOT bypass the state-directory orphan blocker (that's genuinely unsafe and has no escape hatch).

## Optional cleanup (after soak)

After the migrated daemon has been running healthily for at least a week (long enough to confirm one or two auto-update cycles completed cleanly), you can decouple from the old source tree entirely:

```bash
npm install -g @origintrail-official/dkg
which dkg                              # should now point at the npm-installed binary
dkg --version                          # confirm it matches what's in your blue-green slot
dkg stop
rm -rf ~/dkg/packages ~/dkg/node_modules ~/dkg/pnpm-lock.yaml
dkg start
```

At that point `~/dkg/` contains only the renamed backup files (`.git.pre-npm-migration-...`, `package.json.pre-npm-migration-...`) and is safe to delete entirely.

## Log rotation (cross-cutting recommendation)

Unrelated to this migration but discovered by the same incident retrospective: beacon-01 accumulated **134 MB of `daemon.log` in 24 hours** during a shutdown deadlock, dominated by chain-provider polling spam. Independent of whether you migrate, set up log rotation:

`/etc/logrotate.d/dkg`:

```
/home/<your-user>/.dkg/daemon.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
```

`copytruncate` is required — the daemon does not respond to SIGHUP for log reopening, and renaming the file out from under it would silently lose subsequent writes. A future core-stability fix should reduce chain-provider log spam at the source.
