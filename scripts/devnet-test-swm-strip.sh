#!/usr/bin/env bash
#
# Rung-1 SWM strip regression — a non-participant CORE custodies ZERO private-CG
# SWM ciphertext, while the member still converges from the curator.
#
# Host-mode (LU-6) custody is core-only and engaged automatically for any curated
# CG a core discovers (chain-event / beacon). The strip gates that on "am I a
# participant": a third-party core declines, so it writes NO `swm-host/*.meta`
# for the CG. Members consume via member-mode (they never touch the host-mode
# store — see the `sharedMemoryGossipRegistered` skip at reconcile), so the
# ONLY nodes that ever create a host-mode `.meta` for a curated CG are
# host-only cores. That makes the disk a clean discriminator.
#
# Controls (all in ONE run, per the test-design review):
#   node1 curator (participant), node2 member (participant)
#   node3 BASELINE bystander core — swmHostMode.stripNonParticipants=FALSE
#         ⇒ legacy auto-host: it SHOULD host (proves it *would* have, pre-strip)
#   node4 STRIP    bystander core — stripNonParticipants=TRUE (default)
#         ⇒ it MUST hold zero `.meta` for the private CG
#
#   G-baseline : node3 (strip off) DOES create a host-mode .meta for the CG
#                (without this, "node4 holds zero" proves nothing)
#   G-strip    : node4 (strip on)  creates ZERO .meta for the CG  ← the proof
#   G-backfill : member (node2) converges to the curator's SWM (positive control)
#   G-absent   : with BOTH bystander cores stopped, an offline member still
#                converges from the curator on reconnect (cores not needed)
#
# Preconditions (run a devnet free of any other):
#   ./scripts/devnet.sh clean
#   ./scripts/devnet.sh start 4         # node1-4 all core (NUM_CORE_NODES>=4)
#   # then patch node3 to strip-off + restart it (this script does it for you if
#   # PATCH_NODE3=1, the default).
#
# Uses only the daemon HTTP API + on-disk host-mode store inspection.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CURATOR_NODE="${CURATOR_NODE:-1}"
MEMBER_NODE="${MEMBER_NODE:-2}"
BASELINE_NODE="${BASELINE_NODE:-3}"   # strip OFF — should host
STRIP_NODE="${STRIP_NODE:-4}"         # strip ON  — must hold zero
PATCH_NODE3="${PATCH_NODE3:-1}"
TMPDIR="${TMPDIR:-/tmp}"

PRED="http://schema.org/name"
ROOT="urn:swm:strip-root"

log()  { echo "[strip] $*"; }
fail() { echo "[strip] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[strip] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }

# Count host-mode store .meta files (one per curated CG this core custodies).
swm_host_meta_count() { local d; d="$(node_dir "$1")/swm-host"; [ -d "$d" ] && find "$d" -maxdepth 1 -name '*.meta' 2>/dev/null | wc -l | tr -d ' ' || echo 0; }

# The wire-id (keccak256 of the cleartext CG id) — the form host-mode logs/keys use.
cg_wire_id() { CGW="$1" node -e 'const {ethers}=require("ethers");process.stdout.write(ethers.keccak256(ethers.toUtf8Bytes(process.env.CGW)).toLowerCase())' 2>/dev/null; }

# Count LU-11 ciphertext-chunk quads this node holds (ANY graph). Global query
# (no contextGraphId scope) so the urn:dkg:swm:ciphertext-chunks/* graphs are
# visible. SWM direct writes (agent.share) do NOT chunk — chunking is a VM-publish
# surface (M6) — so this should read 0 on every node here; asserting node4==0 is a
# cheap corroboration that the strip leaves no ciphertext on the chunk surface either.
chunk_count() {
  local node="$1"
  api_call "$node" POST /api/query '{"sparql":"SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s <urn:dkg:swm:v10-publish-ciphertext-chunk-bytes> ?o } }"}' \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const j=JSON.parse(d);const b=j?.result?.bindings??j?.bindings??[];const v=b[0]&&((b[0].c&&b[0].c.value)??b[0].c);console.log(v==null?"0":String(v))}catch{console.log("0")}})'
}

