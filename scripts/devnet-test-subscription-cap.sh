#!/usr/bin/env bash
#
# rc.17 devnet test — context-graph subscription rehydration CAP + dormancy (#997/#1012).
#
# On boot, rehydrateContextGraphSubscriptions ACTIVATES at most
# maxRehydratedContextGraphSubscriptions user subscriptions (default 64; 0 = no
# cap). Rows beyond the cap stay PERSISTED but dormant; AGENTS/ONTOLOGY system
# CGs and coreHosted graphs are exempt. This is the #997 anti-wedge measure: a
# large stale backlog otherwise fans out store work and starves authenticated
# routes on boot.
#
# Runs on node 2 (not node 1, the relay) so restarts don't disrupt the rest of
# the devnet. Patches node2/config.json + `devnet.sh restart-node 2` to apply a
# cap, since the cap only takes effect at rehydrate (boot).
#
# Preconditions: ./scripts/devnet.sh start N  (N >= 2; auth enabled)
#
# Asserts:
#   1. cap=2 → exactly 2 user subs ACTIVE; 'Rehydrated 2 of <total>' + dormant note logged.
#   2. node boots RESPONSIVE under the backlog (status + list answer fast — the wedge guard).
#   3. invalid cap (-1, 0.5) → 'Ignoring invalid …' warning + default 64 (all active).
#   4. cap=0 → no cap (all subs active).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
NODE_NUM="${DEVNET_TEST_NODE:-2}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
API_PORT=$((API_PORT_BASE + NODE_NUM - 1))
API="http://127.0.0.1:${API_PORT}"
NODE_DIR="$DEVNET_DIR/node${NODE_NUM}"
CFG="$NODE_DIR/config.json"
DAEMON_LOG="$NODE_DIR/daemon.log"
SEED_N="${SEED_N:-8}"     # > cap so some rows are left dormant
CAP=2
TS=$(date +%s)

AUTH_TOKEN=$(grep -v '^#' "$NODE_DIR/auth.token" 2>/dev/null | head -1 || echo "")
AUTH="Authorization: Bearer $AUTH_TOKEN"

PASS=0; FAIL=0; declare -a FAILURES
ok()   { PASS=$((PASS+1)); echo "  PASS: $*"; }
bad()  { FAIL=$((FAIL+1)); FAILURES+=("$*"); echo "  FAIL: $*"; }
log()  { echo "[sub-cap] $*"; }
jq_field() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo ""; }
get_count() { curl -s -H "$AUTH" "$API/api/context-graph/subscriptions" | jq_field "d['count']"; }

# Restore a clean config + cap on any exit so the node isn't left capped.
cleanup() {
  patch_cap remove
  curl -s -X DELETE -H "$AUTH" "$API/api/context-graph/subscriptions" >/dev/null 2>&1 || true
}
trap cleanup EXIT

patch_cap() {  # $1 = integer value | "remove"  (env vars MUST precede `node`)
  CAP_VAL="$1" CFG_PATH="$CFG" node -e "
    const fs=require('fs'); const p=process.env.CFG_PATH;
    const c=JSON.parse(fs.readFileSync(p,'utf8'));
    const v=process.env.CAP_VAL;
    if (v==='remove') delete c.maxRehydratedContextGraphSubscriptions;
    else c.maxRehydratedContextGraphSubscriptions = Number(v);
    fs.writeFileSync(p, JSON.stringify(c,null,2));
  "
}

restart_and_wait() {
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh restart-node "$NODE_NUM" ) >/dev/null 2>&1
  for _ in $(seq 1 60); do curl -s "$API/api/status" >/dev/null 2>&1 && { sleep 2; return 0; }; sleep 1; done
  return 1
}

latest_rehydrate_line() { grep -E "Rehydrated [0-9]+ of [0-9]+ persisted context-graph" "$DAEMON_LOG" 2>/dev/null | tail -1; }
# Parse "Rehydrated X of Y …" → echoes "X Y" (X=activated, Y=persisted backlog).
# The GET count is polluted by CGs the node live-discovers from gossip AFTER
# rehydrate, so the boot log is the deterministic cap signal, not GET.
rehydrate_xy() { latest_rehydrate_line | sed -E 's/.*Rehydrated ([0-9]+) of ([0-9]+).*/\1 \2/'; }

# --- Preconditions -----------------------------------------------------------
[ -f "$DEVNET_DIR/hardhat.pid" ] || { echo "devnet not running — ./scripts/devnet.sh start N"; exit 1; }
curl -s "$API/api/status" >/dev/null || { echo "node $NODE_NUM API :$API_PORT not responding"; exit 1; }
[ -n "$AUTH_TOKEN" ] || { echo "no admin token at $NODE_DIR/auth.token"; exit 1; }
log "node $NODE_NUM API :$API_PORT, seeding $SEED_N subs, cap=$CAP"

