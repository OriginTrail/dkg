#!/usr/bin/env bash
#
# v10-rc-validation.sh — DKG v10 RC API smoke test
#
# 15 sections covering boot, publish, gossip, SWM, WM, promote, sub-graphs,
# query views, CAS, chat, SKILL.md, identity. Talks only to the public HTTP
# API of a running 6-node devnet (ports 9201-9205).
#
# Exit code is non-zero when any sub-test fails — orchestrators key off this.
#
# Wire shapes assumed:
#   - publish:    POST /api/knowledge-assets + POST /api/knowledge-assets/<name>/vm/publish
#   - update/private quads: POST /api/update     (legacy is intentionally retained)
#   - SWM:        POST /api/knowledge-assets/<name>/swm/share
#   - knowledge-assets: POST /api/knowledge-assets (create), POST /api/knowledge-assets/<name>/wm/write, GET /api/knowledge-assets/<name>/wm/quads (query), POST /api/knowledge-assets/<name>/swm/share (promote)
#   - CAS:        retired with loose SWM writes
#   - chat:       POST /api/chat { to, text }
#   - identity:   GET  /api/identity      (replaces deprecated /api/profile)
#   - status:     GET  /api/status        (carries peerId, name, nodeRole — covers profile cases)
#
# rc.10/rc.11 endpoints that no longer exist (`/api/publish`, `/api/profile`)
# have been removed from the script. The validation suite is the
# canonical place to read the current public API contract.

set -uo pipefail

# Resolve bearer token: explicit env var wins; otherwise read the devnet's
# generated auth token from disk. We never hard-code a token here — every
# `./scripts/devnet.sh start` rolls a fresh one, so a baked-in default would
# work only by accident (and fail loudly with 401s on every POST after a
# clean restart, which is exactly the trap this fallback path avoids).
REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
NUM_NODES="${NUM_NODES:-6}"
# shellcheck source=devnet-update-helpers.sh
source "$SCRIPT_DIR/devnet-update-helpers.sh"
if [ -n "${DKG_AUTH:-}" ]; then
  AUTH="$DKG_AUTH"
elif [ -n "${AUTH_TOKEN:-}" ]; then
  AUTH="$AUTH_TOKEN"
elif [ -r "$DEVNET_DIR/node1/auth.token" ]; then
  AUTH=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" | head -1)
else
  echo "  ❌ Could not resolve bearer token: set DKG_AUTH, or run devnet first (expected $DEVNET_DIR/node1/auth.token)" >&2
  exit 2
fi
H="Authorization: Bearer $AUTH"
PASS=0; FAIL=0; WARN=0; TOTAL=0

# Per-run suffix so re-runs against the same devnet don't collide on
# rootEntity-already-exists rejections (rc.12 SWM Rule 4).
RUN_TAG="${RUN_TAG:-$(date -u +%s)}"

ok()   { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "  ✅ $*"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "  ❌ $*"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️  $*"; }

api()  { curl -s -H "$H" "$@"; }
post() { local port=$1; shift; api -X POST "http://127.0.0.1:$port$@"; }
get()  { local port=$1; shift; api "http://127.0.0.1:$port$@"; }
http_code() {
  local port=$1; shift
  curl -s -o /dev/null -w "%{http_code}" -H "$H" "$@" "http://127.0.0.1:$port$1" 2>/dev/null
}

section() { echo ""; echo "━━━ $* ━━━"; }

# JSON quad/triple builders — keep the IRI/literal escaping in one place so
# every section feeds identically-shaped quads.
q()  { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"$3\",\"graph\":\"\"}"; }
ql() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"\\\"$3\\\"\",\"graph\":\"\"}"; }

# jq is convenient but not always present in CI containers. We use python3
# for JSON pulls — every parser call goes through this helper so a single
# format change is fixable in one place.
#
# Usage: `echo "$json" | pyfield <python-expression>`
#   - The JSON is bound to `d`.
#   - The argument is a single Python EXPRESSION (no statements / semicolons).
#     Need locals? Use `(lambda b=...: ...)()` or fold into a single expression.
#   - Always emits a single line, never raises (parse/eval errors → '').
pyfield() {
  # NOTE: heredoc <<EOF as stdin would shadow the pipe-stdin, so we pass the
  # script via -c and reserve real stdin for the JSON payload.
  python3 -c '
import sys, json
expr = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print("")
    sys.exit(0)
try:
    print(eval(expr, {"d": d, "__builtins__": __builtins__}))
except Exception:
    print("")
' "$1"
}

