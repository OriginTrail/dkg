#!/usr/bin/env bash
# CAS Stress Test — simulates a noisy 3-node devnet environment
# Tests concurrent swarm creation, joining, and expedition launches
# to verify CAS conditional writes hold under contention.

set -euo pipefail

AUTH="$(grep -v '^#' .devnet/node1/auth.token 2>/dev/null | tr -d '[:space:]')"

APP="/api/apps/origin-trail-game"
NODE1="http://127.0.0.1:9201"
NODE2="http://127.0.0.1:9202"
NODE3="http://127.0.0.1:9203"

TMPDIR_RUN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RUN"' EXIT

PASS=0
FAIL=0
TOTAL=0

ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ✗ $1"; }

api() {
  local node="$1" method="$2" path="$3"
  shift 3
  curl -sf --connect-timeout 5 --max-time 30 -X "$method" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    "$node$path" "$@" 2>/dev/null
}

swarm_field() {
  python3 -c "import sys,json; print(json.load(sys.stdin).get('$1',''))" 2>/dev/null <<< "$2"
}

echo "=============================================="
echo "  CAS Conditional Writes — Stress Test"
echo "  3-node devnet, noisy concurrent operations"
echo "=============================================="
echo ""

# ── Phase 1: Register players on all 3 nodes ───────────────────────
echo "Phase 1: Register players across all 3 nodes"

REG_OK=0
for pair in "$NODE1:Alice" "$NODE2:Bob" "$NODE3:Carol"; do
  node="${pair%%:*}"; player="${pair##*:}"
  if api "$node" POST "$APP/profile" -d "{\"displayName\":\"$player\"}" > /dev/null; then
    REG_OK=$((REG_OK+1))
  else
    fail "Failed to register $player on $node"
  fi
done
sleep 2
if [[ "$REG_OK" -eq 3 ]]; then
  ok "Registered Alice (node1), Bob (node2), Carol (node3)"
fi

# ── Phase 2: Create swarm on node1 ─────────────────────────────────
echo ""
echo "Phase 2: Create swarm and fill roster"

if ! SWARM_JSON=$(api "$NODE1" POST "$APP/create" \
  -d '{"playerName":"Alice","swarmName":"CAS-Test-Swarm","maxPlayers":3}'); then
  fail "Create swarm request failed"; echo ""; echo "Results: $PASS passed, $FAIL failed, $TOTAL total"; exit 1
fi
SWARM_ID=$(swarm_field id "$SWARM_JSON")

if [[ -z "$SWARM_ID" ]]; then
  fail "Failed to create swarm: $SWARM_JSON"
  echo ""; echo "Results: $PASS passed, $FAIL failed, $TOTAL total"; exit 1
fi
ok "Created swarm $SWARM_ID on node1 (Alice = leader)"

join_with_retry() {
  local node="$1" swarm_id="$2" player="$3"
  for attempt in 1 2 3 4 5 6 7 8; do
    local result
    if ! result=$(api "$node" POST "$APP/join" -d "{\"swarmId\":\"$swarm_id\",\"playerName\":\"$player\"}"); then
      sleep 3; continue
    fi
    local err
    err=$(swarm_field error "$result")
    if [[ -z "$err" ]]; then
      echo "  $player joined on attempt $attempt"
      return 0
    fi
    sleep 3
  done
  echo "  $player failed to join after 8 attempts"
  return 1
}
join_with_retry "$NODE2" "$SWARM_ID" "Bob" &
J1=$!
join_with_retry "$NODE3" "$SWARM_ID" "Carol" &
J2=$!
wait "$J1" || true
wait "$J2" || true
sleep 3

SWARM_STATE=$(api "$NODE1" GET "$APP/swarm/$SWARM_ID" || echo '{}')
PLAYER_COUNT=$(swarm_field playerCount "$SWARM_STATE")
STATUS=$(swarm_field status "$SWARM_STATE")

if [[ "$PLAYER_COUNT" -eq 3 ]]; then
  ok "All 3 players joined (status=$STATUS)"
else
  fail "Only $PLAYER_COUNT/3 players visible on node1 (status=$STATUS)"
fi

# ── Phase 3: Concurrent launch attempts (CAS test) ─────────────────
echo ""
echo "Phase 3: CAS — concurrent launch attempt"
echo "  (Two launch requests fired ~50ms apart."
echo "   CAS should ensure only the first one succeeds.)"

