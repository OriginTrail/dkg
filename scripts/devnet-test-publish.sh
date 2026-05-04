#!/usr/bin/env bash
#
# V10 publishDirect devnet smoke test — the ship gate for the off-chain rewire.
#
# Preconditions:
#   ./scripts/devnet.sh start 6   must already be running (hardhat + 6 nodes,
#                                 identities registered, stake + ask set).
#
# What this does:
#   1. Reads ContextGraphs / ContextGraphStorage / IdentityStorage /
#      KnowledgeCollectionStorage addresses from
#      packages/evm-module/deployments/localhost_contracts.json.
#   2. Discovers hosting-node identity ids by reading each devnet node's
#      .devnet/nodeN/wallets.json, deriving the operational wallet[0]
#      address, and querying IdentityStorage.getIdentityId(opAddress).
#      Pre-PR #366 the operational + admin keys were the same Hardhat
#      signer, so iterating provider.listAccounts() worked. Post-PR #366
#      identities are registered against random operational wallets only,
#      so Hardhat signers no longer resolve to any identity.
#   3. Creates a fresh open-policy V10 context graph on-chain via
#      ContextGraphs.createContextGraph(hostingNodes, [], 1, 0, 1, ZeroAddress, 0).
#      Uses staticCall to preview the returned numeric cgId, then sends the
#      real tx. Falls back to parsing ContextGraphStorage.ContextGraphCreated
#      from the receipt if preview fails.
#   4. Writes a single N-Quad into a tmp file under the new CG URI.
#   5. Invokes the CLI `dkg publish <cgId> --file <tmp>` via DKG_HOME=.devnet/node1.
#   6. Tails .devnet/node1/daemon.log for a line matching
#      "On-chain confirmed: UAL=... batchId=N tx=0x..." (format from
#      dkg-publisher.ts:1252). Extracts batchId + tx.
#   7. Verifies the KC is readable back via
#      KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(batchId) —
#      merkleRoots array non-empty and byteSize > 0.
#   8. Exits 0 on success with "Published KC id=N tx=0x..."; non-zero otherwise.
#
# Scope:
#   publishDirect only. Conviction-path `publish` and `update`/`updateDirect`
#   are out of scope for this PR.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
NODE_NUM="${DEVNET_TEST_NODE:-1}"
API_PORT_BASE=9201
API_PORT=$((API_PORT_BASE + NODE_NUM - 1))
CONFIRM_TIMEOUT="${CONFIRM_TIMEOUT:-60}"
# Match scripts/devnet.sh's default node count when probing for hosting-node
# identities. Override if you start devnet with a different size.
HOSTING_NODE_COUNT="${HOSTING_NODE_COUNT:-6}"

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"
CLI_JS="$REPO_ROOT/packages/cli/dist/cli.js"
NODE_DIR="$DEVNET_DIR/node${NODE_NUM}"
DAEMON_LOG="$NODE_DIR/daemon.log"

log()  { echo "[v10-publish-test] $*"; }
fail() { log "FAIL: $*"; exit 1; }

# --- 1. Preconditions ---------------------------------------------------------

[ -f "$DEVNET_DIR/hardhat.pid" ] \
  || fail "devnet not running — start with ./scripts/devnet.sh start 6"

HARDHAT_PID=$(cat "$DEVNET_DIR/hardhat.pid")
kill -0 "$HARDHAT_PID" 2>/dev/null \
  || fail "stale hardhat pid file ($HARDHAT_PID)"

[ -f "$NODE_DIR/devnet.pid" ] \
  || fail "node $NODE_NUM not running (missing $NODE_DIR/devnet.pid)"
NODE_PID=$(cat "$NODE_DIR/devnet.pid")
kill -0 "$NODE_PID" 2>/dev/null \
  || fail "node $NODE_NUM pid stale ($NODE_PID)"

curl -s "http://127.0.0.1:${API_PORT}/api/status" > /dev/null \
  || fail "node $NODE_NUM API :${API_PORT} not responding"