CG="${CG:-devnet-test}"

# publish_swm <port> <cgid> <quads-json> [<subGraphName>] [<rootEntity>]
#
# Two-step SWM write+publish flow. When rootEntity is supplied, we use
# the targeted `selection: { rootEntities: [...] }` form — important
# when the CG already has unrelated SWM content from earlier runs
# (which would otherwise trip the "rootEntity already exists" rule
# at the publish boundary).
#
# Echoes `"<status>|<kaId>|<raw-response-json>"` on stdout. Callers
# split on the first two `|` and treat the rest as the raw response.
publish_swm() {
  local port=$1 cgid=$2 quads_json=$3 sgname=${4:-} root_entity=${5:-}
  local name="rc-${RUN_TAG}-${port}-${RANDOM:-0}"
  local write_body=$(cat <<JSON
{"contextGraphId":"$cgid","name":"$name","quads":[$quads_json],"finalize":true,"alsoShareSwm":true$([ -n "$sgname" ] && echo ",\"subGraphName\":\"$sgname\"")}
JSON
)
  local w=$(post "$port" /api/knowledge-assets -H "Content-Type: application/json" -d "$write_body")
  local shared=$(echo "$w" | pyfield "1 if d.get('swmShared') or d.get('status') in ('swm-shared','vm-confirmed') else 0")
  if [ "$shared" != "1" ]; then
    echo "WRITE_FAILED||$w"
    return 1
  fi
  local pub_body=$(cat <<JSON
{"contextGraphId":"$cgid"$([ -n "$sgname" ] && echo ",\"subGraphName\":\"$sgname\""),"options":{"clearAfter":false}}
JSON
)
  local p=$(post "$port" "/api/knowledge-assets/$name/vm/publish" -H "Content-Type: application/json" -d "$pub_body")
  local st=$(echo "$p" | pyfield "d.get('status','?')")
  local kc=$(echo "$p" | pyfield "d.get('kaId','?')")
  echo "${st}|${kc}|${p}"
}

# ────────────────────────────────────────────────────────────────────────────
section "1. NODE HEALTH & CONNECTIVITY"

for port in 9201 9202 9203 9204 9205; do
  STATUS=$(get $port /api/status 2>/dev/null || echo '{}')
  NAME=$(echo "$STATUS" | pyfield "d.get('name','?')")
  ROLE=$(echo "$STATUS" | pyfield "d.get('nodeRole','?')")
  if [ "$NAME" != "" ] && [ "$NAME" != "?" ]; then
    ok "Node $port ($NAME, $ROLE) healthy"
  else
    fail "Node $port unreachable"
  fi
done

AGENTS=$(get 9201 /api/agents 2>/dev/null || echo '{}')
PEER_COUNT=$(echo "$AGENTS" | pyfield "len(d.get('agents',[]))")
if [ -z "$PEER_COUNT" ]; then PEER_COUNT=0; fi
if [ "$PEER_COUNT" -ge 4 ]; then
  ok "Node 1 sees $PEER_COUNT peers (expected ≥4)"
else
  fail "Node 1 sees only $PEER_COUNT peers (expected ≥4)"
fi

# ────────────────────────────────────────────────────────────────────────────
section "2. CONTEXT GRAPH CREATION"

CG2="v10-validation-$RUN_TAG"
CG_CREATE=$(post 9201 /api/context-graph/create -H "Content-Type: application/json" -d "{\"id\":\"$CG2\",\"name\":\"V10 Validation CG\"}")
CG_OK=$(echo "$CG_CREATE" | pyfield "1 if (d.get('created') or d.get('uri') or 'context-graph' in str(d).lower()) else 0")
if [ "$CG_OK" = "1" ]; then
  ok "Context graph '$CG2' created on node 1"
else
  fail "Context graph create failed: $CG_CREATE"
fi

# ────────────────────────────────────────────────────────────────────────────
section "3. PUBLISH PUBLIC QUADS (SWM-write → SWM-publish → VM)"

