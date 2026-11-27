#!/usr/bin/env bash
#
# DKG comprehensive devnet soak: 6 nodes (4 core + 2 edge), 10 staked
# wallets, sustained publishing, and 2h of observation to validate
# random sampling, on-chain publishing, and reward accrual.
#
# What this exercises end-to-end (positive scenarios):
#   - Random Sampling prover: each core node ticks every 5s, picks an
#     eligible challenge, builds + submits proofs across many proof
#     periods. We assert each core successfully submits across the
#     soak window.
#   - Publishing: a steady workload of creates with a share (the request
#     `dkg ka create --share` sends) + `dkg ka publish` spreads KCs across
#     two registered context graphs, distributing publishes round-robin
#     across all 4 core nodes' APIs (so the publisher path is exercised on
#     every node, not just node 1). A share the node cannot finish at once
#     is followed as a client would: shared again, or waited for while the
#     share job that owns it finishes; each such publish is reported
#     (scripts/devnet-soak-rs-publisher.sh, scripts/devnet-soak-rs-share.mjs).
#   - Stake & reward accounting: 10 distinct wallets stake on the 4
#     core identities (asymmetrically — cores 1+2 carry 100k each,
#     cores 3+4 carry 75k each). We snapshot
#     `getNetNodeEpochRewards` and `getNodeEpochScorePerStake` over
#     time and assert they grow on the proving cores.
#
# Negative scenarios woven into the run:
#   - Publish to an unregistered context graph → expect HTTP 4xx,
#     nothing on chain.
#   - Edge nodes (5, 6) MUST report `enabled=false` for RS for the
#     entire soak. Any non-zero submitted count from an edge node
#     is a failure (would mean the role gate broke).
#   - Mid-soak, gracefully stop one core node, wait one proof period,
#     then restart it. Assert it resumes submitting proofs without
#     manual intervention (`dkg start` re-binds the prover loop).
#
# Output:
#   $DEVNET_DIR/soak-r${ROUND}/
#     ├─ findings.md         human summary + assertion results
#     ├─ timeseries.jsonl    1-row-per-snapshot of per-node RS state
#     ├─ publish.jsonl       per-publish-attempt log (success/failure)
#     ├─ stake.json          frozen stake/reward state at start vs. end
#     ├─ delegators.json     six bootstrapped delegator wallets
#     └─ chain-events.jsonl  RS submitProof events sniffed from chain
#
# Usage:
#   scripts/devnet-soak-rs.sh <round-number> [duration-seconds]
#
# Env knobs:
#   DEVNET_DIR              defaults to .devnet (matches devnet.sh)
#   HARDHAT_PORT            defaults to 8545
#   API_PORT_BASE           defaults to 9201
#   PUBLISH_INTERVAL_SEC    seconds between publish attempts (default 30)
#   SNAPSHOT_INTERVAL_SEC   seconds between observer snapshots (default 60)
#   CORE_RESTART_AT_FRAC    when (as fraction of total duration) to
#                           bounce one core (default 0.5)
#   SOAK_EPOCH_LENGTH_SEC   override Chronos.epochLength (default 1800)
#   SOAK_SKIP_RESTART=1     skip the mid-soak core restart scenario
#   SOAK_SHARE_RECOVERY_WAIT_SEC
#                           seconds to wait for a share job that owns a share
#                           before the publish counts as failed (default 300)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
PUBLISH_INTERVAL_SEC="${PUBLISH_INTERVAL_SEC:-30}"
SNAPSHOT_INTERVAL_SEC="${SNAPSHOT_INTERVAL_SEC:-60}"
CORE_RESTART_AT_FRAC="${CORE_RESTART_AT_FRAC:-0.5}"
SOAK_EPOCH_LENGTH_SEC="${SOAK_EPOCH_LENGTH_SEC:-1800}"
NUM_CORES=4
NUM_EDGE=2
NUM_NODES=$((NUM_CORES + NUM_EDGE))
EXTRA_DELEGATORS=6

ROUND="${1:-}"
DURATION_SEC="${2:-7200}"
if [ -z "$ROUND" ]; then
  echo "Usage: $0 <round-number> [duration-seconds]"
  echo "  round-number    Identifier for this run (1..N), used in output dir name"
  echo "  duration-seconds  How long to soak (default 7200 = 2h)"
  exit 1
fi

