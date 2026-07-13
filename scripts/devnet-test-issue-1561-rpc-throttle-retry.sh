#!/usr/bin/env bash
# Live-devnet regression for #1561. A temporary node uses two logical RPC
# endpoints behind a fault proxy. The first eth_getBlockByNumber on each endpoint
# returns 429 (one complete throttled pool); the next pool pass forwards and the
# publish must confirm.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
UPSTREAM="${DEVNET_RPC:-http://127.0.0.1:8545}"
PROXY_PORT="${THROTTLE_PROXY_PORT:-18561}"
NODE="${THROTTLE_TEST_NODE:-7}"
NODE_DIR="$DEVNET_DIR/node$NODE"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
proxy_pid=''

fail() { echo "[#1561] FAIL: $*" >&2; exit 1; }
cleanup() {
  "$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null 2>&1 || true
  rm -rf "$NODE_DIR"
  [[ -n "$proxy_pid" ]] && kill "$proxy_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
[[ ! -d "$NODE_DIR" ]] || fail "$NODE_DIR already exists"

UPSTREAM="$UPSTREAM" PROXY_PORT="$PROXY_PORT" node --input-type=module <<'NODE' &
import http from 'node:http';
const counts = new Map();
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/stats') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(Object.fromEntries(counts)));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  let method = '';
  try { method = JSON.parse(body.toString()).method; } catch {}
  const key = `${req.url}:${method}`;
  const count = counts.get(key) ?? 0;
  counts.set(key, count + 1);
  if (method === 'eth_getBlockByNumber' && count === 0) {
    res.statusCode = 429;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Too Many Requests' }));
  }
  const upstream = await fetch(process.env.UPSTREAM, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  res.statusCode = upstream.status;
  res.end(Buffer.from(await upstream.arrayBuffer()));
}).listen(Number(process.env.PROXY_PORT), '127.0.0.1');
NODE
proxy_pid=$!
sleep 1
curl -fsS "http://127.0.0.1:$PROXY_PORT/stats" >/dev/null || fail "fault proxy did not start"

"$ROOT/scripts/devnet.sh" addnode "$NODE" edge >/dev/null
"$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null
NODE_DIR="$NODE_DIR" PROXY_PORT="$PROXY_PORT" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const path = join(process.env.NODE_DIR, 'config.json');
const config = JSON.parse(readFileSync(path, 'utf8'));
const base = `http://127.0.0.1:${process.env.PROXY_PORT}`;
config.chain.rpcUrl = `${base}/a`;
config.chain.rpcUrls = [`${base}/a`, `${base}/b`];
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

name="issue-1561-$(date +%s)-$$"; subject="urn:issue:1561:$name"
api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$name\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/write" \
  "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"429 recovery probe\\\"\",\"graph\":\"\"}]}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CG\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CG\"}" >/dev/null
result="$(api "$NODE" POST "/api/knowledge-assets/$name/vm/publish" "{\"contextGraphId\":\"$CG\"}")"
[[ "$(code_of "$result")" == 200 ]] || fail "publish failed: $(body_of "$result")"
[[ "$(field "$(body_of "$result")" status)" == confirmed ]] || fail "publish not confirmed"

stats="$(curl -fsS "http://127.0.0.1:$PROXY_PORT/stats")"
STATS="$stats" node -e 'const s=JSON.parse(process.env.STATS); for (const p of ["/a","/b"]) { const n=s[`${p}:eth_getBlockByNumber`]||0; if(n<2) throw new Error(`${p} getBlock calls=${n}, expected throttle plus recovery`); }' \
  || fail "proxy did not observe a full throttled pass plus recovery: $stats"
echo "[#1561] PASS: publish recovered after both RPC endpoints returned 429"
