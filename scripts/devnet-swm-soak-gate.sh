#!/usr/bin/env bash
# Run the SWM transport soak on a fresh, unregistered public graph. Registered
# graphs exercise RFC-64 catalog authority; this gate measures SWM fan-out
# without a late graph registration on an already loaded devnet. A cross-peer
# write/read preflight proves the scoped view is actually receiving shares.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
SWM_CYCLES="${SOAK_SWM_CYCLES:-10}"
SWM_SETTLE="${SOAK_SWM_SETTLE_S:-300}"
RESULTS="${SWM_SOAK_RESULTS:-$DEVNET_DIR/swm-soak-gate-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$RESULTS"

api() {
  local node=$1 method=$2 path=$3 body=${4:-}
  local token
  token=$(awk '!/^[[:space:]]*(#|$)/ { gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit }' "$DEVNET_DIR/node${node}/auth.token")
  [ -n "$token" ] || { echo "Missing node${node} auth token" >&2; return 1; }
  local -a args=(-fsS --max-time "${API_MAX_TIME:-240}" -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -z "$body" ] || args+=(-d "$body")
  curl "${args[@]}" "http://127.0.0.1:$((API_PORT_BASE + node - 1))$path"
}

agent_address() {
  api "$1" GET /api/agent/identity | python3 -c 'import json,sys; print(json.load(sys.stdin)["agentAddress"])'
}

CURATOR=$(agent_address 5)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CG_ID="${CURATOR}/swm-soak-${STAMP}"
COHORT_ID="devnet-swm-${STAMP}"
SUB_GRAPH_NAME=soak

create_body=$(python3 -c '
import json,sys
cg = sys.argv[1]
print(json.dumps({"id":cg,"name":"devnet SWM soak","accessPolicy":0,
                  "publishPolicy":1,"register":False}))
' "$CG_ID")
create_response=$(api 5 POST /api/context-graph/create "$create_body")
created=$(printf '%s' "$create_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created", ""))')
[ "$created" = "$CG_ID" ] || { echo "SWM soak graph creation failed: $create_response" >&2; exit 1; }

member_body=$(python3 -c '
import json,sys
cg = sys.argv[1]
print(json.dumps({"id":cg,"name":"devnet SWM soak peer","accessPolicy":0,
                  "publishPolicy":1,"register":False}))
' "$CG_ID")
peer_response=$(api 6 POST /api/context-graph/create "$member_body")
peer_created=$(printf '%s' "$peer_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created", ""))')
[ "$peer_created" = "$CG_ID" ] || { echo "SWM soak peer graph creation failed: $peer_response" >&2; exit 1; }
subgraph_body=$(python3 -c 'import json,sys; print(json.dumps({"contextGraphId":sys.argv[1],"subGraphName":sys.argv[2]}))' "$CG_ID" "$SUB_GRAPH_NAME")
subgraph_response=$(api 5 POST /api/sub-graph/create "$subgraph_body")
subgraph_created=$(printf '%s' "$subgraph_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created", ""))')
[ "$subgraph_created" = "$SUB_GRAPH_NAME" ] || { echo "SWM soak subgraph creation failed: $subgraph_response" >&2; exit 1; }
member_subgraph_response=$(api 6 POST /api/sub-graph/create "$subgraph_body")
member_subgraph_created=$(printf '%s' "$member_subgraph_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created", ""))')
[ "$member_subgraph_created" = "$SUB_GRAPH_NAME" ] || { echo "SWM soak member subgraph creation failed: $member_subgraph_response" >&2; exit 1; }
printf 'graph=%s cohort=%s\n' "$CG_ID" "$COHORT_ID" | tee "$RESULTS/setup.txt"