OUT_DIR="$DEVNET_DIR/soak-r${ROUND}"
TIMESERIES="$OUT_DIR/timeseries.jsonl"
PUBLISH_LOG="$OUT_DIR/publish.jsonl"
EVENTS_LOG="$OUT_DIR/chain-events.jsonl"
RESTART_WINDOW_FILE="$OUT_DIR/restart-window.json"
DELEGATORS_FILE="$OUT_DIR/delegators.json"
STAKE_BEFORE="$OUT_DIR/stake.before.json"
STAKE_AFTER="$OUT_DIR/stake.after.json"
FINDINGS="$OUT_DIR/findings.md"
PUBLISHER_PIDFILE="$OUT_DIR/publisher.pid"
OBSERVER_PIDFILE="$OUT_DIR/observer.pid"
EVENT_PIDFILE="$OUT_DIR/event-listener.pid"
mkdir -p "$OUT_DIR"

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"
CLI_JS="$REPO_ROOT/packages/cli/dist/cli.js"

log()  { local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "[soak-r${ROUND} $ts] $*"; }
fail() { log "FAIL: $*"; exit 1; }

# Safe line counter that survives missing files and tolerates `set -e`.
# R1 used `pcount=$([ -f X ] && wc -l < X | tr -d ' ' || echo 0)` which
# aborted at the END_TS boundary with `=NNNN: command not found` (the
# inner pipeline interacted badly with operator precedence under load).
safe_line_count() {
  local f="$1"
  if [ -f "$f" ]; then
    local n
    n=$(wc -l < "$f" 2>/dev/null | tr -d '[:space:]')
    echo "${n:-0}"
  else
    echo 0
  fi
}

# --- 0. Pre-flight ----------------------------------------------------------

log "Round $ROUND, duration ${DURATION_SEC}s, output dir $OUT_DIR"
[ -f "$DEVNET_DIR/hardhat.pid" ] && kill -0 "$(cat "$DEVNET_DIR/hardhat.pid")" 2>/dev/null \
  || fail "devnet not running — start with ./scripts/devnet.sh start $NUM_NODES"

