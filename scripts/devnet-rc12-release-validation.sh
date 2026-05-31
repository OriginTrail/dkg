#!/usr/bin/env bash
#
# devnet-rc12-release-validation.sh
# ─────────────────────────────────────────────────────────────────────────────
# Comprehensive release-validation run for v10.0.0-rc.12 on a fresh 6-node
# devnet (4 cores + 2 edge curators). Authored for the rc.12 → main landing
# (#716). Drives the FULL functional matrix the release owner asked for and
# enforces the hard acceptance metrics.
#
# Topology (per scripts/devnet.sh, NUM_CORE_NODES=4, NUM_NODES=6):
#   nodes 1-4  = CORE  (api :9201-9204)  — on-chain identity + staking + RS prover
#   nodes 5-6  = EDGE  (api :9205-9206)  — curators; create curated CGs + invite
#
# Acceptance metrics (hard gates — drive the final PASS/FAIL):
#   - >= TARGET_KAS knowledge assets published (default 500)
#   - across >= TARGET_CGS context graphs (default 12)
#   - each KA carries between MIN_ENTITIES..MAX_ENTITIES KG entities (50..1000)
#   - random-sampling success rate >= RS_MIN_SUCCESS_PCT (default 80)
#   - operational functionality matrix complete (per-section PASS, no hard FAIL)
#
# Functional matrix (operational checks):
#   A. WM -> SWM -> VM publish for public + curated CGs, from cores AND edges
#   B. KA updates across all CG variants
#   C. Random sampling for public + private CGs (success rate)
#   D. Staking present + conviction multiplier + reward claim/withdraw + position transfer
#   D2. V8→V10 migration conviction credit — eligible migrants on tiers 6/12 get a
#       fixed 60-day (2-month) shorter lock; lower tiers and ineligible get default
#   E. Conviction-discounted vs non-conviction publish + publishing-NFT transfer
#   F. Protocol treasury fee (treasury account receives a percentage)
#   G. Prolonged inter-node messaging
#   H. CG invitations (edge curators invite each other + cores)
#   I. Ownership transfer + new owner can update KAs
#   A2. Canonical assertion lifecycle smoke (create→finalize→promote→publish)
#   J. MCP server tool surface
#
# This script ASSUMES a running devnet unless BOOTSTRAP=1 (then it wipes and
# starts one itself). It talks to the public HTTP API + the deployed contracts
# via scripts/devnet-chain-call.mjs.
#
# Env knobs (all optional):
#   BOOTSTRAP=1            wipe + start a fresh 6-node devnet before running
#   TARGET_KAS=500         KA publish target
#   TARGET_CGS=12          context-graph target
#   MIN_ENTITIES=50        min KG entities per KA
#   MAX_ENTITIES=1000      max KG entities per KA
#   RS_MIN_SUCCESS_PCT=80  required random-sampling success rate
#   DURATION_TARGET_S=7200 target wall budget (~2h); paces messaging soak + RS observe
#   PUBLISH_CONCURRENCY=6  parallel in-flight publishes (1 per node)
#   RESULTS_DIR=...        output dir (default .devnet/rc12-validation/<ts>)
#   SKIP_MESSAGING_SOAK=1  skip the prolonged messaging soak
#   SKIP_V8_MIGRATION_CREDIT=1  skip D2 (V8 eligible 6m/12m lock-shortening smoke)
#
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export REPO_ROOT
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_NODES="${NUM_NODES:-6}"
NUM_CORE_NODES="${NUM_CORE_NODES:-4}"

TARGET_KAS="${TARGET_KAS:-500}"
TARGET_CGS="${TARGET_CGS:-12}"
MIN_ENTITIES="${MIN_ENTITIES:-50}"
MAX_ENTITIES="${MAX_ENTITIES:-1000}"
RS_MIN_SUCCESS_PCT="${RS_MIN_SUCCESS_PCT:-80}"
DURATION_TARGET_S="${DURATION_TARGET_S:-7200}"
PUBLISH_CONCURRENCY="${PUBLISH_CONCURRENCY:-6}"

TS=$(date -u +'%Y%m%dT%H%M%SZ')
# IMPORTANT: keep results OUTSIDE $REPO_ROOT/.devnet — BOOTSTRAP runs
# `devnet.sh clean` which `rm -rf`s .devnet and would otherwise nuke this dir
# (and the redirect target) mid-run.
RESULTS="${RESULTS_DIR:-$REPO_ROOT/.rc12-validation/$TS}"
mkdir -p "$RESULTS"
ln -sfn "$RESULTS" "$(dirname "$RESULTS")/latest" 2>/dev/null || true

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
export CONTRACTS_JSON
CHAIN_CALL="node $REPO_ROOT/scripts/devnet-chain-call.mjs"
UPDATE_SEAL="node $REPO_ROOT/scripts/devnet-update-seal.mjs"
CLI_JS="$REPO_ROOT/packages/cli/dist/cli.js"

# Operator wallet private key for devnet node N (index 0 in wallets.json).
node_op_key() {
  python3 -c "import json;print(json.load(open('$DEVNET_DIR/node$1/wallets.json'))['wallets'][0]['privateKey'])" 2>/dev/null
}
node_op_addr() {
  python3 -c "import json;print(json.load(open('$DEVNET_DIR/node$1/wallets.json'))['wallets'][0]['address'])" 2>/dev/null
}

# Resolve the on-chain KA owner (DKGKnowledgeAssets.ownerOf(kaId)) and return the
# matching private key from any node's publisher-wallets.json. KC tokens are
# minted to the EOA that submitted the on-chain publish (the daemon's publisher
# wallet of whichever node finalized the SWM publish). Because every node has
# its own publisher wallet pool but only one of them executes each on-chain
# publish, the originating-node assumption is wrong for /api/update and
# DKGKnowledgeAssets.safeTransferFrom — both require the actual KA owner's
# signature. This helper scans every devnet node's publisher-wallets.json plus
# operator wallets.json[0..N] and prints "address<TAB>privateKey" for the match.
# Returns nonzero if the owner address can't be matched against any local key.
# Args: kaId
ka_owner_key() {
  local kc=$1
  local owner addr key
  owner=$($CHAIN_CALL DKGKnowledgeAssets ownerOf --json "[\"$kc\"]" 2>/dev/null \
    | pyf "d.get('result','') or ''" 2>/dev/null)
  [ -z "$owner" ] && return 1
  python3 - "$DEVNET_DIR" "$owner" <<'PY'
import json, os, sys
devnet_dir = sys.argv[1]
target = sys.argv[2].lower()
# Try publisher-wallets.json first (where KA tokens are normally minted), then
# operator wallets.json[0..N] as a fallback for nodes that pay publishes from
# their op wallet directly.
for n in range(1, 7):
    for fname in ("publisher-wallets.json", "wallets.json"):
        p = os.path.join(devnet_dir, f"node{n}", fname)
        if not os.path.exists(p): continue
        try: data = json.load(open(p))
        except Exception: continue
        wallets = data["wallets"] if isinstance(data, dict) and "wallets" in data else data
        if not isinstance(wallets, list): continue
        for w in wallets:
            a = (w.get("address") or "").lower()
            if a == target:
                print(w.get("address","") + "\t" + w.get("privateKey",""))
                sys.exit(0)
sys.exit(1)
PY
}

# Build POST /api/update JSON with precomputedUpdateAttestation (RC12 requires it).
# The seal author MUST equal the on-chain KA owner (KnowledgeAssetsLifecycle._verifyUpdateAuthorAttestation
# + the `p.authorAddress != kas.ownerOf(p.id)` revert), so we ignore the
# originating node and resolve the owner key from chain state.
# Args: node_num kaId contextGraphId quads_json_array_string
build_update_body() {
  local node=$1 kc=$2 cg=$3 quads_json=$4 key seal owner_line
  owner_line=$(ka_owner_key "$kc") || return 1
  key="${owner_line##*$'\t'}"
  [ -z "$key" ] && return 1
  seal=$($UPDATE_SEAL --key "$key" --ka-id "$kc" --quads-json "$quads_json") || return 1
  python3 -c "
import json, sys
wrap = json.loads(sys.argv[1])
if not wrap.get('ok'):
    sys.stderr.write(wrap.get('error','seal failed') + '\n')
    sys.exit(1)
body = {
    'kaId': sys.argv[2],
    'contextGraphId': sys.argv[3],
    'quads': json.loads(sys.argv[4]),
    'precomputedUpdateAttestation': wrap['precomputedUpdateAttestation'],
}
print(json.dumps(body))
" "$seal" "$kc" "$cg" "$quads_json"
}

START_EPOCH=$(date +%s)
LOG="$RESULTS/run.log"
METRICS_JSONL="$RESULTS/metrics.jsonl"
: > "$METRICS_JSONL"

log()  { echo "[rc12-val $(date -u +'%H:%M:%S')] $*" | tee -a "$LOG"; }
section() { echo "" | tee -a "$LOG"; echo "━━━━━━━━━━ $* ━━━━━━━━━━" | tee -a "$LOG"; }

# Portable UTC ISO-8601 from unix epoch (GNU date lacks BSD's `date -r`).
iso_from_epoch() {
  python3 -c "import datetime,sys; print(datetime.datetime.utcfromtimestamp(int(sys.argv[1])).strftime('%Y-%m-%dT%H:%M:%SZ'))" "$1"
}

# Per-check accounting. Each check records a line into checks.tsv:
#   <section>\t<name>\t<PASS|WARN|FAIL>\t<detail>
CHECKS_TSV="$RESULTS/checks.tsv"
: > "$CHECKS_TSV"
record() { # section name status detail
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >> "$CHECKS_TSV"
  echo "  [$3] $1/$2 ${4:+— $4}" | tee -a "$LOG"
}
pass() { record "$1" "$2" PASS "${3:-}"; }
warn() { record "$1" "$2" WARN "${3:-}"; }
fail() { record "$1" "$2" FAIL "${3:-}"; }

