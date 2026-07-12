#!/usr/bin/env bash
# Live Hardhat-devnet regression for #1574. Hold mining for 65 seconds while two
# same-wallet publishes run. The old 60s acquisition deadline drops the second;
# the fixed queue-position budget keeps it pending, then both finish after mining
# resumes. Run only on an isolated devnet because automine is briefly disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
RPC="${DEVNET_RPC:-http://127.0.0.1:8545}"
NODE="${SERIALIZER_TEST_NODE:-1}"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/dkg-1574.XXXXXX")"
automine_off=0

fail() { echo "[#1574] FAIL: $*" >&2; exit 1; }
rpc() { curl -fsS -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC" >/dev/null; }
cleanup() {
  if [[ "$automine_off" == 1 ]]; then rpc evm_setAutomine '[true]' || true; rpc evm_mine '[]' || true; fi
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

suffix="$(date +%s)-$$"
name1="issue-1574-a-$suffix"; name2="issue-1574-b-$suffix"
prepare "$name1"; prepare "$name2"

rpc evm_setAutomine '[false]'; automine_off=1
(api "$NODE" POST "/api/knowledge-assets/$name1/vm/publish" "{\"contextGraphId\":\"$CG\"}") >"$tmp/one" & p1=$!
sleep 2
(api "$NODE" POST "/api/knowledge-assets/$name2/vm/publish" "{\"contextGraphId\":\"$CG\"}") >"$tmp/two" & p2=$!

sleep 65
kill -0 "$p1" 2>/dev/null || fail "first publish exited while mining was paused"
kill -0 "$p2" 2>/dev/null || fail "queued publish was dropped at the old 60s deadline: $(cat "$tmp/two" 2>/dev/null)"

for _ in $(seq 1 30); do
  rpc evm_mine '[]'
  if ! kill -0 "$p1" 2>/dev/null && ! kill -0 "$p2" 2>/dev/null; then break; fi
  sleep 1
done
rpc evm_setAutomine '[true]'; automine_off=0
wait "$p1" || true; wait "$p2" || true

for result in "$tmp/one" "$tmp/two"; do
  [[ "$(code_of "$(cat "$result")")" == 200 ]] || fail "publish failed after mining resumed: $(cat "$result")"
  [[ "$(field "$(body_of "$(cat "$result")")" status)" == confirmed ]] || fail "publish not confirmed: $(cat "$result")"
done
echo "[#1574] PASS: queued write survived >60s and both same-wallet publishes confirmed"