# Surface the deployed Chronos.epochLength so the operator knows whether epoch
# transitions are observable inside the soak window. EPOCH_LENGTH is set in the
# Chronos constructor (immutable post-deploy), so to shorten it we have to
# bounce the devnet: patch packages/evm-module/deployments/parameters.json ->
# development.Chronos.epochLength to e.g. 1800, then
#   ./scripts/devnet.sh clean && ./scripts/devnet.sh start 6
# We deliberately do NOT touch parameters.json from this script — it is in the
# Solidity test path and shipping a patched value would break unrelated CI.
EPOCH_LEN_SEC=$(node -e '
const { ethers } = require("ethers");
const fs = require("fs");
(async () => {
  const c = JSON.parse(fs.readFileSync("'"$CONTRACTS_JSON"'", "utf8")).contracts;
  const p = new ethers.JsonRpcProvider("http://127.0.0.1:'"$HARDHAT_PORT"'");
  const ch = new ethers.Contract(c.Chronos.evmAddress, ["function epochLength() view returns (uint256)"], p);
  console.log((await ch.epochLength()).toString());
})().catch(()=>console.log("?"));
' 2>/dev/null || echo "?")
if [ "$EPOCH_LEN_SEC" != "?" ]; then
  if [ "$EPOCH_LEN_SEC" -gt "$DURATION_SEC" ] 2>/dev/null; then
    log "  Chronos.epochLength=${EPOCH_LEN_SEC}s > duration=${DURATION_SEC}s — soak will NOT observe an epoch transition."
    log "  Reward distribution (setNetNodeEpochRewards / delegator-roll updates) only fires at epoch finalize."
    log "  To observe rewards: edit packages/evm-module/deployments/parameters.json development.Chronos.epochLength to e.g. 1800, then clean + restart devnet."
  else
    expected_epochs=$((DURATION_SEC / EPOCH_LEN_SEC))
    log "  Chronos.epochLength=${EPOCH_LEN_SEC}s; with duration=${DURATION_SEC}s expect ~${expected_epochs} epoch transitions (rewards distribute on transition)."
  fi
fi
[ -f "$CONTRACTS_JSON" ] || fail "missing $CONTRACTS_JSON"
[ -f "$CLI_JS" ]         || fail "missing $CLI_JS (run pnpm run build)"
for abi in IdentityStorage RandomSamplingStorage ConvictionStakingStorage \
           StakingStorage DKGStakingConvictionNFT Token Profile ProfileStorage \
           ContextGraphStorage; do
  [ -f "$EVM_ABI_DIR/${abi}.json" ] || fail "missing ABI: $EVM_ABI_DIR/${abi}.json"
done

TOKEN_FILE="$DEVNET_DIR/node1/auth.token"
[ -f "$TOKEN_FILE" ] || fail "missing auth token at $TOKEN_FILE"
AUTH_TOKEN=$(tail -1 "$TOKEN_FILE" | tr -d '[:space:]')
[ -n "$AUTH_TOKEN" ] || fail "auth token empty in $TOKEN_FILE"

for n in $(seq 1 $NUM_NODES); do
  pidfile="$DEVNET_DIR/node${n}/devnet.pid"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null \
    || fail "node ${n} not running (devnet.sh start ${NUM_NODES} first)"
done
log "All ${NUM_NODES} nodes responsive"

# --- 1. Bootstrap 6 extra delegator wallets ---------------------------------

log "Bootstrapping ${EXTRA_DELEGATORS} extra delegator wallets to reach 10 staking wallets"
log "  (4 op-wallets already staked 50k each by devnet.sh)"

if [ -f "$DELEGATORS_FILE" ]; then
  log "  delegators.json exists — reusing"
else
  cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
  CONTRACTS_JSON="$CONTRACTS_JSON" \
  ABI_DIR="$EVM_ABI_DIR" \
  DEVNET_DIR="$DEVNET_DIR" \
  OUT_FILE="$DELEGATORS_FILE" \
  EXTRA="$EXTRA_DELEGATORS" \
  node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const deployer = await provider.getSigner(0);

  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const tokenAddr = contracts.Token.evmAddress;
  const stakingNftAddr = contracts.DKGStakingConvictionNFT.evmAddress;
  const stakingV10Addr = contracts.StakingV10.evmAddress;
  const identityAddr = contracts.IdentityStorage.evmAddress;

  const tokenAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "Token.json"), "utf8"));
  const idAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "IdentityStorage.json"), "utf8"));
  const nftAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "DKGStakingConvictionNFT.json"), "utf8"));

  const token = new ethers.Contract(tokenAddr, tokenAbi, deployer);
  const idStorage = new ethers.Contract(identityAddr, idAbi, provider);

  // Resolve the 4 core identities by reading each cores wallets.json and
  // looking up IdentityStorage by the OPERATIONAL wallet[0] address (post-PR
  // 366 the admin/Hardhat key is no longer the identity owner).
  const coreIds = [];
  for (let n = 1; n <= 4; n++) {
    const w = JSON.parse(fs.readFileSync(path.join(process.env.DEVNET_DIR, "node" + n, "wallets.json"), "utf8"));
    const opAddr = new ethers.Wallet(w.wallets[0].privateKey).address;
    const id = await idStorage.getIdentityId(opAddr);
    if (id === 0n) throw new Error("core node " + n + " has no identity");
    coreIds.push(id.toString());
  }
  console.error("core identities: " + coreIds.join(", "));

  // Distribution: 25k stake each, asymmetric across cores.
  // Cores 1,2 each get 2 delegators (final stake 100k); cores 3,4 each get 1
  // (final stake 75k). Asymmetric on purpose — RS scoring weights stake, so
  // an asymmetric distribution gives us measurable score-per-stake variance
  // to pin the reward calculation against.
  const targetCoreIdxs = [0, 0, 1, 1, 2, 3];
  const stakePerDelegator = ethers.parseEther("25000");
  const ethFunding = ethers.parseEther("10");
  const tracFunding = ethers.parseEther("100000");

  // Track the wallet nonce locally and pass it explicitly to every tx. ethers
  // v6 honours { nonce } in contract-call overrides, but under interval mining
  // even the explicit-pending pattern can race because the "pending" view will
  // not always include the just-submitted tx for a few hundred ms. We sidestep
  // the race by reading "pending" ONCE for a fresh wallet (always 0) then
  // incrementing locally per send.
  const delegators = [];
  for (let i = 0; i < Number(process.env.EXTRA); i++) {
    const pk = "0x" + crypto.randomBytes(32).toString("hex");
    const wallet = new ethers.Wallet(pk, provider);
    await provider.send("hardhat_setBalance", [wallet.address, "0x" + ethFunding.toString(16)]);
    await (await token.mint(wallet.address, tracFunding)).wait();
    const tokenAsDelegator = token.connect(wallet);
    const nft = new ethers.Contract(stakingNftAddr, nftAbi, wallet);
    let nonce = await provider.getTransactionCount(wallet.address, "pending");
    const approveTx = await tokenAsDelegator.approve(stakingV10Addr, stakePerDelegator, { nonce });
    await approveTx.wait();
    const targetIdId = BigInt(coreIds[targetCoreIdxs[i]]);
    nonce += 1;
    const convictionTx = await nft.createConviction(targetIdId, stakePerDelegator, 1n, { nonce });
    const receipt = await convictionTx.wait();
    delegators.push({
      address: wallet.address,
      privateKey: pk,
      stakedOnIdentityId: targetIdId.toString(),
      stakedOnCoreNodeIdx: targetCoreIdxs[i] + 1,
      stakeAmountWei: stakePerDelegator.toString(),
      txHash: receipt.hash,
    });
    console.error("  delegator " + (i+1) + " " + wallet.address + " staked " + ethers.formatEther(stakePerDelegator) + " TRAC on core " + (targetCoreIdxs[i] + 1) + " (idId=" + targetIdId + ") tx=" + receipt.hash);
  }

  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({
    coreIdentities: coreIds,
    targetCoreIdxs,
    delegators,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
'
fi
log "Delegators bootstrap complete (see $DELEGATORS_FILE)"

# --- 2. Snapshot stake state BEFORE the soak --------------------------------

snapshot_stake_state() {
  local out_path="$1"
  cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
  CONTRACTS_JSON="$CONTRACTS_JSON" \
  ABI_DIR="$EVM_ABI_DIR" \
  DEVNET_DIR="$DEVNET_DIR" \
  DELEGATORS_FILE="$DELEGATORS_FILE" \
  OUT_FILE="$out_path" \
  node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const cssAddr = contracts.ConvictionStakingStorage.evmAddress;
  const ssAddr = contracts.StakingStorage.evmAddress;
  const rssAddr = contracts.RandomSamplingStorage.evmAddress;
  const chronosAddr = contracts.Chronos.evmAddress;

  const cssAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "ConvictionStakingStorage.json"), "utf8"));
  const ssAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "StakingStorage.json"), "utf8"));
  const rssAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "RandomSamplingStorage.json"), "utf8"));
  const chronosAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "Chronos.json"), "utf8"));

  const css = new ethers.Contract(cssAddr, cssAbi, provider);
  const ss = new ethers.Contract(ssAddr, ssAbi, provider);
  const rss = new ethers.Contract(rssAddr, rssAbi, provider);
  const chronos = new ethers.Contract(chronosAddr, chronosAbi, provider);

  const epoch = await chronos.getCurrentEpoch();
  const block = await provider.getBlockNumber();
  const ts = (await provider.getBlock(block)).timestamp;

  const meta = JSON.parse(fs.readFileSync(process.env.DELEGATORS_FILE, "utf8"));
  const out = {
    snapshotAt: new Date().toISOString(),
    blockNumber: block,
    blockTimestamp: ts,
    epoch: epoch.toString(),
    perCore: [],
    perDelegator: [],
  };

  for (let i = 0; i < meta.coreIdentities.length; i++) {
    const idId = BigInt(meta.coreIdentities[i]);
    const v10Stake = await css.getNodeStakeV10(idId);
    let v8Stake = 0n;
    try { v8Stake = await ss.getNodeStake(idId); } catch { /* legacy contract not deployed */ }
    const epochScore = await rss.getNodeEpochScore(epoch, idId);
    const epochScorePerStake = await rss.getNodeEpochScorePerStake(epoch, idId);
    let netRewards = 0n;
    try { netRewards = await css.getNetNodeEpochRewards(idId, epoch); } catch { /* might not exist for current epoch yet */ }
    out.perCore.push({
      coreNodeIdx: i + 1,
      identityId: idId.toString(),
      v10StakeWei: v10Stake.toString(),
      v8StakeWei: v8Stake.toString(),
      epochScore: epochScore.toString(),
      epochScorePerStake: epochScorePerStake.toString(),
      netNodeEpochRewards: netRewards.toString(),
    });
  }

  // Per-delegator rolling rewards via DelegatorsInfo.getDelegatorRollingRewards
  const delInfoAddr = contracts.DelegatorsInfo?.evmAddress;
  let delInfo = null;
  if (delInfoAddr) {
    const delInfoAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "DelegatorsInfo.json"), "utf8"));
    delInfo = new ethers.Contract(delInfoAddr, delInfoAbi, provider);
  }
  for (const d of meta.delegators) {
    let rolling = 0n;
    if (delInfo) {
      try { rolling = await delInfo.getDelegatorRollingRewards(BigInt(d.stakedOnIdentityId), d.address); } catch { /* may not exist before epoch finalize */ }
    }
    out.perDelegator.push({
      address: d.address,
      stakedOnIdentityId: d.stakedOnIdentityId,
      stakedOnCoreNodeIdx: d.stakedOnCoreNodeIdx,
      rollingRewardsWei: rolling.toString(),
    });
  }

  fs.writeFileSync(process.env.OUT_FILE, JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
'
}