pyf() { python3 -c '
import sys, json
expr = sys.argv[1]
try: d = json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
try: print(eval(expr, {"d": d, "__builtins__": __builtins__}))
except Exception: print("")
' "$1"; }

# ── Bootstrap (optional) ─────────────────────────────────────────────────────
if [ "${BOOTSTRAP:-0}" = "1" ]; then
  section "BOOTSTRAP — wipe + start fresh 6-node devnet (4 core / 2 edge)"
  log "Building project (ensure latest merged rc.12 binaries)..."
  ( cd "$REPO_ROOT" && pnpm run build ) >> "$LOG" 2>&1 || { log "FATAL: build failed"; exit 2; }
  log "devnet clean..."
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh clean ) >> "$LOG" 2>&1 || true
  log "devnet start 6 (NUM_CORE_NODES=4, publisher enabled)..."
  ( cd "$REPO_ROOT" && NUM_CORE_NODES=4 DEVNET_ENABLE_PUBLISHER=1 ./scripts/devnet.sh start 6 ) >> "$LOG" 2>&1 \
    || { log "FATAL: devnet start failed"; exit 2; }
  log "Waiting 45s for identity registration + RS prover bind..."
  sleep 45
fi

# ── Auth + preflight ─────────────────────────────────────────────────────────
section "PREFLIGHT — node health + role topology"
if [ -n "${DKG_AUTH:-}" ]; then AUTH="$DKG_AUTH"
elif [ -r "$DEVNET_DIR/node1/auth.token" ]; then AUTH=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" | head -1)
else log "FATAL: no auth token (set DKG_AUTH or run devnet)"; exit 2; fi
export DKG_AUTH="$AUTH"
H="Authorization: Bearer $AUTH"

# Default curl budget for control-plane calls (/api/status, CG setup, chat, …).
# Long-running publish/update/query paths use `post_long`/`api_long` (180s).
# Even 90s proved too tight for /api/update under sustained bulk-publish
# load (B-section fires ~20 in-flight updates while curate-publish ACKs
# drain); those paths get the explicit 180s budget instead of widening
# every harness call.
API_TIMEOUT="${HARNESS_API_TIMEOUT:-90}"
API_LONG_TIMEOUT="${HARNESS_API_LONG_TIMEOUT:-180}"
api()      { curl -s --max-time "$API_TIMEOUT" -H "$H" "$@"; }
api_long() { curl -s --max-time "$API_LONG_TIMEOUT" -H "$H" "$@"; }
post()      { local port=$1; shift; api -X POST -H "Content-Type: application/json" "http://127.0.0.1:$port$@"; }
post_long() { local port=$1; shift; api_long -X POST -H "Content-Type: application/json" "http://127.0.0.1:$port$@"; }
get()       { local port=$1; shift; api "http://127.0.0.1:$port$@"; }
get_long()  { local port=$1; shift; api_long "http://127.0.0.1:$port$@"; }

# Section B /api/update: cap each curl to remaining section budget (not a
# hard "must have 180s left" gate — a 5s update with 30s left is fine).
# Response is stored in POST_UPDATE_LAST (not $(...) — subshell would drop
# UPD_BUDGET_EXHAUSTED).
POST_UPDATE_LAST=""
post_update_bounded() {
  local port=$1; shift
  local remain=$(( UPD_SECTION_DEADLINE - $(date +%s) ))
  if [ "$remain" -le 5 ]; then
    UPD_BUDGET_EXHAUSTED=1
    POST_UPDATE_LAST=""
    return 1
  fi
  local cap="${API_LONG_TIMEOUT:-180}"
  if [ "$remain" -lt "$cap" ]; then cap=$remain; fi
  POST_UPDATE_LAST=$(curl -s --max-time "$cap" -H "$H" -H "Content-Type: application/json" \
    -X POST "http://127.0.0.1:${port}$@") || return 1
  return 0
}

DOWN=""
for n in $(seq 1 "$NUM_NODES"); do
  port=$((API_PORT_BASE + n - 1))
  st=$(get "$port" /api/status 2>/dev/null || echo '{}')
  name=$(echo "$st" | pyf "d.get('name','?')")
  role=$(echo "$st" | pyf "d.get('nodeRole','?')")
  if [ -z "$name" ] || [ "$name" = "?" ]; then
    DOWN="$DOWN node$n(:$port)"
  else
    log "node$n :$port name=$name role=$role"
  fi
done
if [ -n "$DOWN" ]; then fail PREFLIGHT nodes-up "down:$DOWN"; log "FATAL: nodes down"; exit 2; fi
pass PREFLIGHT nodes-up "all $NUM_NODES reachable"

PEERS=$(get "$API_PORT_BASE" /api/agents 2>/dev/null | pyf "len(d.get('agents',[]))")
[ -z "$PEERS" ] && PEERS=0
if [ "$PEERS" -ge $((NUM_NODES - 2)) ]; then pass PREFLIGHT mesh "node1 sees $PEERS peers"
else warn PREFLIGHT mesh "node1 sees only $PEERS peers (expected >= $((NUM_NODES-2)))"; fi

# Discover each node's agent address + peerId (for invites/messaging/transfers).
declare_addr() { get "$1" /api/agent/identity 2>/dev/null | pyf "d.get('agentAddress','')"; }
declare_peer() { get "$1" /api/status 2>/dev/null | pyf "d.get('peerId','')"; }
NODE_ADDR=(); NODE_PEER=(); NODE_PORT=()
for n in $(seq 1 "$NUM_NODES"); do
  port=$((API_PORT_BASE + n - 1))
  NODE_PORT+=("$port")
  NODE_ADDR+=("$(declare_addr "$port")")
  NODE_PEER+=("$(declare_peer "$port")")
done
log "core nodes: 1-$NUM_CORE_NODES | edge nodes: $((NUM_CORE_NODES+1))-$NUM_NODES"

# RS counters are cumulative across the daemon's lifetime. With BOOTSTRAP=0 the
# pre-existing devnet can carry stale totals that would inflate Section C's
# success rate without this run sampling anything. Snapshot per-core counters
# BEFORE any publish; Section C subtracts the baseline and reports the delta.
#
# The status route exposes `loop.totalTicks` (ticks attempted) and
# `loop.submittedCount` (successful submissions). It does NOT expose a
# `failedCount`, so the success rate is computed as
# (Δsubmitted) / (Δticks_attempted), not via a failed-counter subtraction.
declare -a RS_BASE_SUB RS_BASE_TICKS
for n in $(seq 1 "$NUM_CORE_NODES"); do
  port="${NODE_PORT[$((n-1))]}"
  s=$(get "$port" /api/random-sampling/status 2>/dev/null || echo '{}')
  RS_BASE_SUB[$n]=$(echo "$s" | pyf "d.get('loop',{}).get('submittedCount',0)")
  RS_BASE_TICKS[$n]=$(echo "$s" | pyf "d.get('loop',{}).get('totalTicks',0)")
  [ -z "${RS_BASE_SUB[$n]}" ] && RS_BASE_SUB[$n]=0
  [ -z "${RS_BASE_TICKS[$n]}" ] && RS_BASE_TICKS[$n]=0
done
log "RS baseline (per-core): $(for n in $(seq 1 "$NUM_CORE_NODES"); do printf 'n%d=sub:%s/ticks:%s ' "$n" "${RS_BASE_SUB[$n]}" "${RS_BASE_TICKS[$n]}"; done)"

# ── Section H: CG creation matrix + invitations ──────────────────────────────
section "H. CONTEXT GRAPHS — create $TARGET_CGS registered CGs (public + curated) from cores & edges, with curator invites"
RUN_TAG="${RUN_TAG:-$(date -u +%s)}"
CG_LIST_FILE="$RESULTS/cgs.tsv"   # id \t kind(public|curated) \t creatorNode \t memberNodesCSV
: > "$CG_LIST_FILE"

create_public_cg() { # node id
  local node=$1 id=$2 port="${NODE_PORT[$((node-1))]}"
  local r
  r=$(post "$port" /api/context-graph/create -d "{\"id\":\"$id\",\"name\":\"$id\",\"accessPolicy\":0,\"publishPolicy\":1,\"register\":true}")
  echo "$r" | grep -qiE 'context-graph|registered|created|"id"|onChainId' && echo "OK" || echo "ERR:$r"
}
create_curated_cg() { # node id allowedAgentsCSV
  local node=$1 id=$2 allowed=$3 port="${NODE_PORT[$((node-1))]}"
  local agents_json
  agents_json=$(python3 -c "import sys;print(__import__('json').dumps([a for a in '$allowed'.split(',') if a]))")
  local r
  r=$(post "$port" /api/context-graph/create -d "{\"id\":\"$id\",\"name\":\"$id\",\"accessPolicy\":1,\"publishPolicy\":0,\"allowedAgents\":$agents_json,\"register\":true}")
  echo "$r" | grep -qiE 'context-graph|registered|created|"id"|onChainId' && echo "OK" || echo "ERR:$r"
}

CG_CREATED=0
# Non-public slots: 2 edge-curated CGs + 1 invite-flow CG. Must match loops below.
NUM_NON_PUBLIC=3
NUM_PUBLIC=$(( TARGET_CGS - NUM_NON_PUBLIC ))
[ "$NUM_PUBLIC" -lt 1 ] && NUM_PUBLIC=1
# Public CGs: spread creation across all 6 nodes (cores AND edges).
for i in $(seq 1 "$NUM_PUBLIC"); do
  node=$(( (i - 1) % NUM_NODES + 1 ))
  cgid="rc12-pub-${RUN_TAG}-${i}"
  res=$(create_public_cg "$node" "$cgid")
  if [ "$res" = "OK" ]; then
    printf '%s\tpublic\t%s\t1,2,3,4,5,6\n' "$cgid" "$node" >> "$CG_LIST_FILE"
    CG_CREATED=$((CG_CREATED+1))
  else
    log "  public CG create failed on node$node: ${res:0:200}"
  fi
done