[ -f "$CONTRACTS_JSON" ] || fail "missing $CONTRACTS_JSON"
[ -f "$CLI_JS" ]         || fail "missing $CLI_JS (run pnpm run build)"
[ -f "$DAEMON_LOG" ]     || fail "missing $DAEMON_LOG"

for abi in ContextGraphs ContextGraphStorage IdentityStorage KnowledgeCollectionStorage; do
  [ -f "$EVM_ABI_DIR/${abi}.json" ] \
    || fail "missing ABI: $EVM_ABI_DIR/${abi}.json"
done

log "Preconditions OK (hardhat pid=$HARDHAT_PID, node $NODE_NUM pid=$NODE_PID, api :$API_PORT)"

# --- 2. Create V10 context graph ---------------------------------------------

log "Creating fresh V10 context graph via ContextGraphs.createContextGraph..."

CG_ID=$(
  cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
  CONTRACTS_JSON="$CONTRACTS_JSON" \
  ABI_DIR="$EVM_ABI_DIR" \
  DEVNET_DIR="$DEVNET_DIR" \
  HOSTING_NODE_COUNT="$HOSTING_NODE_COUNT" \
  node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  const rpc = process.env.RPC_URL;
  const contractsPath = process.env.CONTRACTS_JSON;
  const abiDir = process.env.ABI_DIR;

  const provider = new ethers.JsonRpcProvider(rpc);
  const deployer = await provider.getSigner(0);

  const contracts = JSON.parse(fs.readFileSync(contractsPath, "utf8")).contracts;
  const cgAddr        = contracts.ContextGraphs?.evmAddress;
  const cgStorageAddr = contracts.ContextGraphStorage?.evmAddress;
  const identityAddr  = contracts.IdentityStorage?.evmAddress;
  if (!cgAddr)        throw new Error("ContextGraphs not deployed");
  if (!cgStorageAddr) throw new Error("ContextGraphStorage not deployed");
  if (!identityAddr)  throw new Error("IdentityStorage not deployed");

  const loadAbi = (name) => JSON.parse(fs.readFileSync(path.join(abiDir, name + ".json"), "utf8"));
  const identityAbi  = loadAbi("IdentityStorage");
  const cgAbi        = loadAbi("ContextGraphs");
  const cgStorageAbi = loadAbi("ContextGraphStorage");

  // Discover hosting-node identity ids by reading each devnet nodes
  // wallets.json file and querying IdentityStorage against the operational
  // wallet[0] address. PR #366 separated admin and operational keys: the
  // identity is registered against the operational key, not the Hardhat
  // signer that funded the node. NOTE: avoid an apostrophe in this comment;
  // the entire JS body lives inside bashs `node -e ...` single-quoted arg,
  // so any apostrophe here would close the bash quoting prematurely.
  const identity = new ethers.Contract(identityAddr, identityAbi, provider);
  const devnetDir = process.env.DEVNET_DIR;
  const hostingCount = Number(process.env.HOSTING_NODE_COUNT || "6");
  if (!devnetDir) throw new Error("DEVNET_DIR not set");
  // Distinguish FILE-level failures (missing/malformed wallets.json —
  // unexpected post-bootstrap, treat as fatal) from NO-IDENTITY (edge
  // nodes have valid wallets.json but no on-chain identity by design,
  // so this is silently expected). Without this split, a corrupt
  // wallets.json on one core node would silently shrink the roster
  // and let the smoke test pass against fewer hosting nodes than
  // intended. Codex follow-up to PR #368.
  const ids = [];
  const failures = [];
  for (let i = 1; i <= hostingCount; i++) {
    const walletsPath = path.join(devnetDir, "node" + i, "wallets.json");
    if (!fs.existsSync(walletsPath)) {
      failures.push("node " + i + ": missing " + walletsPath);
      continue;
    }
    let opAddr;
    try {
      const w = JSON.parse(fs.readFileSync(walletsPath, "utf8"));
      const op0 = Array.isArray(w.wallets) ? w.wallets[0] : null;
      if (!op0 || !op0.privateKey) {
        failures.push("node " + i + ": wallets.json has no wallets[0].privateKey");
        continue;
      }
      opAddr = new ethers.Wallet(op0.privateKey).address;
    } catch (e) {
      failures.push("node " + i + ": failed to parse wallets.json: " + (e?.message || e));
      continue;
    }
    const id = await identity.getIdentityId(opAddr);
    if (id > 0n) ids.push(id);
    // No identity → edge node, by design (dkg-agent.ts skips
    // ensureProfile for effectiveRole==='edge'). Silent skip is
    // intentional here.
  }
  if (failures.length > 0) {
    throw new Error("hosting-node discovery failures (refusing partial roster):\n  " + failures.join("\n  "));
  }
  if (ids.length === 0) {
    throw new Error("no hosting-node identities found — devnet identity registration may still be pending");
  }
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  console.error("hosting-node identity ids: [" + ids.map(String).join(", ") + "]");

  const cg        = new ethers.Contract(cgAddr, cgAbi, deployer);
  const cgStorage = new ethers.Contract(cgStorageAddr, cgStorageAbi, provider);

  // Open policy, requiredSignatures=1, no metadata, no curator, no authority.
  const args = [
    ids,                    // uint72[] hostingNodes
    [],                     // uint72[] participantAgents (open — no curator list)
    1,                      // uint8 requiredSignatures  (contract needs > 0)
    0,                      // uint256 metadataBatchId  (none)
    1,                      // uint8 publishPolicy      (1 = open)
    ethers.ZeroAddress,     // address publishAuthority  (open rejects non-zero)
    0,                      // uint256 publishAuthorityAccountId (open rejects non-zero)
  ];

  // Preview cgId via staticCall, fall back to event parsing if needed.
  let previewId = null;
  try {
    previewId = await cg.createContextGraph.staticCall(...args);
    console.error("staticCall preview: cgId=" + previewId);
  } catch (e) {
    console.error("staticCall preview failed: " + (e?.shortMessage || e?.message || e));
  }

  const tx = await cg.createContextGraph(...args);
  const receipt = await tx.wait();

  let cgId = previewId;
  if (cgId == null) {
    const topic = cgStorage.interface.getEvent("ContextGraphCreated").topicHash;
    for (const lg of receipt.logs) {
      if (lg.address.toLowerCase() !== cgStorageAddr.toLowerCase()) continue;
      if (lg.topics[0] !== topic) continue;
      const parsed = cgStorage.interface.parseLog(lg);
      cgId = parsed.args.contextGraphId;
      break;
    }
    if (cgId == null) throw new Error("ContextGraphCreated event not found on receipt");
  }

  console.error("createContextGraph tx=" + receipt.hash + " cgId=" + cgId);
  console.log(cgId.toString());
})().catch(e => {
  console.error("[create-cg] " + (e?.shortMessage || e?.message || String(e)));
  process.exit(1);
});
'
) || fail "context graph creation failed"