snapshot_stake_state "$STAKE_BEFORE"
log "Stake snapshot BEFORE soak written to $STAKE_BEFORE"

# --- 3. Negative scenario A: create/share to unregistered CG ---------------

log "Negative scenario A: create/share to unregistered CG (expect HTTP 4xx)"
NEG_TMP=$(mktemp -d -t soak-neg)
trap 'rm -rf "$NEG_TMP"' RETURN
echo '<urn:soak:bogus:'"$ROUND"'> <urn:soak:p> "neg-test" .' > "$NEG_TMP/neg.nt"
NEG_RC=0
DKG_HOME="$DEVNET_DIR/node1" node "$CLI_JS" ka create "soak-neg-${ROUND}" --context-graph-id "does-not-exist-$ROUND" --input-file "$NEG_TMP/neg.nt" --share \
  > "$OUT_DIR/neg-create-share-bogus-cg.log" 2>&1 || NEG_RC=$?
if [ "$NEG_RC" -eq 0 ]; then
  log "  WARNING: create/share to unregistered CG SUCCEEDED - that should have failed"
  echo '{"scenario":"create_share_unregistered_cg","result":"unexpected_success"}' >> "$OUT_DIR/negative-results.jsonl"
else
  log "  OK: create/share to unregistered CG correctly failed (rc=$NEG_RC)"
  echo "{\"scenario\":\"create_share_unregistered_cg\",\"result\":\"correctly_rejected\",\"rc\":$NEG_RC}" >> "$OUT_DIR/negative-results.jsonl"
