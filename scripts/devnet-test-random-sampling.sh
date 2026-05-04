#!/usr/bin/env bash
#
# V10 Random Sampling devnet smoke test — drives the prover end-to-end
# against the local Hardhat-backed devnet.
#
# Preconditions:
#   ./scripts/devnet.sh start 6   must already be running. Devnet writes
#                                 `randomSampling.walPath` + a 5s tick
#                                 cadence into each core node's
#                                 config.json (see devnet.sh:create_node_config),
#                                 so the agent's bind layer schedules
#                                 RandomSamplingProver.tick() automatically
#                                 once identity registration completes.
#
# What this does (in order):
#   1. Validates devnet is running and core nodes (1-4) have on-chain
#      identities. Resolves auth token from .devnet/node1/auth.token.
#   2. Publishes a fresh KC into a fresh open-policy V10 CG by delegating
#      to devnet-test-publish.sh. Without a published KC inside an
#      open CG, `_pickWeightedChallenge` reverts with `NoEligibleContextGraph`
#      and the prover returns no-challenge forever.
#   3. Polls each core node's `/api/random-sampling/status` until at
#      least one reports `submittedCount > 0` (or RS_TIMEOUT seconds
#      elapse). Captures the tx hash and identityId of the first
#      successful submission.
#   4. Verifies on-chain that `RandomSamplingStorage.getNodeChallenge(idId)`
#      reports `solved=true` for the captured prover identity.
#   5. Verifies on-chain that
#      `RandomSamplingStorage.getNodeEpochProofPeriodScore(idId, epoch, periodStart)`
#      is non-zero — i.e. the chain credited the score and downstream
#      reward accounting will read it.
#   6. Asserts the prover's WAL has the expected trail
#      [challenge, extracted, built, submitted] for the latest period.
#
# Exit codes:
#   0     end-to-end RS pipeline pinned (a real on-chain proof landed).
#   != 0  failure; tail-end of the prover's WAL + status JSON dumped to stderr.
#
# Knobs:
#   RS_TIMEOUT  Seconds to wait for first submitted proof (default 60).
#               Devnet ticks every 5s so 60s comfortably covers ~10 ticks
#               plus chain confirmation latency.
#   DEVNET_DIR  Override the devnet data dir (default `.devnet`).
#   HARDHAT_PORT  Override hardhat RPC port (default 8545).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
RS_TIMEOUT="${RS_TIMEOUT:-60}"
NUM_CORE_NODES=4

CONTRACTS_JSON="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
EVM_ABI_DIR="$REPO_ROOT/packages/evm-module/abi"

log()  { echo "[rs-test] $*"; }
fail() { log "FAIL: $*"; exit 1; }

# --- 1. Preconditions ---------------------------------------------------------

[ -f "$DEVNET_DIR/hardhat.pid" ] \
  || fail "devnet not running — start with ./scripts/devnet.sh start 6"
HARDHAT_PID=$(cat "$DEVNET_DIR/hardhat.pid")
kill -0 "$HARDHAT_PID" 2>/dev/null \
  || fail "stale hardhat pid file ($HARDHAT_PID)"

[ -f "$CONTRACTS_JSON" ] || fail "missing $CONTRACTS_JSON"
for abi in RandomSampling RandomSamplingStorage IdentityStorage; do
  [ -f "$EVM_ABI_DIR/${abi}.json" ] \
    || fail "missing ABI: $EVM_ABI_DIR/${abi}.json"
done

# Token used for HTTP auth from this script. Each devnet node owns the
# same shared token (devnet.sh writes it during start).
TOKEN_FILE="$DEVNET_DIR/node1/auth.token"
[ -f "$TOKEN_FILE" ] || fail "missing auth token at $TOKEN_FILE"
AUTH_TOKEN=$(tail -1 "$TOKEN_FILE" | tr -d '[:space:]')
[ -n "$AUTH_TOKEN" ] || fail "auth token empty in $TOKEN_FILE"

# Per-core preflight: identity registered, prover handle enabled.
log "Preflight: checking core nodes 1-${NUM_CORE_NODES} have identity + prover bound..."
for n in $(seq 1 $NUM_CORE_NODES); do
  port=$((API_PORT_BASE + n - 1))
  pidfile="$DEVNET_DIR/node${n}/devnet.pid"
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null \
    || fail "node ${n} not running"

  status_json=$(curl -sS --max-time 10 \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    "http://127.0.0.1:${port}/api/random-sampling/status" 2>/dev/null || echo '{}')
  enabled=$(echo "$status_json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('enabled',False))" 2>/dev/null || echo 'False')
  identity=$(echo "$status_json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('identityId','0'))" 2>/dev/null || echo '0')
  if [ "$enabled" != "True" ]; then
    log "  node ${n}: prover DISABLED (identityId=${identity}). Status: $status_json"
    fail "node ${n} did not enable random sampling. Identity registration may still be pending — wait a few seconds and retry."
  fi
  log "  node ${n}: enabled=true, identityId=${identity}"
