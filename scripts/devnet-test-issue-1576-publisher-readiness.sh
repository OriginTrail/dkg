#!/usr/bin/env bash
# Live-devnet regression for #1576. A temporary edge node is started with
# publisher.enabled=true but no publisher wallet. publish-async must return 503
# before persistence, and the durable publisher job count must not change.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NODE="${PUBLISHER_READINESS_NODE:-7}"
NODE_DIR="$DEVNET_DIR/node$NODE"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"

fail() { echo "[#1576] FAIL: $*" >&2; exit 1; }
cleanup() {
  "$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null 2>&1 || true
  rm -rf "$NODE_DIR"
}
trap cleanup EXIT INT TERM

[[ -d "$DEVNET_DIR/node1" ]] || fail "start the baseline devnet first"
[[ ! -d "$NODE_DIR" ]] || fail "$NODE_DIR already exists; choose PUBLISHER_READINESS_NODE"
"$ROOT/scripts/devnet.sh" addnode "$NODE" edge >/dev/null
"$ROOT/scripts/devnet.sh" stop-node "$NODE" >/dev/null

NODE_DIR="$NODE_DIR" node --input-type=module <<'NODE'
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const path = join(process.env.NODE_DIR, 'config.json');
const config = JSON.parse(readFileSync(path, 'utf8'));
config.publisher = { ...(config.publisher ?? {}), enabled: true };
writeFileSync(path, JSON.stringify(config, null, 2));
rmSync(join(process.env.NODE_DIR, 'publisher-wallets.json'), { force: true });
NODE
"$ROOT/scripts/devnet.sh" restart-node "$NODE" >/dev/null

. "$ROOT/scripts/devnet-lib.sh"
for _ in $(seq 1 90); do
  [[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] && break
  sleep 1
done
[[ "$(code_of "$(api "$NODE" GET /api/status)")" == 200 ]] || fail "temporary node did not become ready"
api "$NODE" POST /api/identity/ensure '{}' >/dev/null || true

jobs_before_body="$(body_of "$(api "$NODE" GET /api/publisher/jobs)")"
jobs_before="$(JOBS="$jobs_before_body" node -e 'const j=JSON.parse(process.env.JOBS);process.stdout.write(String((j.jobs||[]).length))')"

name="issue-1576-$(date +%s)-$$"
subject="urn:issue:1576:$name"
api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$name\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/write" \
  "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"publisher readiness probe\\\"\",\"graph\":\"\"}]}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CG\"}" >/dev/null
api "$NODE" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CG\"}" >/dev/null

response="$(api "$NODE" POST "/api/knowledge-assets/$name/vm/publish-async" "{\"contextGraphId\":\"$CG\"}")"
[[ "$(code_of "$response")" == 503 ]] || fail "expected 503, got $(code_of "$response"): $(body_of "$response")"
body="$(body_of "$response")"
[[ "$(field "$body" code)" == async_publisher_unavailable ]] || fail "wrong stable error code: $body"
[[ "$(field "$body" reason)" == no_publisher_wallets ]] || fail "wrong unavailable reason: $body"
[[ "$(field "$body" retryable)" == false ]] || fail "no-wallet state was advertised retryable"

jobs_after_body="$(body_of "$(api "$NODE" GET /api/publisher/jobs)")"
jobs_after="$(JOBS="$jobs_after_body" node -e 'const j=JSON.parse(process.env.JOBS);process.stdout.write(String((j.jobs||[]).length))')"
[[ "$jobs_after" == "$jobs_before" ]] || fail "job count grew from $jobs_before to $jobs_after"
echo "[#1576] PASS: unavailable publisher rejected before durable enqueue"