require_node() {
  [ -d "$(node_dir "$1")" ] || fail "node $1 home missing; run ./scripts/devnet.sh start 4 first"
  [ -n "$(node_token "$1")" ] || fail "node $1 auth token missing"
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port token tmp code
  port=$(node_port "$node"); token=$(node_token "$node")
  tmp="$(mktemp "$TMPDIR/strip-XXXXXX")"
  local -a args=(-sS --max-time 180 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X "$method"
    -H "Authorization: Bearer $token" -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(--data "$data")
  code=$(curl "${args[@]}" "http://127.0.0.1:${port}${path}" || echo "000")
  cat "$tmp"; rm -f "$tmp"
  [[ "$code" =~ ^2 ]] || { echo "[strip] HTTP $code on $method $path" >&2; return 1; }
}

parse_json() { JQ_PATH="$2" node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const p=process.env.JQ_PATH.replace(/^\./,"").split(".");let v=j;for(const k of p)v=v?.[k];console.log(v==null?"":v)})' <<<"$1"; }
identity_field() { local body; body="$(api_call "$1" GET /api/agent/identity)"; parse_json "$body" ".$2"; }

swm_values() {
  local node="$1" subj="$2" q
  q=$(CG="$CG_ID" R="$subj" P="$PRED" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,graphSuffix:"_shared_memory",sparql:`SELECT DISTINCT ?v WHERE { GRAPH ?g { <${process.env.R}> <${process.env.P}> ?v } }`}))')
  api_call "$node" POST /api/query "$q" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const b=j?.result?.bindings??j?.bindings??[];const vals=b.map(r=>String((r.v&&r.v.value)??r.v??"").replace(/^"|"$/g,"")).filter(Boolean).sort();console.log(JSON.stringify(vals))})'
}

share_value() {
  local node="$1" subj="$2" value="$3" payload
  payload=$(CG="$CG_ID" R="$subj" P="$PRED" V="$value" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,quads:[{subject:process.env.R,predicate:process.env.P,object:JSON.stringify(process.env.V),graph:""}]}))')
  api_call "$node" POST /api/shared-memory/write "$payload" >/dev/null
}

wait_down() { local p; p=$(node_port "$1"); for _ in $(seq 1 60); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null || return 0; sleep 0.5; done; fail "node $1 still up"; }
wait_up()   { local p; p=$(node_port "$1"); for _ in $(seq 1 240); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null && return 0; sleep 0.5; done; fail "node $1 never came up"; }
stop_node() {
  local n="$1" pidf port pids
  pidf="$DEVNET_DIR/node${n}/devnet.pid"; port=$(node_port "$n")
  pids=$({ [ -f "$pidf" ] && cat "$pidf"; lsof -ti "tcp:$port" 2>/dev/null; } | sort -u)
  for pid in $pids; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 15); do lsof -ti "tcp:$port" >/dev/null 2>&1 || break; sleep 1; done
  for pid in $(lsof -ti "tcp:$port" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
  rm -f "$pidf"; wait_down "$n"
}
start_node() { "$REPO_ROOT/scripts/devnet.sh" restart-node "$1" >/dev/null 2>&1 || true; wait_up "$1"; }

await_values() {
  local node="$1" subj="$2" want="$3" secs="${4:-120}" got
  for _ in $(seq 1 "$((secs*2))"); do
    got="$(swm_values "$node" "$subj")"
    [ "$got" = "$want" ] && { echo "$got"; return 0; }
    sleep 0.5
  done
  swm_values "$node" "$subj"; return 1
}

# ───────────────────────────────────────────────────────────────────────────
for n in "$CURATOR_NODE" "$MEMBER_NODE" "$BASELINE_NODE" "$STRIP_NODE"; do require_node "$n"; done

# Patch the BASELINE node to strip-OFF (legacy auto-host) and restart it, so the
# run carries its own discriminator. Idempotent: skip if already set.
if [ "$PATCH_NODE3" = "1" ]; then
  act "0a. patch node$BASELINE_NODE → swmHostMode.stripNonParticipants=false (baseline control)"
  CFG="$(node_dir "$BASELINE_NODE")/config.json"
  node -e '
    const fs=require("fs"); const f=process.argv[1];
    const c=JSON.parse(fs.readFileSync(f,"utf8"));
    c.swmHostMode=Object.assign({},c.swmHostMode,{stripNonParticipants:false});
    fs.writeFileSync(f,JSON.stringify(c,null,2));
  ' "$CFG"
  log "patched; restarting node$BASELINE_NODE"
  stop_node "$BASELINE_NODE"; start_node "$BASELINE_NODE"