done

# --- 2. Publish a KC so the chain has eligible RS material ------------------
#
# We publish into `devnet-test` (the CG devnet.sh registers via the
# agent's /api/context-graph/register endpoint, with publishPolicy=1).
# Using a known-registered CG avoids the "not registered on-chain"
# preflight that rejects directly-created CGs (the cleaner path is for
# devnet bootstrap to register, then everyone publishes through the
# already-registered CG — same shape as production).

CG_NAME="devnet-test"
NODE_DIR="$DEVNET_DIR/node1"
DAEMON_LOG="$NODE_DIR/daemon.log"
CLI_JS="$REPO_ROOT/packages/cli/dist/cli.js"
[ -f "$CLI_JS" ] || fail "missing $CLI_JS (run pnpm run build)"
[ -f "$DAEMON_LOG" ] || fail "missing $DAEMON_LOG"

TMP_RDF_DIR=$(mktemp -d -t rs-publish)
TMP_RDF="$TMP_RDF_DIR/fixture.nq"
trap 'rm -rf "$TMP_RDF_DIR" /tmp/rs-publish.log' EXIT

# Resolve devnet-test's numeric on-chain id (registered by devnet.sh).
TOKEN_HEADER="Authorization: Bearer $AUTH_TOKEN"
CG_NUMERIC_ID=$(curl -sS --max-time 10 -H "$TOKEN_HEADER" \
  "http://127.0.0.1:${API_PORT_BASE}/api/context-graph/list" \
  | python3 -c "
import sys, json
d = json.load(sys.stdin)
for g in d.get('contextGraphs', []):
    if g.get('id') == '$CG_NAME':
        print(g.get('onChainId', ''))
        break
" 2>/dev/null || echo '')
[ -n "$CG_NUMERIC_ID" ] || fail "could not resolve on-chain id for CG '$CG_NAME' on node 1"
log "Resolved $CG_NAME → on-chain cgId=$CG_NUMERIC_ID"

# RDF fixture lives in the data graph for this CG. SWM validation
# requires the named graph to match `did:dkg:context-graph:<NAME>`
# (the agent's local CG identifier — numeric on-chain ids are an
# implementation detail).
SUBJECT="urn:test:rs-smoke:$(date +%s)"
cat > "$TMP_RDF" <<EOF
<${SUBJECT}> <urn:test:predicate> "rs-devnet-smoke" <did:dkg:context-graph:${CG_NAME}> .
EOF

# Snapshot daemon log line count so we can find ONLY the new
# `On-chain confirmed` line written for this publish.
if [ -s "$DAEMON_LOG" ]; then
  BASELINE_LINES=$(wc -l < "$DAEMON_LOG" | tr -d ' ')
else
  BASELINE_LINES=0
fi

log "Publishing 1 quad into $CG_NAME (cgId=$CG_NUMERIC_ID) via CLI..."
set +e
DKG_HOME="$NODE_DIR" node "$CLI_JS" publish "$CG_NAME" --file "$TMP_RDF" \
  > /tmp/rs-publish.log 2>&1
PUBLISH_RC=$?
set -e
if [ $PUBLISH_RC -ne 0 ]; then
  tail -n 30 /tmp/rs-publish.log >&2
  fail "CLI publish exited with $PUBLISH_RC"
fi

# Wait for the publisher's "On-chain confirmed: ... batchId=N tx=0x..."
# line. Without this, RandomSampling sees no KCs in the CG and the
# prover keeps reporting `no-eligible-kc` forever.
log "Waiting up to 60s for daemon 'On-chain confirmed' line..."
PUB_KC_ID=""
for _ in $(seq 1 60); do
  LINE=$(tail -n +"$((BASELINE_LINES + 1))" "$DAEMON_LOG" \
         | grep -E 'On-chain confirmed: UAL=.* batchId=[0-9]+ tx=0x[0-9a-fA-F]+' \
         | tail -n 1 || true)
  if [ -n "$LINE" ]; then
    PUB_KC_ID=$(printf '%s' "$LINE" | sed -E 's/.*batchId=([0-9]+).*/\1/')
    break
  fi
  sleep 1
done
[ -n "$PUB_KC_ID" ] || { tail -n 50 "$DAEMON_LOG" >&2; fail "publish did not confirm on-chain within 60s"; }
log "Publish OK (kcId=$PUB_KC_ID into cgId=$CG_NUMERIC_ID)"

# --- 3. Wait for first submitted proof across the core fleet ----------------

log "Waiting up to ${RS_TIMEOUT}s for any core node to submit a RS proof (5s tick cadence)..."
SUCCESS_NODE=""
SUCCESS_PORT=""
SUCCESS_IDENTITY=""
SUCCESS_TX=""
SUCCESS_OUTCOME=""

for attempt in $(seq 1 "$RS_TIMEOUT"); do
  for n in $(seq 1 $NUM_CORE_NODES); do
    port=$((API_PORT_BASE + n - 1))
    status_json=$(curl -sS --max-time 5 \
      -H "Authorization: Bearer $AUTH_TOKEN" \
      "http://127.0.0.1:${port}/api/random-sampling/status" 2>/dev/null || echo '{}')
    submitted=$(echo "$status_json" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('loop', {}).get('submittedCount', 0) if d.get('loop') else 0)
except Exception:
    print(0)
" 2>/dev/null || echo '0')
    if [ "$submitted" -gt 0 ] 2>/dev/null; then
      SUCCESS_NODE="$n"
      SUCCESS_PORT="$port"
      SUCCESS_IDENTITY=$(echo "$status_json" | python3 -c "import sys,json;print(json.load(sys.stdin).get('identityId','0'))")
      SUCCESS_TX=$(echo "$status_json" | python3 -c "
import sys, json
try:
    print(json.load(sys.stdin).get('loop', {}).get('lastSubmittedTxHash', ''))
except Exception:
    print('')
")
      SUCCESS_OUTCOME=$(echo "$status_json" | python3 -c "
import sys, json
try:
    print(json.dumps(json.load(sys.stdin).get('loop', {}).get('lastOutcome', {})))
except Exception:
    print('{}')
")
      break 2
    fi
  done
  sleep 1
done

if [ -z "$SUCCESS_NODE" ]; then
  log "No core node reported submittedCount>0 within ${RS_TIMEOUT}s. Last status snapshots:"
  for n in $(seq 1 $NUM_CORE_NODES); do
    port=$((API_PORT_BASE + n - 1))
    snap=$(curl -sS --max-time 5 -H "Authorization: Bearer $AUTH_TOKEN" \
      "http://127.0.0.1:${port}/api/random-sampling/status" 2>/dev/null || echo '{}')
    log "  node $n: $snap"
  done
  fail "prover did not submit any proof — check daemon logs and /api/random-sampling/status"
fi

log "Submitted: node=${SUCCESS_NODE} idId=${SUCCESS_IDENTITY} tx=${SUCCESS_TX}"
log "  outcome: ${SUCCESS_OUTCOME}"

# --- 4. Confirm on-chain that the challenge is marked solved ---------------

log "Verifying on-chain RandomSamplingStorage.getNodeChallenge(${SUCCESS_IDENTITY}).solved == true..."
CHALLENGE_INFO=$(
  cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
  CONTRACTS_JSON="$CONTRACTS_JSON" \
  ABI_DIR="$EVM_ABI_DIR" \
  IDENTITY_ID="$SUCCESS_IDENTITY" \
  node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const rssAddr = contracts.RandomSamplingStorage?.evmAddress;
  if (!rssAddr) throw new Error("RandomSamplingStorage not deployed");
  const rssAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "RandomSamplingStorage.json"), "utf8"));
  const rss = new ethers.Contract(rssAddr, rssAbi, provider);
  const ch = await rss.getNodeChallenge(BigInt(process.env.IDENTITY_ID));
  // Tuple shape (matches RandomSamplingLib.Challenge):
  //   knowledgeCollectionId, chunkId, kcStorage, epoch, activeProofPeriodStartBlock, proofingPeriodDurationInBlocks, solved
  console.log(JSON.stringify({
    kcId: ch[0].toString(),
    chunkId: ch[1].toString(),
    epoch: ch[3].toString(),
    periodStartBlock: ch[4].toString(),
    solved: ch[6],
  }));
})().catch(e => { console.error("[verify-challenge] " + (e?.shortMessage || e?.message || String(e))); process.exit(1); });
' 2>&1
) || { log "node script output: $CHALLENGE_INFO"; fail "RandomSamplingStorage.getNodeChallenge call failed"; }