fi

# --- 4. Background publisher loop (positive workload) ----------------------
# scripts/devnet-soak-rs-publisher.sh, started in section 7.

# --- 5. Background observer loop ------------------------------------------

cat > "$OUT_DIR/observer-loop.sh" <<'EOLOOP'
#!/usr/bin/env bash
set -uo pipefail
REPO_ROOT="$1"; DEVNET_DIR="$2"; OUT_DIR="$3"; SNAPSHOT_INTERVAL_SEC="$4"; END_TS="$5"
AUTH_TOKEN="$6"; HARDHAT_PORT="$7"; API_PORT_BASE="$8"; NUM_CORES="$9"; NUM_NODES="${10}"
TIMESERIES="$OUT_DIR/timeseries.jsonl"
CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

while [ "$(date +%s)" -lt "$END_TS" ]; do
  # Snapshot per-node /api/random-sampling/status + /api/connections + /api/status
  per_node_json="["
  sep=""
  for n in $(seq 1 "$NUM_NODES"); do
    port=$((API_PORT_BASE + n - 1))
    rs=$(curl -sS --max-time 5 -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${port}/api/random-sampling/status" 2>/dev/null || echo '{}')
    st=$(curl -sS --max-time 5 -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${port}/api/status" 2>/dev/null || echo '{}')
    cn=$(curl -sS --max-time 5 -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${port}/api/connections" 2>/dev/null || echo '{}')
    per_node_json+="${sep}{\"node\":${n},\"rs\":${rs},\"status\":${st},\"connections\":${cn}}"
    sep=","
  done
  per_node_json+="]"

  # On-chain observation: current epoch + per-core score & rewards
  chain_json=$(cd "$REPO_ROOT/packages/evm-module" && \
    RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
    CONTRACTS_JSON="$CONTRACTS_JSON" \
    ABI_DIR="$ABI_DIR" \
    DEVNET_DIR="$DEVNET_DIR" \
    NUM_CORES="$NUM_CORES" \
    node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const chronos = new ethers.Contract(contracts.Chronos.evmAddress, JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "Chronos.json"), "utf8")), provider);
  const idStorage = new ethers.Contract(contracts.IdentityStorage.evmAddress, JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "IdentityStorage.json"), "utf8")), provider);
  const rss = new ethers.Contract(contracts.RandomSamplingStorage.evmAddress, JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "RandomSamplingStorage.json"), "utf8")), provider);
  const css = new ethers.Contract(contracts.ConvictionStakingStorage.evmAddress, JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "ConvictionStakingStorage.json"), "utf8")), provider);
  const epoch = await chronos.getCurrentEpoch();
  const block = await provider.getBlockNumber();
  const cores = [];
  for (let n = 1; n <= Number(process.env.NUM_CORES); n++) {
    const w = JSON.parse(fs.readFileSync(path.join(process.env.DEVNET_DIR, "node" + n, "wallets.json"), "utf8"));
    const opAddr = new ethers.Wallet(w.wallets[0].privateKey).address;
    const idId = await idStorage.getIdentityId(opAddr);
    if (idId === 0n) { cores.push({n, idId: "0"}); continue; }
    const epochScore = await rss.getNodeEpochScore(epoch, idId);
    const sps = await rss.getNodeEpochScorePerStake(epoch, idId);
    const stake = await css.getNodeStakeV10(idId);
    let rewards = 0n;
    try { rewards = await css.getNetNodeEpochRewards(idId, epoch); } catch {}
    cores.push({
      n,
      idId: idId.toString(),
      epochScore: epochScore.toString(),
      epochScorePerStake: sps.toString(),
      stakeWei: stake.toString(),
      netNodeEpochRewardsWei: rewards.toString(),
    });
  }
  console.log(JSON.stringify({epoch: epoch.toString(), block, cores}));
})().catch((e) => { console.error(e.message); process.exit(1); });
' 2>/dev/null || echo '{}')

  echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"perNode\":$per_node_json,\"chain\":$chain_json}" >> "$TIMESERIES"

  sleep "$SNAPSHOT_INTERVAL_SEC"