fi

CURATOR_AGENT="$(identity_field "$CURATOR_NODE" agentAddress)"
MEMBER_AGENT="$(identity_field "$MEMBER_NODE" agentAddress)"
CURATOR_PEER="$(identity_field "$CURATOR_NODE" peerId)"
[ -n "$CURATOR_AGENT" ] && [ -n "$MEMBER_AGENT" ] || fail "could not resolve agent identities"

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/strip-${STAMP}"
ALLOWED='["'"$CURATOR_AGENT"'", "'"$MEMBER_AGENT"'"]'   # node3/node4 deliberately NOT participants
log "curator =$CURATOR_AGENT (node$CURATOR_NODE)"
log "member  =$MEMBER_AGENT (node$MEMBER_NODE)"
log "baseline=node$BASELINE_NODE (strip OFF, must host)   strip=node$STRIP_NODE (strip ON, must hold zero)"
log "cg      =$CG_ID  (private, accessPolicy=1)"

act "0b. create + register private CG (curator + member participants only)"
B3_BEFORE=$(swm_host_meta_count "$BASELINE_NODE"); B4_BEFORE=$(swm_host_meta_count "$STRIP_NODE")
log "host-mode .meta before: node$BASELINE_NODE=$B3_BEFORE  node$STRIP_NODE=$B4_BEFORE"
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "{ \"id\": \"$CG_ID\", \"name\": \"strip $STAMP\", \"accessPolicy\": 1, \"publishPolicy\": 0, \"allowedAgents\": $ALLOWED, \"register\": true }")
ON_CHAIN_ID=$(parse_json "$CREATE" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE"
api_call "$MEMBER_NODE" POST /api/context-graph/create "{ \"id\": \"$CG_ID\", \"name\": \"strip $STAMP (member)\", \"accessPolicy\": 1, \"publishPolicy\": 0, \"allowedAgents\": $ALLOWED }" >/dev/null || true
api_call "$CURATOR_NODE" POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}" >/dev/null
api_call "$MEMBER_NODE"  POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}" >/dev/null
sleep 3
log "✓ CG onChainId=$ON_CHAIN_ID"

act "1. curator shares ROOT=v1"
share_value "$CURATOR_NODE" "$ROOT" "v1"

act "G-backfill — member converges to [v1] from the curator (positive control)"
GOT="$(await_values "$MEMBER_NODE" "$ROOT" '["v1"]' 90)" || fail "member never received v1 (got $GOT)"
log "member holds [v1] ✓ (backfill via curator works)"

act "wait for bystander cores to discover the curated CG + run host-mode reconcile"
# Poll up to 90s for the BASELINE node (strip off) to host — that appearance is
# the discriminator. The STRIP node is checked over the SAME window.
B3_DELTA=0
for _ in $(seq 1 90); do
  B3_DELTA=$(( $(swm_host_meta_count "$BASELINE_NODE") - B3_BEFORE ))
  [ "$B3_DELTA" -ge 1 ] && break
  sleep 1
done
B4_AFTER=$(swm_host_meta_count "$STRIP_NODE"); B4_DELTA=$(( B4_AFTER - B4_BEFORE ))
B3_AFTER=$(swm_host_meta_count "$BASELINE_NODE")
log "host-mode .meta after:  node$BASELINE_NODE=$B3_AFTER (Δ$B3_DELTA)  node$STRIP_NODE=$B4_AFTER (Δ$B4_DELTA)"

act "G-baseline — node$BASELINE_NODE (strip OFF) DID auto-host the private CG"
[ "$B3_DELTA" -ge 1 ] || fail "baseline node never hosted (Δ=$B3_DELTA) — bystanders don't auto-host on this devnet; the strip test can't discriminate. Check chain-event/beacon discovery."
log "baseline node hosted the private CG (Δ=$B3_DELTA) ✓ — a non-participant core WOULD hold ciphertext without the strip"

