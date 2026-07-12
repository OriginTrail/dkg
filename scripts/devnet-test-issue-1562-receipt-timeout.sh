#!/usr/bin/env bash
# Live-devnet config/deadline regression for #1562. A temporary node uses a 3s
# receipt deadline; Hardhat automine is paused and the publish must return the
# configured RPC_TIMEOUT near that deadline (not after the transport's 5s attempt
# plus poll sleep, and not the old hard-coded timeout).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
RPC="${DEVNET_RPC:-http://127.0.0.1:8545}"
NODE="${RECEIPT_TIMEOUT_TEST_NODE:-7}"
NODE_DIR="$DEVNET_DIR/node$NODE"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
automine_off=0

fail() { echo "[#1562] FAIL: $*" >&2; exit 1; }
rpc() { curl -fsS -H 'Content-Type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC" >/dev/null; }
cleanup() {
  if [[ "$automine_off" == 1 ]]; then rpc evm_setAutomine '[true]' || true; rpc evm_mine '[]' || true; fi
  "$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null 2>&1 || true
  rm -rf "$NODE_DIR"
}
trap cleanup EXIT INT TERM
[[ ! -d "$NODE_DIR" ]] || fail "$NODE_DIR already exists"
"$ROOT/scripts/devnet.sh" addnode "$NODE" edge >/dev/null
"$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null
NODE_DIR="$NODE_DIR" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const path = join(process.env.NODE_DIR, 'config.json');
const config = JSON.parse(readFileSync(path, 'utf8'));
config.chain = { ...config.chain, receiptTimeoutMs: 3000 };
writeFileSync(path, JSON.stringify(config, null, 2));
NODE
"$ROOT/scripts/devnet.sh" restart-node "$NODE" >/dev/null

. "$ROOT/scripts/devnet-lib.sh"
for _ in $(seq 1 90); do
  [[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] && break
  sleep 1
done
[[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] || fail "temporary node not ready"
api "$NODE" POST /api/identity/ensure '{}' >/dev/null || true

name="issue-1562-$(date +%s)-$$"; subject="urn:issue:1562:$name"
api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$name\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/write" \
  "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"receipt deadline probe\\\"\",\"graph\":\"\"}]}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CG\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CG\"}" >/dev/null

rpc evm_setAutomine '[false]'; automine_off=1
started_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
response="$(api "$NODE" POST "/api/knowledge-assets/$name/vm/publish" "{\"contextGraphId\":\"$CG\"}")"
elapsed_ms=$(( $(node -e 'process.stdout.write(String(Date.now()))') - started_ms ))
body="$(body_of "$response")"
[[ "$(code_of "$response")" == 504 ]] || fail "expected 504 RPC timeout, got $(code_of "$response"): $body"
[[ "$body" == *3000ms* ]] || fail "response did not report configured 3000ms deadline: $body"
[[ "$elapsed_ms" -ge 2500 && "$elapsed_ms" -lt 6000 ]] || fail "overall deadline took ${elapsed_ms}ms"
echo "[#1562] PASS: live receipt wait honored the configured overall deadline (${elapsed_ms}ms)"
