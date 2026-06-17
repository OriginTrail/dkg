#!/usr/bin/env bash
#
# Curator-leader convergence regression (AUTOMATIC on-reconnect path).
#
# Unlike devnet-test-swm-recovery.sh (which drives the EXPLICIT recover
# endpoint), this exercises the automatic sync-on-connect path through the
# member→curator REPLACE gate: a stale member that reconnects must converge to
# the curator's current private shared-memory state WITHOUT any manual call, and
# the curator must NOT be polluted in reverse.
#
# Writes model a real UPDATE of one fact via direct /api/shared-memory/write
# (per-SUBJECT REPLACE on the base graph, single-valued). This is the ONLY
# working in-place update path — see share_value below for why the KA-share /
# finalized-KA paths are not updates. The same-graph v1->v2->v3 update is exactly
# what exercises the gossip-vs-sync union bug the gate fixes: live gossip REPLACEs
# per (graph,subject), but the catch-up SYNC historically blind-unioned, so a
# member holding v1 that re-synced the same graph at v3 ended up {v1,v3}.
#
#   A. Corruption fix + curator-skip (HARD GATE)
#      1. node1 (curator) shares ROOT=v1; node2 (member) catches up -> [v1].
#      2. node2 stopped; node1 updates ROOT v2 then v3 -> node1 [v3].
#      3. node2 restarted -> automatic on-connect sync converges it.
#      4. assert node2 == [v3]  (REPLACE, not the {v1,v3} union bug)
#         assert node1 == [v3]  (curator never reverse-syncs a CG it owns)
#
#   B. Member-local root the curator LACKS survives (HARD GATE)
#      per-root REPLACE only clears roots the curator sent; a member-only root
#      (written while the curator was down) must survive the next sync.
#
#   C. Offline SAME-root member write (DIAGNOSTIC, not a gate)
#      a member's offline re-write of a root the curator already knows is
#      clobbered by the pull (no member->curator push yet). This is the known
#      gap the seqno watermark + push close; the script reports it, never fails
#      on it, so A/B remain the M2-a gate.
#
# Preconditions (run a devnet free of your other one):
#   ./scripts/devnet.sh clean
#   ./scripts/devnet.sh start 2
#
# Uses only the daemon HTTP API.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
CURATOR_NODE="${CURATOR_NODE:-1}"
MEMBER_NODE="${MEMBER_NODE:-2}"
TMPDIR="${TMPDIR:-/tmp}"

PRED="http://schema.org/name"
ROOT="urn:swm:converge-root"
ROOT2="urn:swm:member-only-root"

log()  { echo "[converge] $*"; }
fail() { echo "[converge] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[converge] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

require_node() {
  [ -d "$(node_dir "$1")" ] || fail "node $1 home missing; run ./scripts/devnet.sh start 2 first"
  [ -n "$(node_token "$1")" ] || fail "node $1 auth token missing"
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port token tmp code
  port=$(node_port "$node"); token=$(node_token "$node")
  tmp="$(mktemp "$TMPDIR/converge-XXXXXX")"
  local -a args=(-sS --max-time 180 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X "$method"
    -H "Authorization: Bearer $token" -H "Content-Type: application/json")
  [ -n "$data" ] && args+=(--data "$data")
  code=$(curl "${args[@]}" "http://127.0.0.1:${port}${path}" || echo "000")
  cat "$tmp"; rm -f "$tmp"
  [[ "$code" =~ ^2 ]] || { echo "[converge] HTTP $code on $method $path" >&2; return 1; }
}

parse_json() { JQ_PATH="$2" node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const p=process.env.JQ_PATH.replace(/^\./,"").split(".");let v=j;for(const k of p)v=v?.[k];console.log(v==null?"":v)})' <<<"$1"; }

identity_field() { local body; body="$(api_call "$1" GET /api/agent/identity)"; parse_json "$body" ".$2"; }

# DISTINCT object values for a subject across ALL of the CG's _shared_memory
# graphs (base bucket + any per-KA subgraphs). The GRAPH ?g form is required:
# the no-GRAPH form routes only to per-KA subgraphs and SHADOWS the base bucket
# once any per-KA graph exists (a real read-path quirk; verified on devnet).
swm_values() {
  local node="$1" subj="$2" q
  q=$(CG="$CG_ID" R="$subj" P="$PRED" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,graphSuffix:"_shared_memory",sparql:`SELECT DISTINCT ?v WHERE { GRAPH ?g { <${process.env.R}> <${process.env.P}> ?v } }`}))')
  api_call "$node" POST /api/query "$q" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const b=j?.result?.bindings??j?.bindings??[];const vals=b.map(r=>String((r.v&&r.v.value)??r.v??"").replace(/^"|"$/g,"")).filter(Boolean).sort();console.log(JSON.stringify(vals))})'
}

