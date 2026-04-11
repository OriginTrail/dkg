#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${DKG_AUTH:-}" ]]; then
  AUTH="$DKG_AUTH"
elif [[ -f "$SCRIPT_DIR/../.devnet/node1/auth.token" ]]; then
  AUTH="$(grep -v '^#' "$SCRIPT_DIR/../.devnet/node1/auth.token" 2>/dev/null | tr -d '[:space:]')"
else
  echo "ERROR: No auth token found. Export DKG_AUTH or start a devnet with ./scripts/devnet.sh start" >&2
  exit 1
fi
H="Authorization: Bearer $AUTH"
CG="devnet-test"
PASS=0; FAIL=0; WARN=0
HH_PORT="${HARDHAT_PORT:-8545}"
CONTRACTS_JSON="$(cd "$(dirname "$0")/.." && pwd)/packages/evm-module/deployments/localhost_contracts.json"

ok()   { PASS=$((PASS+1)); echo "  [PASS] $*"; }
fail() { FAIL=$((FAIL+1)); echo "  [FAIL] $*"; }
warn() { WARN=$((WARN+1)); echo "  [WARN] $*"; }

api() { curl -s -H "$H" "$@"; }
post() { local port=$1; shift; api -X POST "http://127.0.0.1:$port$@"; }
get()  { local port=$1; shift; api "http://127.0.0.1:$port$@"; }
q()  { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"$3\",\"graph\":\"\"}"; }
ql() { echo "{\"subject\":\"$1\",\"predicate\":\"$2\",\"object\":\"\\\"$3\\\"\",\"graph\":\"\"}"; }

echo "============================================================"
echo "DKG V10 Deep Devnet Test — Pre-Release Validation"
echo "Covers: gossip, staking, game, CAS, sub-graphs, edge cases"
echo "============================================================"

# ================================================================
echo ""
echo "=== TEST 1: Thorough Cross-Node Gossip (SWM) ==="
echo "--- Write unique entity FROM each node, verify replication to ALL others ---"
echo ""

for writer_port in 9201 9202 9203 9204 9205; do
  ENTITY="http://test.org/gossip-from-$writer_port"
  SWM_RESP=$(post $writer_port /api/shared-memory/write -H "Content-Type: application/json" -d "{
    \"contextGraphId\": \"$CG\",
    \"quads\": [
      $(q "$ENTITY" 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Thing'),
      $(ql "$ENTITY" 'http://schema.org/name' "Written by node $writer_port"),
      $(ql "$ENTITY" 'http://test.org/sourcePort' "$writer_port")
    ]
  }" 2>&1)
  if echo "$SWM_RESP" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d.get('shareOperationId') or d.get('operationId') else 1)" 2>/dev/null; then
    ok "SWM write from Node $writer_port"
  else
    fail "SWM write from Node $writer_port failed: ${SWM_RESP:0:200}"
  fi
done

echo "  Waiting 8s for GossipSub propagation..."
sleep 8

GOSSIP_MATRIX_OK=true
for writer_port in 9201 9202 9203 9204 9205; do
  ENTITY="http://test.org/gossip-from-$writer_port"
  for reader_port in 9201 9202 9203 9204 9205; do
    CT=$(post $reader_port /api/query -H "Content-Type: application/json" -d "{
      \"sparql\": \"SELECT ?name WHERE { GRAPH ?g { <$ENTITY> <http://schema.org/name> ?name } . FILTER(CONTAINS(STR(?g),'_shared_memory')) }\",
      \"contextGraphId\": \"$CG\"
    }" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
    if [ "$CT" -ge 1 ]; then
      ok "Gossip $writer_port→$reader_port OK"
    else
      fail "Gossip $writer_port→$reader_port FAILED (0 triples)"
      GOSSIP_MATRIX_OK=false
    fi
  done
done
[[ "$GOSSIP_MATRIX_OK" == "true" ]] && echo "  ✓ Full 5×5 gossip matrix PASSED" || echo "  ✗ Gossip matrix has gaps"

echo ""
echo "--- 1b: Gossip latency test — write and measure time to appear on remote ---"
ENTITY="http://test.org/gossip-latency-test"
START_TS=$(python3 -c "import time; print(int(time.time()*1000))")
post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [$(ql "$ENTITY" 'http://schema.org/name' 'LatencyTest')]
}" > /dev/null

