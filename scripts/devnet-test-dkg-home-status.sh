#!/usr/bin/env bash
#
# Post-rc.12 devnet regression for PR #878.
#
# Verifies `dkg status` honours the selected DKG_HOME instead of drifting
# to another node's control-plane files or a stale DKG_API_PORT override.
# The script talks to two already-running devnet nodes and compares CLI
# output against each node's /api/status identity.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CLI_JS="$REPO_ROOT/packages/cli/dist/cli.js"

log()  { echo "[dkg-home-status] $*"; }
fail() { echo "[dkg-home-status] FAIL: $*" >&2; exit 1; }

[ -f "$CLI_JS" ] || fail "missing CLI build at $CLI_JS (run pnpm run build)"

node_token() {
  tail -1 "$DEVNET_DIR/node$1/auth.token" 2>/dev/null | tr -d '\r\n'
}

api_status() {
  local node="$1"
  local port=$((API_PORT_BASE + node - 1))
  local token
  token="$(node_token "$node")"
  curl -sS --max-time 10 \
    -H "Authorization: Bearer $token" \
    "http://127.0.0.1:${port}/api/status"
}

json_get() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      const j = JSON.parse(d);
      const path = process.argv[1].split(".");
      let v = j;
      for (const p of path) v = v?.[p];
      console.log(v == null ? "" : String(v));
    });
  ' "$1"
}

check_node() {
  local node="$1"
  local home="$DEVNET_DIR/node${node}"
  local status_json expected_name expected_peer stale_node stale_port out

  [ -d "$home" ] || fail "missing devnet node home: $home"
  status_json="$(api_status "$node")"
  expected_name="$(printf '%s' "$status_json" | json_get name)"
  expected_peer="$(printf '%s' "$status_json" | json_get peerId)"
  [ -n "$expected_name" ] || fail "node${node} /api/status missing name: $status_json"
  [ -n "$expected_peer" ] || fail "node${node} /api/status missing peerId: $status_json"

  # Intentionally set DKG_API_PORT to the other node. PR #878 was about
  # stale process-level overrides winning over DKG_HOME's control-plane files.
  stale_node=1
  [ "$node" = "1" ] && stale_node=2
  stale_port=$((API_PORT_BASE + stale_node - 1))
  out="$(env DKG_API_PORT="$stale_port" DKG_HOME="$home" node "$CLI_JS" status 2>&1)"
  printf '%s\n' "$out" | sed "s/^/[dkg-home-status node${node}] /"

  printf '%s\n' "$out" | grep -F "Node:" | grep -F "$expected_name" >/dev/null \
    || fail "dkg status for node${node} did not report expected name '$expected_name'"
  printf '%s\n' "$out" | grep -F "PeerId:" | grep -F "$expected_peer" >/dev/null \
    || fail "dkg status for node${node} did not report expected peer '$expected_peer'"

  log "PASS node${node}: DKG_HOME selected $expected_name / $expected_peer"
}

log "Checking DKG_HOME status selection on latest devnet"
check_node 1
check_node 2
log "PASS: DKG_HOME status selection is isolated per node"