ALICE_URI="urn:v10:alice-$RUN_TAG"
QUADS_PUBLIC="$(q "$ALICE_URI" 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Person'),$(ql "$ALICE_URI" 'http://schema.org/name' "Alice V10 $RUN_TAG"),$(ql "$ALICE_URI" 'http://schema.org/jobTitle' 'Protocol Engineer')"

RES=$(publish_swm 9201 "$CG" "$QUADS_PUBLIC" "" "$ALICE_URI")
PUB_STATUS="${RES%%|*}"
REST="${RES#*|}"
PUB_KCID="${REST%%|*}"
PUB_RAW="${REST#*|}"

if [ "$PUB_STATUS" = "confirmed" ] || [ "$PUB_STATUS" = "finalized" ] || [ -n "$PUB_KCID" -a "$PUB_KCID" != "?" ]; then
  ok "Public publish confirmed, kaId=$PUB_KCID, status=$PUB_STATUS"
else
  fail "Public publish status=$PUB_STATUS, raw=$PUB_RAW"
fi

sleep 3

# ────────────────────────────────────────────────────────────────────────────
section "4. PUBLISH WITH PRIVATE TRIPLES (via /api/update)"

# rc.12 publish path does NOT take privateQuads. Privacy enforcement now lives
# on the update path: publish a KC first (§3 already did), then issue an
# update that adds public + private quads. The publisher receives both, but
# only the public ones gossip; the private set stays on the publisher.