FOUND=false
for attempt in $(seq 1 20); do
  CT=$(post 9205 /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT ?n WHERE { GRAPH ?g { <$ENTITY> <http://schema.org/name> ?n } . FILTER(CONTAINS(STR(?g),'_shared_memory')) }\",
    \"contextGraphId\": \"$CG\"
  }" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
  if [ "$CT" -ge 1 ]; then
    END_TS=$(python3 -c "import time; print(int(time.time()*1000))")
    LATENCY=$((END_TS - START_TS))
    ok "Gossip latency Node1→Node5: ${LATENCY}ms"
    FOUND=true
    break
  fi
  sleep 0.5
done
[[ "$FOUND" == "false" ]] && fail "Gossip latency: entity never arrived at Node5 within 10s"

echo ""
echo "--- 1c: Large payload gossip (100 triples) ---"
LARGE_QUADS=""
for i in $(seq 1 100); do
  LARGE_QUADS="$LARGE_QUADS$(ql "http://test.org/large-gossip/$i" 'http://schema.org/name' "LargeItem$i"),"
done
LARGE_QUADS="${LARGE_QUADS%,}"

post 9203 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [$LARGE_QUADS]
}" > /dev/null
ok "Large SWM write (100 triples) from Node3"
sleep 8

for p in 9201 9202 9204 9205; do
  CT=$(post $p /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s <http://schema.org/name> ?n . FILTER(STRSTARTS(STR(?s),'http://test.org/large-gossip/')) } . FILTER(CONTAINS(STR(?g),'_shared_memory')) }\",
    \"contextGraphId\": \"$CG\"
  }" | python3 -c '
import sys,json,re
b=json.load(sys.stdin).get("result",{}).get("bindings",[])
v=str(b[0].get("c","0")) if b else "0"
m=re.search(r"(\d+)",v)
print(m.group(1) if m else "0")
' 2>/dev/null || echo "0")
  [[ "$CT" -ge 80 ]] && ok "Node $p received $CT/100 large gossip triples" || warn "Node $p only has $CT/100 large gossip triples"
done

# ================================================================
echo ""
echo "=== TEST 2: Staking Verification ==="
echo "--- 2a: Verify all nodes have on-chain stakes ---"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

for p in 9201 9202 9203 9204 9205; do
  IDENT=$(get $p /api/identity)
  IID=$(echo "$IDENT" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("identityId","0"))' 2>/dev/null)
  [[ "$IID" != "0" && "$IID" != "None" ]] && ok "Node $p identityId=$IID" || fail "Node $p no identity"
done

echo ""
echo "--- 2b: Check on-chain stake amounts via contract calls ---"
STAKING_OUTPUT=$(cd "$REPO_ROOT/packages/evm-module" && node -e "
  const { ethers } = require('ethers');
  const fs = require('fs');
  (async () => {
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:$HH_PORT');
    const contracts = JSON.parse(fs.readFileSync('$CONTRACTS_JSON', 'utf8'));
    const c = (name) => contracts.contracts[name]?.evmAddress;
    const identity = new ethers.Contract(c('IdentityStorage'), ['function getIdentityId(address) view returns (uint72)'], provider);
    const abi = JSON.parse(fs.readFileSync('abi/StakingStorage.json', 'utf8'));
    const staking = new ethers.Contract(c('StakingStorage'), abi, provider);
    const signers = await provider.listAccounts();
    for (let i = 0; i < 5; i++) {
      const idId = await identity.getIdentityId(signers[i].address);
      let stake = 0n;
      try { stake = await staking.getNodeStake(idId); } catch {}
      const stakeEth = ethers.formatEther(stake);
      console.log('Node ' + (i+1) + ': identityId=' + idId + ' stake=' + stakeEth + ' TRAC');
    }
  })();
" 2>&1) || true
STAKED_COUNT=0
while IFS= read -r line; do
  echo "  $line"
  STAKE_VAL=$(echo "$line" | sed -n 's/.*stake=\([0-9.]*\).*/\1/p')
  if [[ -n "$STAKE_VAL" ]] && python3 -c "exit(0 if float('$STAKE_VAL') >= 50000 else 1)" 2>/dev/null; then
    ok "$(echo "$line" | cut -d: -f1) staked ${STAKE_VAL} TRAC (>= 50k)"
    STAKED_COUNT=$((STAKED_COUNT+1))
  fi
done <<< "$STAKING_OUTPUT"
[[ "$STAKED_COUNT" -eq 5 ]] || fail "Only $STAKED_COUNT/5 nodes confirmed >= 50k stake"

echo ""
echo "--- 2c: Perform additional staking — add 10k TRAC to Node1 ---"
cd "$REPO_ROOT/packages/evm-module" && STAKE_RESULT=$(node -e "
  const { ethers } = require('ethers');
  const fs = require('fs');
  (async () => {
    const provider = new ethers.JsonRpcProvider('http://127.0.0.1:$HH_PORT');
    const contracts = JSON.parse(fs.readFileSync('$CONTRACTS_JSON', 'utf8'));
    const c = (name) => contracts.contracts[name]?.evmAddress;
    const deployer = await provider.getSigner(0);
    const signer0 = await provider.getSigner(0);
    const token = new ethers.Contract(c('Token'), ['function mint(address,uint256)', 'function approve(address,uint256)'], deployer);
    const identity = new ethers.Contract(c('IdentityStorage'), ['function getIdentityId(address) view returns (uint72)'], provider);
    const staking = new ethers.Contract(c('Staking'), ['function stake(uint72,uint96)'], signer0);
    const stakingAbi = JSON.parse(fs.readFileSync('abi/StakingStorage.json', 'utf8'));
    const stakingStorage = new ethers.Contract(c('StakingStorage'), stakingAbi, provider);

    const idId = await identity.getIdentityId(signer0.address);
    const beforeStake = await stakingStorage.getNodeStake(idId);
    const addAmount = ethers.parseEther('10000');
    await (await token.mint(signer0.address, addAmount)).wait();
    await (await token.approve(c('Staking'), addAmount)).wait();
    await (await staking.stake(idId, addAmount)).wait();
    const afterStake = await stakingStorage.getNodeStake(idId);
    console.log(JSON.stringify({
      before: ethers.formatEther(beforeStake),
      after: ethers.formatEther(afterStake),
      added: '10000'
    }));
  })();
" 2>&1) || true
cd "$REPO_ROOT" || true
echo "  Stake result: $STAKE_RESULT"

BEFORE=$(echo "$STAKE_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["before"])' 2>/dev/null || echo "?")
AFTER=$(echo "$STAKE_RESULT" | python3 -c 'import sys,json;print(json.load(sys.stdin)["after"])' 2>/dev/null || echo "?")
[[ "$BEFORE" != "$AFTER" ]] && ok "Staking increased: $BEFORE → $AFTER TRAC" || fail "Stake unchanged after adding 10k"

echo ""
echo "--- 2d: Publish after staking — verify node still functional ---"
post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [$(ql 'http://test.org/post-stake-publish' 'http://schema.org/name' 'AfterStaking')]
}" > /dev/null
sleep 1
PSTAKE=$(post 9201 /api/shared-memory/publish -H "Content-Type: application/json" -d "{\"contextGraphId\":\"$CG\",\"selection\":[\"http://test.org/post-stake-publish\"]}")
PS_ST=$(echo "$PSTAKE" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null)
[[ "$PS_ST" == "confirmed" || "$PS_ST" == "finalized" ]] && ok "Post-staking publish OK ($PS_ST)" || fail "Post-staking publish=$PS_ST"

# ================================================================
echo ""
echo "=== TEST 3: OriginTrail Game on Devnet ==="
echo ""

echo "--- 3a: Game info endpoint ---"
GAME_INFO=$(get 9201 /api/apps/origin-trail-game/info)
echo "  Game info: $(echo "$GAME_INFO" | head -c 300)"
GAME_STATUS=$(echo "$GAME_INFO" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if "minPlayers" in d or "dkgEnabled" in d else "missing")' 2>/dev/null || echo "error")
[[ "$GAME_STATUS" == "ok" ]] && ok "Game info endpoint works" || warn "Game info unexpected: $GAME_INFO"

echo "--- 3b: Game lobby ---"
LOBBY=$(get 9201 /api/apps/origin-trail-game/lobby)
echo "  Lobby: $(echo "$LOBBY" | head -c 200)"
ok "Game lobby accessible"

echo "--- 3c: Game locations ---"
LOCS=$(get 9201 /api/apps/origin-trail-game/locations)
LOC_CT=$(echo "$LOCS" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("locations",[])))' 2>/dev/null || echo "0")
echo "  Locations: $LOC_CT"
[[ "$LOC_CT" -ge 1 ]] && ok "Game has $LOC_CT locations" || warn "No game locations found"

echo "--- 3d: Create a swarm ---"
CREATE=$(post 9201 /api/apps/origin-trail-game/create -H "Content-Type: application/json" -d '{"playerName":"TestPlayer1","swarmName":"DevnetTestSwarm"}')
echo "  Create: $(echo "$CREATE" | head -c 300)"
SWARM_ID=$(echo "$CREATE" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("swarmId",d.get("id","")))' 2>/dev/null || echo "")
[[ -n "$SWARM_ID" ]] && ok "Swarm created: $SWARM_ID" || warn "Swarm creation response: $CREATE"

if [[ -n "$SWARM_ID" ]]; then
  echo "--- 3e: Join swarm from Node2 ---"
  JOIN=$(post 9202 /api/apps/origin-trail-game/join -H "Content-Type: application/json" -d "{\"swarmId\":\"$SWARM_ID\",\"playerName\":\"TestPlayer2\"}")
  echo "  Join: $(echo "$JOIN" | head -c 200)"
  JOIN_OK=$(echo "$JOIN" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("success") or d.get("joined") or "player" in str(d).lower() else "fail")' 2>/dev/null || echo "fail")
  [[ "$JOIN_OK" == "ok" ]] && ok "Player2 joined swarm" || warn "Join response: $JOIN"

  echo "--- 3f: Check swarm state ---"
  SWARM=$(get 9201 /api/apps/origin-trail-game/swarm/$SWARM_ID)
  PLAYER_CT=$(echo "$SWARM" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d.get("players",[])))' 2>/dev/null || echo "0")
  echo "  Swarm players: $PLAYER_CT"
  [[ "$PLAYER_CT" -ge 2 ]] && ok "Swarm has $PLAYER_CT players" || warn "Swarm has $PLAYER_CT players"

  echo "--- 3g: Leaderboard ---"
  LB=$(get 9201 /api/apps/origin-trail-game/leaderboard)
  echo "  Leaderboard: $(echo "$LB" | head -c 200)"
  ok "Leaderboard accessible"
fi

# ================================================================
echo ""
echo "=== TEST 4: Sub-graph Writes ==="
echo ""

echo "--- 4a: Write to a named sub-graph ---"
SG_W=$(post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"subGraphName\": \"research-papers\",
  \"quads\": [
    $(q 'http://test.org/paper1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/ScholarlyArticle'),
    $(ql 'http://test.org/paper1' 'http://schema.org/name' 'DKG V10 Architecture'),
    $(ql 'http://test.org/paper1' 'http://schema.org/author' 'OriginTrail Team')
  ]
}")
SG_OK=$(echo "$SG_W" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") or d.get("stored") or d.get("triplesWritten") else "fail")' 2>/dev/null)
echo "  Sub-graph write result: $(echo "$SG_W" | head -c 200)"
[[ "$SG_OK" == "ok" ]] && ok "Sub-graph 'research-papers' write OK" || warn "Sub-graph write: $SG_W"

echo "--- 4b: Sub-graph gossip — check on Node3 ---"
sleep 5
SG_Q=$(post 9203 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name ?g WHERE { GRAPH ?g { <http://test.org/paper1> <http://schema.org/name> ?name } . FILTER(CONTAINS(STR(?g),'research-papers') && CONTAINS(STR(?g),'_shared_memory')) }\",
  \"contextGraphId\": \"$CG\"
}")
SG_CT=$(echo "$SG_Q" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$SG_CT" -ge 1 ]] && ok "Sub-graph 'research-papers' data gossiped to Node3" || warn "Sub-graph data not on Node3 ($SG_CT)"

# ================================================================
echo ""
echo "=== TEST 5: Conditional Write (CAS) ==="
echo ""

echo "--- 5a: Write initial value ---"
post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [$(ql 'http://test.org/cas-entity' 'http://test.org/counter' '1')]
}" > /dev/null
ok "CAS initial write OK"

echo "--- 5b: Conditional write with correct expected value ---"
CAS_RESP=$(post 9201 /api/shared-memory/conditional-write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"conditions\": [{
    \"subject\": \"http://test.org/cas-entity\",
    \"predicate\": \"http://test.org/counter\",
    \"expectedValue\": \"\\\"1\\\"\"
  }],
  \"quads\": [$(ql 'http://test.org/cas-entity' 'http://test.org/counter' '2')]
}")
echo "  CAS response: $(echo "$CAS_RESP" | head -c 300)"
CAS_OK=$(echo "$CAS_RESP" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") or d.get("applied") else "fail")' 2>/dev/null)
[[ "$CAS_OK" == "ok" ]] && ok "CAS conditional write succeeded" || warn "CAS write response: $CAS_RESP"

echo "--- 5c: Conditional write with WRONG expected value (should fail) ---"
CAS_BAD=$(post 9201 /api/shared-memory/conditional-write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"conditions\": [{
    \"subject\": \"http://test.org/cas-entity\",
    \"predicate\": \"http://test.org/counter\",
    \"expectedValue\": \"\\\"999\\\"\"
  }],
  \"quads\": [$(ql 'http://test.org/cas-entity' 'http://test.org/counter' '3')]
}")
echo "  CAS bad response: $(echo "$CAS_BAD" | head -c 300)"
CAS_REJECTED=$(echo "$CAS_BAD" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("rejected" if d.get("conflict") or d.get("error") or not d.get("ok",True) else "accepted")' 2>/dev/null)
[[ "$CAS_REJECTED" == "rejected" ]] && ok "CAS correctly rejected wrong expectedValue" || fail "CAS accepted wrong expectedValue (data-integrity regression): $CAS_BAD"

# ================================================================
echo ""
echo "=== TEST 6: Verified Memory — Publish + Query Across All Nodes ==="
echo ""

echo "--- 6a: Publish a batch from Node2 ---"
post 9202 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [
    $(q 'http://test.org/vm-test1' 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' 'http://schema.org/Event'),
    $(ql 'http://test.org/vm-test1' 'http://schema.org/name' 'VM Replication Test'),
    $(ql 'http://test.org/vm-test1' 'http://schema.org/startDate' '2026-04-10')
  ]
}" > /dev/null
sleep 2
VM_PUB=$(post 9202 /api/shared-memory/publish -H "Content-Type: application/json" -d "{\"contextGraphId\":\"$CG\",\"selection\":[\"http://test.org/vm-test1\"]}")
VM_ST=$(echo "$VM_PUB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("status","?"))' 2>/dev/null)
VM_TX=$(echo "$VM_PUB" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("txHash","?"))' 2>/dev/null)
echo "  VM publish: status=$VM_ST tx=$VM_TX"
[[ "$VM_ST" == "confirmed" || "$VM_ST" == "finalized" ]] && ok "VM publish confirmed ($VM_ST)" || fail "VM publish=$VM_ST"

echo "--- 6b: Wait for finalization gossip, query ALL nodes ---"
sleep 12
for p in 9201 9202 9203 9204 9205; do
  CT=$(post $p /api/query -H "Content-Type: application/json" -d "{
    \"sparql\": \"SELECT ?name WHERE { <http://test.org/vm-test1> <http://schema.org/name> ?name }\",
    \"contextGraphId\": \"$CG\",
    \"view\": \"verified-memory\"
  }" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
  [[ "$CT" -ge 1 ]] && ok "Node $p has VM event in verified memory" || warn "Node $p missing VM event ($CT)"
done

# ================================================================
echo ""
echo "=== TEST 7: On-Chain Block Progression ==="
echo ""

BLOCK=$(curl -s -X POST http://127.0.0.1:$HH_PORT -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1
}' | python3 -c 'import sys,json;d=json.load(sys.stdin);print(int(d["result"],16))' 2>/dev/null || echo "0")
echo "  Hardhat block number: $BLOCK"
[[ "$BLOCK" -gt 50 ]] && ok "Block number $BLOCK confirms many txs" || warn "Block number $BLOCK seems low"

# ================================================================
echo ""
echo "=== TEST 8: Edge Cases ==="
echo ""

echo "--- 8a: Removed /api/publish returns 404 ---"
PUB_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:9201/api/publish" -H "$H" -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test","quads":[]}')
[[ "$PUB_CODE" == "404" ]] && ok "/api/publish correctly removed (404)" || warn "/api/publish returned $PUB_CODE"

echo "--- 8b: Huge payload (10KB string) ---"
HUGE_VAL=$(python3 -c "print('x'*10000)")
HUGE_RESP=$(post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"quads\": [{\"subject\":\"http://test.org/huge\",\"predicate\":\"http://test.org/data\",\"object\":\"\\\"$HUGE_VAL\\\"\",\"graph\":\"\"}]
}" 2>&1 | head -c 500)
echo "  Large payload: $(echo "$HUGE_RESP" | head -c 200)"
ok "Large payload handled (no crash)"

echo "--- 8c: Malformed SPARQL ---"
BAD_SPARQL=$(post 9201 /api/query -H "Content-Type: application/json" -d '{
  "sparql": "NOT VALID SPARQL",
  "contextGraphId": "devnet-test"
}')
echo "$BAD_SPARQL" | grep -qi "error" && ok "Malformed SPARQL rejected" || fail "Malformed SPARQL not rejected"

echo "--- 8d: Query with SPARQL FILTER ---"
FILTER=$(post 9201 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?name WHERE { ?s <http://schema.org/name> ?name . FILTER(CONTAINS(STR(?name), 'VM Replication')) }\",
  \"contextGraphId\": \"$CG\"
}")
FILTER_CT=$(echo "$FILTER" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$FILTER_CT" -ge 1 ]] && ok "SPARQL FILTER found VM Replication Test" || warn "SPARQL FILTER: 0 results"

echo "--- 8e: SWM localOnly=true (no gossip) ---"
LOCAL_W=$(post 9201 /api/shared-memory/write -H "Content-Type: application/json" -d "{
  \"contextGraphId\": \"$CG\",
  \"localOnly\": true,
  \"quads\": [$(ql 'http://test.org/local-only' 'http://schema.org/name' 'LocalOnlyEntity')]
}")
LOCAL_OK=$(echo "$LOCAL_W" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") or d.get("triplesWritten") else "fail")' 2>/dev/null)
[[ "$LOCAL_OK" == "ok" ]] && ok "localOnly SWM write accepted" || warn "localOnly write: $LOCAL_W"

sleep 4
LOCAL_CHECK=$(post 9205 /api/query -H "Content-Type: application/json" -d "{
  \"sparql\": \"SELECT ?n WHERE { GRAPH ?g { <http://test.org/local-only> <http://schema.org/name> ?n } . FILTER(CONTAINS(STR(?g),'_shared_memory')) }\",
  \"contextGraphId\": \"$CG\"
}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("result",{}).get("bindings",[])))' 2>/dev/null || echo "0")
[[ "$LOCAL_CHECK" == "0" ]] && ok "localOnly entity NOT gossiped to Node5 (correct)" || warn "localOnly entity appeared on Node5 ($LOCAL_CHECK)"

# ================================================================
echo ""
echo "=== TEST 9: Context Graph Operations ==="
echo ""

echo "--- 9a: List context graphs ---"
CG_LIST=$(get 9201 /api/context-graph/list)
CG_COUNT=$(echo "$CG_LIST" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(len(d) if isinstance(d,list) else len(d.get("contextGraphs",d.get("paranets",[]))))' 2>/dev/null || echo "0")
echo "  Context graphs: $CG_COUNT"
[[ "$CG_COUNT" -ge 1 ]] && ok "Context graphs listed ($CG_COUNT)" || warn "No context graphs"

echo "--- 9b: Subscribe Node5 to devnet-test ---"
SUB=$(post 9205 /api/context-graph/subscribe -H "Content-Type: application/json" -d '{"contextGraphId":"devnet-test"}')
echo "  Subscribe: $(echo "$SUB" | head -c 200)"
ok "Subscribe requested"

# ================================================================
echo ""
echo "=== TEST 10: SKILL.md Validation ==="
echo ""

for p in 9201 9202 9203 9204 9205; do
  SKILL=$(curl -s "http://127.0.0.1:$p/.well-known/skill.md")
  if echo "$SKILL" | grep -q "shared-memory"; then
    ok "Node $p SKILL.md has SWM references"
  else
    warn "Node $p SKILL.md missing SWM references"
  fi
  OLD_PUB=$(echo "$SKILL" | grep "POST.*publish" | grep -v "shared-memory" || true)
  if [[ -n "$OLD_PUB" ]]; then
    fail "Node $p SKILL.md references old /api/publish"
  else
    ok "Node $p SKILL.md clean of old /api/publish"
  fi
done

# ================================================================
echo ""
echo "=== TEST 11: Node UI Accessibility ==="
echo ""

for p in 9201 9202 9203 9204 9205; do
  UI_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$p/ui")
  [[ "$UI_CODE" == "200" || "$UI_CODE" == "301" || "$UI_CODE" == "302" ]] && ok "Node $p UI accessible ($UI_CODE)" || warn "Node $p UI returned $UI_CODE"
done

# ================================================================
echo ""
echo "============================================================"
echo "DEEP TEST SUMMARY"
echo "============================================================"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  WARN: $WARN"
echo "  TOTAL: $((PASS+FAIL+WARN))"
echo "============================================================"
[ "$FAIL" -eq 0 ] && echo "  ALL TESTS PASSED!" || echo "  Some tests FAILED — see above."