api "$NODE1" POST "$APP/start" -d "{\"swarmId\":\"$SWARM_ID\"}" > "$TMPDIR_RUN/launch1.json" &
PID1=$!
sleep 0.05
api "$NODE1" POST "$APP/start" -d "{\"swarmId\":\"$SWARM_ID\"}" > "$TMPDIR_RUN/launch2.json" &
PID2=$!

wait $PID1 || true
wait $PID2 || true

R1=$(cat "$TMPDIR_RUN/launch1.json" 2>/dev/null || echo '{}')
R2=$(cat "$TMPDIR_RUN/launch2.json" 2>/dev/null || echo '{}')

S1=$(swarm_field status "$R1")
S2=$(swarm_field status "$R2")
E1=$(swarm_field error "$R1")
E2=$(swarm_field error "$R2")

echo "  Launch 1: status=${S1:-error} ${E1:+(err: $E1)}"
echo "  Launch 2: status=${S2:-error} ${E2:+(err: $E2)}"

if [[ "$S1" == "traveling" && "$S2" != "traveling" ]] || [[ "$S2" == "traveling" && "$S1" != "traveling" ]]; then
  ok "Exactly one launch succeeded (CAS prevented duplicate)"
elif [[ "$S1" == "traveling" && "$S2" == "traveling" ]]; then
  fail "BOTH launches returned traveling — CAS may not be working"
else
  sleep 1
  FINAL=$(api "$NODE1" GET "$APP/swarm/$SWARM_ID")
  FSTATUS=$(swarm_field status "$FINAL")
  if [[ "$FSTATUS" == "traveling" ]]; then
    ok "Swarm is traveling (second request correctly rejected: ${E2:-$E1})"
  else
    fail "Swarm status is '$FSTATUS' after concurrent launches (errors: $E1 / $E2)"
  fi
fi

# ── Phase 4: Verify swarm state consistency across nodes ───────────
echo ""
echo "Phase 4: Cross-node state consistency"
sleep 10

for node_port in 9201 9202 9203; do
  STATE=$(api "http://127.0.0.1:$node_port" GET "$APP/swarm/$SWARM_ID")
  NSTATUS=$(swarm_field status "$STATE")
  NPC=$(swarm_field playerCount "$STATE")
  TURN=$(swarm_field currentTurn "$STATE")
  if [[ "$NSTATUS" == "traveling" ]]; then
    ok "Node :$node_port — status=$NSTATUS, players=$NPC, turn=$TURN"
  elif [[ -z "$NSTATUS" ]]; then
    fail "Node :$node_port — swarm not found (gossip may not have propagated)"
  else
    fail "Node :$node_port — status=$NSTATUS (expected traveling), players=$NPC"
  fi
done

# ── Phase 5: Concurrent voting (write contention) ──────────────────
echo ""
echo "Phase 5: Concurrent voting — 3 nodes vote simultaneously"

api "$NODE1" POST "$APP/vote" -d "{\"swarmId\":\"$SWARM_ID\",\"voteAction\":\"march\"}" > /dev/null &
api "$NODE2" POST "$APP/vote" -d "{\"swarmId\":\"$SWARM_ID\",\"voteAction\":\"forage\"}" > /dev/null &
api "$NODE3" POST "$APP/vote" -d "{\"swarmId\":\"$SWARM_ID\",\"voteAction\":\"march\"}" > /dev/null &
wait || true

sleep 10

AFTER_VOTE=$(api "$NODE1" GET "$APP/swarm/$SWARM_ID")
ATURN=$(swarm_field currentTurn "$AFTER_VOTE")
ASTATUS=$(swarm_field status "$AFTER_VOTE")

if [[ "$ATURN" -ge 2 ]]; then
  ok "Turn resolved — now on turn $ATURN (status=$ASTATUS)"
else
  echo "  Turn didn't auto-advance (turn=$ATURN). Force-resolving..."
  api "$NODE1" POST "$APP/force-resolve" -d "{\"swarmId\":\"$SWARM_ID\"}" > /dev/null
  sleep 3
  AFTER_FORCE=$(api "$NODE1" GET "$APP/swarm/$SWARM_ID")
  ATURN=$(swarm_field currentTurn "$AFTER_FORCE")
  ASTATUS=$(swarm_field status "$AFTER_FORCE")
  if [[ "$ATURN" -ge 2 ]]; then
    ok "Turn resolved after force-resolve — turn $ATURN (status=$ASTATUS)"
  else
    fail "Turn didn't advance even after force-resolve — turn $ATURN (status=$ASTATUS)"
  fi