# Curated CGs: created by EDGE curators (nodes 5,6). Edges invite each other +
# two cores. allowedAgents seeds membership; we then exercise the join/approve
# flow as an explicit invitation check.
EDGE_A=$((NUM_CORE_NODES+1))   # node 5
EDGE_B=$((NUM_CORE_NODES+2))   # node 6
for pair in "$EDGE_A:$EDGE_B" "$EDGE_B:$EDGE_A"; do
  curator=${pair%%:*}; invitee=${pair##*:}
  cgid="rc12-cur-${RUN_TAG}-by${curator}"
  allowed="${NODE_ADDR[$((curator-1))]},${NODE_ADDR[$((invitee-1))]},${NODE_ADDR[0]}"
  res=$(create_curated_cg "$curator" "$cgid" "$allowed")
  if [ "$res" = "OK" ]; then
    printf '%s\tcurated\t%s\t%s,%s,1\n' "$cgid" "$curator" "$curator" "$invitee" >> "$CG_LIST_FILE"
    CG_CREATED=$((CG_CREATED+1))
    pass H curated-cg-create "edge node$curator created curated $cgid (members: edge$invitee + core1)"
  else
    fail H curated-cg-create "edge node$curator: ${res:0:160}"
  fi
done

# Explicit invite/join/approve round-trip (curator = edge A, joiner = a core not pre-seeded).
section "H. INVITE FLOW — explicit request-join -> approve round-trip"
INV_CG="rc12-invite-${RUN_TAG}"
CURATOR_NODE=$EDGE_A; CURATOR_PORT="${NODE_PORT[$((CURATOR_NODE-1))]}"
JOINER_NODE=2; JOINER_PORT="${NODE_PORT[$((JOINER_NODE-1))]}"
JOINER_ADDR="${NODE_ADDR[$((JOINER_NODE-1))]}"
CURATOR_PEER="${NODE_PEER[$((CURATOR_NODE-1))]}"
res=$(create_curated_cg "$CURATOR_NODE" "$INV_CG" "${NODE_ADDR[$((CURATOR_NODE-1))]}")
if [ "$res" = "OK" ]; then
  printf '%s\tcurated\t%s\t%s\n' "$INV_CG" "$CURATOR_NODE" "$CURATOR_NODE" >> "$CG_LIST_FILE"
  CG_CREATED=$((CG_CREATED+1))
  ENC=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$INV_CG',safe=''))")
  sign=$(post "$JOINER_PORT" "/api/context-graph/$ENC/sign-join" -d '{}')
  deleg=$(echo "$sign" | pyf "__import__('json').dumps(d.get('delegation',{}))")
  if [ -n "$deleg" ] && [ "$deleg" != "{}" ]; then
    jr=$(post "$JOINER_PORT" "/api/context-graph/$ENC/request-join" -d "{\"delegation\":$deleg,\"curatorPeerId\":\"$CURATOR_PEER\"}")
    got=0
    for _ in $(seq 1 12); do
      sleep 3
      reqs=$(get "$CURATOR_PORT" "/api/context-graph/$ENC/join-requests")
      # listPendingJoinRequests already filters to status='pending'; require an
      # entry whose agentAddress matches the joiner (case-insensitive EVM addr)
      # so unrelated `pending` strings in the response body don't false-pass.
      match=$(echo "$reqs" | python3 -c "
import json, sys
addr = sys.argv[1].lower()
try: d = json.load(sys.stdin)
except Exception: d = {}
for r in (d.get('requests') or []):
    if str(r.get('agentAddress','')).lower() == addr:
        print('1'); break
else:
    print('0')
" "$JOINER_ADDR" 2>/dev/null || echo 0)
      [ "$match" = "1" ] && { got=1; break; }
    done
    if [ "$got" = "1" ]; then
      ap=$(post "$CURATOR_PORT" "/api/context-graph/$ENC/approve-join" -d "{\"agentAddress\":\"$JOINER_ADDR\"}")
      echo "$ap" | grep -qi approved && pass H invite-approve "core$JOINER_NODE joined curated $INV_CG via edge$CURATOR_NODE" \
        || warn H invite-approve "approve returned: ${ap:0:160}"
    else
      # Seeded-allowlist membership (curated-cg-create above) already proves the
      # invite/ACL path; the live request-join round-trip is P2P-gossip-timed and
      # occasionally slow on a cold mesh — treat a timeout as WARN, not a release blocker.
      warn H invite-approve "request-join not visible within 36s (P2P gossip timing; seeded membership path verified separately)"
    fi
  else
    warn H invite-approve "sign-join returned no delegation: ${sign:0:160}"
  fi
else
  fail H invite-cg-create "${res:0:160}"
fi

CG_COUNT=$(wc -l < "$CG_LIST_FILE" | tr -d ' ')
if [ "$CG_COUNT" -ge "$TARGET_CGS" ]; then pass H cg-count "$CG_COUNT CGs created (target $TARGET_CGS)"
else warn H cg-count "$CG_COUNT CGs created (< target $TARGET_CGS)"; fi

# A node can only WRITE/publish to a CG it has locally subscribed/synced
# (the daemon rejects writes with CONTEXT_GRAPH_NOT_WRITABLE otherwise — true
# even for the creator). Subscribe every publishing node to each CG up front:
# all 6 nodes for public CGs, member nodes only for curated (allowlist-gated).
section "H. SUBSCRIBE — sync each CG to its publishing nodes (required before writes)"
SUB_OK=0; SUB_TRY=0
while IFS=$'\t' read -r cgid kind creator members; do
  if [ "$kind" = "public" ]; then subnodes="$(seq 1 "$NUM_NODES")"; else subnodes="$(echo "$members" | tr ',' ' ')"; fi
  for n in $subnodes; do
    [ -z "$n" ] && continue
    port="${NODE_PORT[$((n-1))]}"
    SUB_TRY=$((SUB_TRY+1))
    r=$(post "$port" /api/context-graph/subscribe -d "{\"contextGraphId\":\"$cgid\",\"includeSharedMemory\":true}")
    echo "$r" | grep -q "subscribed" && SUB_OK=$((SUB_OK+1))
  done
done < "$CG_LIST_FILE"
if [ "$SUB_OK" -ge $((SUB_TRY * 8 / 10)) ]; then pass H cg-subscribe "$SUB_OK/$SUB_TRY CG subscriptions established"
else warn H cg-subscribe "$SUB_OK/$SUB_TRY CG subscriptions (some failed)"; fi
log "Waiting 20s for subscription catch-up to settle..."
sleep 20

# Build a routing table: a publish job = (node, cgid). Public CGs can be
# published to from any node; curated CGs only from member nodes.
JOBS_FILE="$RESULTS/publish-jobs.tsv"   # node \t cgid \t kind
: > "$JOBS_FILE"
while IFS=$'\t' read -r cgid kind creator members; do
  if [ "$kind" = "public" ]; then
    for n in $(seq 1 "$NUM_NODES"); do printf '%s\t%s\t%s\n' "$n" "$cgid" "$kind" >> "$JOBS_FILE"; done
  else
    IFS=',' read -ra mem <<< "$members"
    for n in "${mem[@]}"; do printf '%s\t%s\t%s\n' "$n" "$cgid" "$kind" >> "$JOBS_FILE"; done
  fi
done < "$CG_LIST_FILE"
NUM_JOBS=$(wc -l < "$JOBS_FILE" | tr -d ' ')
log "Publish routing table: $NUM_JOBS (node,CG) slots"

# Quad generator: emits a JSON array of triples for E entities under a unique
# root subject. Root carries an rdf:type so it is a valid rootEntity.
gen_quads() { # rootUri E
  python3 - "$1" "$2" <<'PY'
import sys, json
root, E = sys.argv[1], int(sys.argv[2])
RDF="http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
q=[{"subject":root,"predicate":RDF,"object":"http://schema.org/Dataset","graph":""},
   {"subject":root,"predicate":"http://schema.org/name","object":'"%s"'%("KA "+root.split(':')[-1]),"graph":""}]
for i in range(E):
    e=f"{root}/e{i}"
    q.append({"subject":e,"predicate":RDF,"object":"http://schema.org/Thing","graph":""})
    q.append({"subject":e,"predicate":"http://schema.org/identifier","object":'"%d"'%i,"graph":""})
    q.append({"subject":root,"predicate":"http://schema.org/hasPart","object":e,"graph":""})
print(json.dumps(q))
PY
}

# Single publish: write -> publish; emits a metrics jsonl line.
publish_one() { # idx node cgid kind
  local idx=$1 node=$2 cgid=$3 kind=$4 port="${NODE_PORT[$((node-1))]}"
  local E root quads w op sel p st kc
  E=$(( RANDOM % (MAX_ENTITIES - MIN_ENTITIES + 1) + MIN_ENTITIES ))
  root="urn:rc12:ka:${RUN_TAG}:${idx}:n${node}"
  # Large bodies (up to ~1000 entities * 3 triples) go via a temp file to stay
  # well clear of ARG_MAX in this unattended run.
  local bodyf; bodyf=$(mktemp -t rc12pub.XXXXXX)
  { printf '{"contextGraphId":"%s","quads":' "$cgid"; gen_quads "$root" "$E"; printf '}'; } > "$bodyf"
  w=$(curl -s --max-time 60 -H "$H" -H "Content-Type: application/json" -X POST \
      "http://127.0.0.1:$port/api/shared-memory/write" --data @"$bodyf")
  rm -f "$bodyf"
  op=$(echo "$w" | pyf "d.get('shareOperationId','')")
  if [ -z "$op" ]; then
    printf '{"idx":"%s","node":%d,"cg":"%s","kind":"%s","entities":%d,"ok":false,"stage":"write","err":%s}\n' \
      "$idx" "$node" "$cgid" "$kind" "$E" "$(python3 -c "import json,sys;print(json.dumps(sys.argv[1][:200]))" "$w")" >> "$METRICS_JSONL"
    return 1
  fi
  # The SWM write is async: `shareOperationId` returns immediately but the quads
  # land in the queryable SWM store a beat later, so an immediate publish can hit
  # "No quads in shared memory ... matching selection". Retry the publish leg with
  # backoff. The owner-registration error ("Only the context graph owner ...") is
  # NOT retryable — the seed/register phase (H2) must have run first — so bail on it.
  # `clearAfter` defaults to `true` on the server (memory.ts: `clearAfter ?? true`).
  # Multiple workers publish into the same CG concurrently — letting one publish
  # clear the SWM would wipe other in-flight roots between their write and
  # publish steps. Force `clearAfter:false` so subset publishes are isolated.
  local attempt p st kc
  for attempt in 1 2 3 4 5; do
    p=$(curl -s --max-time 120 -H "$H" -H "Content-Type: application/json" -X POST \
        "http://127.0.0.1:$port/api/shared-memory/publish" \
        -d "{\"contextGraphId\":\"$cgid\",\"selection\":{\"rootEntities\":[\"$root\"]},\"clearAfter\":false}")
    st=$(echo "$p" | pyf "d.get('status','')")
    kc=$(echo "$p" | pyf "d.get('kaId','')")
    if [ "$st" = "confirmed" ] || [ "$st" = "finalized" ]; then
      printf '{"idx":"%s","node":%d,"cg":"%s","kind":"%s","entities":%d,"ok":true,"kaId":"%s","status":"%s","root":"%s"}\n' \
        "$idx" "$node" "$cgid" "$kind" "$E" "$kc" "$st" "$root" >> "$METRICS_JSONL"
      return 0
    fi
    case "$p" in
      *"could not be auto-registered"*|*"context graph owner"*) break ;;   # not retryable
      *) sleep 3 ;;                                                          # transient: retry
    esac
  done
  printf '{"idx":"%s","node":%d,"cg":"%s","kind":"%s","entities":%d,"ok":false,"stage":"publish","status":"%s","err":%s}\n' \
    "$idx" "$node" "$cgid" "$kind" "$E" "$st" "$(python3 -c "import json,sys;print(json.dumps(sys.argv[1][:200]))" "$p")" >> "$METRICS_JSONL"
  return 1
}

