# Edge npm-only update + rollback validation (RFC-41 Bundle B)

This runbook is the operator-facing companion to
`scripts/devnet-test-edge-update.sh` and the vitest harness at
`devnet/edge-update-flow/automated.test.ts`. It closes RFC-41 §6.2:
end-to-end validation of the Edge node `dkg update` + `dkg rollback`
flow against a real `npm install -g` against a real (local) npm
registry, _without_ requiring a Trace Labs NPM publish.

The §6.2 gap exists because automated devnet update testing has been
gated on the prerequisites in §6.5 (Trace Labs publishing a `next`
dist-tag with the Bundle B build). Until that lands, this runbook +
script let any contributor exercise the full flow on their own laptop
against a self-hosted `verdaccio` registry.

## What this validates

Bundle B's contract (RFC-41 §4.7, §4.8):

1. `npm install -g @origintrail-official/dkg@<version>` resolves through
   the registry and installs the global binary at the npm prefix.
2. `dkg --version` reports the installed version.
3. `dkg update <new-version>` runs `npm install -g
   @origintrail-official/dkg@<new-version>`, writes the OLD version to
   `~/.dkg/previous-version`, and the binary reports the new version.
4. `dkg rollback` reads `~/.dkg/previous-version`, runs `npm install
   -g @origintrail-official/dkg@<previous-version>`, and the binary
   reports the previous version. Round-trip lands back on the
   starting version.

What this does **not** validate (separate suites cover these):

- `dkg init --role edge` flow — covered by Bundle B unit tests in
  `packages/cli/test/rfc-41-bundle-b.test.ts` (monorepo guard,
  `--role` parsing, config layout). The runbook below bootstraps a
  minimal `~/.dkg/config.json` directly to keep the focus on the
  update + rollback path.
- Daemon HTTP behavior under the new install — covered by
  `devnet/v10-core-flows/` once the daemon is started against an
  Edge-mode `config.json`.
- Core slot-based update — RFC-41 §4.7.2 keeps that path for Core
  nodes; this runbook is Edge-only.
- Build-info / install-mode telemetry — Bundle A's `/api/status` +
  `dkg doctor` output is covered by Bundle A's unit suite.

## Prerequisites

1. **Built workspace.** `pnpm pack` packs `dist/`, not source; without
   it the packed tarballs are stubs.
   ```bash
   pnpm install
   pnpm build
   ```
2. **Network access for `npx`.** The script boots verdaccio via
   `npx -y verdaccio@latest`. Warm the npx cache once:
   ```bash
   npx -y verdaccio@latest --version
   ```
3. **No conflicting verdaccio.** Port `4873` must be free, or set
   `VERDACCIO_PORT=<free port>` when invoking the script.
4. **Node ≥ what the repo requires.** Use `nvm use` (reads `.nvmrc`)
   to pin the right version.

The script does NOT touch:

- The host's `~/.dkg` (uses `DKG_HOME=<scratch>/dkg-home`).
- The host's npm global prefix (uses `NPM_CONFIG_PREFIX=<scratch>/npm-global`).
- The host's `~/.npmrc` (uses `NPM_CONFIG_USERCONFIG=<scratch>/.npmrc`).

## Run it (automated)

From the repo root:

```bash
pnpm test:devnet:edge-update-flow
```

That registers the script as a vitest scenario alongside the other
`pnpm test:devnet:*` suites, gives you streamed progress, and fails
loud with the script's own stderr captured.

To debug a failure, re-run the script directly with the scratch root
preserved:

```bash
EDGE_UPDATE_KEEP_SCRATCH=1 ./scripts/devnet-test-edge-update.sh
```

The path it printed under `[edge-update] scratch root:` survives the
exit trap and contains:

- `dkg-home/` — `config.json`, `previous-version`, etc.
- `npm-global/` — the scratch npm prefix with `bin/dkg`.
- `verdaccio-storage/` — the local registry's package storage.
- `verdaccio.log` — the registry's stderr.
- `tarballs/` — every packed tarball (v1 for all public packages,
  plus v2 of the CLI).
- `.npmrc` — the registry/auth config the script used.

## Run it (manual, step by step)