if [ "$PUB_STATUS" = "confirmed" ] || [ "$PUB_STATUS" = "finalized" ]; then
  BOB_URI="urn:v10:bob-$RUN_TAG"
  QUADS_JSON=$(cat <<JSON
[
  $(q "$BOB_URI" "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" "http://schema.org/Person"),
  $(ql "$BOB_URI" "http://schema.org/name" "Bob V10 $RUN_TAG")
]
JSON
)
  PRIVATE_QUADS_JSON=$(node -e "
    const s = process.argv[1];
    console.log(JSON.stringify([
      { subject: s, predicate: 'http://schema.org/email', object: '\"bob@secret.test\"', graph: '' },
      { subject: s, predicate: 'http://schema.org/telephone', object: '\"+1-555-PRIVATE\"', graph: '' },
    ]));
  " "$BOB_URI")
  UPD_BODY=$(build_update_body 1 "$PUB_KCID" "$CG" "$QUADS_JSON" "$PRIVATE_QUADS_JSON") || UPD_BODY=""
  if [ -z "$UPD_BODY" ]; then
    fail "Private update: could not build precomputedUpdateAttestation for kaId=$PUB_KCID (is Hardhat up and contracts deployed?)"
    PRIV_RESULT=""
  else
    PRIV_RESULT=$(post 9201 /api/update -H "Content-Type: application/json" -d "$UPD_BODY")
  fi
  PRIV_STATUS=$(echo "$PRIV_RESULT" | pyfield "d.get('status','?')")
  if [ "$PRIV_STATUS" = "confirmed" ] || [ "$PRIV_STATUS" = "finalized" ]; then
    ok "Update with private triples confirmed, status=$PRIV_STATUS"
  elif echo "$PRIV_RESULT" | grep -Eq 'NO_DATA_IN_SWM|MERKLE_MISMATCH_IN_SWM'; then
    # OT-RFC-49 (Rung-1 strip): cores hold ZERO private SWM ciphertext, so a
    # private-quad update on a curated CG cannot draw its ACK quorum FROM the
    # cores. Depending on whether a peer has already retained the public SWM
    # snapshot, it declines as NO_DATA_IN_SWM or MERKLE_MISMATCH_IN_SWM. Both
    # are the privacy model working as intended, not a failure. The durable
    # private-update path now routes through the curator and is covered by
    # scripts/devnet-test-curator-ack-gate.sh.
    warn "Private update declined by core ACK privacy guard — expected post-RFC-49 (curator path covered by devnet-test-curator-ack-gate.sh)"
  else
    fail "Private update status=$PRIV_STATUS: $PRIV_RESULT"
  fi

  sleep 3

  echo ""
  echo "--- 4b: Private triples NOT visible on other nodes ---"
  for PORT in 9202 9203 9204; do
    LEAK=$(post $PORT /api/query -H "Content-Type: application/json" -d "{
      \"sparql\": \"SELECT ?o WHERE { <$BOB_URI> <http://schema.org/email> ?o }\",
      \"contextGraphId\": \"$CG\"
    }")
    BINDINGS=$(echo "$LEAK" | pyfield "len(d.get('result',{}).get('bindings',[]))")
    [ -z "$BINDINGS" ] && BINDINGS=0
    if [ "$BINDINGS" = "0" ]; then
      ok "Node $PORT: no private triple leak"
    else
      fail "Node $PORT: private triple leaked! ($BINDINGS bindings)"
    fi
  done

  echo ""
  echo "--- 4c: Private triples invisible to publisher's own public SPARQL view ---"
  # rc.12 stores private triples encrypted-at-rest in the PrivateStore. The
  # /api/update response exposes only { tokenId, rootEntity } per KA — neither
  # `privateTripleCount` nor `privateMerkleRoot` are part of the public wire
  # shape (see agent-chat.ts /api/update route). The unit test
  # core/test/private-store-update.test.ts pins the storage round-trip.
  #
  # At the public API surface we can only assert two things:
  #   (a) §4 above: the update with privateQuads returned status=confirmed
  #       (i.e., the daemon accepted the private payload without erroring);
  #   (b) here: the private subject is invisible in the public SPARQL view
  #       on the PUBLISHER itself — not just on §4b's peer nodes. This is
  #       the strongest "privacy boundary" assertion we can make without
  #       leaking the decryption key into a test fixture.
  PUB_LEAK=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT ?o WHERE { <$BOB_URI> <http://schema.org/email> ?o }\",
    \"contextGraphId\": \"$CG\"
  }")
  PUB_BINDINGS=$(echo "$PUB_LEAK" | pyfield "len(d.get('result',{}).get('bindings',[]))")
  [ -z "$PUB_BINDINGS" ] && PUB_BINDINGS=0
  if [ "$PUB_BINDINGS" = "0" ]; then
    ok "Publisher (node 9201) public view does NOT leak private email — privacy boundary intact"
  else
    fail "Publisher (node 9201) public view leaked private email ($PUB_BINDINGS bindings): $PUB_LEAK"
  fi
else
  warn "Skipping §4 — §3 publish did not yield a kaId (private-update path needs an existing KC)"
fi

# ────────────────────────────────────────────────────────────────────────────
section "5. VM REPLICATION — public data on other nodes"

# Closes #774 finding #2 — the original single `sleep 5` + one-shot
# query was flaky on cold/warming meshes: replication did happen, but
# the test polled before the first SWM/VM sync arrived at the edge
# nodes. Switch to a per-node poll-until-found loop with a 60s budget
# and 2s tick — gives a warm mesh the same fast-path (first tick OK)
# while letting a cold mesh actually exercise the sync path before we
# fail. `RC_VALIDATION_GOSSIP_BUDGET_S` lets CI/operators tune this.
#
# Published KA quads live in the verifiable-memory layer on peer nodes.
# The default query view is a legacy/local root-graph view and is not a
# reliable cross-node replication assertion for the per-KA VM layout.
GOSSIP_BUDGET_S="${RC_VALIDATION_GOSSIP_BUDGET_S:-60}"
# Per-request curl timeout makes the poll budget real: if a node wedges
# its HTTP socket, a bare `post` (no `--max-time`) would hang the whole
# script and never let the budget expire. Cap each tick at
# `GOSSIP_TICK_MAX_S` (default 5s) so we always stay within budget.
GOSSIP_TICK_MAX_S="${RC_VALIDATION_GOSSIP_TICK_MAX_S:-5}"

for PORT in 9202 9203 9204; do
  DEADLINE=$(( $(date +%s) + GOSSIP_BUDGET_S ))
  NAME_VAL=""
  while [ "$(date +%s)" -lt "$DEADLINE" ]; do
    REP=$(curl -s --max-time "$GOSSIP_TICK_MAX_S" --connect-timeout 2 \
      -H "$H" -H "Content-Type: application/json" \
      -X POST "http://127.0.0.1:$PORT/api/query" -d "{
      \"sparql\": \"SELECT ?name WHERE { <$ALICE_URI> <http://schema.org/name> ?name }\",
      \"contextGraphId\": \"$CG\",
      \"view\": \"verifiable-memory\"
    }" || echo '')
    NAME_VAL=$(echo "$REP" | pyfield "(lambda b: (b[0].get('name') if b else 'EMPTY'))(d.get('result',{}).get('bindings',[]))")
    echo "$NAME_VAL" | grep -q "Alice" && break
    sleep 2
  done
  if echo "$NAME_VAL" | grep -q "Alice"; then
    ok "Node $PORT: replicated Alice data"
  else
    fail "Node $PORT: Alice data not found after ${GOSSIP_BUDGET_S}s poll (got: $NAME_VAL)"
  fi
done

# ────────────────────────────────────────────────────────────────────────────
section "6. SHARED WORKING MEMORY (SWM) — direct write"

DRAFT_URI="urn:v10:draft-report-$RUN_TAG"
SWM_NAME="draft-report-$RUN_TAG"
SWM_BODY=$(cat <<JSON
{
  "contextGraphId": "$CG",
  "name": "$SWM_NAME",
  "quads": [
    $(q "$DRAFT_URI" "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" "http://schema.org/Report"),
    $(ql "$DRAFT_URI" "http://schema.org/name" "Q1 Analysis Draft $RUN_TAG"),
    $(ql "$DRAFT_URI" "http://schema.org/description" "Work in progress analysis")
  ],
  "finalize": true,
  "alsoShareSwm": true
}
JSON
)
SWM_RESULT=$(post 9201 /api/knowledge-assets -H "Content-Type: application/json" -d "$SWM_BODY")
SWM_SHARED=$(echo "$SWM_RESULT" | pyfield "1 if d.get('swmShared') or d.get('status') in ('swm-shared','vm-confirmed') else 0")
if [ "$SWM_SHARED" = "1" ]; then
  ok "Named KA shared to SWM: $SWM_NAME"
else
  fail "Named KA share failed: $SWM_RESULT"
fi

sleep 2

echo ""
echo "--- 6b: Query SWM data on node 1 ---"
SWM_Q=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$DRAFT_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"includeSharedMemory\": true
}")
SWM_FOUND=$(echo "$SWM_Q" | pyfield "(lambda b: (b[0].get('name') if b else 'EMPTY'))(d.get('result',{}).get('bindings',[]))")
if echo "$SWM_FOUND" | grep -q "Q1 Analysis"; then
  ok "SWM data queryable on node 1"