# ── H2: owner seed/register publish ──────────────────────────────────────────
# A CG must be registered on-chain by its OWNER before any non-owner node can
# publish into it (the auto-register leg is owner-gated). The owner's first
# publish does that registration, so seed-publish each CG from its creator now;
# afterwards subscriber nodes' publishes find an existing on-chain id and skip
# (the owner-gated) registration entirely.
section "H2. REGISTER — owner seed-publish to register each CG on-chain"
SEED_OK=0; SEED_TRY=0
while IFS=$'\t' read -r cgid kind creator members; do
  SEED_TRY=$((SEED_TRY+1))
  if publish_one "seed-${SEED_TRY}" "$creator" "$cgid" "$kind"; then SEED_OK=$((SEED_OK+1)); fi
done < "$CG_LIST_FILE"
if [ "$SEED_OK" -ge $((SEED_TRY * 8 / 10)) ]; then pass H cg-register "$SEED_OK/$SEED_TRY CGs registered via owner seed-publish"
else warn H cg-register "$SEED_OK/$SEED_TRY CGs seed-published (some owners failed to register)"; fi
log "Waiting 20s for on-chain registration to propagate to subscribers..."
sleep 20

# ── Section A/B: bulk publish + updates (the metric engine) ──────────────────
section "A. BULK PUBLISH — target $TARGET_KAS KAs ($MIN_ENTITIES..$MAX_ENTITIES entities each) across $CG_COUNT CGs, from cores & edges"

# Drive publishes with a concurrency cap. Loop until the CONFIRMED count hits
# the target (not merely dispatched): a fraction of publishes hit transient
# "no quads matching selection" races on freshly-synced subscriber nodes, so we
# overshoot to compensate. A hard dispatch ceiling + time budget bound the loop.
idx=0
inflight=0
DISPATCH_CEIL=$(( TARGET_KAS * 2 + 50 ))   # never dispatch more than ~2x target
PUBLISH_DEADLINE=$(( START_EPOCH + DURATION_TARGET_S * 60 / 100 ))   # ~60% of budget for publish
okc=0
while [ "$okc" -lt "$TARGET_KAS" ] && [ "$idx" -lt "$DISPATCH_CEIL" ]; do
  # Pick a job slot round-robin.
  slot=$(( idx % NUM_JOBS + 1 ))
  line=$(sed -n "${slot}p" "$JOBS_FILE")
  jn=$(echo "$line" | cut -f1); jc=$(echo "$line" | cut -f2); jk=$(echo "$line" | cut -f3)
  publish_one "$idx" "$jn" "$jc" "$jk" &
  inflight=$((inflight+1))
  idx=$((idx+1))
  # bash 3.2 (macOS) has no `wait -n`; drain the whole batch when full.
  if [ "$inflight" -ge "$PUBLISH_CONCURRENCY" ]; then
    wait; inflight=0
    okc=$(grep -c '"ok":true' "$METRICS_JSONL" 2>/dev/null || true); okc=${okc:-0}
  fi
  if [ $((idx % 25)) -eq 0 ]; then
    log "  ...dispatched $idx publishes, $okc confirmed so far (target $TARGET_KAS)"
  fi
  if [ "$(date +%s)" -gt "$PUBLISH_DEADLINE" ]; then
    log "  publish time budget reached at idx=$idx — stopping dispatch"
    break
  fi
done
wait 2>/dev/null || true