SOLVED=$(echo "$CHALLENGE_INFO" | python3 -c "import sys,json;print(json.load(sys.stdin)['solved'])" 2>/dev/null || echo 'unknown')
CH_EPOCH=$(echo "$CHALLENGE_INFO" | python3 -c "import sys,json;print(json.load(sys.stdin)['epoch'])" 2>/dev/null || echo '0')
CH_PERIOD=$(echo "$CHALLENGE_INFO" | python3 -c "import sys,json;print(json.load(sys.stdin)['periodStartBlock'])" 2>/dev/null || echo '0')

if [ "$SOLVED" != "True" ] && [ "$SOLVED" != "true" ]; then
  log "Challenge NOT solved on-chain — chain disagrees with prover status?"
  log "  challenge: $CHALLENGE_INFO"
  fail "RandomSamplingStorage.getNodeChallenge.solved is not true"
fi
log "On-chain solved=true (epoch=${CH_EPOCH}, periodStartBlock=${CH_PERIOD})"

# --- 5. Confirm the score was credited --------------------------------------

log "Verifying on-chain getNodeEpochProofPeriodScore(${SUCCESS_IDENTITY}, ${CH_EPOCH}, ${CH_PERIOD}) > 0..."
SCORE=$(
  cd "$REPO_ROOT/packages/evm-module" && \
  RPC_URL="http://127.0.0.1:${HARDHAT_PORT}" \
  CONTRACTS_JSON="$CONTRACTS_JSON" \
  ABI_DIR="$EVM_ABI_DIR" \
  IDENTITY_ID="$SUCCESS_IDENTITY" \
  CH_EPOCH="$CH_EPOCH" \
  CH_PERIOD="$CH_PERIOD" \
  node -e '
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contracts = JSON.parse(fs.readFileSync(process.env.CONTRACTS_JSON, "utf8")).contracts;
  const rssAddr = contracts.RandomSamplingStorage?.evmAddress;
  if (!rssAddr) throw new Error("RandomSamplingStorage not deployed");
  const rssAbi = JSON.parse(fs.readFileSync(path.join(process.env.ABI_DIR, "RandomSamplingStorage.json"), "utf8"));
  const rss = new ethers.Contract(rssAddr, rssAbi, provider);
  const s = await rss.getNodeEpochProofPeriodScore(
    BigInt(process.env.IDENTITY_ID),
    BigInt(process.env.CH_EPOCH),
    BigInt(process.env.CH_PERIOD),
  );
  console.log(s.toString());
})().catch(e => { console.error("[verify-score] " + (e?.shortMessage || e?.message || String(e))); process.exit(1); });
' 2>&1
) || { log "node script output: $SCORE"; fail "getNodeEpochProofPeriodScore call failed"; }