# Canonical SWM fact write/UPDATE: direct write to the base _shared_memory graph,
# which does per-SUBJECT REPLACE (single-valued, last-write-wins) and gossips to
# connected members. This is the only working in-place update path: the KA-share
# path is per-asset APPEND (each asset its own graph, by design), and a finalized
# KA's value cannot be superseded in place (the finalization seal hard-rejects
# re-finalize). No publish: publish needs a 3-core ACK quorum unavailable on a
# 2-node devnet, and the gossip from the write itself already propagates.
share_value() {
  local node="$1" subj="$2" value="$3" payload
  payload=$(CG="$CG_ID" R="$subj" P="$PRED" V="$value" node -e 'console.log(JSON.stringify({contextGraphId:process.env.CG,quads:[{subject:process.env.R,predicate:process.env.P,object:JSON.stringify(process.env.V),graph:""}]}))')
  api_call "$node" POST /api/shared-memory/write "$payload" >/dev/null
}

wait_down() { local p; p=$(node_port "$1"); for _ in $(seq 1 60); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null || return 0; sleep 0.5; done; fail "node $1 still up"; }
wait_up()   { local p; p=$(node_port "$1"); for _ in $(seq 1 240); do curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$p/api/status" 2>/dev/null && return 0; sleep 0.5; done; fail "node $1 never came up"; }
# Stop ONE node only (devnet.sh `stop` tears down the whole devnet, so kill the
# single pid directly — same logic cmd_restart_node uses — leaving the curator
# and Hardhat running).
stop_node() {
  local n="$1"
  local pidf="$DEVNET_DIR/node${n}/devnet.pid"
  local port; port=$(node_port "$n")
  # Kill BOTH the pid-file pid (supervisor) AND whatever actually listens on the
  # API port (the daemon can leave orphans that the pid file doesn't track, which
  # otherwise keep the node "up" so it never goes offline for the test).
  local pids
  pids=$({ [ -f "$pidf" ] && cat "$pidf"; lsof -ti "tcp:$port" 2>/dev/null; } | sort -u)
  for pid in $pids; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  for _ in $(seq 1 15); do
    lsof -ti "tcp:$port" >/dev/null 2>&1 || break
    sleep 1
  done
  for pid in $(lsof -ti "tcp:$port" 2>/dev/null); do kill -9 "$pid" 2>/dev/null || true; done
  rm -f "$pidf"
  wait_down "$n"
}
# Bring ONE node back via restart-node (its stop-step no-ops on the dead pid,
# then start_node boots it against the still-running chain).
start_node() { "$REPO_ROOT/scripts/devnet.sh" restart-node "$1" >/dev/null 2>&1 || true; wait_up "$1"; }

# Poll node $1 until subject $2 reads exactly $3 (JSON array) or timeout.
await_values() {
  local node="$1" subj="$2" want="$3" secs="${4:-120}" got
  for _ in $(seq 1 "$((secs*2))"); do
    got="$(swm_values "$node" "$subj")"
    [ "$got" = "$want" ] && { echo "$got"; return 0; }
    sleep 0.5
  done
  swm_values "$node" "$subj"; return 1
}

require_node "$CURATOR_NODE"; require_node "$MEMBER_NODE"
CURATOR_AGENT="$(identity_field "$CURATOR_NODE" agentAddress)"
MEMBER_AGENT="$(identity_field "$MEMBER_NODE" agentAddress)"
CURATOR_PEER="$(identity_field "$CURATOR_NODE" peerId)"
[ -n "$CURATOR_AGENT" ] && [ -n "$MEMBER_AGENT" ] || fail "could not resolve agent identities"

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/converge-${STAMP}"
ALLOWED='["'"$CURATOR_AGENT"'", "'"$MEMBER_AGENT"'"]'
log "curator=$CURATOR_AGENT (node$CURATOR_NODE, peer=$CURATOR_PEER)"
log "member =$MEMBER_AGENT (node$MEMBER_NODE)"
log "cg     =$CG_ID  (private, accessPolicy=1)"

act "0. create private CG (curator registers; member pre-creates) + subscribe"
CREATE=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "{ \"id\": \"$CG_ID\", \"name\": \"converge $STAMP\", \"accessPolicy\": 1, \"publishPolicy\": 0, \"allowedAgents\": $ALLOWED, \"register\": true }")
ON_CHAIN_ID=$(parse_json "$CREATE" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE"
# The MEMBER pre-creates the CG locally with the same allowlist — the established
# rfc38 multi-member onboarding pattern. This stamps the MEMBER's own wallet as a
# `dkg:curator` triple alongside the real curator's, which used to make
# isCuratorOf() resolve the member AS the curator and silently skip its recovery.
# The SWM gate now decides curatorship by the STRUCTURAL curator (the id prefix),
# so a pre-creating member still converges. (Validates the production fix, not a
# test workaround.)
api_call "$MEMBER_NODE" POST /api/context-graph/create "{ \"id\": \"$CG_ID\", \"name\": \"converge $STAMP (member)\", \"accessPolicy\": 1, \"publishPolicy\": 0, \"allowedAgents\": $ALLOWED }" >/dev/null || true
api_call "$CURATOR_NODE" POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}" >/dev/null
api_call "$MEMBER_NODE"  POST /api/context-graph/subscribe "{\"contextGraphId\":\"$CG_ID\",\"includeSharedMemory\":true}" >/dev/null
sleep 3
log "✓ CG onChainId=$ON_CHAIN_ID, both subscribed"
sleep 3