If the script is failing in a way that's hard to read from logs alone,
here's the same flow broken into copy-pasteable shell. Same env vars,
same paths.

### 1. Scratch root + env

```bash
export SCRATCH_ROOT="$(mktemp -d -t dkg-edge-update.XXXXXX)"
export NPM_CONFIG_PREFIX="$SCRATCH_ROOT/npm-global"
export DKG_HOME="$SCRATCH_ROOT/dkg-home"
export NPM_CONFIG_USERCONFIG="$SCRATCH_ROOT/.npmrc"
export NPM_CONFIG_REGISTRY="http://127.0.0.1:4873/"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
mkdir -p "$NPM_CONFIG_PREFIX" "$DKG_HOME" "$SCRATCH_ROOT/tarballs"

cat > "$NPM_CONFIG_USERCONFIG" <<EOF
registry=$NPM_CONFIG_REGISTRY
//127.0.0.1:4873/:_authToken=anon-token-for-verdaccio
@origintrail-official:registry=$NPM_CONFIG_REGISTRY
EOF
```

### 2. Boot verdaccio

```bash
cat > "$SCRATCH_ROOT/verdaccio-config.yaml" <<EOF
storage: $SCRATCH_ROOT/verdaccio-storage
auth:
  htpasswd:
    file: $SCRATCH_ROOT/htpasswd
    max_users: -1
uplinks: {}
packages:
  '@origintrail-official/*':
    access: \$anonymous
    publish: \$anonymous
    unpublish: \$anonymous
  '**':
    access: \$anonymous
    publish: \$authenticated
log:
  type: stdout
  format: pretty
  level: warn
EOF

nohup npx -y verdaccio@latest \
  --listen 4873 --config "$SCRATCH_ROOT/verdaccio-config.yaml" \
  >"$SCRATCH_ROOT/verdaccio.log" 2>&1 &
echo "verdaccio pid: $!"

# Wait until /ping returns 200.
until curl -fsS "$NPM_CONFIG_REGISTRY/-/ping" >/dev/null; do sleep 1; done
```

### 3. Pack + publish v1 of every public package

```bash
cd <repo-root>
V1="$(node -p "require('./packages/cli/package.json').version")"
echo "v1 = $V1"

# Discover public packages.
for d in packages/*; do
  [ -f "$d/package.json" ] || continue
  IS_PRIVATE="$(node -p "JSON.parse(require('fs').readFileSync('$d/package.json','utf-8')).private === true")"
  [ "$IS_PRIVATE" = "true" ] && continue
  ( cd "$d" && pnpm pack --pack-destination "$SCRATCH_ROOT/tarballs" >/dev/null )
done

for tgz in "$SCRATCH_ROOT/tarballs"/*.tgz; do
  npm publish "$tgz"
done
```

### 4. Bump CLI to v2 and publish

```bash
V2="${V1}-edge-update-test.1"
cp packages/cli/package.json "$SCRATCH_ROOT/cli-package.json.bak"
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('packages/cli/package.json','utf-8'));
  p.version = '$V2';
  fs.writeFileSync('packages/cli/package.json', JSON.stringify(p, null, 2) + '\n');
"
( cd packages/cli && pnpm pack --pack-destination "$SCRATCH_ROOT/tarballs" >/dev/null )
npm publish "$SCRATCH_ROOT/tarballs/origintrail-official-dkg-${V2}.tgz"
cp "$SCRATCH_ROOT/cli-package.json.bak" packages/cli/package.json
echo "v2 = $V2"
```

### 5. Install v1 globally

```bash
npm install -g "@origintrail-official/dkg@$V1"
which dkg               # → $NPM_CONFIG_PREFIX/bin/dkg
dkg --version           # → $V1
```

### 6. Bootstrap a minimal Edge config

(`dkg init` is interactive and asks ~12 questions; we bypass it here
because the focus is the UPDATE flow. Bundle B unit tests cover the
init flow.)

```bash
cat > "$DKG_HOME/config.json" <<EOF
{
  "name": "dkg-edge-update-test",
  "nodeRole": "edge",
  "apiPort": 8901,
  "autoUpdate": { "enabled": false, "source": "npm" },
  "auth": { "enabled": false }
}
EOF
```

