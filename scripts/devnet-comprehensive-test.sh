#!/usr/bin/env bash
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
AUTH=$(cat "$DEVNET_DIR/node1/auth.token" 2>/dev/null | tail -1)
N1="http://127.0.0.1:9201"
N2="http://127.0.0.1:9202"
N3="http://127.0.0.1:9203"
N4="http://127.0.0.1:9204"
N5="http://127.0.0.1:9205"
PASS=0; FAIL=0; WARN=0
BUGS=""

ok()   { PASS=$((PASS+1)); echo "  ✅ $*"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $*"; BUGS="${BUGS}\n  - $*"; }
warn() { WARN=$((WARN+1)); echo "  ⚠️  $*"; }
hdr()  { echo ""; echo "═══════════════════════════════════════"; echo "  $*"; echo "═══════════════════════════════════════"; }
api()  { curl -sf -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"; }
api_raw()  { curl -s -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" "$@"; }

###########################################################################
# 1. BASIC CONNECTIVITY
###########################################################################
hdr "1. Basic Connectivity & Peer Mesh"

for port in 9201 9202 9203 9204 9205; do
  STATUS=$(api "http://127.0.0.1:$port/api/status" 2>/dev/null)
  if [ $? -eq 0 ] && echo "$STATUS" | grep -q '"peerId"'; then
    PEERS=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('connectedPeers',0))")
    ROLE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('nodeRole','?'))")
    ok "Node :$port ($ROLE) — peers=$PEERS"
  else
    fail "Node :$port unreachable"
  fi
done

###########################################################################
# 2. SWM WRITE + GOSSIP REPLICATION
###########################################################################
hdr "2. Shared Memory Write → Gossip Replication"

SWM_RESULT=$(api_raw "$N1/api/shared-memory/write" -X POST -d '{
  "contextGraphId":"devnet-test",
  "quads":[
    {"subject":"urn:test:alice","predicate":"http://schema.org/name","object":"\"Alice\"","graph":"did:dkg:context-graph:devnet-test"},
    {"subject":"urn:test:alice","predicate":"http://schema.org/age","object":"\"30\"^^<http://www.w3.org/2001/XMLSchema#integer>","graph":"did:dkg:context-graph:devnet-test"},
    {"subject":"urn:test:alice","predicate":"http://schema.org/knows","object":"urn:test:bob","graph":"did:dkg:context-graph:devnet-test"},
    {"subject":"urn:test:bob","predicate":"http://schema.org/name","object":"\"Bob\"","graph":"did:dkg:context-graph:devnet-test"},
    {"subject":"urn:test:bob","predicate":"http://schema.org/age","object":"\"25\"^^<http://www.w3.org/2001/XMLSchema#integer>","graph":"did:dkg:context-graph:devnet-test"}
  ]
}')
if echo "$SWM_RESULT" | grep -q '"workspaceOperationId"'; then
  ok "SWM write succeeded"
else
  fail "SWM write failed: $SWM_RESULT"
fi

sleep 8

for port in 9202 9203 9204 9205; do
  Q=$(api "http://127.0.0.1:$port/api/query" -X POST -d '{"sparql":"SELECT ?name WHERE { <urn:test:alice> <http://schema.org/name> ?name }","contextGraphId":"devnet-test"}' 2>&1)
  if echo "$Q" | grep -q "Alice"; then
    ok "Gossip to :$port — Alice found"
  else
    fail "Gossip to :$port — Alice NOT found ($Q)"
  fi
done

###########################################################################
# 3. PUBLISH FROM SWM → ON-CHAIN
###########################################################################
hdr "3. Publish from SWM (devnet-test)"

PUB=$(api_raw "$N1/api/shared-memory/publish" -X POST -d '{"contextGraphId":"devnet-test","selection":"all","clearAfter":false}')
if echo "$PUB" | grep -q '"kcId"'; then
  KC_ID=$(echo "$PUB" | python3 -c "import sys,json; print(json.load(sys.stdin).get('kcId',''))")
  KAS=$(echo "$PUB" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))")
  TX=$(echo "$PUB" | python3 -c "import sys,json; print(json.load(sys.stdin).get('txHash','')[:20])")
  ok "Publish: kcId=$KC_ID, kas=$KAS, tx=${TX}..."
else
  fail "Publish failed: $PUB"
fi

sleep 10

