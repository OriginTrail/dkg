#!/usr/bin/env bash
# Run the SWM delivery soak on a fresh, registered curated graph. The two
# devnet bootstrap graphs are not suitable fixtures: catalog authority can
# deny their SWM reads even though local writes return swm-shared.
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
  local -a args=(-fsS --max-time 240 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -z "$body" ] || args+=(-d "$body")
  curl "${args[@]}" "http://127.0.0.1:$((API_PORT_BASE + node - 1))$path"
}

agent_address() {
  api "$1" GET /api/agent/identity | python3 -c 'import json,sys; print(json.load(sys.stdin)["agentAddress"])'
}

CURATOR=$(agent_address 5)
MEMBER=$(agent_address 6)
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
CG_ID="${CURATOR}/swm-soak-${STAMP}"
COHORT_ID="devnet-swm-${STAMP}"
SUB_GRAPH_NAME=soak

create_body=$(python3 -c '
import json,sys
cg,curator,member = sys.argv[1:]
print(json.dumps({"id":cg,"name":"devnet SWM soak","accessPolicy":1,
                  "publishPolicy":0,"allowedAgents":[curator,member],"register":True}))
' "$CG_ID" "$CURATOR" "$MEMBER")
create_response=$(api 5 POST /api/context-graph/create "$create_body")
on_chain_id=$(printf '%s' "$create_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("onChainId", ""))')
[ -n "$on_chain_id" ] || { echo "SWM soak graph registration failed: $create_response" >&2; exit 1; }

member_body=$(python3 -c '
import json,sys
cg,curator,member = sys.argv[1:]
print(json.dumps({"id":cg,"name":"devnet SWM soak member","accessPolicy":1,
                  "publishPolicy":0,"allowedAgents":[curator,member]}))
' "$CG_ID" "$CURATOR" "$MEMBER")
api 6 POST /api/context-graph/create "$member_body" > "$RESULTS/member-create.json"
subgraph_body=$(python3 -c 'import json,sys; print(json.dumps({"contextGraphId":sys.argv[1],"subGraphName":sys.argv[2]}))' "$CG_ID" "$SUB_GRAPH_NAME")
subgraph_response=$(api 5 POST /api/sub-graph/create "$subgraph_body")
subgraph_created=$(printf '%s' "$subgraph_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created", ""))')
[ "$subgraph_created" = "$SUB_GRAPH_NAME" ] || { echo "SWM soak subgraph creation failed: $subgraph_response" >&2; exit 1; }
member_subgraph_response=$(api 6 POST /api/sub-graph/create "$subgraph_body")
member_subgraph_created=$(printf '%s' "$member_subgraph_response" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("created", ""))')
[ "$member_subgraph_created" = "$SUB_GRAPH_NAME" ] || { echo "SWM soak member subgraph creation failed: $member_subgraph_response" >&2; exit 1; }
printf 'graph=%s onChainId=%s cohort=%s\n' "$CG_ID" "$on_chain_id" "$COHORT_ID" | tee "$RESULTS/setup.txt"
sleep 3

env DKG_HOME="$DEVNET_DIR/node5" API="http://127.0.0.1:$((API_PORT_BASE + 4))" \
  SWM_CG_CURATED="$CG_ID" SWM_SUBGRAPH_NAME="$SUB_GRAPH_NAME" SWM_TOTAL_CYCLES="$SWM_CYCLES" SWM_SETTLE_S="$SWM_SETTLE" SWM_INTERVAL_S=30 \
  SOAK_COHORT_ID="$COHORT_ID" SENDER_TAG=rc12-n5 PEERS_EXPECTED=rc12-n6 \
  "$REPO_ROOT/scripts/swm-soak-test.sh" > "$RESULTS/node5.log" 2>&1 &
pid5=$!
env DKG_HOME="$DEVNET_DIR/node6" API="http://127.0.0.1:$((API_PORT_BASE + 5))" \
  SWM_CG_CURATED="$CG_ID" SWM_SUBGRAPH_NAME="$SUB_GRAPH_NAME" SWM_TOTAL_CYCLES="$SWM_CYCLES" SWM_SETTLE_S="$SWM_SETTLE" SWM_INTERVAL_S=30 \
  SOAK_COHORT_ID="$COHORT_ID" SENDER_TAG=rc12-n6 PEERS_EXPECTED=rc12-n5 \
  "$REPO_ROOT/scripts/swm-soak-test.sh" > "$RESULTS/node6.log" 2>&1 &
pid6=$!

rc5=0; wait "$pid5" || rc5=$?
rc6=0; wait "$pid6" || rc6=$?
tail -n 20 "$RESULTS/node5.log"
tail -n 20 "$RESULTS/node6.log"
printf 'node5=%s node6=%s\n' "$rc5" "$rc6" | tee "$RESULTS/verdict.txt"
[ "$rc5" -eq 0 ] && [ "$rc6" -eq 0 ]
