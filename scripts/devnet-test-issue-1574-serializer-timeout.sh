#!/usr/bin/env bash
# Live Hardhat-devnet regression for #1574. Hold mining for 65 seconds while one
# more publish than the node's operational-wallet count runs. Round-robin must
# therefore assign at least two writes to the same signer. The old 60s acquisition
# deadline drops the queued write; the fixed queue-position budget keeps every
# request pending, then all finish after mining resumes. Run only on an isolated
# devnet because both automine and interval mining are briefly disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
RPC="${DEVNET_RPC:-http://127.0.0.1:8545}"
NODE="${SERIALIZER_TEST_NODE:-1}"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/dkg-1574.XXXXXX")"
automine_off=0
interval_mining_off=0

fail() { echo "[#1574] FAIL: $*" >&2; exit 1; }
rpc() { curl -fsS -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC" >/dev/null; }
cleanup() {
  if [[ "$automine_off" == 1 ]]; then rpc evm_setAutomine '[true]' || true; fi
  if [[ "$interval_mining_off" == 1 ]]; then rpc evm_setIntervalMining '[1000]' || true; fi
  if [[ "$automine_off" == 1 || "$interval_mining_off" == 1 ]]; then rpc evm_mine '[]' || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM
. "$ROOT/scripts/devnet-lib.sh"
[[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] || fail "node$NODE not ready"

prepare() {
  local name="$1" subject="urn:issue:1574:$1"
  api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$name\"}" >/dev/null
  api "$NODE" POST "/api/knowledge-assets/$name/wm/write" \
    "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"serializer probe\\\"\",\"graph\":\"\"}]}" >/dev/null
  api "$NODE" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CG\"}" >/dev/null
  api "$NODE" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CG\"}" >/dev/null
}

wallet_file="$DEVNET_DIR/node$NODE/wallets.json"
[[ -f "$wallet_file" ]] || fail "node$NODE wallet pool not found: $wallet_file"
wallet_count="$(jq -r '.wallets | length' "$wallet_file")"
[[ "$wallet_count" =~ ^[1-9][0-9]*$ ]] || fail "invalid operational-wallet count: $wallet_count"
publish_count=$((wallet_count + 1))
suffix="$(date +%s)-$$"
names=(); pids=(); results=()
for i in $(seq 1 "$publish_count"); do
  name="issue-1574-$i-$suffix"
  prepare "$name"
  names+=("$name")
done

# devnet.sh enables one-second interval mining. evm_setAutomine(false) alone
# does not stop those blocks, so explicitly disable both mining modes.
rpc evm_setIntervalMining '[0]'; interval_mining_off=1
rpc evm_setAutomine '[false]'; automine_off=1
for i in $(seq 0 $((publish_count - 1))); do
  result="$tmp/result-$i"
  (api "$NODE" POST "/api/knowledge-assets/${names[$i]}/vm/publish" "{\"contextGraphId\":\"$CG\"}") >"$result" &
  pids+=("$!")
  results+=("$result")
  sleep 1
done

sleep 65
for i in $(seq 0 $((publish_count - 1))); do
  kill -0 "${pids[$i]}" 2>/dev/null \
    || fail "publish $((i + 1)) exited while mining was paused: $(cat "${results[$i]}" 2>/dev/null)"
done

for _ in $(seq 1 90); do
  rpc evm_mine '[]'
  still_running=0
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then still_running=1; break; fi
  done
  [[ "$still_running" == 0 ]] && break
  sleep 1
done
rpc evm_setAutomine '[true]'; automine_off=0
rpc evm_setIntervalMining '[1000]'; interval_mining_off=0
for pid in "${pids[@]}"; do wait "$pid" || true; done

for result in "${results[@]}"; do
  [[ "$(code_of "$(cat "$result")")" == 200 ]] || fail "publish failed after mining resumed: $(cat "$result")"
  [[ "$(field "$(body_of "$(cat "$result")")" status)" == confirmed ]] || fail "publish not confirmed: $(cat "$result")"
done
echo "[#1574] PASS: $publish_count writes across $wallet_count wallets survived >60s and all confirmed"