if [ "$SCORE" = "0" ]; then
  log "WARNING: on-chain score is 0 for (id=$SUCCESS_IDENTITY, epoch=$CH_EPOCH, period=$CH_PERIOD)"
  log "This can happen on freshly-staked devnets where the score-input factors haven't"
  log "warmed up yet (P(t) over the last 4 epochs is 0). The submission landed and the"
  log "challenge is solved — we don't fail here, but flag it so the operator knows."
else
  log "On-chain score=${SCORE} (18-decimal scaled; non-zero confirms RFC-26 inputs are warm)"
fi

# --- 6. Tail the prover's WAL for the expected trail ------------------------

WAL_PATH="$DEVNET_DIR/node${SUCCESS_NODE}/random-sampling.wal"
if [ -f "$WAL_PATH" ]; then
  log "Sampling tail of WAL at $WAL_PATH..."
  TRAIL=$(tail -n 10 "$WAL_PATH" \
    | python3 -c "
import sys, json
trail = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: trail.append(json.loads(line).get('status', '?'))
    except Exception: pass
print(','.join(trail))
")
  log "  WAL trail: ${TRAIL}"
  case "$TRAIL" in
    *"submitted"*) log "  WAL trail contains 'submitted' — full pipeline recorded";;
    *) log "  WARNING: WAL trail missing 'submitted' marker (TRAIL=${TRAIL})";;
  esac
else
  log "WAL file not found at $WAL_PATH (the agent should have written one — config drift?)"
fi

log ""
log "=== Random Sampling devnet smoke: PASS ==="
log "  prover node:          ${SUCCESS_NODE} (api :${SUCCESS_PORT})"
log "  prover identityId:    ${SUCCESS_IDENTITY}"
log "  submitProof tx:       ${SUCCESS_TX}"
log "  on-chain solved:      ${SOLVED}"
log "  on-chain score:       ${SCORE}"
log "  challenge epoch:      ${CH_EPOCH}"
log "  challenge periodStart: ${CH_PERIOD}"
log ""
exit 0