# --- Seed a clean backlog of SEED_N user subscriptions -----------------------
curl -s -X DELETE -H "$AUTH" "$API/api/context-graph/subscriptions" >/dev/null 2>&1 || true
for i in $(seq 1 "$SEED_N"); do
  CG="did:dkg:context-graph:subcap-${TS}-${i}"
  curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"contextGraphId\":\"$CG\",\"includeSharedMemory\":false}" \
    "$API/api/context-graph/subscribe" >/dev/null
done
sleep 1
PRE=$(get_count)
log "seeded; active user subs before cap = ${PRE:-?}"
[ "${PRE:-0}" -ge "$SEED_N" ] && ok "seeded $SEED_N user subscriptions (active=$PRE, uncapped)" \
  || bad "expected ≥$SEED_N seeded subs, active=$PRE"

# --- 1. cap=2 → exactly 2 ACTIVATED at rehydrate; dormant note logged --------
echo "--- 1. cap=$CAP rehydration ---"
patch_cap "$CAP"
restart_and_wait || bad "node $NODE_NUM did not come back after restart (cap=$CAP)"
read -r X1 Y1 <<<"$(rehydrate_xy)"
if [ "${X1:-}" = "$CAP" ] && [ "${Y1:-0}" -gt "$CAP" ] 2>/dev/null; then
  ok "rehydrate ACTIVATED exactly $CAP of $Y1 persisted (cap enforced; $((Y1-CAP)) dormant)"
else
  bad "expected 'Rehydrated $CAP of >$CAP', got X=${X1:-?} Y=${Y1:-?} (line: $(latest_rehydrate_line | sed 's/.*\[DKGAgent\] //'))"
fi
if latest_rehydrate_line | grep -qE "non-hosted left dormant — over the $CAP activation cap"; then
  ok "boot log records the dormant note"
else
  bad "rehydrate log missing the 'left dormant — over the $CAP activation cap' note"
fi

# --- 2. boot responsive under the backlog (the #997 wedge guard) -------------
echo "--- 2. boot responsive under backlog ---"
T0=$(python3 -c 'import time;print(time.time())')
curl -s -H "$AUTH" "$API/api/context-graph/subscriptions" >/dev/null
curl -s "$API/api/status" >/dev/null
T1=$(python3 -c 'import time;print(time.time())')
ELAPSED=$(python3 -c "print(f'{$T1-$T0:.2f}')")
if python3 -c "import sys;sys.exit(0 if ($T1-$T0)<3.0 else 1)"; then
  ok "status + subscriptions answered in ${ELAPSED}s (not starved by the dormant backlog)"
else
  bad "store-backed routes slow on boot (${ELAPSED}s) — possible store contention"
fi

# --- 3. invalid cap → warning + default 64 (all rehydrated) ------------------
echo "--- 3. invalid cap → warning + default ---"
for badval in -1 0.5; do
  patch_cap "$badval"
  restart_and_wait || { bad "node did not return after restart (cap=$badval)"; continue; }
  if grep -E "Ignoring invalid maxRehydratedContextGraphSubscriptions=$badval" "$DAEMON_LOG" >/dev/null 2>&1; then
    ok "cap=$badval → 'Ignoring invalid …' warning logged"
  else
    bad "cap=$badval → no invalid-cap warning in daemon.log"
  fi
  read -r X3 Y3 <<<"$(rehydrate_xy)"
  if [ -n "${X3:-}" ] && [ "${X3:-}" = "${Y3:-}" ]; then
    ok "cap=$badval → default 64 applied (all $Y3 rehydrated, none dormant)"
  else
    bad "cap=$badval → expected all rehydrated under default, got X=${X3:-?} Y=${Y3:-?}"
  fi
done

# --- 4. cap=0 → no cap (all rehydrated) --------------------------------------
echo "--- 4. cap=0 → no cap ---"
patch_cap 0
restart_and_wait || bad "node did not return after restart (cap=0)"
read -r X4 Y4 <<<"$(rehydrate_xy)"
if [ -n "${X4:-}" ] && [ "${X4:-}" = "${Y4:-}" ]; then
  ok "cap=0 disables the cap (all $Y4 user subs rehydrated)"
else
  bad "cap=0 → expected all rehydrated, got X=${X4:-?} Y=${Y4:-?}"
fi

# --- Summary -----------------------------------------------------------------
echo ""
echo "=== subscription-cap: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -gt 0 ]; then
  for f in "${FAILURES[@]}"; do echo "  ✗ $f"; done
  exit 1
fi
exit 0