fi

# ── Phase 6: Rapid swarm creation + join storm ─────────────────────
echo ""
echo "Phase 6: Rapid swarm creation storm (5 swarms in parallel)"

for i in 1 2 3 4 5; do
  api "$NODE1" POST "$APP/create" \
    -d "{\"playerName\":\"Alice\",\"swarmName\":\"Storm-$i\",\"maxPlayers\":3}" > "$TMPDIR_RUN/storm_$i.json" &
done
wait || true
sleep 2

CREATED=0
for i in 1 2 3 4 5; do
  SID=$(cat "$TMPDIR_RUN/storm_$i.json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
  if [[ -n "$SID" ]]; then
    CREATED=$((CREATED+1))
  fi
done

if [[ "$CREATED" -ge 3 ]]; then
  ok "Created $CREATED/5 swarms under burst load"
else
  fail "Only created $CREATED/5 swarms under burst load"
fi

# ── Phase 7: Verify workspace graph — swarm triples preserved ──────
echo ""
echo "Phase 7: Verify workspace graph — swarm triples preserved after CAS"

SPARQL="SELECT ?p ?o WHERE { <https://origintrail-game.dkg.io/swarm/${SWARM_ID}> ?p ?o }"
QUERY_RESULT=$(api "$NODE1" POST "/api/query" \
  -d "{\"sparql\":\"$SPARQL\",\"paranetId\":\"origin-trail-game\",\"includeWorkspace\":true}")
BINDING_COUNT=$(echo "$QUERY_RESULT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
b = d.get('bindings', d.get('result',{}).get('bindings',[]))
print(len(b))
" 2>/dev/null || echo "0")

if [[ "$BINDING_COUNT" -ge 4 ]]; then
  ok "Swarm entity has $BINDING_COUNT triples in workspace (snapshot preserved)"
else
  echo "  (query returned: $QUERY_RESULT)"
  if [[ "$BINDING_COUNT" -gt 0 ]]; then
    fail "Swarm entity has only $BINDING_COUNT triples (expected ≥4 — snapshot may be incomplete)"
  else
    fail "Swarm entity has 0 triples — snapshot may have been dropped by upsert"
  fi
fi

# ── Phase 8: Second round of concurrent votes ──────────────────────
echo ""
echo "Phase 8: Second vote round + turn resolution"

CURRENT_TURN=$(swarm_field currentTurn "$(api "$NODE1" GET "$APP/swarm/$SWARM_ID")")
echo "  Current turn: $CURRENT_TURN"

api "$NODE1" POST "$APP/vote" -d "{\"swarmId\":\"$SWARM_ID\",\"voteAction\":\"syncMemory\"}" > /dev/null &
api "$NODE2" POST "$APP/vote" -d "{\"swarmId\":\"$SWARM_ID\",\"voteAction\":\"syncMemory\"}" > /dev/null &
api "$NODE3" POST "$APP/vote" -d "{\"swarmId\":\"$SWARM_ID\",\"voteAction\":\"march\"}" > /dev/null &
wait || true

sleep 10

ROUND2=$(api "$NODE1" GET "$APP/swarm/$SWARM_ID")
R2TURN=$(swarm_field currentTurn "$ROUND2")
R2STATUS=$(swarm_field status "$ROUND2")

if [[ "$R2TURN" -gt "$CURRENT_TURN" ]]; then
  ok "Turn $CURRENT_TURN resolved — now on turn $R2TURN (status=$R2STATUS)"
else
  api "$NODE1" POST "$APP/force-resolve" -d "{\"swarmId\":\"$SWARM_ID\"}" > /dev/null
  sleep 3
  R2AFTER=$(api "$NODE1" GET "$APP/swarm/$SWARM_ID")
  R2TURN=$(swarm_field currentTurn "$R2AFTER")
  R2STATUS=$(swarm_field status "$R2AFTER")
  if [[ "$R2TURN" -gt "$CURRENT_TURN" ]]; then
    ok "Turn resolved after force-resolve — turn $R2TURN (status=$R2STATUS)"
  else
    fail "Turn stuck at $R2TURN (status=$R2STATUS)"
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Results: $PASS passed, $FAIL failed ($TOTAL total)"
echo "=============================================="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