[ -n "$CG_ID" ] || fail "empty CG_ID captured"
log "Created V10 context graph id=$CG_ID"

# --- 3. Build RDF fixture -----------------------------------------------------

TMP_DIR=$(mktemp -d -t v10-publish-smoke)
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_RDF="$TMP_DIR/fixture.nq"
SUBJECT="urn:test:v10-smoke:$(date +%s)"
cat > "$TMP_RDF" <<EOF
<${SUBJECT}> <urn:test:predicate> "v10-publishDirect-smoke" <did:dkg:context-graph:${CG_ID}> .
EOF
log "Wrote RDF fixture to $TMP_RDF (subject=$SUBJECT)"

# --- 4. CLI publish -----------------------------------------------------------

# Remember where the daemon log currently ends so we can scan only new lines.
if [ -s "$DAEMON_LOG" ]; then
  BASELINE_LINES=$(wc -l < "$DAEMON_LOG" | tr -d ' ')
else
  BASELINE_LINES=0
fi

log "Invoking CLI publish (DKG_HOME=$NODE_DIR)..."
set +e
DKG_HOME="$NODE_DIR" node "$CLI_JS" publish "$CG_ID" --file "$TMP_RDF"
PUBLISH_RC=$?
set -e

if [ $PUBLISH_RC -ne 0 ]; then
  log "CLI publish exited with $PUBLISH_RC — tailing daemon log for context:"
  tail -n 50 "$DAEMON_LOG" >&2 || true
  fail "CLI publish returned non-zero"
