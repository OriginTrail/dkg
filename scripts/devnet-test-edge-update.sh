#!/usr/bin/env bash
#
# RFC-41 Bundle B — Edge node npm-only update + rollback flow validation.
#
# Closes the §6.2 testing gap by exercising the production
# `performNpmUpdateEdge` and `dkg rollback` (Edge branch) code paths
# against a real `npm install -g` against a real (local) npm registry.
# Unit tests cover the LOGIC with mocked `exec`; this script covers
# the INTEGRATION:
#
#   * `npm install -g @origintrail-official/dkg@<v>` actually mutates
#     the global prefix.
#   * The installed `dkg` binary runs and reports the expected version.
#   * A minimal Edge `config.json` routes `dkg update` through the
#     `performNpmUpdateEdge` branch (rather than the slot branch).
#   * `dkg update <new-version>` reinstalls globally, writes
#     `~/.dkg/previous-version` containing the OLD version, and the
#     binary now reports `<new-version>`.
#   * `dkg rollback` reads `~/.dkg/previous-version` and reinstalls the
#     OLD version. Round-trip lands back on the original version.
#
# The script does NOT exercise `dkg init` (interactive; ~12 prompts).
# That command's monorepo guard + `--role` flag are covered by unit
# tests in `packages/cli/test/rfc-41-bundle-b.test.ts`. The runbook in
# `docs/devnet/EDGE_UPDATE_VALIDATION.md` documents the bypass.
#
# Verdaccio runs locally as the npm registry. Because the CLI declares
# 10+ `workspace:*` dependencies, the script must publish EVERY public
# workspace package at v1 (mirrors `.github/workflows/npm-publish.yml`),
# then bump the CLI to v2 and publish that one tarball. v2 CLI depends
# on v1 workspace deps already in verdaccio, so `npm install -g` works.
# The scratch npm prefix and scratch `DKG_HOME` are isolated under a
# per-run mktemp dir; no system state is touched.
#
# Flow:
#   1. mktemp scratch root → NPM_CONFIG_PREFIX, DKG_HOME, verdaccio storage.
#   2. Boot verdaccio on a free port (default 4873; override with VERDACCIO_PORT).
#   3. `pnpm pack` every public `packages/*` at HEAD → publish v1 of all.
#      Bump `packages/cli/package.json` → repack CLI only → publish v2.
#   4. `npm install -g @origintrail-official/dkg@<v1>` into the scratch prefix.
#   5. Bootstrap a minimal Edge `config.json` under DKG_HOME.
#   6. `dkg update <v2>` → assert previous-version file + new binary version.
#   7. `dkg rollback` → assert binary version back to v1.
#   8. Trap cleans up: stop verdaccio, rm scratch root.
#
# Exit 0 on full round-trip pass. Non-zero on any assertion failure
# with a clear "[edge-update] FAIL: ..." line on stderr.
#
# Runtime: ~3-5 minutes (verdaccio cold-start + pack/publish of ~15
# workspace packages + two `npm install -g` round-trips dominate).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_PKG_DIR="$REPO_ROOT/packages/cli"

# ---------------------------------------------------------------------------
# Logging helpers (match existing devnet-test-*.sh conventions).
# ---------------------------------------------------------------------------