else
  fail "SWM data not found on node 1 (got: $SWM_FOUND)"
fi

echo ""
echo "--- 6c: SWM data replicated to node 2 ---"
sleep 3
SWM_REP=$(post 9202 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$DRAFT_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"includeSharedMemory\": true
}")
SWM_REP_FOUND=$(echo "$SWM_REP" | pyfield "(lambda b: (b[0].get('name') if b else 'EMPTY'))(d.get('result',{}).get('bindings',[]))")
if echo "$SWM_REP_FOUND" | grep -q "Q1 Analysis"; then
  ok "SWM data replicated to node 2"
else
  warn "SWM data not yet on node 2 (may need more time): $SWM_REP_FOUND"
fi

# ────────────────────────────────────────────────────────────────────────────
section "7. WORKING MEMORY ASSERTIONS"

# Unique assertion name per run avoids "already exists" rejections on the
# named-assertion lifecycle (rc.12 surfaces the conflict as a 400).
ASSERT_NAME="research-notes-$RUN_TAG"

echo "--- 7a: Create assertion ---"
WM_CREATE=$(post 9201 /api/knowledge-assets -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"name\": \"$ASSERT_NAME\"
}")
WM_URI=$(echo "$WM_CREATE" | pyfield "d.get('assertionUri','?')")
if [ -n "$WM_URI" ] && [ "$WM_URI" != "?" ]; then
  ok "WM assertion created: $WM_URI"
else
  fail "WM assertion create failed: $WM_CREATE"
fi

FINDING_URI="urn:v10:finding-$RUN_TAG"

