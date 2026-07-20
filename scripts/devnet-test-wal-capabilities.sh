#!/usr/bin/env bash
# OT-RFC-65 cumulative WAL devnet lane: raw protocol registration and
# GET_CAPABILITIES over real DKG daemons. Start at least two nodes with:
#
#   DEVNET_SYNC_MODE=parallel ./scripts/devnet.sh start 2
#   ./scripts/devnet-test-wal-capabilities.sh
#
# A relay-only pair can be checked explicitly when the topology provides one:
#
#   WAL_RELAY_SOURCE_NODE=2 WAL_RELAY_TARGET_NODE=3 \
#     ./scripts/devnet-test-wal-capabilities.sh
#
# The script never treats the protocol advertisement as the capability result;
# each direction performs the actual authenticated raw request.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DIRECT_LEFT_NODE="${WAL_DIRECT_LEFT_NODE:-1}"
DIRECT_RIGHT_NODE="${WAL_DIRECT_RIGHT_NODE:-2}"
RELAY_SOURCE_NODE="${WAL_RELAY_SOURCE_NODE:-}"
RELAY_TARGET_NODE="${WAL_RELAY_TARGET_NODE:-}"

# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh"

fail() {
  echo "[wal-devnet] FAIL: $*" >&2
  exit 1
}

log() {
  echo "[wal-devnet] $*"
}

get() {
  local node="$1" path="$2" response code
  response="$(api "$node" GET "$path")"
  code="$(code_of "$response")"
  [ "$code" = "200" ] || fail "node $node GET $path returned HTTP $code: $(body_of "$response")"
  body_of "$response"
}

json_field() {
  local path="$1"
  JSON_PATH="$path" node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const value = process.env.JSON_PATH.split(".").reduce(
        (current, key) => current == null ? undefined : current[key],
        JSON.parse(input),
      );
      process.stdout.write(value == null ? "" : String(value));
    });
  '
}

peer_id() {
  get "$1" /api/status | json_field peerId
}

assert_parallel_runtime() {
  local node="$1" status
  status="$(get "$node" /api/status)"
  [ "$(printf '%s' "$status" | json_field wal.mode)" = "parallel" ] \
    || fail "node $node is not in WAL parallel mode"
  [ "$(printf '%s' "$status" | json_field wal.protocolsRegistered)" = "true" ] \
    || fail "node $node has not registered WAL protocols"
  [ "$(printf '%s' "$status" | json_field wal.synchronizationAuthority)" = "legacy" ] \
    || fail "node $node unexpectedly changed synchronization authority"
  [ "$(printf '%s' "$status" | json_field wal.workersActive)" = "0" ] \
    || fail "node $node unexpectedly started a WAL worker"
}

assert_capabilities() {
  local source="$1" target="$2" target_peer response
  target_peer="$(peer_id "$target")"
  [ -n "$target_peer" ] || fail "node $target did not report a peer ID"
  response="$(get "$source" "/api/wal/capabilities?peerId=$target_peer")"
  RESPONSE="$response" TARGET_PEER="$target_peer" node -e '
    const response = JSON.parse(process.env.RESPONSE);
    const expected = {
      peerId: process.env.TARGET_PEER,
      protocolVersions: ["1"],
      adapterVersions: ["1"],
      maximumControlFrameBytes: "1048576",
      maximumSymbolsPerResponse: "4096",
      maximumFallbackIdsPerPage: "4096",
      maximumObjectRangeBytes: "1048576",
      maximumWalObjectBytes: "8589934592",
      maximumConcurrentRanges: "16",
    };
    if (JSON.stringify(response) !== JSON.stringify(expected)) {
      console.error("unexpected capability response", response);
      process.exit(1);
    }
  ' || fail "capability mismatch from node $source to node $target"
  log "node $source -> node $target GET_CAPABILITIES passed"
}

assert_advertised() {
  local source="$1" target="$2" target_peer response attempt
  target_peer="$(peer_id "$target")"
  for attempt in $(seq 1 30); do
    response="$(get "$source" "/api/peer-info?peerId=$target_peer")"
    if RESPONSE="$response" node -e '
      const response = JSON.parse(process.env.RESPONSE);
      const protocols = new Set(response.protocols || []);
      const expected = [
        "/dkg/10.1.0/wal-control",
        "/dkg/10.1.0/wal-reconcile",
        "/dkg/10.1.0/wal-object",
      ];
      process.exit(expected.every(id => protocols.has(id)) ? 0 : 1);
    '; then
      log "node $target advertised every WAL protocol to node $source"
      return
    fi
    sleep 1
  done
  fail "node $target did not advertise every WAL protocol to node $source within 30s"
}

assert_relayed_connection() {
  local source="$1" target="$2" target_peer response
  target_peer="$(peer_id "$target")"
  response="$(get "$source" "/api/peer-info?peerId=$target_peer")"
  RESPONSE="$response" node -e '
    const response = JSON.parse(process.env.RESPONSE);
    if (!(response.transports || []).includes("relayed")) {
      console.error("no relayed connection", response.connections || []);
      process.exit(1);
    }
  ' || fail "node $source -> node $target did not use a relay path"
}

for node in "$DIRECT_LEFT_NODE" "$DIRECT_RIGHT_NODE"; do
  assert_parallel_runtime "$node"
done
assert_advertised "$DIRECT_LEFT_NODE" "$DIRECT_RIGHT_NODE"
assert_capabilities "$DIRECT_LEFT_NODE" "$DIRECT_RIGHT_NODE"
assert_capabilities "$DIRECT_RIGHT_NODE" "$DIRECT_LEFT_NODE"

if [ -n "$RELAY_SOURCE_NODE" ] || [ -n "$RELAY_TARGET_NODE" ]; then
  [ -n "$RELAY_SOURCE_NODE" ] && [ -n "$RELAY_TARGET_NODE" ] \
    || fail "set both WAL_RELAY_SOURCE_NODE and WAL_RELAY_TARGET_NODE"
  assert_parallel_runtime "$RELAY_SOURCE_NODE"
  assert_parallel_runtime "$RELAY_TARGET_NODE"
  assert_capabilities "$RELAY_SOURCE_NODE" "$RELAY_TARGET_NODE"
  assert_relayed_connection "$RELAY_SOURCE_NODE" "$RELAY_TARGET_NODE"
  log "relay-path assertion passed"
fi

log "restarting node $DIRECT_RIGHT_NODE"
DEVNET_DIR="$DEVNET_DIR" API_PORT_BASE="$API_PORT_BASE" \
  "$REPO_ROOT/scripts/devnet.sh" restart-node "$DIRECT_RIGHT_NODE"
assert_parallel_runtime "$DIRECT_RIGHT_NODE"
assert_capabilities "$DIRECT_LEFT_NODE" "$DIRECT_RIGHT_NODE"
assert_capabilities "$DIRECT_RIGHT_NODE" "$DIRECT_LEFT_NODE"

log "PASS: WAL capability protocol survives real daemon transport and restart"
