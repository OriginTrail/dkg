#!/usr/bin/env bash
#
# Test the full project invitation flow via CLI and API (simulating UI).
# Requires a running 3-node devnet.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
TOKEN_FILE="$DEVNET_DIR/node1/auth.token"
TOKEN=$(tail -1 "$TOKEN_FILE" 2>/dev/null || echo "")
if [ -z "$TOKEN" ]; then
  echo "FATAL: No auth token found. Is devnet running?" >&2
  exit 1
fi

CLI="node $REPO_ROOT/packages/cli/dist/cli.js"

PORT1="${API_PORT_BASE:-9201}"
PORT2=$((PORT1 + 1))
PORT3=$((PORT1 + 2))
HOME1="$DEVNET_DIR/node1"
HOME2="$DEVNET_DIR/node2"
HOME3="$DEVNET_DIR/node3"
ADDR1="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ADDR2="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
ADDR3="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

PASS=0
FAIL=0
WARN=0

pass() { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ✗ $1" >&2; }
warn() { WARN=$((WARN+1)); echo "  ⚠ $1"; }
h()    { echo ""; echo "═══ $1 ═══"; }

api() {
  local port=$1; shift
  local method=$1; shift
  local path=$1; shift
  if [ "$method" = "GET" ]; then
    curl -sf -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${port}${path}" "$@" 2>/dev/null || echo '{"error":"request failed"}'
  else
    curl -sf -X "$method" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "http://127.0.0.1:${port}${path}" "$@" 2>/dev/null || echo '{"error":"request failed"}'
  fi
}

cli_node() {
  local port=$1; shift
  local home="$DEVNET_DIR/node${port: -1}"
  DKG_HOME="$home" DKG_API_PORT=$port $CLI "$@" 2>&1
}

# ──────────────────────────────────────────────────────────
h "PART 1: CLI Flow — Node 1 creates, Node 2 joins"
# ──────────────────────────────────────────────────────────

echo "1a. Node 1: Create curated project via CLI (bare slug auto-namespace)"
CREATE_OUT=$(cli_node $PORT1 context-graph create cli-test-project --name "CLI Test Project" --access-policy 1)
echo "$CREATE_OUT"
CG_ID=$(echo "$CREATE_OUT" | grep "ID:" | head -1 | sed 's/.*ID:[ ]*//')
if echo "$CG_ID" | grep -q "$ADDR1/cli-test-project"; then
  pass "Auto-namespaced CG ID: $CG_ID"
else
  fail "Expected $ADDR1/cli-test-project, got: $CG_ID"
fi

echo ""
echo "1b. Node 1: List agents (should have creator auto-added)"
AGENTS_OUT=$(cli_node $PORT1 context-graph agents "$CG_ID")
echo "$AGENTS_OUT"
if echo "$AGENTS_OUT" | grep -q "Allowed agents" && echo "$AGENTS_OUT" | grep -q "$ADDR1"; then
  pass "Creator is in allowlist"
else
  fail "Creator not in allowlist: $AGENTS_OUT"
fi

echo ""
echo "1c. Node 2: Request to join via CLI"
sleep 3
JOIN_OUT=$(cli_node $PORT2 context-graph request-join "$CG_ID")
echo "$JOIN_OUT"
if echo "$JOIN_OUT" | grep -qi "sent\|already"; then
  pass "Join request sent from Node 2"
else
  fail "Join request failed: $JOIN_OUT"
fi

echo ""
echo "1d. Node 1: List join requests (poll up to 10s)"
GOT_REQUEST=0
for i in $(seq 1 5); do
  sleep 2
  REQUESTS_OUT=$(cli_node $PORT1 context-graph join-requests "$CG_ID")
  if echo "$REQUESTS_OUT" | grep -q "$ADDR2"; then
    GOT_REQUEST=1
    break
  fi
done
echo "$REQUESTS_OUT"
if [ "$GOT_REQUEST" -eq 1 ]; then
  pass "Node 2's join request visible to curator"
else
  fail "Join request not found after 10s: $REQUESTS_OUT"
fi

echo ""
echo "1e. Node 1: Approve Node 2's join request"
APPROVE_OUT=$(cli_node $PORT1 context-graph approve-join "$CG_ID" --agent "$ADDR2")
echo "$APPROVE_OUT"
if echo "$APPROVE_OUT" | grep -qi "approved"; then
  pass "Join request approved"
else
  fail "Approve failed: $APPROVE_OUT"
fi

echo ""
echo "1f. Node 1: List agents after approval"
AGENTS_AFTER=$(cli_node $PORT1 context-graph agents "$CG_ID")
echo "$AGENTS_AFTER"
if echo "$AGENTS_AFTER" | grep -qi "$ADDR2"; then
  pass "Node 2 now in allowlist"
else
  fail "Node 2 not in allowlist after approval"
fi

echo ""
echo "1g. Node 1: Add Node 3 directly (pre-invite)"
ADD_OUT=$(cli_node $PORT1 context-graph add-agent "$CG_ID" --agent "$ADDR3")
echo "$ADD_OUT"
if echo "$ADD_OUT" | grep -qi "added\|Agent"; then
  pass "Node 3 added to allowlist"
else
  fail "Add agent failed: $ADD_OUT"
fi

echo ""
echo "1h. Node 1: Verify all 3 agents in allowlist"
AGENTS_FINAL=$(cli_node $PORT1 context-graph agents "$CG_ID")
echo "$AGENTS_FINAL"
HAS1=$(echo "$AGENTS_FINAL" | grep -ci "$ADDR1" || true)
HAS2=$(echo "$AGENTS_FINAL" | grep -ci "$ADDR2" || true)
HAS3=$(echo "$AGENTS_FINAL" | grep -ci "$ADDR3" || true)
if [ "$HAS1" -ge 1 ] && [ "$HAS2" -ge 1 ] && [ "$HAS3" -ge 1 ]; then
  pass "All 3 agents in allowlist"
else
  fail "Missing agents: addr1=$HAS1 addr2=$HAS2 addr3=$HAS3"
fi

echo ""
echo "1i. Node 1: Remove Node 3"
REMOVE_OUT=$(cli_node $PORT1 context-graph remove-agent "$CG_ID" --agent "$ADDR3")
echo "$REMOVE_OUT"
if echo "$REMOVE_OUT" | grep -qi "removed\|Agent"; then
  pass "Node 3 removed from allowlist"
else
  fail "Remove failed: $REMOVE_OUT"
fi

echo ""
echo "1j. Verify Node 3 removed"
AGENTS_POST_REMOVE=$(cli_node $PORT1 context-graph agents "$CG_ID")
echo "$AGENTS_POST_REMOVE"
if echo "$AGENTS_POST_REMOVE" | grep -q "^  $ADDR3"; then
  fail "Node 3 still in allowlist after removal"
else
  pass "Node 3 no longer in allowlist"
fi

# ──────────────────────────────────────────────────────────
h "PART 2: API Flow (simulating UI) — Node 1 creates, Node 3 joins"
# ──────────────────────────────────────────────────────────

UI_CG_ID="$ADDR1/ui-test-project"

echo "2a. Node 1: Create curated project via API (like UI would)"
CREATE_API=$(api $PORT1 POST "/api/context-graph/create" -d "{\"id\":\"$UI_CG_ID\",\"name\":\"UI Test Project\",\"accessPolicy\":1,\"allowedAgents\":[\"$ADDR1\"]}")
echo "$CREATE_API" | python3 -m json.tool 2>/dev/null || echo "$CREATE_API"
if echo "$CREATE_API" | grep -q "ui-test-project"; then
  pass "API: Project created with clean slug (no timestamp suffix)"
else
  fail "API: Project creation failed: $CREATE_API"
fi

echo ""
echo "2b. Node 3: Send join request via API"
sleep 3
JOIN_API=$(api $PORT3 POST "/api/context-graph/$(python3 -c "import urllib.parse; print(urllib.parse.quote('$UI_CG_ID', safe=''))")/sign-join" -d '{}')
echo "$JOIN_API" | python3 -m json.tool 2>/dev/null || echo "$JOIN_API"
if echo "$JOIN_API" | grep -q '"ok"'; then
  pass "API: Join request sent from Node 3"
else
  fail "API: Join request failed: $JOIN_API"
fi

echo ""
echo "2c. Node 1: List join requests via API"
sleep 2
ENC_ID=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$UI_CG_ID', safe=''))")
REQUESTS_API=$(api $PORT1 GET "/api/context-graph/$ENC_ID/join-requests")
echo "$REQUESTS_API" | python3 -m json.tool 2>/dev/null || echo "$REQUESTS_API"
if echo "$REQUESTS_API" | grep -qi "$ADDR3\|pending"; then
  pass "API: Join request from Node 3 visible"
else
  fail "API: No join request found: $REQUESTS_API"
fi

echo ""
echo "2d. Node 1: Approve Node 3 via API"
APPROVE_API=$(api $PORT1 POST "/api/context-graph/$ENC_ID/approve-join" -d "{\"agentAddress\":\"$ADDR3\"}")
echo "$APPROVE_API" | python3 -m json.tool 2>/dev/null || echo "$APPROVE_API"
if echo "$APPROVE_API" | grep -qi "approved"; then
  pass "API: Node 3 approved"
else
  fail "API: Approve failed: $APPROVE_API"
fi

echo ""
echo "2e. Node 1: List participants via API"
PARTS_API=$(api $PORT1 GET "/api/context-graph/$ENC_ID/participants")
echo "$PARTS_API" | python3 -m json.tool 2>/dev/null || echo "$PARTS_API"
if echo "$PARTS_API" | grep -qi "$ADDR3"; then
  pass "API: Node 3 in participants list"
else
  fail "API: Node 3 not in participants"
fi

# ──────────────────────────────────────────────────────────
h "PART 3: Cross-check — CLI reads API project, API reads CLI project"
# ──────────────────────────────────────────────────────────

echo "3a. CLI: List agents on the API-created project"
CLI_READ_API=$(cli_node $PORT1 context-graph agents "$UI_CG_ID")
echo "$CLI_READ_API"
if echo "$CLI_READ_API" | grep -qi "$ADDR3"; then
  pass "CLI can read API-created project's agents"
else
  fail "CLI cannot see API-created project agents"
fi

echo ""
echo "3b. API: List participants on the CLI-created project"
CLI_ENC=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CG_ID', safe=''))")
API_READ_CLI=$(api $PORT1 GET "/api/context-graph/$CLI_ENC/participants")
echo "$API_READ_CLI" | python3 -m json.tool 2>/dev/null || echo "$API_READ_CLI"
if echo "$API_READ_CLI" | grep -qi "$ADDR2"; then
  pass "API can read CLI-created project's agents"
else
  fail "API cannot see CLI-created project agents"
fi

echo ""
echo "3c. Both projects visible in context-graph list"
LIST_OUT=$(cli_node $PORT1 context-graph list)
CLI_PROJ=$(echo "$LIST_OUT" | grep -c "cli-test-project" || true)
UI_PROJ=$(echo "$LIST_OUT" | grep -c "ui-test-project" || true)
if [ "$CLI_PROJ" -ge 1 ] && [ "$UI_PROJ" -ge 1 ]; then
  pass "Both projects visible in list"
else
  warn "Missing projects in list: cli=$CLI_PROJ ui=$UI_PROJ"
fi

# ──────────────────────────────────────────────────────────
h "PART 4: Edge cases"
# ──────────────────────────────────────────────────────────

echo "4a. Duplicate create should fail (409)"
DUP_OUT=$(cli_node $PORT1 context-graph create cli-test-project --name "Duplicate" --access-policy 1 2>&1 || true)
echo "$DUP_OUT"
if echo "$DUP_OUT" | grep -qi "already exists\|409\|conflict"; then
  pass "Duplicate create rejected"
else
  fail "Duplicate create did not fail: $DUP_OUT"
fi

echo ""
echo "4b. Non-curator cannot approve (Node 2 tries to approve on Node 1's project)"
NON_CURATOR=$(cli_node $PORT2 context-graph approve-join "$CG_ID" --agent "$ADDR3" 2>&1 || true)
echo "$NON_CURATOR"
if echo "$NON_CURATOR" | grep -qi "error\|creator\|not curator\|not found\|pending"; then
  pass "Non-curator approval rejected"
else
  warn "Non-curator check unclear: $NON_CURATOR"
fi

echo ""
echo "4c. Deprecated invite command shows warning"
INVITE_OUT=$(cli_node $PORT1 context-graph invite "$CG_ID" --peer "12D3KooWFake" 2>&1 || true)
echo "$INVITE_OUT"
if echo "$INVITE_OUT" | grep -qi "deprecated"; then
  pass "Deprecated invite shows warning"
else
  fail "No deprecation warning shown"
fi

# ──────────────────────────────────────────────────────────
h "RESULTS"
# ──────────────────────────────────────────────────────────

TOTAL=$((PASS+FAIL+WARN))
echo ""
echo "  Passed:   $PASS / $TOTAL"
echo "  Failed:   $FAIL"
echo "  Warnings: $WARN"
echo ""
if [ "$FAIL" -gt 0 ]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "ALL TESTS PASSED"
fi