# Check gossip-publish handler propagated data to node 2
Q_N2=$(api "$N2/api/query" -X POST -d '{"sparql":"SELECT ?name WHERE { <urn:test:alice> <http://schema.org/name> ?name }","contextGraphId":"devnet-test"}' 2>&1)
if echo "$Q_N2" | grep -q "Alice"; then
  ok "Published data visible on node 2 (via gossip-publish)"
else
  warn "Published data NOT on node 2: $Q_N2"
fi

# Check verified-memory view
VM_Q=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?s WHERE { ?s ?p ?o } LIMIT 1","contextGraphId":"devnet-test","view":"verified-memory"}' 2>&1)
VM_COUNT=$(echo "$VM_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null || echo "0")
if [ "$VM_COUNT" -gt 0 ]; then
  ok "verified-memory view returns data"
else
  warn "verified-memory view returns empty (data stored in data graph, not _verified_memory/ graph)"
fi

###########################################################################
# 4. SECOND CONTEXT GRAPH + CG ISOLATION
###########################################################################
hdr "4. Second Context Graph & Isolation"

GAME_WRITE=$(api_raw "$N2/api/shared-memory/write" -X POST -d '{
  "contextGraphId":"origin-trail-game",
  "quads":[
    {"subject":"urn:game:sword","predicate":"http://schema.org/name","object":"\"Excalibur\"","graph":"did:dkg:context-graph:origin-trail-game"},
    {"subject":"urn:game:shield","predicate":"http://schema.org/name","object":"\"Aegis\"","graph":"did:dkg:context-graph:origin-trail-game"}
  ]
}')
if echo "$GAME_WRITE" | grep -q '"workspaceOperationId"'; then
  ok "Game CG: SWM write on node 2"
else
  fail "Game CG SWM write: $GAME_WRITE"
fi

GAME_PUB=$(api_raw "$N2/api/shared-memory/publish" -X POST -d '{"contextGraphId":"origin-trail-game","selection":"all","clearAfter":false}')
if echo "$GAME_PUB" | grep -q '"kcId"'; then
  ok "Game CG: publish from node 2"
else
  fail "Game CG publish: $GAME_PUB"
fi

sleep 8

# Cross-CG isolation
ISO_Q=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:game:sword> <http://schema.org/name> ?n }","contextGraphId":"devnet-test"}' 2>&1)
ISO_BINDINGS=$(echo "$ISO_Q" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null || echo "0")
if [ "$ISO_BINDINGS" -eq 0 ]; then
  ok "CG isolation: game entity NOT visible in devnet-test"
else
  fail "CG isolation broken: game entity leaked into devnet-test"
fi

# Positive check: game entity IS in origin-trail-game
GAME_POS=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:game:sword> <http://schema.org/name> ?n }","contextGraphId":"origin-trail-game"}' 2>&1)
if echo "$GAME_POS" | grep -q "Excalibur"; then
  ok "CG isolation: game entity found in origin-trail-game on node 1"
else
  fail "CG isolation: game entity NOT found in origin-trail-game"
fi

###########################################################################
# 5. SUB-GRAPH OPERATIONS
###########################################################################
hdr "5. Sub-Graph Operations"

SG_CREATE=$(api_raw "$N1/api/sub-graph/create" -X POST -d '{"contextGraphId":"devnet-test","subGraphName":"research-papers"}')
if echo "$SG_CREATE" | grep -q '"created"'; then
  ok "Sub-graph research-papers created"
else
  warn "Sub-graph create: $SG_CREATE"
fi

SG_WRITE=$(api_raw "$N1/api/shared-memory/write" -X POST -d '{
  "contextGraphId":"devnet-test","subGraphName":"research-papers",
  "quads":[
    {"subject":"urn:paper:ai","predicate":"http://schema.org/name","object":"\"AI and Knowledge Graphs\"","graph":"did:dkg:context-graph:devnet-test"}
  ]
}')
if echo "$SG_WRITE" | grep -q '"triplesWritten"'; then
  ok "Sub-graph SWM write"
else
  fail "Sub-graph SWM write: $SG_WRITE"
fi

sleep 4

SG_Q=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:paper:ai> <http://schema.org/name> ?n }","contextGraphId":"devnet-test","subGraphName":"research-papers","includeSharedMemory":true}' 2>&1)
if echo "$SG_Q" | grep -q "AI and Knowledge Graphs"; then
  ok "Sub-graph query with includeSharedMemory works"
else
  fail "Sub-graph query failed: $SG_Q"
fi

# Cross sub-graph isolation: paper NOT in root CG default query
SG_ISO=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:paper:ai> <http://schema.org/name> ?n }","contextGraphId":"devnet-test"}' 2>&1)
SG_ISO_COUNT=$(echo "$SG_ISO" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null || echo "0")
if [ "$SG_ISO_COUNT" -eq 0 ]; then
  ok "Sub-graph isolation: paper NOT in root CG query"
else
  warn "Sub-graph isolation: paper leaked to root CG query"
fi

# Sub-graph gossip to node 3
SG_Q3=$(api "$N3/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:paper:ai> <http://schema.org/name> ?n }","contextGraphId":"devnet-test","subGraphName":"research-papers","includeSharedMemory":true}' 2>&1)
if echo "$SG_Q3" | grep -q "AI and Knowledge Graphs"; then
  ok "Sub-graph gossiped to node 3"
else
  warn "Sub-graph gossip to node 3: $SG_Q3"
fi

###########################################################################
# 6. ASSERTION (DRAFT) LIFECYCLE
###########################################################################
hdr "6. Assertion Lifecycle — create, write, query, promote, discard"

CREATE=$(api_raw "$N1/api/assertion/create" -X POST -d '{"contextGraphId":"devnet-test","name":"test-draft"}')
if echo "$CREATE" | grep -q '"assertionUri"'; then
  ok "Assertion test-draft created"
else
  fail "Assertion create: $CREATE"
fi

WRITE=$(api_raw "$N1/api/assertion/test-draft/write" -X POST -d '{
  "contextGraphId":"devnet-test",
  "quads":[
    {"subject":"urn:draft:idea1","predicate":"http://schema.org/name","object":"\"My Draft Idea\"","graph":"did:dkg:context-graph:devnet-test"},
    {"subject":"urn:draft:idea1","predicate":"http://schema.org/status","object":"\"pending\"","graph":"did:dkg:context-graph:devnet-test"}
  ]
}')
if echo "$WRITE" | grep -q '"written"'; then
  ok "Assertion write: $(echo "$WRITE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('written',0))")"