# An empty successful query is not sufficient evidence of a usable view.
# Each peer shares one setup quad; both scoped views must observe both unique
# subjects before the measured soak starts.
for node in 5 6; do
  preflight_body=$(python3 -c '
import json,sys
cg,sg,node,cohort=sys.argv[1:]
subject=f"urn:swm-soak-preflight:{cohort}:node{node}"
print(json.dumps({"contextGraphId":cg,"subGraphName":sg,
  "name":f"swm-soak-preflight-{cohort}-node{node}",
  "quads":[{"subject":subject,"predicate":"urn:swm-soak:sentBy",
            "object":f"\"node{node}\"","graph":""}],
  "finalize":True,"alsoShareSwm":True}))
' "$CG_ID" "$SUB_GRAPH_NAME" "$node" "$COHORT_ID")
  preflight_response=$(api "$node" POST /api/knowledge-assets "$preflight_body")
  printf '%s' "$preflight_response" | python3 -c '
import json,sys
d=json.load(sys.stdin)
sys.exit(0 if d.get("swmShared") or d.get("status")=="swm-shared" else 1)
' || { echo "node${node} SWM preflight write failed: $preflight_response" >&2; exit 1; }
done
read_body=$(python3 -c 'import json,sys; print(json.dumps({"contextGraphId":sys.argv[1],"subGraphName":sys.argv[2],"view":"shared-working-memory","sparql":"SELECT DISTINCT ?s WHERE { ?s ?p ?o } LIMIT 100"}))' "$CG_ID" "$SUB_GRAPH_NAME")
for node in 5 6; do
  ready=false
  for attempt in $(seq 1 30); do
    response=$(API_MAX_TIME=10 api "$node" POST /api/query "$read_body" 2>/dev/null) || response=""
    if printf '%s' "$response" | python3 -c '
import json,sys
try:
  rows=json.load(sys.stdin)["result"]["bindings"]
  found={row.get("s") for row in rows}
  expected={f"urn:swm-soak-preflight:{sys.argv[1]}:node5",f"urn:swm-soak-preflight:{sys.argv[1]}:node6"}
  sys.exit(0 if expected.issubset(found) else 1)
except (KeyError,TypeError,ValueError): sys.exit(1)
' "$COHORT_ID" 2>/dev/null; then ready=true; break; fi
    sleep 5
  done
  [ "$ready" = true ] || { echo "node${node} SWM cross-peer preflight failed for $CG_ID" >&2; exit 1; }
  echo "node${node} cross-peer scoped SWM read ready after attempt ${attempt}" | tee -a "$RESULTS/setup.txt"
done

env DKG_HOME="$DEVNET_DIR/node5" API="http://127.0.0.1:$((API_PORT_BASE + 4))" \
  SWM_CG_PUBLIC="$CG_ID" SWM_SUBGRAPH_NAME="$SUB_GRAPH_NAME" SWM_TOTAL_CYCLES="$SWM_CYCLES" SWM_SETTLE_S="$SWM_SETTLE" SWM_INTERVAL_S=30 \
  SOAK_COHORT_ID="$COHORT_ID" SENDER_TAG=rc12-n5 PEERS_EXPECTED=rc12-n6 \
  "$REPO_ROOT/scripts/swm-soak-test.sh" > "$RESULTS/node5.log" 2>&1 &
pid5=$!
env DKG_HOME="$DEVNET_DIR/node6" API="http://127.0.0.1:$((API_PORT_BASE + 5))" \
  SWM_CG_PUBLIC="$CG_ID" SWM_SUBGRAPH_NAME="$SUB_GRAPH_NAME" SWM_TOTAL_CYCLES="$SWM_CYCLES" SWM_SETTLE_S="$SWM_SETTLE" SWM_INTERVAL_S=30 \
  SOAK_COHORT_ID="$COHORT_ID" SENDER_TAG=rc12-n6 PEERS_EXPECTED=rc12-n5 \
  "$REPO_ROOT/scripts/swm-soak-test.sh" > "$RESULTS/node6.log" 2>&1 &
pid6=$!

rc5=0; wait "$pid5" || rc5=$?
rc6=0; wait "$pid6" || rc6=$?
tail -n 20 "$RESULTS/node5.log"
tail -n 20 "$RESULTS/node6.log"
printf 'node5=%s node6=%s\n' "$rc5" "$rc6" | tee "$RESULTS/verdict.txt"
[ "$rc5" -eq 0 ] && [ "$rc6" -eq 0 ]
