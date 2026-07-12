#!/usr/bin/env bash
# Live-devnet regression for #1573. A temporary edge node's operational wallet
# is drained of TRAC, then a named publish must fail with the stable funding code
# before the StorageACK timeout/remote-staging phase.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
RPC="${DEVNET_RPC:-http://127.0.0.1:8545}"
NODE="${FUNDABILITY_TEST_NODE:-7}"
NODE_DIR="$DEVNET_DIR/node$NODE"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"

fail() { echo "[#1573] FAIL: $*" >&2; exit 1; }
cleanup() { "$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null 2>&1 || true; rm -rf "$NODE_DIR"; }
trap cleanup EXIT INT TERM
[[ ! -d "$NODE_DIR" ]] || fail "$NODE_DIR already exists"
"$ROOT/scripts/devnet.sh" addnode "$NODE" edge >/dev/null
"$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null

NODE_DIR="$NODE_DIR" RPC="$RPC" node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
const cfg = JSON.parse(readFileSync(join(process.env.NODE_DIR, 'config.json'), 'utf8'));
const wallets = JSON.parse(readFileSync(join(process.env.NODE_DIR, 'wallets.json'), 'utf8'));
const key = (wallets.wallets ?? [])[0]?.privateKey;
const tokenAddress = cfg.chain?.tokenAddress;
if (!key || !tokenAddress) throw new Error('temporary node wallet/token config missing');
const provider = new ethers.JsonRpcProvider(process.env.RPC);
const wallet = new ethers.Wallet(key, provider);
const token = new ethers.Contract(tokenAddress, [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
], wallet);
const balance = await token.balanceOf(wallet.address);
if (balance > 0n) await (await token.transfer('0x000000000000000000000000000000000000dEaD', balance)).wait();
if (await token.balanceOf(wallet.address) !== 0n) throw new Error('TRAC drain failed');
NODE

"$ROOT/scripts/devnet.sh" restart-node "$NODE" >/dev/null
. "$ROOT/scripts/devnet-lib.sh"
for _ in $(seq 1 90); do
  [[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] && break
  sleep 1
done
[[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] || fail "temporary node not ready"
api "$NODE" POST /api/identity/ensure '{}' >/dev/null || true

name="issue-1573-$(date +%s)-$$"; subject="urn:issue:1573:$name"
api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$name\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/write" \
  "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"unfunded probe\\\"\",\"graph\":\"\"}]}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CG\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CG\"}" >/dev/null

started="$(date +%s)"
response="$(api "$NODE" POST "/api/knowledge-assets/$name/vm/publish" "{\"contextGraphId\":\"$CG\"}")"
elapsed=$(( $(date +%s) - started ))
body="$(body_of "$response")"
[[ "$(code_of "$response")" != 200 ]] || fail "unfunded publish unexpectedly succeeded"
[[ "$body" == *NO_FUNDED_PUBLISHER_WALLET* ]] || fail "missing stable funds diagnostic: $body"
[[ "$elapsed" -lt 20 ]] || fail "rejection took ${elapsed}s, suggesting ACK collection ran first"
echo "[#1573] PASS: zero-TRAC publish rejected in ${elapsed}s before ACK collection"