echo "--- 7b: Write to assertion ---"
WM_WRITE=$(post 9201 "/api/knowledge-assets/$ASSERT_NAME/wm/write" -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(q "$FINDING_URI" "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" "http://schema.org/ScholarlyArticle"),
    $(ql "$FINDING_URI" "http://schema.org/name" "Local Finding $RUN_TAG"),
    $(ql "$FINDING_URI" "http://schema.org/abstract" "This is a WM-only research note")
  ]
}")
WM_WRITE_OK=$(echo "$WM_WRITE" | pyfield "1 if (d.get('written',0) > 0 or 'ok' in str(d).lower() or d.get('triplesWritten',0) > 0) else 0")
if [ "$WM_WRITE_OK" = "1" ]; then
  ok "WM assertion write succeeded"
else
  fail "WM assertion write failed: $WM_WRITE"
fi

echo "--- 7c: Query assertion ---"
WM_QUERY=$(api "http://127.0.0.1:9201/api/knowledge-assets/$ASSERT_NAME/wm/quads?contextGraphId=$CG")
WM_COUNT=$(echo "$WM_QUERY" | pyfield "(len(d) if isinstance(d,list) else d.get('count', len(d.get('quads',[]))))")
[ -z "$WM_COUNT" ] && WM_COUNT=0
if [ "$WM_COUNT" != "0" ]; then
  ok "WM assertion query returned $WM_COUNT quads"
else
  fail "WM assertion query empty"
fi

echo "--- 7d: WM data NOT visible on other nodes (isolation) ---"
WM_LEAK=$(post 9202 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$FINDING_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\"
}")
WM_LEAK_COUNT=$(echo "$WM_LEAK" | pyfield "len(d.get('result',{}).get('bindings',[]))")
[ -z "$WM_LEAK_COUNT" ] && WM_LEAK_COUNT=0
if [ "$WM_LEAK_COUNT" = "0" ]; then
  ok "WM data correctly isolated — not visible on node 2"
else
  fail "WM data leaked to node 2 ($WM_LEAK_COUNT bindings)"
fi

# ────────────────────────────────────────────────────────────────────────────
section "8. PROMOTE WM → SWM"

WM_PROMOTE=$(post 9201 "/api/knowledge-assets/$ASSERT_NAME/swm/share" -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\"
}")
PROMOTE_COUNT=$(echo "$WM_PROMOTE" | pyfield "d.get('promotedCount', d.get('triplesPromoted','?'))")
if [ -n "$PROMOTE_COUNT" ] && [ "$PROMOTE_COUNT" != "?" ] && [ "$PROMOTE_COUNT" != "0" ]; then
  ok "Promoted $PROMOTE_COUNT quads from WM to SWM"
else
  fail "Promote failed: $WM_PROMOTE"
fi

# ────────────────────────────────────────────────────────────────────────────
section "9. PUBLISH FROM SWM → VM"

sleep 2
ENSHRINE=$(post 9201 "/api/knowledge-assets/$ASSERT_NAME/vm/publish" -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"options\": { \"clearAfter\": false }
}")
ENS_STATUS=$(echo "$ENSHRINE" | pyfield "d.get('status','?')")
ENS_KCID=$(echo "$ENSHRINE" | pyfield "d.get('kaId','?')")
if [ "$ENS_STATUS" = "confirmed" ] || [ "$ENS_STATUS" = "finalized" ]; then
  ok "Publish from SWM confirmed, kaId=$ENS_KCID"
else
  fail "Publish from SWM status=$ENS_STATUS: $ENSHRINE"
fi

# ────────────────────────────────────────────────────────────────────────────
section "10. SUB-GRAPHS"

echo "--- 10a: Create sub-graph ---"
SG_NAME="decisions-$RUN_TAG"
SG_CREATE=$(post 9201 /api/sub-graph/create -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"subGraphName\": \"$SG_NAME\"
}")
SG_OK=$(echo "$SG_CREATE" | pyfield "1 if (d.get('created') or 'ok' in str(d).lower() or '$SG_NAME' in str(d)) else 0")
if [ "$SG_OK" = "1" ]; then
  ok "Sub-graph '$SG_NAME' created"
else
  fail "Sub-graph create failed: $SG_CREATE"
fi

