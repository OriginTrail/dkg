#!/usr/bin/env bash
#
# V10 publishDirect devnet smoke test — the ship gate for the off-chain rewire.
#
# Preconditions:
#   ./scripts/devnet.sh start 6   must already be running (hardhat + 6 nodes,
#                                 identities registered, stake + ask set).
#
# What this does:
#   1. Reads ContextGraphs / ContextGraphStorage / KnowledgeCollectionStorage
#      addresses from packages/evm-module/deployments/localhost_contracts.json.
#   2. Creates a fresh open-policy V10 context graph on-chain via
#      ContextGraphs.createContextGraph([], 0, 0, 1, ZeroAddress, 0)
#      — participantAgents=[] (open), metadataBatchId=0, accessPolicy=0
#      (public), publishPolicy=1 (open), no publish authority. Per
#      SPEC_CG_MEMORY_MODEL, the contract no longer accepts hostingNodes
#      or per-CG requiredSignatures: hosting comes from the sharding table
#      at publish time and the ACK quorum is the system parameter
#      parametersStorage.minimumRequiredSignatures().
#      Uses staticCall to preview the returned numeric cgId, then sends
#      the real tx. Falls back to parsing
#      ContextGraphStorage.ContextGraphCreated from the receipt if preview
#      fails.
#   3. Writes a single N-Quad into a tmp file under the new CG URI.
#   4. Invokes the CLI `dkg publish <cgId> --file <tmp>` via DKG_HOME=.devnet/node1.
#   5. Tails .devnet/node1/daemon.log for a line matching
#      "On-chain confirmed: UAL=... batchId=N tx=0x..." (format from
#      dkg-publisher.ts:1252). Extracts batchId + tx.
#   6. Verifies the KC is readable back via
#      KnowledgeCollectionStorage.getKnowledgeCollectionMetadata(batchId) —
#      merkleRoots array non-empty and byteSize > 0.
#   7. Exits 0 on success with "Published KC id=N tx=0x..."; non-zero otherwise.
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

# --- 2. Create + register V10 context graph via the daemon -------------------
#
# Previous revision called `ContextGraphs.createContextGraph(...)` directly
# from a hardhat signer. That mints an on-chain CG owned by a wallet the
# daemon does not control, so the subsequent `dkg context-graph register
# <id>` call (run against that numeric id) creates a SECOND on-chain CG
# under the daemon's wallet rather than binding the existing one. The
# publish then targets the orphan and fails with "not registered on-chain".
#
# The publish flow expects the daemon to OWN the CG it publishes to (the
# author signature on the finalized assertion has to chain back to the
# on-chain CG curator/creator). So we just use the daemon's own CLI:
#   1. `context-graph create <slug>` creates a local CG name.
#   2. `context-graph register <slug>` mints the on-chain CG under the
#      daemon's EOA and binds the local name to the numeric id.
# The RDF data graph URI is `did:dkg:context-graph:<slug>` (the publisher
# resolves the slug → on-chain id internally before computing leaves).
#
# Slug is timestamped so reruns within the same devnet session don't
# collide with prior CGs.

CG_SLUG="v10-publish-smoke-$(date +%s)"
log "Creating local CG '$CG_SLUG' via daemon CLI..."
# `context-graph create` auto-namespaces bare slugs to
# `{agentAddress}/{slug}` (see cli.ts → contextGraphCmd.command('create')).
# Capture the post-namespacing id from the "ID:" line so register and
# publish use the fully-qualified form the daemon registry actually
# stores.
CREATE_OUT=$(DKG_HOME="$NODE_DIR" node "$CLI_JS" context-graph create "$CG_SLUG" \
  --name "V10 publishDirect smoke" \
  --description "Auto-created by scripts/devnet-test-publish.sh") \
  || fail "context-graph create failed"
CG_FQ_ID=$(printf '%s\n' "$CREATE_OUT" | sed -nE 's/^[[:space:]]*ID:[[:space:]]+(.+)$/\1/p' | head -n1)
[ -n "$CG_FQ_ID" ] || fail "could not parse CG id from create output:\n$CREATE_OUT"
log "Local CG id = $CG_FQ_ID"

log "Registering '$CG_FQ_ID' on-chain via daemon CLI..."
REG_OUT=$(DKG_HOME="$NODE_DIR" node "$CLI_JS" context-graph register "$CG_FQ_ID") \
  || fail "context-graph register failed (CG=$CG_FQ_ID)"
CG_ONCHAIN_ID=$(printf '%s\n' "$REG_OUT" | sed -nE 's/.*On-chain:[[:space:]]+([0-9]+).*/\1/p' | head -n1)
[ -n "$CG_ONCHAIN_ID" ] || fail "could not parse on-chain id from register output:\n$REG_OUT"
# The slug is what `dkg publish` and the data-graph URI both consume;
# CG_ONCHAIN_ID is only used in the post-publish KCS verification at
# step 6 (kcsAddr.getKnowledgeCollectionMetadata takes a numeric KC id,
# but the publish receipt gives us batchId directly so CG_ONCHAIN_ID is
# only kept for logging / debug context).
CG_ID="$CG_FQ_ID"
log "CG ready: id=$CG_ID on-chain=$CG_ONCHAIN_ID"

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
