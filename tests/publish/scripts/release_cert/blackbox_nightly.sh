#!/bin/bash
# Nightly blackbox run (M2): conductor + two locally spawned participants,
# entirely inside the job container. Fresh everything per the harness practice:
# new runId, new CG, newly published SWM data on the curator, participants
# verify subscription parity.
#
# Expects (Jenkins provides): node22 + npm, git checkout of the harness repo at
# $HARNESS_DIR, `dkg` CLI installed globally, WORKSPACE set.
set -euo pipefail

HARNESS_DIR="${HARNESS_DIR:-blackbox-harness}"
RUN_ID="nightly-$(date -u +%Y%m%d-%H%M)"
BASE_PORT="${RC_BB_BASE_PORT:-9351}"
WS="${WORKSPACE:-$(pwd)}/bb-run"
rm -rf "$WS"; mkdir -p "$WS"

declare -A HOMES PORTS
for role in curator p1 p2; do
  HOMES[$role]="$WS/home-$role"
  mkdir -p "${HOMES[$role]}"
done
PORTS[curator]=$BASE_PORT; PORTS[p1]=$((BASE_PORT+1)); PORTS[p2]=$((BASE_PORT+2))

start_node() { # role
  local role="$1" home="${HOMES[$1]}" port="${PORTS[$1]}"
  cat > "$home/config.json" <<EOF
{ "name": "rc-bb-$role-$RUN_ID", "nodeRole": "edge", "networkConfig": "testnet", "apiPort": $port, "store": { "backend": "oxigraph" } }
EOF
  DKG_HOME="$home" nohup dkg start -f > "$WS/$role.log" 2>&1 &
  echo $! > "$WS/$role.pid"
}

wait_api() { # role
  local port="${PORTS[$1]}"
  for _ in $(seq 1 60); do
    curl -sf -m 4 "http://127.0.0.1:$port/api/status" > /dev/null && return 0
    sleep 5
  done
  echo "❌ $1 never came up"; tail -40 "$WS/$1.log"; return 1
}

cleanup() {
  for role in curator p1 p2; do
    DKG_HOME="${HOMES[$role]}" dkg stop > /dev/null 2>&1 || kill "$(cat "$WS/$role.pid" 2>/dev/null)" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "🌙 blackbox nightly $RUN_ID — starting curator + 2 participants"
for role in curator p1 p2; do start_node "$role"; done
for role in curator p1 p2; do wait_api "$role"; done

CURATOR_API="http://127.0.0.1:${PORTS[curator]}"
CURATOR_TOKEN="$(grep -v "^#" "${HOMES[curator]}/auth.token" | grep -v "^$" | tail -1)"
CURATOR_PEER="$(curl -sf "$CURATOR_API/api/status" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).peerId))')"

# Fresh CG + fresh SWM content on the curator
CG_NAME="blackbox-$RUN_ID"
CG_ID="$(curl -sf -X POST "$CURATOR_API/api/context-graph/create" \
  -H "Authorization: Bearer $CURATOR_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"id\":\"$CG_NAME\",\"name\":\"$CG_NAME\",\"accessPolicy\":0,\"publishPolicy\":1,\"register\":false}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);console.log(j.canonicalId||j.contextGraphId||j.id)})')"
echo "• CG: $CG_ID"

for i in 1 2 3; do
  curl -sf -X POST "$CURATOR_API/api/knowledge-assets" \
    -H "Authorization: Bearer $CURATOR_TOKEN" -H 'Content-Type: application/json' \
    -d "{\"contextGraphId\":\"$CG_ID\",\"name\":\"bb-$RUN_ID-$i\",\"quads\":[{\"subject\":\"urn:bb:$RUN_ID:$i\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"blackbox nightly $i\\\"\",\"graph\":\"\"}],\"alsoShareSwm\":true}" > /dev/null
done
echo "• published 3 SWM KAs on the curator"

# Plan: status → subscribe → catch-up terminal → SWM parity snapshot
cat > "$WS/plan.json" <<EOF
{
  "runId": "$RUN_ID",
  "network": "testnet",
  "requirements": { "network": "testnet", "requireUniformDkgCommit": false, "requireUniformHarnessCommit": true },
  "roster": { "min": 2, "expect": ["p1", "p2"] },
  "steps": [
    { "to": "*", "action": "status", "barrier": true },
    { "to": "*", "action": "subscribe", "params": { "contextGraphId": "$CG_ID", "includeSharedMemory": true }, "barrier": true, "timeoutMs": 360000 },
    { "to": "*", "action": "catchup-status", "params": { "contextGraphId": "$CG_ID", "waitForTerminal": true, "timeoutMs": 900000, "intervalMs": 2000 }, "assert": { "terminal": true }, "barrier": true, "timeoutMs": 960000 },
    { "to": "*", "action": "context-graph-snapshot", "params": { "contextGraphId": "$CG_ID" }, "assert": { "sharedMemoryParity": true }, "barrier": true, "timeoutMs": 300000 }
  ]
}
EOF

cd "$HARNESS_DIR"
node bin/participant.mjs --run "$RUN_ID" --name p1 --home "${HOMES[p1]}" --api "http://127.0.0.1:${PORTS[p1]}" --conductor-peer "$CURATOR_PEER" > "$WS/p1.participant.log" 2>&1 &
node bin/participant.mjs --run "$RUN_ID" --name p2 --home "${HOMES[p2]}" --api "http://127.0.0.1:${PORTS[p2]}" --conductor-peer "$CURATOR_PEER" > "$WS/p2.participant.log" 2>&1 &
sleep 5

set +e
node bin/conductor.mjs --plan "$WS/plan.json" --home "${HOMES[curator]}" --api "$CURATOR_API"
VERDICT=$?
set -e

echo "— conductor exit: $VERDICT (0=PASS, 2=INVALID)"
cp -r runs "$WS/runs" 2>/dev/null || true
exit $VERDICT