### 7. `dkg update <V2>` — the headline assertion

```bash
dkg update "$V2"
cat "$DKG_HOME/previous-version"   # → $V1 (rollback breadcrumb)
dkg --version                      # → $V2
```

### 8. `dkg rollback`

```bash
dkg rollback
dkg --version                      # → $V1 (back to starting version)
```

### 9. Cleanup

```bash
kill %1 2>/dev/null               # stop verdaccio
rm -rf "$SCRATCH_ROOT"
```

## Expected output (script form)

A passing run looks like:

```
[edge-update] scratch root: /tmp/dkg-edge-update.XXXXXX
[edge-update] verdaccio:    http://127.0.0.1:4873 ...
[edge-update] stage 1: launching verdaccio
[edge-update] verdaccio up after 2s (pid=12345)
[edge-update] stage 2: v1=10.0.0-rc.11  v2=10.0.0-rc.11-edge-update-test.1
[edge-update] packing public packages at v1 (10.0.0-rc.11)
[edge-update] packed 15 v1 tarballs into ...
[edge-update] packing v2 (CLI only, with bumped version ...)
[edge-update] v2 tarball: .../origintrail-official-dkg-10.0.0-rc.11-edge-update-test.1.tgz
[edge-update] restored .../packages/cli/package.json
[edge-update] stage 3: publishing 16 tarballs to verdaccio
[edge-update] published all tarballs
[edge-update] verdaccio knows CLI v1 + v2
[edge-update] stage 4: npm install -g @origintrail-official/dkg@10.0.0-rc.11
[edge-update] v1 installed and reports version 10.0.0-rc.11
[edge-update] stage 5: bootstrap minimal Edge config at .../dkg-home/config.json
[edge-update] config.json nodeRole=edge, autoUpdate.source=npm
[edge-update] stage 6: dkg update 10.0.0-rc.11-edge-update-test.1
[edge-update] previous-version=10.0.0-rc.11 (matches v1)
[edge-update] binary now reports 10.0.0-rc.11-edge-update-test.1
[edge-update] stage 7: dkg rollback (expected back to 10.0.0-rc.11)
[edge-update] binary back to 10.0.0-rc.11 after rollback — round-trip complete
[edge-update] PASS — Edge npm-only update + rollback round-trip ...
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `verdaccio did not respond to /-/ping within 60s` | First-time `npx verdaccio` is downloading | Pre-warm with `npx -y verdaccio@latest --version` |
| `port 4873 in use` | Existing verdaccio | `lsof -i :4873` → kill it, or `VERDACCIO_PORT=4874 ./script.sh` |
| `pnpm pack failed` | Workspace not built | `pnpm build` from repo root |
| `expected dkg binary at .../bin/dkg after install` | `npm install -g` silently failed | Re-run with `EDGE_UPDATE_KEEP_SCRATCH=1`, then `cat <scratch>/verdaccio.log` |
| `dkg update <v2> failed` | Pre-flight doctor check found error severity | Re-run script directly with stderr visible: `bash -x scripts/devnet-test-edge-update.sh 2>&1 \| tee /tmp/dkg-update-log` |
| `previous-version` missing after `dkg update` | `getCurrentCliVersion()` returned empty | Check that v1 tarball includes a non-empty `package.json#version` |
| Test passes locally, fails in CI | CI host has a stale npm global prefix | Confirm CI uses an ephemeral runner; the script's scratch prefix is per-run |

## Tying back to RFC-41

Run this **before** you merge any change that touches:

- `packages/cli/src/daemon/auto-update.ts` (especially
  `performNpmUpdateEdge` and `_performNpmUpdateInnerEdge`).
- `packages/cli/src/cli.ts` `dkg update` / `dkg rollback` action
  handlers.
- `packages/cli/src/migration.ts` `noteEdgeLegacyReleases`.
- Any code under `packages/cli/src/daemon/manifest.ts` that exports
  `_autoUpdateIo`.

It's also a pre-merge gate for the RFC-41 follow-up PRs (deletion of
the dead git-build code paths) once Bundle B has soaked on devnet —
the script ensures the deletions did not accidentally break the
update flow that survived the cleanup.