fi

# --- 5. Wait for On-chain confirmation in daemon log --------------------------

log "Waiting up to ${CONFIRM_TIMEOUT}s for daemon 'On-chain confirmed' line..."
BATCH_ID=""
TX_HASH=""
for _ in $(seq 1 "$CONFIRM_TIMEOUT"); do
  LINE=$(tail -n +"$((BASELINE_LINES + 1))" "$DAEMON_LOG" \
         | grep -E 'On-chain confirmed: UAL=.* batchId=[0-9]+ tx=0x[0-9a-fA-F]+' \
         | tail -n 1 || true)
  if [ -n "$LINE" ]; then
    BATCH_ID=$(printf '%s' "$LINE" | sed -E 's/.*batchId=([0-9]+).*/\1/')
    TX_HASH=$(printf '%s' "$LINE" | sed -E 's/.*tx=(0x[0-9a-fA-F]+).*/\1/')
    break
  fi
  sleep 1
done

if [ -z "$BATCH_ID" ] || [ -z "$TX_HASH" ]; then
  log "No 'On-chain confirmed' line found. Tail of daemon log:"
  tail -n 80 "$DAEMON_LOG" >&2 || true
  fail "publish did not confirm on-chain within ${CONFIRM_TIMEOUT}s"
fi

log "Captured batchId=$BATCH_ID tx=$TX_HASH"

# --- 6. Verify KC readable via KnowledgeCollectionStorage --------------------

log "Verifying KC $BATCH_ID is readable via KnowledgeCollectionStorage..."
(
  cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
  CONTRACTS_JSON="$CONTRACTS_JSON" \
  ABI_DIR="$EVM_ABI_DIR" \
  BATCH_ID="$BATCH_ID" \
  node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const kcsAddr = contracts.KnowledgeCollectionStorage?.evmAddress;
  if (!kcsAddr) throw new Error("KnowledgeCollectionStorage not deployed");

  const kcsAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "KnowledgeCollectionStorage.json"), "utf8"));
  const kcs = new ethers.Contract(kcsAddr, kcsAbi, provider);

  const id = BigInt(process.env.BATCH_ID);
  const [merkleRoots, burned, minted, byteSize, startEpoch, endEpoch, tokenAmount, isImmutable] =
    await kcs.getKnowledgeCollectionMetadata(id);

  if (!merkleRoots || merkleRoots.length === 0) {
    throw new Error("merkleRoots empty — KC not actually created");
  }
  if (byteSize === 0n) {
    throw new Error("byteSize is zero — KC degenerate");
  }
  console.error("[kcs] merkleRoots=" + merkleRoots.length +
                " minted=" + minted +
                " byteSize=" + byteSize +
                " tokenAmount=" + tokenAmount +
                " startEpoch=" + startEpoch +
                " endEpoch=" + endEpoch +
                " isImmutable=" + isImmutable);
})().catch(e => {
  console.error("[verify-kc] " + (e?.shortMessage || e?.message || String(e)));
  process.exit(1);
});
'
) || fail "KCS verification failed"

log "Published KC id=$BATCH_ID tx=$TX_HASH; verified readable via KCS"
exit 0
