#!/usr/bin/env bash
#
# rc.17 devnet test — context-graph subscription bulk clear/list API (#997/#1012/#1020).
#
# Exercises the operator-recovery HTTP surface added in rc.17:
#   GET    /api/context-graph/subscriptions   → { count, subscriptions:[{contextGraphId,subscribed,synced,coreHosted}] }
#   DELETE /api/context-graph/subscriptions   → { cleared:N }
# Both are node-admin-only (the auth.token Bearer); agent-scoped / unknown
# tokens get 403. The list excludes the always-on AGENTS/ONTOLOGY system CGs;
# the clear wipes the user-subscription backlog WITHOUT deafening the node to
# control-plane gossip (system CGs preserved), and leaves no subscribed:false
# ghosts behind.
#
# Preconditions:
#   ./scripts/devnet.sh start N   (node 1 up; auth enabled → node1/auth.token exists)
#
# Asserts:
#   1. GET (admin) lists our seeded user subs and EXCLUDES system CGs (agents/ontology).
#   2. GET with no token / a bogus token → 403 (auth gate).
#   3. DELETE (admin) → 200 { cleared:N } with N == the seeded user subs.
#   4. Re-GET → seeded CGs gone (no ghosts), count back to baseline.
#   5. daemon.log records "Cleared … system context graphs preserved" (control plane kept).
#   6. The node stays functional post-clear (re-subscribe works).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
NODE_NUM="${DEVNET_TEST_NODE:-1}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
API_PORT=$((API_PORT_BASE + NODE_NUM - 1))
API="http://127.0.0.1:${API_PORT}"
NODE_DIR="$DEVNET_DIR/node${NODE_NUM}"
DAEMON_LOG="$NODE_DIR/daemon.log"

AUTH_TOKEN=$(grep -v '^#' "$NODE_DIR/auth.token" 2>/dev/null | head -1 || echo "")
AUTH="Authorization: Bearer $AUTH_TOKEN"
TS=$(date +%s)

PASS=0; FAIL=0; declare -a FAILURES
ok()   { PASS=$((PASS+1)); echo "  PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$*"); echo "  FAIL: $*"; }
log()  { echo "[sub-clear] $*"; }

# JSON field extractor (python3, matches the other probes).
jq_field() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo ""; }

# --- Preconditions -----------------------------------------------------------
[ -f "$DEVNET_DIR/hardhat.pid" ] || { echo "devnet not running — ./scripts/devnet.sh start N"; exit 1; }
curl -s "$API/api/status" >/dev/null || { echo "node $NODE_NUM API :$API_PORT not responding"; exit 1; }
[ -n "$AUTH_TOKEN" ] || { echo "no admin token at $NODE_DIR/auth.token (auth must be enabled)"; exit 1; }
log "node $NODE_NUM API :$API_PORT, admin token ${AUTH_TOKEN:0:8}…"

# --- Baseline ----------------------------------------------------------------
BASE_GET=$(curl -s -H "$AUTH" "$API/api/context-graph/subscriptions")
BASE_COUNT=$(printf '%s' "$BASE_GET" | jq_field "d['count']")
[ -n "$BASE_COUNT" ] || bad "baseline GET returned no count (got: ${BASE_GET:0:120})"
log "baseline subscribed user CGs: ${BASE_COUNT:-?}"

# --- Seed 3 user subscriptions ----------------------------------------------
declare -a SEED
for i in 1 2 3; do
  CG="did:dkg:context-graph:subclear-${TS}-${i}"
  SEED+=("$CG")
  RESP=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"contextGraphId\":\"$CG\",\"includeSharedMemory\":false}" \
    "$API/api/context-graph/subscribe")
  SUBBED=$(printf '%s' "$RESP" | jq_field "d.get('subscribed','')")
  [ -n "$SUBBED" ] || log "  subscribe $CG → ${RESP:0:140}"
done
sleep 1

# --- 1. GET lists our user subs, excludes system CGs -------------------------
echo "--- 1. GET /api/context-graph/subscriptions (admin) ---"
G1=$(curl -s -H "$AUTH" "$API/api/context-graph/subscriptions")
IDS=$(printf '%s' "$G1" | python3 -c "import sys,json;print('\n'.join(s['contextGraphId'] for s in json.load(sys.stdin).get('subscriptions',[])))" 2>/dev/null || echo "")
COUNT1=$(printf '%s' "$G1" | jq_field "d['count']")
seen=0; for cg in "${SEED[@]}"; do printf '%s\n' "$IDS" | grep -qxF "$cg" && seen=$((seen+1)); done
[ "$seen" -eq 3 ] && ok "all 3 seeded user subs listed (count=$COUNT1)" || bad "expected 3 seeded subs listed, saw $seen (ids: $(printf '%s' "$IDS" | tr '\n' ' '))"
if printf '%s\n' "$IDS" | grep -qxE 'agents|ontology'; then
  bad "system CG (agents/ontology) leaked into the subscriptions list"