else
  fail "Assertion write: $WRITE"
fi

QUERY=$(api_raw "$N1/api/assertion/test-draft/query" -X POST -d '{"contextGraphId":"devnet-test"}')
if echo "$QUERY" | grep -q "My Draft Idea"; then
  ok "Assertion query: draft data accessible in working memory"
else
  fail "Assertion query: $QUERY"
fi

# Assertion should NOT be visible on node 2 (working memory is local)
Q_WM_N2=$(api "$N2/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:draft:idea1> <http://schema.org/name> ?n }","contextGraphId":"devnet-test"}' 2>&1)
WM_COUNT=$(echo "$Q_WM_N2" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null || echo "0")
if [ "$WM_COUNT" -eq 0 ]; then
  ok "Working memory isolation: draft NOT visible on node 2"
else
  fail "Working memory leaked to node 2"
fi

# Promote assertion to SWM
PROMOTE=$(api_raw "$N1/api/assertion/test-draft/promote" -X POST -d '{"contextGraphId":"devnet-test"}')
if echo "$PROMOTE" | grep -q '"promotedCount"'; then
  PCOUNT=$(echo "$PROMOTE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('promotedCount',0))")
  ok "Assertion promoted: $PCOUNT entities"
else
  fail "Assertion promote: $PROMOTE"
fi

sleep 5

# Check promoted data on node 2 (should be in SWM now via gossip)
PROMOTED_N2=$(api "$N2/api/query" -X POST -d '{"sparql":"SELECT ?n WHERE { <urn:draft:idea1> <http://schema.org/name> ?n }","contextGraphId":"devnet-test"}' 2>&1)
if echo "$PROMOTED_N2" | grep -q "My Draft Idea"; then
  ok "Promoted assertion gossiped to node 2"
else
  warn "Promoted assertion NOT on node 2 (may need more time): $PROMOTED_N2"
fi