log()  { echo "[edge-update] $*"; }
warn() { echo "[edge-update] WARN: $*" >&2; }
fail() { echo "[edge-update] FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Tunables (env-overridable).
# ---------------------------------------------------------------------------

VERDACCIO_PORT="${VERDACCIO_PORT:-4873}"
# Allow the operator to pre-create a scratch root (useful for debugging
# state between runs); otherwise mktemp.
SCRATCH_ROOT="${EDGE_UPDATE_SCRATCH:-$(mktemp -d -t dkg-edge-update.XXXXXX)}"
KEEP_SCRATCH="${EDGE_UPDATE_KEEP_SCRATCH:-0}"

NPM_PREFIX="$SCRATCH_ROOT/npm-global"
DKG_HOME_DIR="$SCRATCH_ROOT/dkg-home"
VERDACCIO_STORAGE="$SCRATCH_ROOT/verdaccio-storage"
VERDACCIO_CONFIG="$SCRATCH_ROOT/verdaccio-config.yaml"
VERDACCIO_LOG="$SCRATCH_ROOT/verdaccio.log"
NPMRC="$SCRATCH_ROOT/.npmrc"
TARBALL_DIR="$SCRATCH_ROOT/tarballs"

mkdir -p "$NPM_PREFIX" "$DKG_HOME_DIR" "$VERDACCIO_STORAGE" "$TARBALL_DIR"

log "scratch root: $SCRATCH_ROOT"
log "npm prefix:   $NPM_PREFIX"
log "DKG_HOME:     $DKG_HOME_DIR"
log "verdaccio:    http://127.0.0.1:$VERDACCIO_PORT (log: $VERDACCIO_LOG)"

# ---------------------------------------------------------------------------
# Cleanup trap.
# ---------------------------------------------------------------------------

VERDACCIO_PID=""
ORIGINAL_PKG_JSON_BACKUP=""

cleanup() {
  local exit_code=$?
  set +e
  if [ -n "$VERDACCIO_PID" ] && kill -0 "$VERDACCIO_PID" 2>/dev/null; then
    log "stopping verdaccio (pid=$VERDACCIO_PID)"
    kill "$VERDACCIO_PID" 2>/dev/null
    wait "$VERDACCIO_PID" 2>/dev/null
  fi
  # Restore package.json if we mutated it for the v2 pack and didn't
  # already restore on the happy path.
  if [ -n "$ORIGINAL_PKG_JSON_BACKUP" ] && [ -f "$ORIGINAL_PKG_JSON_BACKUP" ]; then
    cp "$ORIGINAL_PKG_JSON_BACKUP" "$CLI_PKG_DIR/package.json"
    log "restored $CLI_PKG_DIR/package.json from backup"
  fi
  if [ "$KEEP_SCRATCH" = "1" ]; then
    log "keeping scratch root for inspection: $SCRATCH_ROOT"
  else
    rm -rf "$SCRATCH_ROOT"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Stage 1 — boot verdaccio.
#
# Config allows anonymous publish for the `@origintrail-official/*`
# scope so we don't have to `npm adduser`. A dummy `_authToken` in the
# scratch npmrc satisfies npm's "must have an auth header" check; the
# token value is never validated server-side because `$anonymous` is
# the publish ACL.
# ---------------------------------------------------------------------------

cat > "$VERDACCIO_CONFIG" <<EOF
storage: $VERDACCIO_STORAGE
auth:
  htpasswd:
    file: $SCRATCH_ROOT/htpasswd
    # max_users: -1 disables registration but does NOT disable
    # anonymous access — \$anonymous below still works.
    max_users: -1
uplinks: {}
packages:
  '@origintrail-official/*':
    access: \$anonymous
    publish: \$anonymous
    unpublish: \$anonymous
  '**':
    access: \$anonymous
    # Block accidental publishes of unrelated packages.
    publish: \$authenticated
log:
  type: stdout
  format: pretty
  level: warn
EOF

cat > "$NPMRC" <<EOF
registry=http://127.0.0.1:$VERDACCIO_PORT/
//127.0.0.1:$VERDACCIO_PORT/:_authToken=anon-token-for-verdaccio
@origintrail-official:registry=http://127.0.0.1:$VERDACCIO_PORT/
EOF

# PUBLIC_REGISTRY is the upstream we fetch verdaccio's own package
# from. Required because once `NPM_CONFIG_REGISTRY` flips to the
# scratch verdaccio (below, after it's up), a cold `npx -y
# verdaccio@<pin>` would chicken-and-egg itself — npx would try to
# fetch verdaccio's tarball from `http://127.0.0.1:$VERDACCIO_PORT/`
# and get ECONNREFUSED before the registry has been launched.
PUBLIC_REGISTRY="https://registry.npmjs.org/"

# Verdaccio version is pinned to keep this gate reproducible — an
# unpinned `@latest` would let an upstream Verdaccio release break
# CI without any change in this repo. Bump deliberately by editing
# this constant; verify the new version against the manual runbook
# in docs/devnet/EDGE_UPDATE_VALIDATION.md before merging.
VERDACCIO_VERSION="${VERDACCIO_VERSION:-6.7.2}"

# DKG_HOME, NPM_CONFIG_PREFIX, NPM_CONFIG_USERCONFIG can be exported
# unconditionally — they don't affect the `npx verdaccio` fetch
# (npx's own cache lives outside our scratch prefix). NPM_CONFIG_REGISTRY
# is the dangerous one and is applied AFTER verdaccio is up.
export NPM_CONFIG_USERCONFIG="$NPMRC"
export NPM_CONFIG_PREFIX="$NPM_PREFIX"
# `dkg init` and `dkg rollback` read DKG_HOME for state. Without this
# they'd write into the operator's real ~/.dkg, polluting the host.
export DKG_HOME="$DKG_HOME_DIR"
# Put the scratch npm prefix's bin on PATH ahead of the system one so
# `dkg` after install resolves to the scratch install, not a global
# `@origintrail-official/dkg` the operator might already have.
export PATH="$NPM_PREFIX/bin:$PATH"

log "stage 1: launching verdaccio@$VERDACCIO_VERSION (npx fetch via $PUBLIC_REGISTRY)"
# Inline `NPM_CONFIG_REGISTRY` override for the npx subprocess only:
# npx fetches verdaccio's tarball from the public registry, NOT from
# the local verdaccio that doesn't exist yet. The export below
# (after verdaccio is reachable) then flips NPM_CONFIG_REGISTRY to
# the scratch instance for all subsequent npm/dkg invocations.
NPM_CONFIG_REGISTRY="$PUBLIC_REGISTRY" nohup npx -y "verdaccio@$VERDACCIO_VERSION" \
  --listen "$VERDACCIO_PORT" --config "$VERDACCIO_CONFIG" \
  >"$VERDACCIO_LOG" 2>&1 &
VERDACCIO_PID=$!

# Wait for verdaccio to be ready.
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$VERDACCIO_PORT/-/ping" >/dev/null 2>&1; then
    log "verdaccio up after ${i}s (pid=$VERDACCIO_PID)"
    break
  fi
  if ! kill -0 "$VERDACCIO_PID" 2>/dev/null; then
    fail "verdaccio process exited during startup — see $VERDACCIO_LOG"
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$VERDACCIO_PORT/-/ping" >/dev/null 2>&1; then
  fail "verdaccio did not respond to /-/ping within 60s — see $VERDACCIO_LOG"
fi

# Verdaccio is now serving — safe to flip the default registry. Every
# subsequent npm / dkg invocation in this shell now uses the scratch
# verdaccio for resolution + publish.
export NPM_CONFIG_REGISTRY="http://127.0.0.1:$VERDACCIO_PORT/"

# ---------------------------------------------------------------------------
# Stage 2 — pack every public workspace package, then a v2 of just the CLI.
#
# The CLI declares 10+ workspace-protocol dependencies. `pnpm pack`
# rewrites `workspace:*` to the resolved version at pack time, but the
# resulting tarball still REQUIRES those packages to be resolvable
# from the registry npm hits. We therefore mirror the CI publish flow
# (.github/workflows/npm-publish.yml step "Pack public packages") and
# publish every non-private `packages/*` to verdaccio at v1.
#
# v1 = the repo's current version (e.g. `10.0.0-rc.11`).
# v2 = `<v1>-edge-update-test.1`. Suffix keeps semver order so npm
#      correctly considers v2 > v1, AND `^v1` does NOT match v2 (npm's
#      caret semantics on prereleases are strict), so v2 CLI installs
#      sit cleanly on top of v1 workspace deps already in verdaccio.
#
# Pre-requisite: `pnpm build` must have produced `packages/*/dist/`
# before this script runs. Otherwise `pnpm pack` emits stub tarballs
# missing the daemon JS and the v1 install reports a phantom
# `Cannot find module ./dist/cli.js` at first invocation.
# ---------------------------------------------------------------------------

cd "$REPO_ROOT"
V1_VERSION="$(node -p "require('./packages/cli/package.json').version")"
V2_VERSION="${V1_VERSION}-edge-update-test.1"
log "stage 2: v1=$V1_VERSION  v2=$V2_VERSION"

# Sanity-check that the workspace is built.
if [ ! -f "$CLI_PKG_DIR/dist/cli.js" ]; then
  fail "CLI build output missing at $CLI_PKG_DIR/dist/cli.js — run 'pnpm build' from the repo root first"
fi

# Discover public packages — same logic the CI workflow uses, kept in
# sync deliberately.
PUBLIC_PKG_DIRS_RAW="$(node -e "
  const fs = require('fs');
  const path = require('path');
  const pkgsDir = path.join(process.cwd(), 'packages');
  const result = [];
  for (const dir of fs.readdirSync(pkgsDir)) {
    const pkgPath = path.join(pkgsDir, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.private) continue;
    result.push(path.join(pkgsDir, dir));
  }
  process.stdout.write(result.join('\n'));
")"
[ -n "$PUBLIC_PKG_DIRS_RAW" ] || fail "no public workspace packages discovered under packages/*"

# Pack every public package at v1.
log "packing public packages at v1 ($V1_VERSION)"
PUBLIC_PKG_COUNT=0
while IFS= read -r pkg_dir; do
  [ -n "$pkg_dir" ] || continue
  PUBLIC_PKG_COUNT=$((PUBLIC_PKG_COUNT + 1))
  ( cd "$pkg_dir" && pnpm pack --pack-destination "$TARBALL_DIR" >/dev/null ) \
    || fail "pnpm pack failed for $pkg_dir"
done <<< "$PUBLIC_PKG_DIRS_RAW"
log "packed $PUBLIC_PKG_COUNT v1 tarballs into $TARBALL_DIR"

# Bump ONLY the CLI to v2 → repack → restore. v2's workspace deps are
# left at v1 (already in verdaccio); npm's semver matcher resolves them
# against the v1 packages we just packed.
ORIGINAL_PKG_JSON_BACKUP="$SCRATCH_ROOT/cli-package.json.v1.bak"
cp "$CLI_PKG_DIR/package.json" "$ORIGINAL_PKG_JSON_BACKUP"

log "packing v2 (CLI only, with bumped version $V2_VERSION)"
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf8'));
  pkg.version = '$V2_VERSION';
  fs.writeFileSync('packages/cli/package.json', JSON.stringify(pkg, null, 2) + '\n');
"
( cd "$CLI_PKG_DIR" && pnpm pack --pack-destination "$TARBALL_DIR" >/dev/null ) \
  || { cp "$ORIGINAL_PKG_JSON_BACKUP" "$CLI_PKG_DIR/package.json"; fail "pnpm pack v2 failed"; }
V2_TARBALL="$TARBALL_DIR/origintrail-official-dkg-${V2_VERSION}.tgz"
[ -f "$V2_TARBALL" ] || { cp "$ORIGINAL_PKG_JSON_BACKUP" "$CLI_PKG_DIR/package.json"; fail "expected v2 tarball at $V2_TARBALL"; }
log "v2 tarball: $V2_TARBALL"

# Restore package.json immediately (don't wait for EXIT trap).
cp "$ORIGINAL_PKG_JSON_BACKUP" "$CLI_PKG_DIR/package.json"
ORIGINAL_PKG_JSON_BACKUP=""
log "restored $CLI_PKG_DIR/package.json"

# ---------------------------------------------------------------------------
# Stage 3 — publish every packed tarball to verdaccio.
#
# `npm publish` reads .npmrc via NPM_CONFIG_USERCONFIG. The dummy
# `_authToken` satisfies npm; verdaccio's `$anonymous` publish ACL
# accepts the upload regardless of token value.
# ---------------------------------------------------------------------------

log "stage 3: publishing $(ls -1 "$TARBALL_DIR"/*.tgz | wc -l | tr -d ' ') tarballs to verdaccio"
for tarball in "$TARBALL_DIR"/*.tgz; do
  pkg_name="$(tar -xOf "$tarball" package/package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf-8')).name")"
  npm publish --registry "$NPM_CONFIG_REGISTRY" "$tarball" >/dev/null 2>&1 \
    || fail "npm publish failed for $tarball ($pkg_name) — see $VERDACCIO_LOG"
done
log "published all tarballs"

# Sanity: verify verdaccio knows about CLI v1 + v2.
#
# Stream the registry JSON to Node via stdin (NOT shell-interpolated)
# and pass the expected versions through env vars. The package
# metadata can legitimately contain shell-significant characters
# like `$` or backticks (e.g. in `description`, `readme`, or
# `repository.url` fields), and direct interpolation into `node -e`
# would let bash expand them before Node ever parses the script.
# Single-quoting the node script keeps bash out of its body entirely.
VERSIONS_JSON="$(curl -fsS "http://127.0.0.1:$VERDACCIO_PORT/@origintrail-official%2Fdkg" \
  || fail "verdaccio metadata fetch failed for @origintrail-official/dkg")"
printf '%s' "$VERSIONS_JSON" | \
  V1_VERSION="$V1_VERSION" V2_VERSION="$V2_VERSION" node -e '
    let d = "";
    process.stdin.on("data", (c) => { d += c; });
    process.stdin.on("end", () => {
      const meta = JSON.parse(d);
      const versions = Object.keys(meta.versions || {});
      const want1 = process.env.V1_VERSION;
      const want2 = process.env.V2_VERSION;
      if (!versions.includes(want1)) {
        console.error("missing v1: " + want1);
        process.exit(1);
      }
      if (!versions.includes(want2)) {
        console.error("missing v2: " + want2);
        process.exit(1);
      }
    });
  ' || fail "verdaccio is missing CLI v1 or v2 — see $VERDACCIO_LOG"
log "verdaccio knows CLI v1 + v2"

# ---------------------------------------------------------------------------
# Stage 4 — install v1 into the scratch prefix.
#
# `npm install -g @origintrail-official/dkg@<v1>` mirrors what
# operators run for first install. The scratch prefix isolates state
# from any pre-existing system install.
# ---------------------------------------------------------------------------

log "stage 4: npm install -g @origintrail-official/dkg@$V1_VERSION"
npm install -g "@origintrail-official/dkg@$V1_VERSION" >/dev/null \
  || fail "initial install failed"

INSTALLED_BIN="$NPM_PREFIX/bin/dkg"
[ -x "$INSTALLED_BIN" ] || fail "expected dkg binary at $INSTALLED_BIN after install"

REPORTED_V1="$("$INSTALLED_BIN" --version 2>&1 | tail -1 | tr -d '\r\n')"
[ "$REPORTED_V1" = "$V1_VERSION" ] \
  || fail "expected dkg --version=$V1_VERSION after initial install, got: $REPORTED_V1"
log "v1 installed and reports version $REPORTED_V1"

# ---------------------------------------------------------------------------
# Stage 5 — bootstrap a minimal Edge config under DKG_HOME.
#
# `dkg init` in rc.12 is interactive (~12 prompts: name, relay, context
# graphs, API port, auto-update, chain RPC, hub address, auth, etc.)
# and does not expose a `--yes` / `--non-interactive` flag — the
# operator runs it once at first install and accepts defaults via
# Enter. Piping `\n` x 12 to stdin would work but breaks silently the
# moment a new prompt is added, which is brittle for an integration
# test whose subject is the UPDATE flow, not init.
#
# Instead we write `$DKG_HOME/config.json` directly with the fields
# that `dkg update` / `dkg rollback` read:
#
#   * `nodeRole: 'edge'`   → dispatches update/rollback through the
#                            Edge branch (`performNpmUpdateEdge`).
#   * `autoUpdate.source: 'npm'` → marks the install as npm-managed
#                                  (no legacy git-build dispatch).
#
# The `dkg init --role edge` monorepo guard + --role flag are covered
# by Bundle B's unit tests in `packages/cli/test/rfc-41-bundle-b.test.ts`;
# this script does not duplicate that coverage.
# ---------------------------------------------------------------------------

log "stage 5: bootstrap minimal Edge config at $DKG_HOME/config.json"
mkdir -p "$DKG_HOME"
cat > "$DKG_HOME/config.json" <<EOF
{
  "name": "dkg-edge-update-test",
  "nodeRole": "edge",
  "apiPort": 8901,
  "autoUpdate": {
    "enabled": false,
    "source": "npm"
  },
  "auth": {
    "enabled": false
  }
}
EOF
INIT_ROLE="$(node -p "JSON.parse(require('fs').readFileSync('$DKG_HOME/config.json','utf8')).nodeRole" 2>/dev/null || echo '')"
[ "$INIT_ROLE" = "edge" ] || fail "expected nodeRole=edge in config.json, got: $INIT_ROLE"
log "config.json nodeRole=edge, autoUpdate.source=npm"

# ---------------------------------------------------------------------------
# Stage 6 — `dkg update <V2_VERSION>`.
#
# This is the headline Bundle B assertion: the Edge branch of
# `dkg update` runs `npm install -g @origintrail-official/dkg@<v2>`,
# writes the OLD version to `$DKG_HOME/previous-version`, and the
# binary now reports v2.
# ---------------------------------------------------------------------------

log "stage 6: dkg update $V2_VERSION"
"$INSTALLED_BIN" update "$V2_VERSION" >/dev/null 2>&1 \
  || fail "dkg update $V2_VERSION failed — re-run with EDGE_UPDATE_KEEP_SCRATCH=1 and inspect $DKG_HOME"

PREV_FILE="$DKG_HOME/previous-version"
[ -f "$PREV_FILE" ] || fail "expected $PREV_FILE after dkg update (Edge rollback breadcrumb)"
PREV_CONTENT="$(tr -d '\r\n[:space:]' <"$PREV_FILE")"
[ "$PREV_CONTENT" = "$V1_VERSION" ] \
  || fail "expected previous-version=$V1_VERSION, got: '$PREV_CONTENT'"
log "previous-version=$PREV_CONTENT (matches v1)"

REPORTED_V2="$("$INSTALLED_BIN" --version 2>&1 | tail -1 | tr -d '\r\n')"
[ "$REPORTED_V2" = "$V2_VERSION" ] \
  || fail "expected dkg --version=$V2_VERSION after update, got: $REPORTED_V2"
log "binary now reports $REPORTED_V2"

# ---------------------------------------------------------------------------
# Stage 7 — `dkg rollback`.
#
# Edge rollback reads `previous-version`, runs `npm install -g
# @origintrail-official/dkg@<old>`, and the binary returns to v1.
# ---------------------------------------------------------------------------

log "stage 7: dkg rollback (expected back to $V1_VERSION)"
"$INSTALLED_BIN" rollback >/dev/null 2>&1 \
  || fail "dkg rollback failed — re-run with EDGE_UPDATE_KEEP_SCRATCH=1 and inspect $DKG_HOME"

REPORTED_ROLLBACK="$("$INSTALLED_BIN" --version 2>&1 | tail -1 | tr -d '\r\n')"
[ "$REPORTED_ROLLBACK" = "$V1_VERSION" ] \
  || fail "expected dkg --version=$V1_VERSION after rollback, got: $REPORTED_ROLLBACK"
log "binary back to $REPORTED_ROLLBACK after rollback — round-trip complete"

# ---------------------------------------------------------------------------
# Done.
# ---------------------------------------------------------------------------

log "PASS — Edge npm-only update + rollback round-trip ($V1_VERSION → $V2_VERSION → $V1_VERSION)"
exit 0