act "G-strip — node$STRIP_NODE (strip ON) custodies ZERO ciphertext for the private CG"
[ "$B4_DELTA" -eq 0 ] || fail "STRIP node hosted the private CG (Δ=$B4_DELTA) — strip FAILED, ciphertext leaked to a non-participant core"
# Corroboration: the DECLINE log keys on the WIRE id (keccak of the cleartext cg).
WIRE_ID="$(cg_wire_id "$CG_ID")"
if [ -n "$WIRE_ID" ] && grep -q "DECLINED for \"$WIRE_ID\"" "$(node_log "$STRIP_NODE")" 2>/dev/null; then
  log "strip node logged the DECLINE for wireId=$WIRE_ID ✓ (it discovered the CG and the gate fired)"
else
  log "note: no DECLINE log matched wireId=$WIRE_ID on node$STRIP_NODE (Δ=0 still proves zero custody)"
fi
# Second custody surface: the LU-11 chunk store. SWM writes don't chunk (VM-only,
# M6), so this is 0 everywhere here — assert node$STRIP_NODE==0 regardless so a
# future change that routed SWM through the chunk path can't silently leak.
C3="$(chunk_count "$BASELINE_NODE")"; C4="$(chunk_count "$STRIP_NODE")"
log "chunk-store quads: node$BASELINE_NODE=$C3  node$STRIP_NODE=$C4 (SWM doesn't chunk → both 0 expected)"
[ "$C4" = "0" ] || fail "STRIP node holds $C4 ciphertext-chunk quads — chunk-surface leak"
log "strip node holds ZERO private SWM ciphertext on BOTH surfaces (host-mode store + chunk store) ✓"

act "G-public — a bystander core is UNAFFECTED for a PUBLIC CG (no-op delta)"
# The gate sits AFTER the `if (!curated) return` in the subscribe path, so a
# public CG must never reach it. Register a public CG and assert node$STRIP_NODE
# never logs a strip DECLINE for it.
PUB_CG="${CURATOR_AGENT}/strip-pub-${STAMP}"
api_call "$CURATOR_NODE" POST /api/context-graph/create "{ \"id\": \"$PUB_CG\", \"name\": \"strip-pub $STAMP\", \"accessPolicy\": 0, \"publishPolicy\": 0, \"register\": true }" >/dev/null || fail "public CG create failed"
PUB_WIRE="$(cg_wire_id "$PUB_CG")"
sleep 15  # let the chain-event poller + reconcile run on the bystander
if grep -q "DECLINED for \"$PUB_WIRE\"" "$(node_log "$STRIP_NODE")" 2>/dev/null; then
  fail "strip gate fired for a PUBLIC CG (wireId=$PUB_WIRE) — public no-op delta VIOLATED"
fi
log "no strip DECLINE for the public CG on node$STRIP_NODE ✓ (gate is curated-only; public unaffected)"

act "G-absent — member still converges with BOTH bystander cores stopped"
stop_node "$BASELINE_NODE"; stop_node "$STRIP_NODE"
log "stopped node$BASELINE_NODE + node$STRIP_NODE (bystander cores gone)"
stop_node "$MEMBER_NODE"
share_value "$CURATOR_NODE" "$ROOT" "v3"; sleep 2
[ "$(swm_values "$CURATOR_NODE" "$ROOT")" = '["v3"]' ] || fail "curator not [v3]"
start_node "$MEMBER_NODE"
M_AFTER="$(await_values "$MEMBER_NODE" "$ROOT" '["v3"]' 150)" \
  || fail "member did not converge to [v3] with bystander cores absent (got $M_AFTER)"
log "member converged to [v3] with no bystander core present ✓ (curator is the sole holder)"

echo ""
log "PASS — non-participant core holds ZERO private SWM ciphertext (G-strip),"
log "       proven against a live baseline (G-baseline) and a working curator backfill"
log "       (G-backfill) that survives bystander-core absence (G-absent)."
log "SCOPE: this is the SWM half. VM-payload private ciphertext (published KA chunks)"
log "       still reaches cores — that is the M5/M6 work, not covered here."