done
EOLOOP
chmod +x "$OUT_DIR/observer-loop.sh"

# --- 6. Background event-listener: poll RandomSamplingStorage for proof events
#
# RandomSampling.sol does NOT emit a ProofSubmitted event — submitProof writes
# state and then emits a single ChallengeGenerated for the next period. The
# actual signal that "a proof landed and was scored" lives on
# RandomSamplingStorage:
#   - EpochNodeValidProofsCountIncremented(epoch, identityId, newCount)
#       fired by the contract every time submitProof passes verification.
#   - NodeEpochScoreAdded(epoch, identityId, scoreAdded, totalScore)
#       fired in the same call when the score is credited (RFC-26 inputs).
#
# Polling getLogs every 5s instead of websocket-subscribing keeps us tolerant
# of Hardhat node restarts (no resubscribe dance) and matches the cadence of
# the prover loop's tick.

cat > "$OUT_DIR/event-listener.js" <<EOJS
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
(async () => {
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:${HARDHAT_PORT}");
  const contracts = JSON.parse(fs.readFileSync("${CONTRACTS_JSON}", "utf8")).contracts;
  const rssAbi = JSON.parse(fs.readFileSync(path.join("${EVM_ABI_DIR}", "RandomSamplingStorage.json"), "utf8"));
  const rss = new ethers.Contract(contracts.RandomSamplingStorage.evmAddress, rssAbi, provider);
  const out = fs.createWriteStream("${EVENTS_LOG}", {flags: "a"});
  let lastBlock = await provider.getBlockNumber();
  // Pin the events we actually care about — RSS emits ~20 events and most are
  // chatty per-tick storage writes that would balloon the log without adding
  // signal. These three pin "node submitted a proof + got scored + tick advanced".
  const wantedEvents = new Set([
    "EpochNodeValidProofsCountIncremented",
    "NodeEpochScoreAdded",
    "ActiveProofPeriodStartBlockSet",
  ]);
  const filters = rssAbi
    .filter(e => e.type === "event" && wantedEvents.has(e.name))
    .map(e => rss.filters[e.name] && rss.filters[e.name]())
    .filter(Boolean);
  while (true) {
    try {
      const head = await provider.getBlockNumber();
      if (head > lastBlock) {
        const fromBlock = lastBlock + 1;
        const toBlock = head;
        for (const f of filters) {
          const evts = await rss.queryFilter(f, fromBlock, toBlock);
          for (const e of evts) {
            out.write(JSON.stringify({
              ts: new Date().toISOString(),
              event: e.fragment?.name || e.eventName || "unknown",
              args: (e.args || []).map(a => typeof a === "bigint" ? a.toString() : a),
              txHash: e.transactionHash,
              blockNumber: e.blockNumber,
            }) + "\n");
          }
        }
        lastBlock = head;
      }
    } catch (err) {
      out.write(JSON.stringify({ts: new Date().toISOString(), error: err.message}) + "\n");
    }
    await new Promise(r => setTimeout(r, 5000));
  }
})().catch((e) => { console.error(e); process.exit(1); });
EOJS