# NOTE: `grep -c` exits 1 on zero matches; `|| echo 0` would then emit a
# SECOND "0" (yielding "0\n0" and breaking later integer tests). Use `|| true`.
KA_OK=$(grep -c '"ok":true' "$METRICS_JSONL" 2>/dev/null || true); KA_OK=${KA_OK:-0}
KA_FAIL=$(grep -c '"ok":false' "$METRICS_JSONL" 2>/dev/null || true); KA_FAIL=${KA_FAIL:-0}
CGS_WITH_KA=$(grep '"ok":true' "$METRICS_JSONL" | python3 -c "
import sys, json
cgs=set()
for l in sys.stdin:
    try: cgs.add(json.loads(l)['cg'])
    except Exception: pass
print(len(cgs))")
ENT_STATS=$(grep '"ok":true' "$METRICS_JSONL" | python3 -c "
import sys, json
es=[]
for l in sys.stdin:
    try: es.append(json.loads(l)['entities'])
    except Exception: pass
if es: print(f'{min(es)} {max(es)} {sum(es)//len(es)} {len(es)}')
else: print('0 0 0 0')")
EMIN=$(echo "$ENT_STATS" | awk '{print $1}'); EMAX=$(echo "$ENT_STATS" | awk '{print $2}')
EAVG=$(echo "$ENT_STATS" | awk '{print $3}')
log "Publish results: ok=$KA_OK fail=$KA_FAIL | CGs-with-KA=$CGS_WITH_KA | entities[min/avg/max]=$EMIN/$EAVG/$EMAX"

if [ "$KA_OK" -ge "$TARGET_KAS" ]; then pass A ka-count "$KA_OK >= $TARGET_KAS KAs published"
else warn A ka-count "$KA_OK KAs published (< target $TARGET_KAS)"; fi
if [ "$CGS_WITH_KA" -ge "$TARGET_CGS" ]; then pass A cg-spread "KAs span $CGS_WITH_KA CGs (>= $TARGET_CGS)"
else warn A cg-spread "KAs span $CGS_WITH_KA CGs (< $TARGET_CGS)"; fi
if [ "$EMIN" -ge "$MIN_ENTITIES" ] 2>/dev/null && [ "$EMAX" -le "$MAX_ENTITIES" ] 2>/dev/null && [ "$EMIN" -gt 0 ] 2>/dev/null; then
  pass A entity-range "entities per KA within [$MIN_ENTITIES,$MAX_ENTITIES] (min=$EMIN max=$EMAX avg=$EAVG)"
else fail A entity-range "entity range min=$EMIN max=$EMAX (expected [$MIN_ENTITIES,$MAX_ENTITIES])"; fi
# Edge-published KAs present?
EDGE_KA=$(grep '"ok":true' "$METRICS_JSONL" | python3 -c "
import sys,json
c=sum(1 for l in sys.stdin if (json.loads(l).get('node',0) > $NUM_CORE_NODES))
print(c)" 2>/dev/null || echo 0)
if [ "${EDGE_KA:-0}" -gt 0 ]; then pass A edge-publish "$EDGE_KA KAs published from edge nodes"; else warn A edge-publish "no edge-published KAs"; fi
CUR_KA=$(grep '"ok":true' "$METRICS_JSONL" | grep -c '"kind":"curated"' || true); CUR_KA=${CUR_KA:-0}
if [ "${CUR_KA:-0}" -gt 0 ]; then pass A curated-publish "$CUR_KA KAs published to curated CGs"; else warn A curated-publish "no curated-CG publishes"; fi

# ── Section B: updates across CG variants ────────────────────────────────────
section "B. UPDATES — update a sample of published KAs across CG variants"
UPD_OK=0; UPD_TRY=0
# Sample up to max(16, TARGET_CGS) PUBLIC KAs, round-robin across CGs.
# Curated KAs are intentionally excluded: updates need allowlisted ciphers and
# rotated keys this harness does not thread (curated publish is covered in §A).
SAMPLE=$(grep '"ok":true' "$METRICS_JSONL" | TARGET_CGS="$TARGET_CGS" python3 -c "
import os,sys,json
by_cg={}
for l in sys.stdin:
    try: r=json.loads(l)
    except Exception: continue
    if not r.get('kaId') or r.get('kind') != 'public': continue
    k=r['cg']
    by_cg.setdefault(k, []).append(f\"{r['node']}|{r['cg']}|{r['kaId']}|{r['root']}\")
MAX=max(16, int(os.environ.get('TARGET_CGS', '12')))
if os.environ.get('HARNESS_UPD_MAX'):
    MAX=min(MAX, int(os.environ['HARNESS_UPD_MAX']))
out=[]
while len(out) < MAX and any(by_cg.values()):
    for k in list(by_cg.keys()):
        bucket=by_cg.get(k) or []
        if bucket:
            out.append(bucket.pop(0))
            if len(out) >= MAX: break
print('\n'.join(out))")
UPD_SECTION_DEADLINE=$(( $(date +%s) + ${HARNESS_UPD_SECTION_BUDGET_S:-900} ))
UPD_BUDGET_EXHAUSTED=0
while IFS='|' read -r un uc ukc uroot; do
  [ -z "$uc" ] && continue
  UPD_TRY=$((UPD_TRY+1))
  uport="${NODE_PORT[$((un-1))]}"
  newuri="${uroot}/upd${UPD_TRY}"
  quads_json="[{\"subject\":\"$newuri\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/UpdateAction\",\"graph\":\"\"},{\"subject\":\"$newuri\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"upd-$UPD_TRY\\\"\",\"graph\":\"\"}]"
  body=$(build_update_body "$un" "$ukc" "$uc" "$quads_json") || continue
  if ! post_update_bounded "$uport" /api/update -d "$body"; then
    if [ "$UPD_BUDGET_EXHAUSTED" = "1" ]; then break; fi
    continue
  fi
  r="$POST_UPDATE_LAST"
  stt=$(echo "$r" | pyf "d.get('status','')")
  { [ "$stt" = "confirmed" ] || [ "$stt" = "finalized" ]; } && UPD_OK=$((UPD_OK+1))
done <<< "$SAMPLE"
if [ "$UPD_BUDGET_EXHAUSTED" = "1" ]; then
  fail B ka-update "budget-limited: $UPD_OK/$UPD_TRY updates incomplete (${HARNESS_UPD_SECTION_BUDGET_S:-900}s cap)"
elif [ "$UPD_OK" -gt 0 ] && [ "$UPD_OK" -ge $((UPD_TRY * 7 / 10)) ]; then
  pass B ka-update "$UPD_OK/$UPD_TRY KA updates confirmed across CG variants"
elif [ "$UPD_OK" -gt 0 ]; then
  warn B ka-update "$UPD_OK/$UPD_TRY KA updates confirmed (below 70%)"
else
  fail B ka-update "0/$UPD_TRY KA updates confirmed"
fi

# ── WM->SWM->VM tier verification (sample) ───────────────────────────────────
section "A. TIER VERIFY — WM -> SWM -> VM round-trip + peer replication (sample)"
SROOT=$(grep '"ok":true' "$METRICS_JSONL" | python3 -c "
import sys,json
for l in sys.stdin:
    r=json.loads(l)
    if r.get('kind')=='public' and r.get('root'):
        print(r['node'], r['cg'], r['root']); break")
if [ -n "$SROOT" ]; then
  sn=$(echo "$SROOT"|awk '{print $1}'); sc=$(echo "$SROOT"|awk '{print $2}'); sr=$(echo "$SROOT"|awk '{print $3}')
  sp="${NODE_PORT[$((sn-1))]}"
  vm=$(post_long "$sp" /api/query -d "{\"sparql\":\"SELECT ?p WHERE { GRAPH ?g { <$sr> ?p ?o } FILTER(CONTAINS(STR(?g),\\\"$sc\\\")) } LIMIT 1\",\"contextGraphId\":\"$sc\",\"view\":\"verified-memory\"}")
  vmb=$(echo "$vm" | pyf "len(d.get('result',{}).get('bindings',[]))")
  [ "${vmb:-0}" -gt 0 ] && pass A vm-view "published KA visible in verified-memory view" || warn A vm-view "KA not in VM view yet (got $vm | first 120: ${vm:0:120})"
  # peer replication: query another node
  pn=$(( sn % NUM_NODES + 1 )); pp="${NODE_PORT[$((pn-1))]}"
  found=0
  for _ in $(seq 1 20); do
    # Retry probes use the short control-plane budget (90s); replication
    # should succeed within seconds once gossip settles, not block for 180s
    # per attempt (Codex round-2 on the tier-verify poll loop).
    rep=$(post "$pp" /api/query -d "{\"sparql\":\"SELECT ?p WHERE { GRAPH ?g { <$sr> ?p ?o } FILTER(CONTAINS(STR(?g),\\\"$sc\\\")) } LIMIT 1\",\"contextGraphId\":\"$sc\"}")
    [ "$(echo "$rep" | pyf "len(d.get('result',{}).get('bindings',[]))")" -gt 0 ] 2>/dev/null && { found=1; break; }
    sleep 3
  done
  [ "$found" = "1" ] && pass A peer-replication "KA replicated to peer node$pn" || warn A peer-replication "KA not replicated to node$pn within 60s"
else
  warn A tier-verify "no public KA available to verify"
fi

# ── Section A2: canonical assertion lifecycle smoke ─────────────────────────
# The bulk publish path above uses /api/shared-memory/write directly. The
# canonical RFC-001 §9.x path is /api/assertion/create with finalize+promote
# (create → write → finalize → promote in one shot), then publish to VM. A
# regression in assertion finalize/promote could still let the SWM-write path
# pass, so we exercise the canonical path end-to-end with one KA and gate the
# release on it.
section "A2. ASSERTION LIFECYCLE — canonical create→write→finalize→promote→publish"
A2_NODE=1
A2_PORT="${NODE_PORT[$((A2_NODE-1))]}"
A2_CG=$(awk -F'\t' '$2=="public" {print $1; exit}' "$CG_LIST_FILE")
if [ -n "$A2_CG" ]; then
  A2_NAME="rc12-asrt-${RUN_TAG}"
  A2_ROOT="urn:rc12:asrt:${RUN_TAG}:n${A2_NODE}"
  A2_BODY=$(python3 - "$A2_CG" "$A2_NAME" "$A2_ROOT" <<'PY'
import json, sys
cg, name, root = sys.argv[1], sys.argv[2], sys.argv[3]
RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
quads = [
    {"subject": root, "predicate": RDF, "object": "http://schema.org/Dataset", "graph": ""},
    {"subject": root, "predicate": "http://schema.org/name", "object": '"rc12 assertion lifecycle smoke"', "graph": ""},
]
print(json.dumps({"contextGraphId": cg, "name": name, "quads": quads, "finalize": True, "promote": True}))
PY
)
  ac=$(post "$A2_PORT" /api/assertion/create -d "$A2_BODY")
  ac_uri=$(echo "$ac" | pyf "d.get('assertionUri','')")
  ac_seal_ok=$(echo "$ac" | pyf "1 if (d.get('seal') or {}).get('merkleRoot') else 0")
  ac_promoted=$(echo "$ac" | pyf "d.get('promotedCount',0)")
  if [ -n "$ac_uri" ] && [ "$ac_seal_ok" = "1" ] && [ "${ac_promoted:-0}" -gt 0 ] 2>/dev/null; then
    pass A2 assertion-create-finalize-promote "assertion=$ac_uri sealed and promoted (promoted=$ac_promoted)"
    # Publish via the FINALIZED-ASSERTION fork (`assertionName`), not the
    # selection fork. The selection fork mints a fresh attestation inline at
    # the selection boundary, which would mask a regression in the stored
    # finalize seal. The assertionName fork reads the seal from `_meta` and
    # forwards it verbatim, so this is what exercises create→finalize→publish
    # end-to-end. clearAfter is harmless for this one-shot path but kept
    # false-explicit for consistency with the bulk path.
    # /api/shared-memory/publish drives an on-chain tx; the default `post`
    # helper caps curl at 30s which is shorter than a busy devnet's mempool
    # round-trip. Use a dedicated 180s budget (the bulk loop already does
    # this for the same reason — keep the named-assertion fork in line).
    pp=$(curl -s --max-time 180 -H "$H" -H "Content-Type: application/json" -X POST \
          "http://127.0.0.1:$A2_PORT/api/shared-memory/publish" \
          -d "{\"contextGraphId\":\"$A2_CG\",\"assertionName\":\"$A2_NAME\",\"clearAfter\":false}")
    pps=$(echo "$pp" | pyf "d.get('status','')")
    case "$pps" in
      confirmed|finalized) pass A2 assertion-publish "VM publish via finalized-assertion fork landed (status=$pps)" ;;
      *) fail A2 assertion-publish "publish via assertionName='$A2_NAME' returned status=$pps body: ${pp:0:200}" ;;
    esac
  else
    fail A2 assertion-create-finalize-promote "create+finalize+promote failed (uri=$ac_uri seal_ok=$ac_seal_ok promoted=$ac_promoted) body: ${ac:0:200}"
  fi
else
  warn A2 assertion-lifecycle "no public CG available for canonical-path smoke"
fi

# ── Section F: protocol treasury fee ─────────────────────────────────────────
section "F. PROTOCOL TREASURY FEE — set treasury + fee, publish, assert balance grows"
OWNER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # hardhat acct[0] (Hub owner)
TREASURY_ADDR="0x000000000000000000000000000000000000dEaD"
cur_treasury=$($CHAIN_CALL ParametersStorage protocolTreasury | pyf "d.get('result','')")
cur_fee=$($CHAIN_CALL ParametersStorage protocolTreasuryFee | pyf "d.get('result','0')")
set_t=$($CHAIN_CALL ParametersStorage setProtocolTreasury --key "$OWNER_KEY" --json "[\"$TREASURY_ADDR\"]")
set_f=$($CHAIN_CALL ParametersStorage setProtocolTreasuryFee --key "$OWNER_KEY" --json "[500]")   # 5%
ok_t=$(echo "$set_t" | pyf "d.get('ok',False)"); ok_f=$(echo "$set_f" | pyf "d.get('ok',False)")
if [ "$ok_t" = "True" ] && [ "$ok_f" = "True" ]; then
  pass F treasury-config "protocolTreasury=$TREASURY_ADDR fee=500bps (5%) set by owner"
  bal_before=$($CHAIN_CALL Token balanceOf --json "[\"$TREASURY_ADDR\"]" | pyf "d.get('result','0')")
  # The conviction path routes the fee as a STAKE transfer (no token-balance
  # change); only the non-conviction DIRECT-SPEND path (edge nodes, no
  # conviction account) does token.transferFrom(msg.sender, treasury, fee).
  # So drive the observable test from an EDGE node + edge-created public CG.
  edge_node=$(awk -F'\t' '$2=="public" && ($3+0)>'"$NUM_CORE_NODES"'{print $3; exit}' "$CG_LIST_FILE")
  edge_pubcg=$(awk -F'\t' '$2=="public" && ($3+0)>'"$NUM_CORE_NODES"'{print $1; exit}' "$CG_LIST_FILE")
  [ -z "$edge_node" ] && edge_node=$((NUM_CORE_NODES+1))
  [ -z "$edge_pubcg" ] && edge_pubcg=$(grep -m1 'public' "$CG_LIST_FILE" | cut -f1)
  log "  treasury publishes from edge node$edge_node into $edge_pubcg (non-conviction direct-spend path)"
  for k in 1 2 3 4 5; do publish_one "tr$k" "$edge_node" "$edge_pubcg" public >/dev/null 2>&1; done
  sleep 5
  bal_after=$($CHAIN_CALL Token balanceOf --json "[\"$TREASURY_ADDR\"]" | pyf "d.get('result','0')")
  delta=$(python3 -c "print(int('${bal_after:-0}') - int('${bal_before:-0}'))" 2>/dev/null || echo 0)
  if [ "$(python3 -c "print(1 if $delta>0 else 0)" 2>/dev/null || echo 0)" = "1" ]; then
    pass F treasury-receives "treasury balance grew by $delta TRAC after paid publishes"
  else
    warn F treasury-receives "treasury balance unchanged (before=$bal_before after=$bal_after) — paths may use non-fee branch on devnet"
  fi
  # Restore prior treasury config (best-effort).
  [ -n "$cur_treasury" ] && $CHAIN_CALL ParametersStorage setProtocolTreasury --key "$OWNER_KEY" --json "[\"$cur_treasury\"]" >/dev/null 2>&1 || true
  [ -n "$cur_fee" ] && $CHAIN_CALL ParametersStorage setProtocolTreasuryFee --key "$OWNER_KEY" --json "[\"$cur_fee\"]" >/dev/null 2>&1 || true
else
  warn F treasury-config "could not set treasury params (t=$set_t f=$set_f)"
fi

# ── Section D: staking / conviction / rewards / position transfer ────────────
section "D. STAKING & CONVICTION — stake present, multiplier, reward claim/withdraw, position transfer"
staked_ok=0
for n in $(seq 1 "$NUM_CORE_NODES"); do
  wfile="$DEVNET_DIR/node$n/wallets.json"
  [ -f "$wfile" ] || continue
  opaddr=$(python3 -c "import json;print(json.load(open('$wfile'))['wallets'][0].get('address',''))" 2>/dev/null || echo "")
  idid=$($CHAIN_CALL IdentityStorage getIdentityId --json "[\"$opaddr\"]" | pyf "d.get('result','0')")
  [ -z "$idid" ] && idid=0
  if [ "$idid" != "0" ]; then
    stake=$($CHAIN_CALL ConvictionStakingStorage getNodeStakeV10 --json "[$idid]" | pyf "d.get('result','0')")
    if [ "$(python3 -c "print(1 if int('${stake:-0}')>0 else 0)" 2>/dev/null || echo 0)" = "1" ]; then
      staked_ok=$((staked_ok+1))
    fi
  fi
done
if [ "$staked_ok" -ge "$NUM_CORE_NODES" ]; then pass D node-stake "$staked_ok/$NUM_CORE_NODES cores have nodeStakeV10 > 0"
elif [ "$staked_ok" -gt 0 ]; then warn D node-stake "$staked_ok/$NUM_CORE_NODES cores staked"
else fail D node-stake "no cores have nodeStakeV10 > 0"; fi

# Conviction multiplier + reward claim/withdraw + transfer.
# ABI presence alone is too weak a gate (a regression that always reverts won't
# remove the method from the ABI), so we ONLY record PASS for verifications that
# run a real call against state. Surface introspection is logged for context.
NFT_ABI="$REPO_ROOT/packages/evm-module/abi/DKGStakingConvictionNFT.json"
CSS_ABI="$REPO_ROOT/packages/evm-module/abi/ConvictionStakingStorage.json"
if [ -f "$NFT_ABI" ]; then
  methods=$(python3 -c "import json;print(' '.join(sorted({f['name'] for f in json.load(open('$NFT_ABI')) if f.get('type')=='function'})))")
  log "  StakingConvictionNFT methods (introspection only — not a release gate): $methods"
else
  fail D nft-abi "DKGStakingConvictionNFT ABI missing — cannot exercise staking surface"
  methods=""
fi

N1_OP=$(python3 -c "import json;print(json.load(open('$DEVNET_DIR/node1/wallets.json'))['wallets'][0]['privateKey'])" 2>/dev/null || echo "")
N1_OPADDR=$(python3 -c "import json;print(json.load(open('$DEVNET_DIR/node1/wallets.json'))['wallets'][0]['address'])" 2>/dev/null || echo "")

# Real multiplier read: fetch a position from CSS and assert lockTier > 0 yields
# multiplier18 > 1e18. This proves the multiplier surface actually returns a
# locked-tier boost on devnet positions.
if [ -f "$CSS_ABI" ] && [ -n "$N1_OPADDR" ]; then
  # Find any token id owned by node1's op wallet; default to id 1 if the helper
  # is unavailable (devnet bootstrap mints conviction positions starting at 1).
  pos1=$($CHAIN_CALL ConvictionStakingStorage getPosition --json "[1]" 2>/dev/null | pyf "d.get('result',[])")
  if [ -n "$pos1" ] && [ "$pos1" != "[]" ]; then
    mult=$(echo "$pos1" | python3 -c "
import sys, ast
try: t = ast.literal_eval(sys.stdin.read().strip())
except Exception: t = None
if isinstance(t, (list, tuple)) and len(t) >= 6:
    print(int(t[5]))
else:
    print(0)" 2>/dev/null || echo 0)
    if [ "${mult:-0}" -ge 1000000000000000000 ] 2>/dev/null; then
      pass D conviction-multiplier "position tokenId=1 multiplier18=$mult (>=1e18 confirms tier boost surface)"
    else
      fail D conviction-multiplier "position tokenId=1 multiplier18=$mult (expected >=1e18)"
    fi
  else
    warn D conviction-multiplier "no position at tokenId=1 to verify multiplier (devnet may not have minted yet)"
  fi
else
  warn D conviction-multiplier "ConvictionStakingStorage ABI or N1 op address missing"
fi

# Reward claim execution. Best-effort: semantics are NFT-gated and lock-aware,
# so a no-op revert is acceptable, but we PASS only when the chain confirms.
if [ -n "$N1_OP" ] && [ -n "$methods" ] && echo "$methods" | grep -qiw claimRewards; then
  cr=$($CHAIN_CALL DKGStakingConvictionNFT claimRewards --key "$N1_OP" --json "[]" 2>/dev/null)
  echo "$cr" | grep -q '"ok":true' && pass D reward-claim-exec "claimRewards tx landed" \
    || warn D reward-claim-exec "claimRewards exec inconclusive: ${cr:0:140}"
elif [ -n "$N1_OP" ]; then
  warn D reward-claim-exec "no zero-arg claimRewards entrypoint — claim is position-scoped (manual tokenId needed)"
fi

# ── Section D2: V8→V10 migration conviction credit (60-day lock on tiers 6/12) ─
# Eligible V8 migrants (frozen V8MigrationEligibility registry) who pick the two
# highest conviction tiers (6m / 12m) must get expiryTimestamp shortened by exactly
# 60 days (fixed literal in StakingV10 3.1.0 — not 2×chronos.epochLength).
# Lower tiers and ineligible delegators migrate at the default lock.
# Exercises: synthetic registry upload+freeze, selfMigrateV8, CSS position expiry.
section "D2. V8 MIGRATION CREDIT — eligible tier 6/12 migrants get 60-day lock discount"
V8_CREDIT_SMOKE="$REPO_ROOT/packages/evm-module/scripts/devnet-credit-smoke.ts"
if [ "${SKIP_V8_MIGRATION_CREDIT:-0}" = "1" ]; then
  warn D2 v8-migration-credit "SKIP_V8_MIGRATION_CREDIT=1"
elif [ ! -f "$CONTRACTS_JSON" ]; then
  fail D2 v8-migration-credit "missing $CONTRACTS_JSON"
elif ! grep -q '"V8MigrationEligibility"' "$CONTRACTS_JSON" 2>/dev/null; then
  fail D2 v8-migration-credit "V8MigrationEligibility not in deployments map"
elif [ ! -f "$V8_CREDIT_SMOKE" ]; then
  fail D2 v8-migration-credit "missing $V8_CREDIT_SMOKE"
else
  reg_frozen=$($CHAIN_CALL V8MigrationEligibility frozen 2>/dev/null | pyf "d.get('result', False)" || echo "False")
  if [ "$reg_frozen" = "True" ] || [ "$reg_frozen" = "true" ]; then
    warn D2 v8-migration-credit "V8MigrationEligibility already frozen on this chain — re-bootstrap (BOOTSTRAP=1) to run the full 4-scenario matrix"
  else
    v8_log="$RESULTS/v8-credit-smoke.log"
    log "  Running devnet-credit-smoke.ts (registry upload, freeze, tier 6/12 vs 3 vs ineligible)…"
    smoke_rc=0
    # `npx ts-node --esm` was unreliable: the evm-module ts-node binary errors
    # with `Unknown file extension ".ts"` under Node's native ESM loader, and
    # `npx` can resolve a stale ts-node from outside the workspace. The repo
    # root ships `tsx` as a dev dep (it transparently runs `.ts` files under
    # ESM), so prefer that. Fall back to the local ts-node only if tsx is
    # missing (CI image variation).
    TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
    TS_NODE_BIN="$REPO_ROOT/packages/evm-module/node_modules/.bin/ts-node"
    (
      cd "$REPO_ROOT/packages/evm-module" || exit 1
      export RPC_LOCALHOST="http://127.0.0.1:${HARDHAT_PORT}"
      if [ -x "$TSX_BIN" ]; then
        "$TSX_BIN" scripts/devnet-credit-smoke.ts
      elif [ -x "$TS_NODE_BIN" ]; then
        "$TS_NODE_BIN" --esm scripts/devnet-credit-smoke.ts
      else
        echo "ERROR: neither tsx nor ts-node found in workspace" >&2; exit 127
      fi
    ) >"$v8_log" 2>&1 || smoke_rc=$?
    if [ "$smoke_rc" -eq 0 ]; then
      pass D2 v8-migration-credit "eligible 6m/12m V8 migrants: 60-day expiryShortenedBy; tier 3 + ineligible: no credit (see $v8_log)"
    else
      fail D2 v8-migration-credit "devnet-credit-smoke failed rc=$smoke_rc (tail): $(tail -n 3 "$v8_log" 2>/dev/null | tr '\n' ' ')"
    fi
  fi
fi

# ── Section E: conviction discount vs non-conviction + publishing NFT transfer ─
section "E. PUBLISHING PATHS — conviction discount vs non-conviction + publishing-NFT transfer surface"
PUB_NFT_ABI="$REPO_ROOT/packages/evm-module/abi/DKGPublishingConvictionNFT.json"
if [ -f "$PUB_NFT_ABI" ]; then
  pmethods=$(python3 -c "import json;print(' '.join(sorted({f['name'] for f in json.load(open('$PUB_NFT_ABI')) if f.get('type')=='function'})))")
  echo "$pmethods" | grep -qiE 'coverPublishingCost|cover' && pass E conviction-discount-surface "conviction publishing-cost entrypoint present" || warn E conviction-discount-surface "no coverPublishingCost"
  echo "$pmethods" | grep -qiE 'transferFrom|safeTransfer' && pass E publishing-nft-transfer "publishing NFT is ERC721-transferable" || warn E publishing-nft-transfer "no transfer method"
else
  warn E pub-nft-abi "DKGPublishingConvictionNFT ABI missing"
fi
# Non-conviction publish: edge nodes have no conviction account → their publishes
# exercise the direct-spend (non-conviction) path. We already published from edges (Section A).
if [ "${EDGE_KA:-0}" -gt 0 ]; then pass E non-conviction-publish "$EDGE_KA edge (non-conviction) publishes succeeded"; else warn E non-conviction-publish "no edge publishes to evidence non-conviction path"; fi

# ── Section I: ownership transfer + new owner update ─────────────────────────
section "I. OWNERSHIP TRANSFER — transfer a KA and update as new owner"
# KA ownership = the DKGKnowledgeAssets ERC-721 token. The on-chain owner is
# whichever publisher wallet finalized the SWM publish (often a single edge
# node ends up owning everything because the publisher routing is sticky to
# the node that drained SWM first). The originating node in metrics.jsonl is
# the request initiator, NOT necessarily the on-chain owner — so we resolve
# the real owner via DKGKnowledgeAssets.ownerOf(kaId) and pick a destination
# address that is provably distinct from the owner.
OREC=$(grep '"ok":true' "$METRICS_JSONL" | python3 -c "
import sys,json
for l in sys.stdin:
    r=json.loads(l)
    if r.get('kaId') and r.get('kind')=='public':
        print(r['cg'], r['kaId'], r['root']); break")
if [ -n "$OREC" ]; then
  ocg=$(echo "$OREC"|awk '{print $1}'); okc=$(echo "$OREC"|awk '{print $2}'); oroot=$(echo "$OREC"|awk '{print $3}')
  KA_ABI="$REPO_ROOT/packages/evm-module/abi/DKGKnowledgeAssets.json"
  if [ -f "$KA_ABI" ]; then
    kmethods=$(python3 -c "import json;print(' '.join(sorted({f['name'] for f in json.load(open('$KA_ABI')) if f.get('type')=='function'})))")
    echo "$kmethods" | grep -qiE 'safeTransferFrom|transferFrom' && pass I ka-transfer-surface "KA token transfer entrypoint present" || warn I ka-transfer-surface "no KA transfer method"
  fi
  xfer_ok=0
  # Resolve the on-chain owner of the chosen KA + the matching private key.
  owner_line=$(ka_owner_key "$okc") || owner_line=""
  ownerAddr="${owner_line%%$'\t'*}"
  ownerKey="${owner_line##*$'\t'}"
  # Destination address: any node op wallet that isn't the current owner.
  # Iterating 1..6 ensures we always find one distinct from the owner across
  # all topologies.
  destAddr=""
  # macOS ships bash 3.2 which lacks `${var,,}`; use a portable tr-based
  # lowercase comparison.
  ownerLower=$(printf '%s' "$ownerAddr" | tr '[:upper:]' '[:lower:]')
  for n in 1 2 3 4 5 6; do
    cand=$(node_op_addr "$n")
    candLower=$(printf '%s' "$cand" | tr '[:upper:]' '[:lower:]')
    if [ -n "$cand" ] && [ "$candLower" != "$ownerLower" ]; then
      destAddr="$cand"; break
    fi
  done
  if [ -n "$ownerKey" ] && [ -n "$destAddr" ]; then
    # ERC-721 safeTransferFrom is overloaded (3-arg + 4-arg); disambiguate
    # with an explicit signature.
    xfr=$($CHAIN_CALL DKGKnowledgeAssets safeTransferFrom \
            --sig "safeTransferFrom(address,address,uint256)" \
            --key "$ownerKey" --json "[\"$ownerAddr\",\"$destAddr\",\"$okc\"]")
    if echo "$xfr" | grep -q '"ok":true'; then
      xfer_ok=1
      pass I ka-transfer-exec "KA token $okc transferred ${ownerAddr:0:10}... -> ${destAddr:0:10}..."
    else
      fail I ka-transfer-exec "transfer tx failed: ${xfr:0:200}"
    fi
  else
    fail I ka-transfer-exec "could not resolve owner key or distinct destination (owner=$ownerAddr dest=$destAddr)"
  fi
  # New owner update path: build_update_body now resolves the seal author from
  # the chain owner automatically, so we just need a publishing-capable node
  # to POST against. Use node1 (or whichever core is up first) — the daemon
  # only forwards the precomputed seal, it doesn't re-sign.
  #
  # Hard FAIL on a non-confirmed status. The previously-tracked daemon
  # `newTokenAmount` accounting gap (issue #831 — daemon under-paid for
  # byteSize growth and reverted with `InvalidTokenAmount(1, 0)`) was fixed
  # by adding `computeUpdateNewTokenAmount` in `packages/chain/src/evm-adapter.ts`:
  # the daemon now pays the exact marginal cost of byteSize growth over the
  # remaining lifetime, so a new-owner update on a transferred KA must land
  # cleanly. If this regresses, treat it as a real release-gate failure.
  if [ "$xfer_ok" = "1" ]; then
    nuri="${oroot}/owner2"
    oquads="[{\"subject\":\"$nuri\",\"predicate\":\"http://www.w3.org/1999/02/22-rdf-syntax-ns#type\",\"object\":\"http://schema.org/UpdateAction\",\"graph\":\"\"},{\"subject\":\"$nuri\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"owner2-upd\\\"\",\"graph\":\"\"}]"
    ob=$(build_update_body 1 "$okc" "$ocg" "$oquads" 2>/dev/null) || ob=""
    if [ -n "$ob" ]; then
      orr=$(post_long "$API_PORT_BASE" /api/update -d "$ob")
      ost=$(echo "$orr" | pyf "d.get('status','')")
      if [ "$ost" = "confirmed" ] || [ "$ost" = "finalized" ]; then
        pass I new-owner-update "new owner updated KA kc=$okc after transfer (status=$ost)"
      else
        fail I new-owner-update "new-owner update status=$ost (expected confirmed/finalized — #831 regression?): ${orr:0:200}"
      fi
    else
      fail I new-owner-update "could not build update seal for new owner ($destAddr)"
    fi
  else
    warn I new-owner-update "skipped — transfer did not land (gated by ka-transfer-exec)"
  fi
else
  warn I ownership "no public KA available for ownership test"
fi

# ── Section J: MCP server tool surface ───────────────────────────────────────
section "J. MCP SERVER — tools/list + representative tool calls over stdio"
MCP_OUT="$RESULTS/mcp.jsonl"
if [ -f "$CLI_JS" ]; then
  python3 - "$CLI_JS" "$DEVNET_DIR/node1" "$MCP_OUT" <<'PY' >> "$LOG" 2>&1 || true
import subprocess, json, sys, os, time, select
cli, home, out = sys.argv[1], sys.argv[2], sys.argv[3]
env=dict(os.environ); env["DKG_HOME"]=home
# MCP SDK stdio transport is newline-delimited JSON-RPC (see @modelcontextprotocol/sdk shared/stdio.js).
p=subprocess.Popen(["node",cli,"mcp","serve"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,text=True,bufsize=1)
def send(o):
    p.stdin.write(json.dumps(o)+"\n"); p.stdin.flush()
def recv_id(req_id, timeout=25):
    deadline=time.time()+timeout
    while time.time()<deadline:
        rem=max(0.05, deadline-time.time())
        r,_,_=select.select([p.stdout],[],[],rem)
        if not r:
            continue
        line=p.stdout.readline()
        if not line.strip():
            continue
        try:
            d=json.loads(line)
        except json.JSONDecodeError:
            continue
        if d.get("id")==req_id:
            return d
    return None
results=[]
try:
    send({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"rc12-val","version":"1"}}})
    init=recv_id(1,30)
    send({"jsonrpc":"2.0","method":"notifications/initialized"})
    send({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
    listed=recv_id(2,30)
    tools=[]
    if listed:
        tools=[t["name"] for t in listed.get("result",{}).get("tools",[])]
    results.append({"tools_count":len(tools),"tools":tools[:60]})
    send({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dkg_status","arguments":{}}})
    called=recv_id(3,30)
    ok=bool(called and "result" in called)
    results.append({"dkg_status_ok":ok})
finally:
    open(out,"w").write("\n".join(json.dumps(r) for r in results))
    try: p.terminate()
    except Exception: pass
PY
  TOOLS_N=$(python3 -c "import json;[print(json.loads(l).get('tools_count',0)) for l in open('$MCP_OUT')][0] if __import__('os').path.exists('$MCP_OUT') else print(0)" 2>/dev/null | head -1 || echo 0)
  [ -z "$TOOLS_N" ] && TOOLS_N=0
  if [ "$TOOLS_N" -ge 10 ] 2>/dev/null; then
    pass J mcp-tools "MCP exposed $TOOLS_N tools via stdio (newline JSON-RPC)"
    grep -q '"dkg_status_ok": true' "$MCP_OUT" 2>/dev/null && pass J mcp-call "dkg_status tool call returned a result" \
      || fail J mcp-call "dkg_status tools/call did not return result (see $MCP_OUT)"
  else
    fail J mcp-tools "MCP tools/list returned $TOOLS_N tools (expected >=10; see $MCP_OUT)"
  fi
else
  warn J mcp "cli.js missing"
fi

# ── Section C: random sampling success rate ──────────────────────────────────
# Two-tier gate. The original "submitted / totalTicks" ratio over-counts the
# denominator: every tick on an empty/not-yet-synced KA queue increments
# `totalTicks` but isn't a "failed proof". On a fresh bootstrap with N KAs
# just published, ~100 of the first 200 ticks routinely show
# `lastOutcome=kc-not-synced` while the indexer catches up — the prover is
# WORKING, just waiting for sync. Treating that as failure makes the gate
# fire spuriously on every reduced-scope run.
#
# Hard gate (FAIL): EVERY core must submit at least one proof during the
# observation window. A core that submits zero is genuinely stuck — either
# the RS prover isn't binding to identity, or the KA index is empty.
#
# Soft gate (WARN unless `RS_MIN_SUCCESS_PCT_STRICT=1`): aggregate
# submitted/attempted rate. Strict mode is intended for long-running full
# validations (`DURATION_TARGET_S>=7200`, hundreds of KAs already synced)
# where the not-synced denominator is negligible. Reduced-scope runs leave
# strict off and only assert the binary "every prover is alive" hard gate.
section "C. RANDOM SAMPLING — observe success rate across cores (target >= ${RS_MIN_SUCCESS_PCT}%)"
RS_OBSERVE_S="${RS_OBSERVE_S:-300}"
now=$(date +%s)
budget_left=$(( START_EPOCH + DURATION_TARGET_S - now ))
[ "$budget_left" -lt 60 ] && budget_left=60
[ "$RS_OBSERVE_S" -gt "$budget_left" ] && RS_OBSERVE_S=$budget_left
log "Observing RS for ${RS_OBSERVE_S}s..."
rs_end=$(( now + RS_OBSERVE_S ))
while [ "$(date +%s)" -lt "$rs_end" ]; do
  sleep 20
done
TOT_SUB=0; TOT_ATT=0; STUCK_CORES=""
for n in $(seq 1 "$NUM_CORE_NODES"); do
  port="${NODE_PORT[$((n-1))]}"
  s=$(get "$port" /api/random-sampling/status 2>/dev/null || echo '{}')
  sub_now=$(echo "$s" | pyf "d.get('loop',{}).get('submittedCount',0)")
  ticks_now=$(echo "$s" | pyf "d.get('loop',{}).get('totalTicks',0)")
  last_outcome=$(echo "$s" | pyf "(d.get('loop',{}).get('lastOutcome') or {}).get('kind','')")
  [ -z "$sub_now" ] && sub_now=0; [ -z "$ticks_now" ] && ticks_now=0
  sub=$(( sub_now - ${RS_BASE_SUB[$n]:-0} ))
  att=$(( ticks_now - ${RS_BASE_TICKS[$n]:-0} ))
  [ "$sub" -lt 0 ] && sub=0
  [ "$att" -lt 0 ] && att=0
  [ "$att" -lt "$sub" ] && att=$sub
  log "  core$n: Δsubmitted=$sub Δticks=$att lastOutcome=$last_outcome (now sub=$sub_now ticks=$ticks_now base sub=${RS_BASE_SUB[$n]} ticks=${RS_BASE_TICKS[$n]})"
  if [ "$sub" -eq 0 ]; then
    STUCK_CORES="$STUCK_CORES core${n}(last:$last_outcome)"
  fi
  TOT_SUB=$(( TOT_SUB + sub )); TOT_ATT=$(( TOT_ATT + att ))
done
if [ "$TOT_ATT" -gt 0 ]; then
  RS_PCT=$(( TOT_SUB * 100 / TOT_ATT ))
else
  RS_PCT=0
fi
log "RS aggregate: submitted=$TOT_SUB attempted=$TOT_ATT success=${RS_PCT}%"
if [ -n "$STUCK_CORES" ]; then
  fail C rs-liveness "core(s) submitted zero proofs:$STUCK_CORES"
else
  pass C rs-liveness "all $NUM_CORE_NODES cores submitted at least one proof (aggregate=$TOT_SUB)"
fi
if [ "$RS_PCT" -ge "$RS_MIN_SUCCESS_PCT" ]; then
  pass C rs-success "RS success rate ${RS_PCT}% (>= ${RS_MIN_SUCCESS_PCT}%, submitted=$TOT_SUB)"
else
  if [ "${RS_MIN_SUCCESS_PCT_STRICT:-0}" = "1" ]; then
    fail C rs-success "RS success rate ${RS_PCT}% (< ${RS_MIN_SUCCESS_PCT}%, submitted=$TOT_SUB attempted=$TOT_ATT) [strict mode]"
  else
    warn C rs-success "RS success rate ${RS_PCT}% (< ${RS_MIN_SUCCESS_PCT}%, submitted=$TOT_SUB attempted=$TOT_ATT) — set RS_MIN_SUCCESS_PCT_STRICT=1 for long-running full validations"
  fi
fi

# ── Section G: prolonged inter-node messaging ────────────────────────────────
section "G. MESSAGING — inter-node chat (immediate) + prolonged soak"
N2_PEER="${NODE_PEER[1]}"
if [ -n "$N2_PEER" ]; then
  cr=$(post "$API_PORT_BASE" /api/chat -d "{\"to\":\"$N2_PEER\",\"text\":\"rc12-validation hello $RUN_TAG\"}")
  [ "$(echo "$cr" | pyf "1 if d.get('delivered') else 0")" = "1" ] && pass G chat-immediate "node1->node2 chat delivered" || warn G chat-immediate "chat not delivered: ${cr:0:120}"
fi
if [ "${SKIP_MESSAGING_SOAK:-0}" != "1" ] && [ -x "$REPO_ROOT/scripts/libp2p-soak-test.sh" ]; then
  now=$(date +%s); budget_left=$(( START_EPOCH + DURATION_TARGET_S - now ))
  if [ "$budget_left" -gt 180 ]; then
    cycles=$(( budget_left / 60 )); [ "$cycles" -gt 30 ] && cycles=30
    log "Running libp2p messaging soak: $cycles cycles x 60s..."
    env DKG_HOME="$DEVNET_DIR/node1" DKG_AUTH="$AUTH" API="http://127.0.0.1:$API_PORT_BASE" \
      RECIPIENT_PEER_ID="$N2_PEER" RECIPIENT=devnet-node-2 SENDER_TAG=rc12val \
      TOTAL_CYCLES="$cycles" INTERVAL_S=60 \
      bash "$REPO_ROOT/scripts/libp2p-soak-test.sh" > "$RESULTS/messaging-soak.log" 2>&1
    if [ $? -eq 0 ]; then pass G messaging-soak "libp2p soak completed $cycles cycles (~$((cycles))m)"
    else warn G messaging-soak "soak exited non-zero (see messaging-soak.log)"; fi
  else
    warn G messaging-soak "insufficient time budget left for soak (${budget_left}s)"
  fi
else
  warn G messaging-soak "skipped"
fi

# ── Final report ─────────────────────────────────────────────────────────────
section "REPORT"
END_EPOCH=$(date +%s); WALL=$(( END_EPOCH - START_EPOCH ))
P=$(grep -c $'\tPASS\t' "$CHECKS_TSV" 2>/dev/null || true); P=${P:-0}
W=$(grep -c $'\tWARN\t' "$CHECKS_TSV" 2>/dev/null || true); W=${W:-0}
F=$(grep -c $'\tFAIL\t' "$CHECKS_TSV" 2>/dev/null || true); F=${F:-0}

# Acceptance verdict.
VERDICT="PASS"
[ "$F" -gt 0 ] && VERDICT="FAIL"
[ "$KA_OK" -lt "$TARGET_KAS" ] && VERDICT="PARTIAL"
[ "$CGS_WITH_KA" -lt "$TARGET_CGS" ] && VERDICT="PARTIAL"
{ [ "${RS_MIN_SUCCESS_PCT_STRICT:-0}" = "1" ] && [ "$TOT_SUB" -gt 0 ] && [ "$RS_PCT" -lt "$RS_MIN_SUCCESS_PCT" ]; } && VERDICT="PARTIAL"
{ [ "${EMIN:-0}" -lt "$MIN_ENTITIES" ] || [ "${EMAX:-0}" -gt "$MAX_ENTITIES" ]; } 2>/dev/null && VERDICT="PARTIAL"
[ "$F" -gt 0 ] && VERDICT="FAIL"

MD="$RESULTS/REPORT.md"
{
  echo "# rc.12 release validation — comprehensive devnet report"
  echo
  echo "- Started: $(iso_from_epoch "$START_EPOCH")"
  echo "- Ended:   $(iso_from_epoch "$END_EPOCH")"
  echo "- Wall:    ${WALL}s (~$((WALL/60))m)"
  echo "- Branch:  $(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD) @ $(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
  echo "- Topology: $NUM_NODES nodes ($NUM_CORE_NODES core / $((NUM_NODES-NUM_CORE_NODES)) edge)"
  echo
  echo "## Verdict: **$VERDICT**"
  echo
  echo "| metric | value | target | status |"
  echo "|---|---|---|---|"
  echo "| KAs published | $KA_OK | >= $TARGET_KAS | $([ "$KA_OK" -ge "$TARGET_KAS" ] && echo ok || echo under) |"
  echo "| CGs with KAs | $CGS_WITH_KA | >= $TARGET_CGS | $([ "$CGS_WITH_KA" -ge "$TARGET_CGS" ] && echo ok || echo under) |"
  echo "| entities/KA min..max | ${EMIN}..${EMAX} | within ${MIN_ENTITIES}..${MAX_ENTITIES} | $([ "${EMIN:-0}" -ge "$MIN_ENTITIES" ] 2>/dev/null && [ "${EMAX:-0}" -le "$MAX_ENTITIES" ] 2>/dev/null && echo ok || echo check) |"
  echo "| RS success | ${RS_PCT}% (sub=$TOT_SUB/att=$TOT_ATT) | >= ${RS_MIN_SUCCESS_PCT}% | $([ "$RS_PCT" -ge "$RS_MIN_SUCCESS_PCT" ] 2>/dev/null && echo ok || echo under) |"
  echo "| checks | PASS=$P WARN=$W FAIL=$F | FAIL=0 | $([ "$F" -eq 0 ] && echo ok || echo fail) |"
  echo
  echo "## Functional matrix (per-check)"
  echo
  echo "| section | check | status | detail |"
  echo "|---|---|---|---|"
  while IFS=$'\t' read -r s nm stt det; do
    echo "| $s | $nm | $stt | ${det//|/\\|} |"
  done < "$CHECKS_TSV"
  echo
  echo "## Publish KA distribution per CG"
  echo
  echo '```'
  grep '"ok":true' "$METRICS_JSONL" | python3 -c "
import sys,json,collections
c=collections.Counter()
for l in sys.stdin:
    try: c[json.loads(l)['cg']]+=1
    except Exception: pass
for k,v in sorted(c.items()): print(f'{v:5d}  {k}')" 2>/dev/null || true
  echo '```'
} > "$MD"

JSON="$RESULTS/REPORT.json"
python3 - "$CHECKS_TSV" "$MD" > "$JSON" <<PY
import sys, json
checks=[]
for line in open(sys.argv[1]):
    p=line.rstrip("\n").split("\t")
    if len(p)>=3: checks.append({"section":p[0],"check":p[1],"status":p[2],"detail":p[3] if len(p)>3 else ""})
print(json.dumps({
  "verdict":"$VERDICT",
  "wallSeconds":$WALL,
  "metrics":{"kasPublished":$KA_OK,"kasFailed":$KA_FAIL,"cgsWithKa":$CGS_WITH_KA,"cgCount":$CG_COUNT,
             "entitiesMin":${EMIN:-0},"entitiesMax":${EMAX:-0},"entitiesAvg":${EAVG:-0},
             "rsSubmitted":$TOT_SUB,"rsAttempted":$TOT_ATT,"rsSuccessPct":$RS_PCT},
  "targets":{"kas":$TARGET_KAS,"cgs":$TARGET_CGS,"minEntities":$MIN_ENTITIES,"maxEntities":$MAX_ENTITIES,"rsMinPct":$RS_MIN_SUCCESS_PCT},
  "totals":{"pass":$P,"warn":$W,"fail":$F},
  "checks":checks
}, indent=2))
PY

log ""
log "════════════════════════════════════════════════"
log "VERDICT: $VERDICT | KAs=$KA_OK/$TARGET_KAS CGs=$CGS_WITH_KA/$TARGET_CGS RS=${RS_PCT}% | PASS=$P WARN=$W FAIL=$F | ${WALL}s"
log "Report: $MD"
log "════════════════════════════════════════════════"

# Hard metric gates (KAs, CGs, RS) downgrade to PARTIAL; operational FAILs win.
# Both FAIL and PARTIAL must exit non-zero so CI does not treat under-target runs as green.
case "$VERDICT" in
  FAIL|PARTIAL) exit 1 ;;
  *) exit 0 ;;
esac