else
  ok "system CGs (agents/ontology) correctly EXCLUDED from the list"
fi

# --- 2. Auth gate: the node-wide subscription view requires auth --------------
# A missing / unrecognized token is rejected 401 by the daemon's global auth
# guard BEFORE the route runs. The route's own 403 is the finer-grained case of
# a VALID but agent-scoped token reaching it (an agent can't enumerate/clear the
# node-wide backlog) — that distinction is unit-covered in #1012 (agent.test.ts
# + the route handler); minting an agent token here would mean reading the agent
# keystore, out of scope for a devnet smoke.
echo "--- 2. auth gate (endpoint requires auth) ---"
CODE_NONE=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/context-graph/subscriptions")
[ "$CODE_NONE" = "401" ] && ok "no token → 401 (auth required)" || bad "no token → expected 401, got $CODE_NONE"
CODE_BOGUS=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer not-a-real-token-$TS" "$API/api/context-graph/subscriptions")
[ "$CODE_BOGUS" = "401" ] && ok "unrecognized token → 401" || bad "unrecognized token → expected 401, got $CODE_BOGUS"

# --- 3. DELETE clears the user backlog ---------------------------------------
echo "--- 3. DELETE /api/context-graph/subscriptions (admin) ---"
BASELINE_LINES=$([ -s "$DAEMON_LOG" ] && wc -l < "$DAEMON_LOG" | tr -d ' ' || echo 0)
DEL=$(curl -s -X DELETE -H "$AUTH" "$API/api/context-graph/subscriptions")
CLEARED=$(printf '%s' "$DEL" | jq_field "d.get('cleared','')")
if [ -n "$CLEARED" ] && [ "$CLEARED" -ge 3 ] 2>/dev/null; then
  ok "DELETE → cleared=$CLEARED (≥ our 3 seeded subs)"
else
  bad "DELETE → expected cleared≥3, got: ${DEL:0:160}"
fi

# --- 4. Re-GET: ghosts gone, count back to baseline --------------------------
echo "--- 4. re-GET (ghosts gone) ---"
G2=$(curl -s -H "$AUTH" "$API/api/context-graph/subscriptions")
IDS2=$(printf '%s' "$G2" | python3 -c "import sys,json;print('\n'.join(s['contextGraphId'] for s in json.load(sys.stdin).get('subscriptions',[])))" 2>/dev/null || echo "")
COUNT2=$(printf '%s' "$G2" | jq_field "d['count']")
ghost=0; for cg in "${SEED[@]}"; do printf '%s\n' "$IDS2" | grep -qxF "$cg" && ghost=$((ghost+1)); done
[ "$ghost" -eq 0 ] && ok "no seeded CG survives the clear (no subscribed:false ghosts)" || bad "$ghost seeded CG(s) still listed after clear"
[ "${COUNT2:-99}" -le "${BASE_COUNT:-0}" ] && ok "count back to ≤ baseline ($COUNT2 ≤ $BASE_COUNT)" || bad "count $COUNT2 did not return to baseline $BASE_COUNT"

# --- 5. system context graphs preserved (control-plane gossip intact) --------
echo "--- 5. system CGs preserved ---"
if tail -n +"$((BASELINE_LINES + 1))" "$DAEMON_LOG" 2>/dev/null | grep -qiE "system context graphs preserved"; then
  ok "daemon.log: clear preserved system context graphs"
else
  bad "no 'system context graphs preserved' line after DELETE (check $DAEMON_LOG)"
fi

# --- 6. node functional post-clear (re-subscribe works) ----------------------
echo "--- 6. node functional post-clear ---"
RECG="did:dkg:context-graph:subclear-${TS}-rejoin"
RE=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"contextGraphId\":\"$RECG\",\"includeSharedMemory\":false}" "$API/api/context-graph/subscribe")
G3=$(curl -s -H "$AUTH" "$API/api/context-graph/subscriptions" | python3 -c "import sys,json;print('\n'.join(s['contextGraphId'] for s in json.load(sys.stdin).get('subscriptions',[])))" 2>/dev/null || echo "")
printf '%s\n' "$G3" | grep -qxF "$RECG" && ok "re-subscribe after clear works (node not wedged)" || bad "re-subscribe after clear failed (resp: ${RE:0:140})"

# Cleanup: clear our test subs, then RESTORE the node's standard devnet CGs so
# this destructive test doesn't leave node $NODE_NUM without its devnet-test SWM
# hosting (the publish ACK quorum depends on it).
curl -s -X DELETE -H "$AUTH" "$API/api/context-graph/subscriptions" >/dev/null 2>&1 || true
for cg in devnet-test devnet-isolation; do
  curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"contextGraphId\":\"$cg\",\"includeSharedMemory\":true}" \
    "$API/api/context-graph/subscribe" >/dev/null 2>&1 || true
done

# --- Summary -----------------------------------------------------------------
echo ""
echo "=== subscription-clear: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  ✗ $f"; done
  exit 1
fi
exit 0