# --- 7. Launch background jobs ---------------------------------------------

START_TS=$(date +%s)
END_TS=$((START_TS + DURATION_SEC))

log "Launching publisher loop (${PUBLISH_INTERVAL_SEC}s interval, ${DURATION_SEC}s total)"
bash "$REPO_ROOT/scripts/devnet-soak-rs-publisher.sh" "$REPO_ROOT" "$DEVNET_DIR" "$OUT_DIR" "$CLI_JS" "$PUBLISH_INTERVAL_SEC" "$END_TS" "$AUTH_TOKEN" "$ROUND" \
  > "$OUT_DIR/publisher.log" 2>&1 &
echo $! > "$PUBLISHER_PIDFILE"

log "Launching observer loop (${SNAPSHOT_INTERVAL_SEC}s interval)"
"$OUT_DIR/observer-loop.sh" "$REPO_ROOT" "$DEVNET_DIR" "$OUT_DIR" "$SNAPSHOT_INTERVAL_SEC" "$END_TS" "$AUTH_TOKEN" "$HARDHAT_PORT" "$API_PORT_BASE" "$NUM_CORES" "$NUM_NODES" \
  > "$OUT_DIR/observer.log" 2>&1 &
echo $! > "$OBSERVER_PIDFILE"

log "Launching chain event listener"
# Place the script INSIDE packages/evm-module so Node can resolve `ethers`.
# `cd` alone doesn't help — Node walks node_modules from the *script* location,
# not from cwd. We hardlink/copy into the package dir, then run from there.
EVENT_SCRIPT_RUN="$REPO_ROOT/packages/evm-module/.soak-event-listener-r${ROUND}.js"
cp "$OUT_DIR/event-listener.js" "$EVENT_SCRIPT_RUN"
( cd "$REPO_ROOT/packages/evm-module" && exec node "$EVENT_SCRIPT_RUN" ) \
  > "$OUT_DIR/event-listener.log" 2>&1 &
echo $! > "$EVENT_PIDFILE"

cleanup_bg() {
  for pf in "$PUBLISHER_PIDFILE" "$OBSERVER_PIDFILE" "$EVENT_PIDFILE"; do
    [ -f "$pf" ] || continue
    pid=$(cat "$pf")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "Stopped background pid $pid"
    fi
    rm -f "$pf"
  done
  # Best-effort tidy-up of the per-round event-listener copy.
  [ -n "${EVENT_SCRIPT_RUN:-}" ] && rm -f "$EVENT_SCRIPT_RUN" 2>/dev/null || true
}
trap cleanup_bg EXIT

# --- 8. Mid-soak negative scenario: bounce one core node -------------------

if [ "${SOAK_SKIP_RESTART:-0}" != "1" ]; then
  RESTART_DELAY=$(awk -v d="$DURATION_SEC" -v f="$CORE_RESTART_AT_FRAC" 'BEGIN { printf "%d", d * f }')
  RESTART_AT_TS=$((START_TS + RESTART_DELAY))
  RESTART_NODE=2
  log "Will bounce core node ${RESTART_NODE} at +${RESTART_DELAY}s (fraction ${CORE_RESTART_AT_FRAC})"
fi

# --- 9. Wait and apply mid-soak interventions -------------------------------