# Create and discard
DISCARD_CREATE=$(api_raw "$N1/api/assertion/create" -X POST -d '{"contextGraphId":"devnet-test","name":"throw-away"}')
api_raw "$N1/api/assertion/throw-away/write" -X POST -d '{"contextGraphId":"devnet-test","quads":[{"subject":"urn:draft:trash","predicate":"http://schema.org/name","object":"\"Trash\"","graph":"did:dkg:context-graph:devnet-test"}]}' > /dev/null 2>&1
DISCARD=$(api_raw "$N1/api/assertion/throw-away/discard" -X POST -d '{"contextGraphId":"devnet-test"}')
if echo "$DISCARD" | grep -q '"discarded":true'; then
  ok "Assertion discarded"
else
  fail "Assertion discard: $DISCARD"
fi

# Verify discarded data is gone
DISC_Q=$(api_raw "$N1/api/assertion/throw-away/query" -X POST -d '{"contextGraphId":"devnet-test"}')
if echo "$DISC_Q" | grep -qE '"count":0|not found|error'; then
  ok "Discarded assertion data cleaned up"
else
  warn "Discarded assertion might still have data: $DISC_Q"
fi

###########################################################################
# 7. IDENTITY & STAKING
###########################################################################
hdr "7. Identity & Staking"

IDENTITY=$(api "$N1/api/identity" 2>&1)
if echo "$IDENTITY" | grep -q '"hasIdentity":true'; then
  ID=$(echo "$IDENTITY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('identityId',''))")
  ok "Identity: identityId=$ID"
else
  warn "Identity: $IDENTITY"
fi

WALLETS=$(api "$N1/api/wallets/balances" 2>&1)
if echo "$WALLETS" | grep -q '"balances"'; then
  WCOUNT=$(echo "$WALLETS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('balances',[])))")
  ok "Wallets: $WCOUNT wallets with balances"
else
  warn "Wallets: $WALLETS"
fi

###########################################################################
# 8. SKILL.MD & IMPORT-FILE
###########################################################################
hdr "8. Skill.md & Import-File"

SKILL=$(curl -sf "$N1/.well-known/skill.md" 2>&1)
if echo "$SKILL" | grep -qi "import.file"; then
  ok "skill.md serves import-file docs"
else
  warn "skill.md: ${SKILL:0:200}"
fi

# Test import-file with proper multipart
TMPFILE=$(mktemp /tmp/test-doc-XXXXXX.md)
cat > "$TMPFILE" <<'DOCEOF'
# DKG Knowledge Paper

This paper describes the Decentralized Knowledge Graph architecture.

## Core Concepts

Nodes form a peer-to-peer network using GossipSub for real-time data propagation.
Knowledge Assets are on-chain anchored entities with merkle-verified integrity.

## Architecture

The system uses three memory layers:
1. Working Memory (drafts, local assertions)
2. Shared Working Memory (gossiped, collaborative state)
3. Verified Memory (on-chain anchored, immutable)
DOCEOF

IMPORT=$(curl -s -H "Authorization: Bearer $AUTH" \
  -F "file=@${TMPFILE};type=text/markdown" \
  -F "contextGraphId=devnet-test" \
  "$N1/api/import-file" 2>&1)
rm -f "$TMPFILE"

if echo "$IMPORT" | grep -qi "assertion\|extract\|quads\|triples\|import\|written\|operationId"; then
  ok "Import-file accepted: ${IMPORT:0:200}"
else
  warn "Import-file response: ${IMPORT:0:300}"
fi

###########################################################################
# 9. PUBLISHER QUEUE OPERATIONS
###########################################################################
hdr "9. Publisher Queue Operations"

STATS=$(api "$N1/api/publisher/stats" 2>&1)
if echo "$STATS" | grep -q "finalized\|accepted"; then
  ok "Publisher stats: $STATS"
else
  warn "Publisher stats: $STATS"
fi

JOBS=$(api "$N1/api/publisher/jobs" 2>&1)
if echo "$JOBS" | grep -q '"jobs"'; then
  JOB_COUNT=$(echo "$JOBS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('jobs',[])))")
  ok "Publisher jobs listed: $JOB_COUNT"
else
  warn "Publisher jobs: $JOBS"
fi

# Test cancel with non-existent job
CANCEL=$(api_raw "$N1/api/publisher/cancel" -X POST -d '{"jobId":"nonexistent-job-id"}')
echo "  Cancel non-existent: $CANCEL"

# Test retry
RETRY=$(api_raw "$N1/api/publisher/retry" -X POST -d '{"status":"failed"}')
if echo "$RETRY" | grep -q '"retried"'; then
  ok "Publisher retry endpoint works"