echo "--- 10b: Publish to sub-graph (SWM-write+publish, subGraphName-scoped) ---"
DECISION_URI="urn:v10:decision-$RUN_TAG"
SG_QUADS="$(q "$DECISION_URI" "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" "http://schema.org/Action"),$(ql "$DECISION_URI" "http://schema.org/name" "Adopt V10 Protocol"),$(ql "$DECISION_URI" "http://schema.org/description" "Board approved V10 migration")"

SG_RES=$(publish_swm 9201 "$CG" "$SG_QUADS" "$SG_NAME" "$DECISION_URI")
SG_STATUS="${SG_RES%%|*}"
SG_REST="${SG_RES#*|}"
SG_KCID="${SG_REST%%|*}"
SG_RAW="${SG_REST#*|}"

if [ "$SG_STATUS" = "confirmed" ] || [ "$SG_STATUS" = "finalized" ]; then
  ok "Sub-graph publish confirmed, kaId=$SG_KCID"
else
  fail "Sub-graph publish status=$SG_STATUS: $SG_RAW"
fi

sleep 3

echo "--- 10c: Query sub-graph specifically ---"
SG_Q=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$DECISION_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"subGraphName\": \"$SG_NAME\"
}")
SG_FOUND=$(echo "$SG_Q" | pyfield "(lambda b: (b[0].get('name') if b else 'EMPTY'))(d.get('result',{}).get('bindings',[]))")
if echo "$SG_FOUND" | grep -q "Adopt V10"; then
  ok "Sub-graph query returned correct data"
else
  fail "Sub-graph query failed: $SG_FOUND"
fi

echo "--- 10d: Sub-graph data isolated from root graph ---"
SG_ROOT=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$DECISION_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\"
}")
SG_ROOT_COUNT=$(echo "$SG_ROOT" | pyfield "len(d.get('result',{}).get('bindings',[]))")
[ -z "$SG_ROOT_COUNT" ] && SG_ROOT_COUNT=0
if [ "$SG_ROOT_COUNT" = "0" ]; then
  ok "Sub-graph data correctly isolated from root graph"
else
  warn "Sub-graph data found in root graph ($SG_ROOT_COUNT bindings) — may be expected depending on query behavior"
fi

# ────────────────────────────────────────────────────────────────────────────
section "11. QUERY VIEWS"

echo "--- 11a: Query with view=verifiable-memory ---"
VM_Q=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$ALICE_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"view\": \"verifiable-memory\"
}")
VM_FOUND=$(echo "$VM_Q" | pyfield "(lambda b: (b[0].get('name') if b else 'EMPTY'))(d.get('result',{}).get('bindings',[]))")
if echo "$VM_FOUND" | grep -q "Alice"; then
  ok "Verifiable-memory view: Alice data found"
else
  fail "Verifiable-memory view: Alice data missing (got: $VM_FOUND)"
fi

echo "--- 11b: Query with view=shared-working-memory ---"
SWM_VIEW=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { <$DRAFT_URI> <http://schema.org/name> ?name }\",
  \"contextGraphId\": \"$CG\",
  \"view\": \"shared-working-memory\"
}")
SWM_VIEW_FOUND=$(echo "$SWM_VIEW" | pyfield "(lambda b: (b[0].get('name') if b else 'EMPTY'))(d.get('result',{}).get('bindings',[]))")
if echo "$SWM_VIEW_FOUND" | grep -q "Q1 Analysis"; then
  ok "Shared-working-memory view: draft report found"
else
  warn "SWM view: draft report not found (may have been promoted/published already): $SWM_VIEW_FOUND"
fi

echo "--- 11c: Query with invalid view returns 400 ---"
BAD_VIEW=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:9201/api/query -H "$H" -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?s WHERE { ?s ?p ?o } LIMIT 1\",
  \"contextGraphId\": \"$CG\",
  \"view\": \"invalid-view\"
}")
if [ "$BAD_VIEW" = "400" ]; then
  ok "Invalid view correctly returns 400"
else
  fail "Invalid view returned $BAD_VIEW (expected 400)"
fi

# ────────────────────────────────────────────────────────────────────────────
section "12. CONDITIONAL SHARE (CAS)"

# Loose SWM CAS was retired with the anonymous SWM write surface. Keep a small
 # contract check so the route does not silently come back.