restart_done=0
while true; do
  now=$(date +%s)
  remaining=$((END_TS - now))
  if [ "$remaining" -le 0 ]; then break; fi

  if [ "${SOAK_SKIP_RESTART:-0}" != "1" ] && [ "$restart_done" -eq 0 ] && [ "$now" -ge "$RESTART_AT_TS" ]; then
    log "MID-SOAK INTERVENTION: stopping core node ${RESTART_NODE} for ~120s"
    restart_log="$OUT_DIR/node${RESTART_NODE}-restart.log"
    restart_stop_ts=$(date +%s)
    restart_stop_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    DEVNET_DIR="$DEVNET_DIR" HARDHAT_PORT="$HARDHAT_PORT" API_PORT_BASE="$API_PORT_BASE" \
      "$REPO_ROOT/scripts/devnet.sh" stop-node "$RESTART_NODE" >> "$restart_log" 2>&1
    log "  stopped node ${RESTART_NODE} via devnet.sh stop-node (see $restart_log)"
    sleep 120
    log "  restarting node ${RESTART_NODE} via devnet.sh restart-node..."
    DEVNET_DIR="$DEVNET_DIR" HARDHAT_PORT="$HARDHAT_PORT" API_PORT_BASE="$API_PORT_BASE" \
      "$REPO_ROOT/scripts/devnet.sh" restart-node "$RESTART_NODE" >> "$restart_log" 2>&1
    log "  restarted node ${RESTART_NODE}; verifying API readiness..."
    api_port=$((API_PORT_BASE + RESTART_NODE - 1))
    restart_ready_ts=""
    restart_ready_iso=""
    for i in $(seq 1 60); do
      if curl -sf -H "Authorization: Bearer $AUTH_TOKEN" "http://127.0.0.1:${api_port}/api/status" > /dev/null 2>&1; then
        log "  node ${RESTART_NODE} API back up after ${i}s"
        restart_ready_ts=$(date +%s)
        restart_ready_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        break
      fi
      sleep 1
    done
    if [ -z "$restart_ready_ts" ]; then
      fail "node ${RESTART_NODE} API did not recover after restart"
    fi
    printf '{"node":%d,"stopTs":%d,"stopIso":"%s","apiReadyTs":%d,"apiReadyIso":"%s","graceSec":45}\n' \
      "$RESTART_NODE" "$restart_stop_ts" "$restart_stop_iso" "$restart_ready_ts" "$restart_ready_iso" \
      > "$RESTART_WINDOW_FILE"
    restart_done=1
  fi

  # Status heartbeat every ~5min. R1 used a `cmd1 && cmd2 | cmd3 || echo 0`
  # one-liner inside `$(...)` which broke under load with bash's
  # operator precedence (the && binds before the |, and the || is then
  # in the wrong position). The script aborted at the END_TS boundary
  # with `=NNNN: command not found`. Replaced with a plain helper.
  elapsed=$((now - START_TS))
  if [ $((elapsed % 300)) -lt 30 ]; then
    pcount=$(safe_line_count "$PUBLISH_LOG")
    tcount=$(safe_line_count "$TIMESERIES")
    ecount=$(safe_line_count "$EVENTS_LOG")
    log "  heartbeat: elapsed=${elapsed}s, remaining=${remaining}s, publishes=${pcount}, snapshots=${tcount}, chain-events=${ecount}"
  fi
  sleep 30
done

# --- 10. Stop background jobs and snapshot final stake state ---------------

log "Soak window elapsed; stopping background jobs"
cleanup_bg
trap - EXIT

snapshot_stake_state "$STAKE_AFTER"
log "Stake snapshot AFTER soak written to $STAKE_AFTER"

# --- 11. Run assertions and write findings ---------------------------------

log "Running assertions and writing findings to $FINDINGS"

cd "$REPO_ROOT/packages/evm-module" && \
OUT_DIR="$OUT_DIR" \
TIMESERIES="$TIMESERIES" \
PUBLISH_LOG="$PUBLISH_LOG" \
EVENTS_LOG="$EVENTS_LOG" \
RESTART_WINDOW_FILE="$RESTART_WINDOW_FILE" \
STAKE_BEFORE="$STAKE_BEFORE" \
STAKE_AFTER="$STAKE_AFTER" \
DELEGATORS_FILE="$DELEGATORS_FILE" \
FINDINGS="$FINDINGS" \
ROUND="$ROUND" \
DURATION_SEC="$DURATION_SEC" \
NUM_CORES="$NUM_CORES" \
NUM_EDGE="$NUM_EDGE" \
node "$REPO_ROOT/scripts/devnet-soak-rs-summary.mjs"

EXIT_RC=$?
if [ $EXIT_RC -eq 0 ]; then
  log "=== Soak round $ROUND PASS — see $FINDINGS ==="
else
  log "=== Soak round $ROUND FAIL — see $FINDINGS ==="
fi
exit $EXIT_RC