# ===========================================================================
act "A. corruption fix + curator-skip (HARD GATE)"
# ===========================================================================
log "A1. curator shares ROOT=v1; member catches up"
share_value "$CURATOR_NODE" "$ROOT" "v1"
GOT="$(await_values "$MEMBER_NODE" "$ROOT" '["v1"]' 60)" || fail "member never received v1 (got $GOT)"
log "member holds v1 ✓"

log "A2. stop member; curator updates v2 then v3"
stop_node "$MEMBER_NODE"
share_value "$CURATOR_NODE" "$ROOT" "v2"; sleep 2
share_value "$CURATOR_NODE" "$ROOT" "v3"; sleep 2
[ "$(swm_values "$CURATOR_NODE" "$ROOT")" = '["v3"]' ] || fail "curator not [v3] (got $(swm_values "$CURATOR_NODE" "$ROOT"))"
log "curator at v3, member offline ✓"

log "A3. restart member — automatic on-connect sync must converge it to [v3]"
start_node "$MEMBER_NODE"
log "member just after restart (pre-sync): $(swm_values "$MEMBER_NODE" "$ROOT")"
M_AFTER="$(await_values "$MEMBER_NODE" "$ROOT" '["v3"]' 150)" \
  || fail "member did not converge to [v3] automatically (got $M_AFTER — a union bug would be [\"v1\",\"v3\"])"
log "member converged to [v3] automatically ✓"

log "A4. curator must be unpolluted (no reverse-sync of a CG it owns)"
C_AFTER="$(swm_values "$CURATOR_NODE" "$ROOT")"
[ "$C_AFTER" = '["v3"]' ] || fail "curator polluted to $C_AFTER (expected [\"v3\"]) — reverse-sync leaked"
log "curator still [v3] ✓"
log "GATE A PASS — automatic REPLACE convergence, no union, no reverse pollution."

# ===========================================================================
act "B. member-local root the curator LACKS survives (HARD GATE)"
# ===========================================================================
log "B1. stop curator; member writes a brand-new root the curator never sees"
stop_node "$CURATOR_NODE"
share_value "$MEMBER_NODE" "$ROOT2" "memberonly"
[ "$(swm_values "$MEMBER_NODE" "$ROOT2")" = '["memberonly"]' ] || fail "member did not write ROOT2 (got $(swm_values "$MEMBER_NODE" "$ROOT2"))"
log "member holds ROOT2=[memberonly], curator offline ✓"

log "B2. restart curator; member re-syncs from it (curator lacks ROOT2)"
start_node "$CURATOR_NODE"
# give the on-connect sync time to run a full REPLACE cycle on ROOT
await_values "$MEMBER_NODE" "$ROOT" '["v3"]' 120 >/dev/null || true
sleep 5
B_ROOT2="$(swm_values "$MEMBER_NODE" "$ROOT2")"
[ "$B_ROOT2" = '["memberonly"]' ] || fail "member-only root was clobbered by REPLACE (got $B_ROOT2, expected [\"memberonly\"]) — per-root REPLACE leaked into untouched roots"
log "ROOT2 survived the sync ✓"
log "GATE B PASS — per-root REPLACE leaves member-local roots intact."

# ===========================================================================
act "C. offline SAME-root member write (DIAGNOSTIC — known M2-b gap)"
# ===========================================================================
log "C1. stop curator; member re-writes ROOT (same subject curator knows) offline"
stop_node "$CURATOR_NODE"
# The write itself may fail with the curator offline (SWM write needs the curator
# for ACK quorum on a curated CG) — that is ITSELF a finding for M2-b (offline-write
# durability), so tolerate it and report the resulting state below.
if share_value "$MEMBER_NODE" "$ROOT" "vmember"; then
  log "member wrote ROOT=vmember locally (state now $(swm_values "$MEMBER_NODE" "$ROOT"))"
else
  log "DIAGNOSTIC: member's offline SWM write was REJECTED (curator offline) — relevant to M2-b member->curator push / offline durability"
fi

log "C2. restart curator (still [v3]); member re-syncs"
start_node "$CURATOR_NODE"
sleep 12
C_ROOT="$(swm_values "$MEMBER_NODE" "$ROOT")"
case "$C_ROOT" in
  '["v3"]')        log "DIAGNOSTIC: offline member write CLOBBERED -> [v3]. EXPECTED in M2-a (no member->curator push). The seqno watermark + push (M2-b) close this." ;;
  '["vmember"]')   log "DIAGNOSTIC: offline member write PRESERVED -> [vmember] (curator absorbed it or pull was skipped)." ;;
  *)               log "DIAGNOSTIC: UNEXPECTED state -> $C_ROOT (a union here would indicate the corruption bug regressed)." ;;
esac

echo ""
log "PASS — gates A+B green (automatic curator-REPLACE convergence, no union, no collateral loss)."
log "       C is a diagnostic for the M2-b member->curator push, not a gate."