else
  warn "Publisher retry: $RETRY"
fi

# Test clear
CLEAR=$(api_raw "$N1/api/publisher/clear" -X POST -d '{"status":"finalized"}')
if echo "$CLEAR" | grep -q '"cleared"'; then
  ok "Publisher clear endpoint works"
else
  warn "Publisher clear: $CLEAR"
fi

# Test malformed JSON
MALFORMED=$(curl -s -H "Authorization: Bearer $AUTH" -H "Content-Type: application/json" \
  -X POST "$N1/api/publisher/enqueue" -d 'not-json' 2>&1)
if echo "$MALFORMED" | grep -qi "invalid.*json\|400\|error"; then
  ok "Publisher enqueue rejects malformed JSON"
else
  fail "Malformed JSON not rejected: $MALFORMED"
fi

###########################################################################
# 10. EDGE CASES
###########################################################################
hdr "10. Edge Cases"

# 10a. Empty quads
EMPTY=$(api_raw "$N1/api/shared-memory/write" -X POST -d '{"contextGraphId":"devnet-test","quads":[]}')
if echo "$EMPTY" | grep -qi "missing\|error\|empty"; then
  ok "Empty quads rejected: $(echo "$EMPTY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error','')[:60])" 2>/dev/null)"
else
  warn "Empty quads: $EMPTY"
fi

# 10b. Malformed SPARQL
BAD_SPARQL=$(api_raw "$N1/api/query" -X POST -d '{"sparql":"SELECTX WHERE","contextGraphId":"devnet-test"}')
echo "  Bad SPARQL response: $(echo "$BAD_SPARQL" | head -c 200)"

# 10c. Non-existent entity
NOENT=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?o WHERE { <urn:does:not:exist> ?p ?o }","contextGraphId":"devnet-test"}' 2>&1)
NOENT_COUNT=$(echo "$NOENT" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null || echo "?")
if [ "$NOENT_COUNT" = "0" ]; then
  ok "Non-existent entity: 0 bindings"
else
  warn "Non-existent entity: $NOENT_COUNT"
fi

# 10d. Large batch (50 entities)
LARGE_QUADS="["
for i in $(seq 1 50); do
  [ "$i" -gt 1 ] && LARGE_QUADS="$LARGE_QUADS,"
  LARGE_QUADS="$LARGE_QUADS{\"subject\":\"urn:batch:item$i\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"Batch Item $i\\\"\",\"graph\":\"did:dkg:context-graph:devnet-test\"}"
done
LARGE_QUADS="$LARGE_QUADS]"

BATCH=$(api_raw "$N1/api/shared-memory/write" -X POST -d "{\"contextGraphId\":\"devnet-test\",\"quads\":$LARGE_QUADS}")
if echo "$BATCH" | grep -q '"triplesWritten"'; then
  TWRIT=$(echo "$BATCH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('triplesWritten',0))")
  ok "Large batch: $TWRIT triples written"
else
  fail "Large batch write: $BATCH"
fi

# 10e. Concurrent writes from multiple nodes
api_raw "$N3/api/shared-memory/write" -X POST -d '{"contextGraphId":"devnet-test","quads":[{"subject":"urn:conc:n3","predicate":"http://schema.org/name","object":"\"From Node 3\"","graph":"did:dkg:context-graph:devnet-test"}]}' > /dev/null 2>&1 &
PID1=$!
api_raw "$N4/api/shared-memory/write" -X POST -d '{"contextGraphId":"devnet-test","quads":[{"subject":"urn:conc:n4","predicate":"http://schema.org/name","object":"\"From Node 4\"","graph":"did:dkg:context-graph:devnet-test"}]}' > /dev/null 2>&1 &
PID2=$!
api_raw "$N5/api/shared-memory/write" -X POST -d '{"contextGraphId":"devnet-test","quads":[{"subject":"urn:conc:n5","predicate":"http://schema.org/name","object":"\"From Node 5\"","graph":"did:dkg:context-graph:devnet-test"}]}' > /dev/null 2>&1 &
PID3=$!
wait $PID1 $PID2 $PID3

sleep 8