CAS_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "http://127.0.0.1:9201/api/shared-memory/conditional-write" -d '{"contextGraphId":"devnet-test","quads":[],"conditions":[]}')
if [ "$CAS_CODE" = "404" ] || [ "$CAS_CODE" = "410" ]; then
  ok "Retired conditional-write route is not served (HTTP $CAS_CODE)"
else
  fail "Retired conditional-write route unexpectedly returned HTTP $CAS_CODE"
fi

# ────────────────────────────────────────────────────────────────────────────
section "13. INTER-NODE MESSAGING"

NODE2_PEER=$(get 9202 /api/status | pyfield "d.get('peerId','')")
if [ -n "$NODE2_PEER" ]; then
  CHAT_RESULT=$(post 9201 /api/chat -H "Content-Type: application/json" -d "{
    \"to\": \"$NODE2_PEER\",
    \"text\": \"Hello from V10 validation test $RUN_TAG!\"
  }")
  DELIVERED=$(echo "$CHAT_RESULT" | pyfield "1 if d.get('delivered') else 0")
  if [ "$DELIVERED" = "1" ]; then
    ok "Chat message delivered to node 2"
  else
    fail "Chat delivery failed: $CHAT_RESULT"
  fi
else
  fail "Could not get node 2 peerId from /api/status"
fi

# ────────────────────────────────────────────────────────────────────────────
section "14. SKILL.MD ENDPOINT"

# Fetch to a temp FILE and grep the file (not an 83KB shell variable, which was
# brittle under the runner's shell state). Case-insensitive for any current
# KA/memory term — the #1116 SKILL.md rewrite changed exact wording, so the old
# literal `grep -q "assertion"` on a piped variable was stale. One retry — the
# static route can lag on a cold daemon.
SKILL_FILE=$(mktemp "${TMPDIR:-/tmp}/v10rc-skill-XXXXXX")
get 9201 /.well-known/skill.md > "$SKILL_FILE" 2>/dev/null
[ -s "$SKILL_FILE" ] || get 9201 /.well-known/skill.md > "$SKILL_FILE" 2>/dev/null
SKILL_BYTES=$(wc -c < "$SKILL_FILE" | tr -d ' ')
if [ "${SKILL_BYTES:-0}" -gt 1000 ] && grep -qiE 'assertion|knowledge asset|verifiable memory|working memory' "$SKILL_FILE"; then
  ok "SKILL.md served ($SKILL_BYTES bytes) with current KA/memory terminology"
else
  fail "SKILL.md missing or stale ($SKILL_BYTES bytes)"
fi
rm -f "$SKILL_FILE"

# ────────────────────────────────────────────────────────────────────────────
section "15. IDENTITY / AGENT PROFILE"

# rc.12 removed /api/profile in favour of /api/identity (chain-side) +
# /api/status (which carries peerId / name / nodeRole). Either is enough
# to prove the node has a public agent identity to interact with.

IDENT=$(get 9201 /api/identity 2>/dev/null || echo '{}')
HAS_IDENT=$(echo "$IDENT" | pyfield "1 if d.get('hasIdentity') else 0")
IDENT_ID=$(echo "$IDENT" | pyfield "d.get('identityId','?')")
ST=$(get 9201 /api/status 2>/dev/null || echo '{}')
ST_PEER=$(echo "$ST" | pyfield "d.get('peerId','')")
ST_NAME=$(echo "$ST" | pyfield "d.get('name','')")

if [ "$HAS_IDENT" = "1" ] && [ -n "$ST_PEER" ] && [ -n "$ST_NAME" ]; then
  ok "Identity wired: identityId=$IDENT_ID, peerId=${ST_PEER:0:16}…, name=$ST_NAME"
elif [ -n "$ST_PEER" ] && [ -n "$ST_NAME" ]; then
  warn "Status OK (peerId=${ST_PEER:0:16}…, name=$ST_NAME) but identity not yet on-chain: $IDENT"
else
  fail "Status/Identity missing — identity=$IDENT, status=$ST"
fi

# ────────────────────────────────────────────────────────────────────────────
section "SUMMARY"
echo ""
echo "  RUN_TAG: $RUN_TAG"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Warnings: $WARN"
echo "  Total: $TOTAL"
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "  🎉 ALL TESTS PASSED"
  exit 0
else
  echo "  ⚠️  $FAIL TESTS FAILED — review above"
  exit 1
fi