for entity_node in "urn:conc:n3:3" "urn:conc:n4:4" "urn:conc:n5:5"; do
  ENTITY="${entity_node%:*}"
  NODE="${entity_node##*:}"
  Q=$(api "$N1/api/query" -X POST -d "{\"sparql\":\"ASK { <${ENTITY}> <http://schema.org/name> ?n }\",\"contextGraphId\":\"devnet-test\"}" 2>&1)
  if echo "$Q" | grep -qi "true"; then
    ok "Concurrent write from node $NODE gossiped to node 1"
  else
    warn "Concurrent write from node $NODE NOT on node 1: $Q"
  fi
done

# 10f. Batch publish from node 1
BATCH_PUB=$(api_raw "$N1/api/shared-memory/publish" -X POST -d '{"contextGraphId":"devnet-test","selection":"all","clearAfter":true}')
if echo "$BATCH_PUB" | grep -q '"kcId"'; then
  BKAS=$(echo "$BATCH_PUB" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('kas',[])))")
  ok "Batch publish: $BKAS knowledge assets"
else
  fail "Batch publish: $BATCH_PUB"
fi

# 10g. Conditional write (CAS)
CAS_WRITE=$(api_raw "$N1/api/shared-memory/write" -X POST -d '{
  "contextGraphId":"devnet-test",
  "quads":[
    {"subject":"urn:cas:v1","predicate":"http://schema.org/version","object":"\"1\"","graph":"did:dkg:context-graph:devnet-test"}
  ]
}')
echo "  CAS setup: $(echo "$CAS_WRITE" | head -c 100)"

# 10h. Query non-existent context graph
NOCG=$(api_raw "$N1/api/query" -X POST -d '{"sparql":"SELECT ?s WHERE { ?s ?p ?o }","contextGraphId":"nonexistent-cg"}')
echo "  Non-existent CG: $(echo "$NOCG" | head -c 200)"

###########################################################################
# 11. VERIFIED MEMORY INVESTIGATION
###########################################################################
hdr "11. Verified Memory Graph Investigation"

# Check if any _verified_memory graphs exist
VM_GRAPHS=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"_verified_memory\"))}","contextGraphId":"devnet-test"}' 2>&1)
VM_G_COUNT=$(echo "$VM_GRAPHS" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('bindings',[])))" 2>/dev/null || echo "0")
if [ "$VM_G_COUNT" -gt 0 ]; then
  ok "Found $VM_G_COUNT _verified_memory graph(s)"
  echo "$VM_GRAPHS" | python3 -m json.tool 2>/dev/null | head -10
else
  warn "No _verified_memory/ graphs found — finalization handler writes to data graph, not VM graph"
fi

# Check confirmed status in meta
CONFIRMED=$(api "$N1/api/query" -X POST -d '{"sparql":"SELECT ?ual ?status WHERE { ?ual <http://dkg.io/ontology/publishStatus> ?status } LIMIT 5","contextGraphId":"devnet-test"}' 2>&1)
echo "  Confirmed status quads: $(echo "$CONFIRMED" | python3 -m json.tool 2>/dev/null | head -20)"

###########################################################################
# 12. CROSS-NODE DATA CONSISTENCY
###########################################################################
hdr "12. Cross-Node Data Consistency"

for port in 9201 9202 9203 9204 9205; do
  COUNT=$(api "http://127.0.0.1:$port/api/query" -X POST -d '{"sparql":"SELECT (COUNT(DISTINCT ?s) AS ?c) WHERE { GRAPH <did:dkg:context-graph:devnet-test> { ?s ?p ?o } }","contextGraphId":"devnet-test"}' 2>&1)
  C=$(echo "$COUNT" | python3 -c "import sys,json; b=json.load(sys.stdin).get('result',{}).get('bindings',[]); print(b[0]['c'] if b else '?')" 2>/dev/null || echo "?")
  echo "  Node :$port — distinct subjects in devnet-test data graph: $C"
done

###########################################################################
# SUMMARY
###########################################################################
hdr "FINAL SUMMARY"
echo "  ✅ Passed: $PASS"
echo "  ❌ Failed: $FAIL"
echo "  ⚠️  Warnings: $WARN"
echo ""

if [ -n "$BUGS" ]; then
  echo "  Bugs found:"
  echo -e "$BUGS"
fi

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "  RESULT: SOME TESTS FAILED"
  exit 1
else
  echo ""
  echo "  RESULT: ALL TESTS PASSED"
  exit 0
fi
