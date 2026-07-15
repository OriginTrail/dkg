#!/usr/bin/env bash
#
# Local DKG Devnet — spins up a Hardhat chain + N DKG nodes for local testing.
#
# Usage:
#   ./scripts/devnet.sh start [N]      Start devnet with N nodes (default 6)
#   ./scripts/devnet.sh stop            Stop all devnet processes (incl. UI)
#   ./scripts/devnet.sh stop-node <N>   Stop one devnet node and its managed store
#   ./scripts/devnet.sh status          Show running devnet processes (incl. UI)
#   ./scripts/devnet.sh logs [N]        Tail logs for node N (1-based)
#   ./scripts/devnet.sh clean           Stop and wipe all devnet data
#   ./scripts/devnet.sh ui {start|stop|restart|status|logs}
#                                       Control the node-ui Vite dev server
#                                       (detached from any TTY via nohup so it
#                                       survives shell restarts; this is the
#                                       fix for "Vite dies whenever the Cursor
#                                       agent terminal recycles" SIGHUP issue.)
#
# Environment:
#   DEVNET_DIR    Base directory for devnet data (default: .devnet)
#   HARDHAT_PORT  Hardhat node port (default: 8545)
#   DEVNET_BLAZEGRAPH_PORT
#                 Host port for the devnet Blazegraph container (default: 9999)
#   DEVNET_OXIGRAPH_SERVER_PORT_5 / DEVNET_OXIGRAPH_SERVER_PORT_6
#                 Host ports for edge-node Oxigraph containers (defaults: 7878/7879)
#   DEVNET_DOCKER_NAME_PREFIX
#                 Prefix for devnet store container names (default: devnet)
#   UI_PORT       node-ui Vite port (default: 5173)
#   UI_NODE_ID    Which devnet node the UI talks to (default: 1)
#   NUM_CORE_NODES
#                 How many of the first N nodes are core; the rest are edge
#                 (default: 4). Useful for 3-core/2-edge etc. layouts.
#   DEVNET_ENABLE_PUBLISHER=1
#                 Enable the async publisher runtime on each node
#   DEVNET_EPCIS_CONTEXT_GRAPH
#                 Context graph used by /api/epcis/capture when publisher is enabled
#   DEVNET_SWM_SYNC_ON_CONNECT=0
#                 Skip peer-connect SWM catch-up, useful for bulk SWM benchmarks
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
NUM_NODES="${2:-6}"
NUM_CORE_NODES="${NUM_CORE_NODES:-4}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
LIBP2P_PORT_BASE="${LIBP2P_PORT_BASE:-10001}"
UI_PORT="${UI_PORT:-5173}"
UI_NODE_ID="${UI_NODE_ID:-1}"
UI_PIDFILE="$DEVNET_DIR/node-ui.pid"
UI_LOGFILE="$DEVNET_DIR/node-ui.log"
# Devnet-only Hardhat config (solc 0.8.24 + cancun; the full WHY lives in the
# config file itself). The `hardhat node` and `hardhat deploy` commands MUST
# stay on the same config -- a split would compile with one solc but execute on
# another hardfork -- so the path is defined ONCE here and reused by both.
HARDHAT_CONFIG="hardhat.devnet.config.ts"
NUM_OP_WALLETS=3
# Hardhat block interval (ms). Without interval mining, Hardhat only mines
# when a tx arrives → block.number / block.timestamp freeze the moment the
# cluster goes idle, which means time-based on-chain mechanics (RS proof
# periods, epochs, stake withdrawal delay, ask update delay, …) NEVER tick
# forward unless somebody is actively publishing. That makes "wait and
# observe" workflows (RS reconciliation, epoch boundary reward distribution,
# operator-fee update unlocks) impossible to test without manual `hardhat_mine`
# RPC calls, and silently masks bugs that only surface across time.
#
# 1 sec/block is an aggressive testnet rate (12× faster than Ethereum
# mainnet's 12s), chosen because the devnet's RS `proofingPeriodDurationInBlocks`
# is 100 (see evm-module/deployments/parameters.json → development.hardhat) →
# new RS period every ~100 sec, fast enough for interactive testing without
# overwhelming the prover loop. Set to 0 to disable (fall back to per-tx
# mining) for tests that need deterministic block-per-tx semantics.
HARDHAT_BLOCK_INTERVAL_MS="${HARDHAT_BLOCK_INTERVAL_MS:-1000}"
DEVNET_DOCKER_NAME_PREFIX="${DEVNET_DOCKER_NAME_PREFIX:-devnet}"
BLAZEGRAPH_PORT="${DEVNET_BLAZEGRAPH_PORT:-9999}"
BLAZEGRAPH_CONTAINER="${DEVNET_DOCKER_NAME_PREFIX}-blazegraph"
# Webapp context path: the 2.1.5 Docker image serves under /bigdata; a native
# 2.1.6 JAR (the Apple-silicon workaround) serves under /blazegraph. Override with
# DEVNET_BLAZEGRAPH_CTX to match whichever Blazegraph is actually running.
BLAZEGRAPH_CTX="${DEVNET_BLAZEGRAPH_CTX:-bigdata}"
OXIGRAPH_SERVER_PORT_5="${DEVNET_OXIGRAPH_SERVER_PORT_5:-7878}"
OXIGRAPH_SERVER_PORT_6="${DEVNET_OXIGRAPH_SERVER_PORT_6:-7879}"
OXIGRAPH_CONTAINER_5="${DEVNET_DOCKER_NAME_PREFIX}-oxigraph-5"
OXIGRAPH_CONTAINER_6="${DEVNET_DOCKER_NAME_PREFIX}-oxigraph-6"

# Hardhat default accounts (first 10 of the well-known mnemonic)
# "test test test test test test test test test test test junk"
HARDHAT_KEYS=(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"
  "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
)

log() {
  echo "[devnet] $*"
}

# Check whether Docker is responsive within `timeout_s` seconds. We use
# a background-process pattern instead of relying on `timeout(1)` since
# macOS doesn't ship it without coreutils. A wedged Docker daemon would
# otherwise hang the whole devnet start at `docker info` indefinitely
# (observed on this machine — `start_blazegraph` waited >5min before we
# noticed). 0 → Docker reachable; non-zero → not reachable / wedged.
docker_responsive() {
  local timeout_s=${1:-3}
  ( docker info >/dev/null 2>&1 ) &
  local probe_pid=$!
  local waited=0
  while kill -0 "$probe_pid" 2>/dev/null; do
    if [ "$waited" -ge "$timeout_s" ]; then
      kill -9 "$probe_pid" 2>/dev/null || true
      wait "$probe_pid" 2>/dev/null || true
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$probe_pid" 2>/dev/null
  return $?
}

fund_wallet() {
  local address=$1
  local amount="0x56BC75E2D63100000"  # 100 ETH in hex wei
  curl -s -X POST "http://127.0.0.1:$HARDHAT_PORT" \
    -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"hardhat_setBalance\",\"params\":[\"$address\",\"$amount\"],\"id\":1}" > /dev/null
}

ensure_built() {
  if [ ! -f "$REPO_ROOT/packages/cli/dist/cli.js" ]; then
    log "Building project..."
    cd "$REPO_ROOT" && pnpm run build
  fi
}

find_hardhat_pid_by_port() {
  command -v lsof >/dev/null 2>&1 || return 1

  local raw_pids pid cmdline
  raw_pids=$(lsof -nP -iTCP:"$HARDHAT_PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true)
  for pid in $raw_pids; do
    cmdline=$(ps -p "$pid" -o command= 2>/dev/null || true)
    case "$cmdline" in
      *"$REPO_ROOT"*hardhat*"node --port $HARDHAT_PORT"*)
        echo "$pid"
        return 0
        ;;
    esac
  done
  return 1
}

refresh_hardhat_pidfile() {
  local pidfile="$DEVNET_DIR/hardhat.pid"
  local pid

  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi

  pid=$(find_hardhat_pid_by_port || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    mkdir -p "$DEVNET_DIR"
    echo "$pid" > "$pidfile"
    echo "$pid"
    return 0
  fi

  rm -f "$pidfile"
  return 1
}

start_hardhat() {
  local pidfile="$DEVNET_DIR/hardhat.pid"
  local existing_pid

  existing_pid=$(refresh_hardhat_pidfile || true)
  if [ -n "$existing_pid" ]; then
    log "Hardhat node already running (PID $existing_pid)"
    return 0
  fi

  log "Starting Hardhat node on port $HARDHAT_PORT..."
  mkdir -p "$DEVNET_DIR/hardhat"

  cd "$REPO_ROOT/packages/evm-module"

  # Remove stale deployment artifacts + marker so the fresh chain starts clean
  rm -f "$REPO_ROOT/packages/evm-module/deployments/hardhat_contracts.json"
  rm -f "$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
  rm -f "$DEVNET_DIR/hardhat/deployed"

  # Focused smoke check for the devnet config itself: compile with it DIRECTLY
  # before booting anything. A typo in the config, a base-config shape drift
  # (the config asserts its single-compiler expectation and throws), or a
  # solc-0.8.24/cancun regression fails right here with the compiler's own
  # message -- instead of surfacing minutes later as an opaque UI-e2e boot
  # failure. Hardhat caches compilation, so re-runs cost ~a second.
  log "Validating devnet Hardhat config (compile smoke check)..."
  if ! npx hardhat compile --config "$HARDHAT_CONFIG" > "$DEVNET_DIR/hardhat/compile.log" 2>&1; then
    log "ERROR: devnet Hardhat config failed to compile -- see $DEVNET_DIR/hardhat/compile.log"
    tail -20 "$DEVNET_DIR/hardhat/compile.log" >&2
    exit 1
  fi

  # --config "$HARDHAT_CONFIG" (defined up top): devnet-only solc 0.8.24 + cancun.
  # The full rationale lives in packages/evm-module/hardhat.devnet.config.ts.
  local hardhat_cli
  hardhat_cli=$(node -e "console.log(require.resolve('hardhat/internal/cli/bootstrap'))")
  local hh_pid
  hh_pid=$(HARDHAT_CLI="$hardhat_cli" \
    HARDHAT_LOG="$DEVNET_DIR/hardhat/node.log" \
    HARDHAT_PORT="$HARDHAT_PORT" \
    HARDHAT_CONFIG="$HARDHAT_CONFIG" \
    EVM_MODULE_DIR="$REPO_ROOT/packages/evm-module" \
    node -e '
      const fs = require("fs");
      const { spawn } = require("child_process");
      const out = fs.openSync(process.env.HARDHAT_LOG, "w");
      const child = spawn(
        process.execPath,
        [
          "--max-old-space-size=2048",
          process.env.HARDHAT_CLI,
          "node",
          "--port",
          process.env.HARDHAT_PORT,
          "--no-deploy",
          "--config",
          process.env.HARDHAT_CONFIG,
        ],
        {
          cwd: process.env.EVM_MODULE_DIR,
          detached: true,
          stdio: ["ignore", out, out],
          env: process.env,
        },
      );
      child.unref();
      if (!child.pid) process.exit(1);
      console.log(child.pid);
    ')
  echo "$hh_pid" > "$pidfile"
  log "Hardhat node started (PID $hh_pid)"

  # Wait for it to be ready
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$HARDHAT_PORT" \
         -X POST -H "Content-Type: application/json" \
         -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
         > /dev/null 2>&1; then
      log "Hardhat node ready"
      enable_hardhat_interval_mining
      return 0
    fi
    sleep 1
  done

  log "ERROR: Hardhat node failed to start within 30s"
  return 1
}

# Switch the running Hardhat node from "mine on tx" into "mine on a wallclock
# interval" mode. Idempotent and best-effort: failures are logged but never
# block the rest of the devnet boot (the cluster is still functional in
# auto-mine-only mode, just without time progression in idle windows).
#
# See HARDHAT_BLOCK_INTERVAL_MS at the top of this file for the rationale and
# the knob to disable it.
enable_hardhat_interval_mining() {
  if [ "$HARDHAT_BLOCK_INTERVAL_MS" -le 0 ] 2>/dev/null; then
    log "Hardhat interval mining disabled (HARDHAT_BLOCK_INTERVAL_MS=$HARDHAT_BLOCK_INTERVAL_MS)"
    return 0
  fi

  local response
  response=$(curl -s "http://127.0.0.1:$HARDHAT_PORT" \
    -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"evm_setIntervalMining\",\"params\":[$HARDHAT_BLOCK_INTERVAL_MS],\"id\":1}" 2>&1)
  if echo "$response" | grep -q '"result"'; then
    log "Hardhat interval mining enabled (one block every ${HARDHAT_BLOCK_INTERVAL_MS}ms)"
  else
    log "WARNING: Failed to enable Hardhat interval mining: $response"
  fi
}

deploy_contracts() {
  local marker="$DEVNET_DIR/hardhat/deployed"

  if [ -f "$marker" ]; then
    log "Contracts already deployed"
    return 0
  fi

  log "Deploying contracts to local Hardhat node..."
  cd "$REPO_ROOT/packages/evm-module"
  RPC_LOCALHOST="http://127.0.0.1:$HARDHAT_PORT" \
    npx hardhat deploy --network localhost --config "$HARDHAT_CONFIG" \
    > "$DEVNET_DIR/hardhat/deploy.log" 2>&1

  # Extract Hub address from deployment log
  local hub_addr
  hub_addr=$(grep 'deploying "Hub"' "$DEVNET_DIR/hardhat/deploy.log" 2>/dev/null \
    | grep -o 'deployed at 0x[a-fA-F0-9]*' | grep -o '0x[a-fA-F0-9]*' || echo "")

  if [ -z "$hub_addr" ]; then
    # Fallback: try the localhost_contracts.json written by the deploy
    hub_addr=$(node -e "
      try{const d=JSON.parse(require('fs').readFileSync('$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json','utf8'));
      console.log(d.contracts.Hub?.evmAddress||'')}catch{console.log('')}
    " 2>/dev/null || echo "")
  fi

  if [ -z "$hub_addr" ]; then
    log "WARNING: Could not extract Hub address. Check $DEVNET_DIR/hardhat/deploy.log"
    hub_addr="0x0000000000000000000000000000000000000000"
  fi

  echo "$hub_addr" > "$DEVNET_DIR/hardhat/hub_address"

  # Pin minimumRequiredSignatures to 3 — the protocol default / production value.
  # ─────────────────────────────────────────────────────────────────────────
  # NEVER lower this (e.g. to 1). The devnet MUST exercise the real 3-of-N
  # StorageACK quorum so publish/consensus behaviour matches mainnet. A lower
  # value silently hides quorum bugs and produces false "publishing works"
  # signals. A publisher collects StorageACKs from its PEERS only (it does NOT
  # sign its own quorum), so a VM publish needs `minimumRequiredSignatures`
  # OTHER reachable core nodes — i.e. >= minSig + 1 core nodes total (>= 4 for
  # minSig=3). Verified empirically: with only 3 core nodes a publish aborts
  # with "need 3 ACKs but only 2 core peers connected — quorum impossible".
  # DO NOT CHANGE THIS VALUE. ── important ──
  local ps_addr
  ps_addr=$(node -e "
    try{const d=JSON.parse(require('fs').readFileSync('$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json','utf8'));
    console.log(d.contracts.ParametersStorage?.evmAddress||'')}catch{console.log('')}
  " 2>/dev/null || echo "")

  if [ -n "$ps_addr" ]; then
    node -e "
      const { ethers } = require('ethers');
      (async () => {
        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:$HARDHAT_PORT');
        const signer = await provider.getSigner(0);
        const ps = new ethers.Contract('$ps_addr', ['function setMinimumRequiredSignatures(uint256)'], signer);
        // DO NOT CHANGE: must stay 3 (real 3-of-N quorum, matches mainnet).
        await (await ps.setMinimumRequiredSignatures(3)).wait();
        console.log('minimumRequiredSignatures set to 3');
      })();
    " 2>&1 | while read -r line; do log "$line"; done
  fi

  touch "$marker"
  log "Contracts deployed. Hub address: $hub_addr"
}

BLAZEGRAPH_AVAILABLE=false

read_blazegraph_metadata() {
  node "$REPO_ROOT/packages/cli/blazegraph-image-metadata.cjs" \
    "$REPO_ROOT/blazegraph-image.json"
}

start_blazegraph() {
  # Use an EXTERNAL Blazegraph already serving on the port. Skips Docker entirely;
  # namespaces are the operator's job here.
  if curl -sf --max-time 4 "http://127.0.0.1:${BLAZEGRAPH_PORT}/${BLAZEGRAPH_CTX}/status" >/dev/null 2>&1; then
    log "Blazegraph already serving on :${BLAZEGRAPH_PORT}/${BLAZEGRAPH_CTX} (external) — using it (skip Docker)"
    BLAZEGRAPH_AVAILABLE=true
    return 0
  fi
  if ! docker_responsive 3; then
    log "Docker not responsive within 3s — nodes 3-4 will use Oxigraph instead of Blazegraph"
    return 0
  fi

  if docker inspect "$BLAZEGRAPH_CONTAINER" > /dev/null 2>&1; then
    if docker inspect -f '{{.State.Running}}' "$BLAZEGRAPH_CONTAINER" 2>/dev/null | grep -q true; then
      log "Blazegraph already running ($BLAZEGRAPH_CONTAINER)"
      BLAZEGRAPH_AVAILABLE=true
      return 0
    fi
    docker rm -f "$BLAZEGRAPH_CONTAINER" > /dev/null 2>&1 || true
  fi

  local blazegraph_metadata blazegraph_image blazegraph_container_port
  if ! blazegraph_metadata="$(read_blazegraph_metadata)"; then
    log "ERROR: Could not read the pinned Blazegraph image metadata"
    return 1
  fi
  IFS=$'\t' read -r blazegraph_image blazegraph_container_port <<< "$blazegraph_metadata"

  log "Starting Blazegraph (Docker) on port $BLAZEGRAPH_PORT..."
  if ! docker run -d --name "$BLAZEGRAPH_CONTAINER" \
    -p "127.0.0.1:$BLAZEGRAPH_PORT:$blazegraph_container_port" \
    "$blazegraph_image" > /dev/null 2>&1; then
    log "WARNING: Failed to start Blazegraph container — nodes 3-4 will use Oxigraph"
    return 0
  fi

  # Wait for Blazegraph to be ready
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$BLAZEGRAPH_PORT/bigdata/status" > /dev/null 2>&1; then
      log "Blazegraph ready"
      BLAZEGRAPH_AVAILABLE=true
      # Create per-node namespaces for nodes 3–4 (Blazegraph)
      for n in 3 4; do
        local ns="node${n}"
        curl -s -X POST "http://127.0.0.1:$BLAZEGRAPH_PORT/bigdata/namespace" \
          -H "Content-Type: application/xml" \
          -d "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"no\"?>
<!DOCTYPE properties SYSTEM \"http://java.sun.com/dtd/properties.dtd\">
<properties>
  <entry key=\"com.bigdata.rdf.sail.namespace\">$ns</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.quads\">true</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.statementIdentifiers\">false</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.textIndex\">false</entry>
  <entry key=\"com.bigdata.rdf.sail.truthMaintenance\">false</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.axiomsClass\">com.bigdata.rdf.axioms.NoAxioms</entry>
</properties>" > /dev/null 2>&1
        log "Created Blazegraph namespace: $ns"
      done
      return 0
    fi
    sleep 1
  done

  log "WARNING: Blazegraph failed to start within 30s — nodes 3-4 will use Oxigraph"
}

OXIGRAPH_SERVER_AVAILABLE=false

start_oxigraph_servers() {
  if [ "$NUM_NODES" -lt 5 ]; then
    return 0
  fi
  if ! docker_responsive 3; then
    log "Docker not responsive within 3s — nodes 5-6 will use Oxigraph (in-process) instead of Oxigraph server"
    return 0
  fi
  if ! docker image inspect oxigraph/oxigraph:latest > /dev/null 2>&1; then
    log "Oxigraph Docker image not found locally — nodes 5-6 will use in-process Oxigraph (pull oxigraph/oxigraph:latest to enable)"
    return 0
  fi

  for name_port in "$OXIGRAPH_CONTAINER_5:$OXIGRAPH_SERVER_PORT_5" "$OXIGRAPH_CONTAINER_6:$OXIGRAPH_SERVER_PORT_6"; do
    local name="${name_port%%:*}"
    local port="${name_port#*:}"
    if docker inspect "$name" > /dev/null 2>&1; then
      if docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -q true; then
        log "Oxigraph server already running ($name, port $port)"
        continue
      fi
      docker rm -f "$name" > /dev/null 2>&1 || true
    fi
    log "Starting Oxigraph server (Docker) $name on port $port..."
    if docker run -d --name "$name" \
      -p "${port}:7878" \
      oxigraph/oxigraph:latest serve --bind 0.0.0.0:7878 > /dev/null 2>&1; then
      log "Oxigraph server started ($name)"
    else
      log "WARNING: Failed to start Oxigraph server $name — nodes 5-6 will use in-process Oxigraph"
      return 0
    fi
  done

  # Wait for both to be ready
  for port in $OXIGRAPH_SERVER_PORT_5 $OXIGRAPH_SERVER_PORT_6; do
    for i in $(seq 1 15); do
      if curl -s -X POST "http://127.0.0.1:${port}/query" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "query=SELECT%20*%20WHERE%20%7B%20%3Fs%20%3Fp%20%3Fo%20%7D%20LIMIT%201" > /dev/null 2>&1; then
        break
      fi
      [ "$i" -eq 15 ] && log "WARNING: Oxigraph server on port $port not ready within 15s"
      sleep 1
    done
  done
  OXIGRAPH_SERVER_AVAILABLE=true
  log "Oxigraph servers ready (ports $OXIGRAPH_SERVER_PORT_5, $OXIGRAPH_SERVER_PORT_6)"
}

stop_oxigraph_servers() {
  # Local daemon-managed oxigraph-server binaries (the `oxigraph-server` backend,
  # nodes 1-N) are spawned as node children; a SIGKILL'd node can ORPHAN them,
  # leaving the :79xx port bound so the NEXT `start` dies with "Address already
  # in use" and those nodes silently fail to boot. Sweep any belonging to THIS
  # devnet (path-scoped — unrelated oxigraph processes are untouched). Runs
  # regardless of docker availability (the local binaries are not docker).
  #
  # DEVNET_DIR is user-configurable and may contain regex/glob metacharacters, so
  # we do NOT feed it to `pkill -f` as a raw regex (where `.`/`[`/`+`/spaces would
  # change the match and could over-match). Instead match the dir as a LITERAL
  # substring of each process's command line via a quoted `case` glob.
  ps axww -o pid=,command= 2>/dev/null | while read -r _pid _cmd; do
    case "$_cmd" in
      *"$DEVNET_DIR/node"*"oxigraph/oxigraph"*) kill "$_pid" 2>/dev/null || true ;;
    esac
  done
  if ! docker_responsive 3; then return 0; fi
  for name in $OXIGRAPH_CONTAINER_5 $OXIGRAPH_CONTAINER_6; do
    if docker inspect "$name" > /dev/null 2>&1; then
      docker rm -f "$name" > /dev/null 2>&1 || true
      log "Stopped Oxigraph server ($name)"
    fi
  done
}

stop_blazegraph() {
  if ! docker_responsive 3; then return 0; fi
  if docker inspect "$BLAZEGRAPH_CONTAINER" > /dev/null 2>&1; then
    docker rm -f "$BLAZEGRAPH_CONTAINER" > /dev/null 2>&1 || true
    log "Stopped Blazegraph container"
  fi
}

create_node_config() {
  local node_num="$1"
  local node_dir="$DEVNET_DIR/node${node_num}"
  mkdir -p "$node_dir"

  local api_port=$((API_PORT_BASE + node_num - 1))
  local libp2p_port=$((LIBP2P_PORT_BASE + node_num - 1))
  local key_idx=$((node_num - 1))
  local node_role="edge"
  local hub_addr
  hub_addr=$(cat "$DEVNET_DIR/hardhat/hub_address" 2>/dev/null || echo "")

  # First `NUM_CORE_NODES` nodes are core (V10 ACK quorum needs at least
  # `minimumRequiredSignatures` sharding-table members reachable from the
  # publisher). Remaining nodes are edge for heterogeneous testing.
  if [ "$node_num" -le "$NUM_CORE_NODES" ]; then
    node_role="core"
  fi
  # `cmd_addnode` overrides the default role/index mapping so we can spawn a
  # mid-run 7th core (or 8th edge) without the test caring about the indexing
  # convention used at fresh-boot time.
  if [ -n "${DEVNET_NODE_ROLE_OVERRIDE:-}" ]; then
    node_role="$DEVNET_NODE_ROLE_OVERRIDE"
  fi

  # All devnet nodes start with relay="none" to prevent falling back to testnet
  # relays from network/testnet.json. Nodes 2+ get their relay overridden in
  # start_node() to point at node 1's local multiaddr.
  local relay_value='"relay": "none",'

  # Backend assignment (production parity + hermetic — no Docker required for the
  # primary coverage):
  #   Node 1-2: oxigraph-server  (DAEMON-MANAGED local server — the actual
  #             fresh-install production default since rc.12. The daemon
  #             auto-downloads + SHA-256-verifies + caches the Oxigraph binary
  #             and spawns it on its own port — NO Docker. Node 1 is the node the
  #             UI/e2e suite drives, so the suite now exercises the REAL default
  #             backend and deterministically reproduces SPARQL-over-HTTP-only
  #             bugs such as #996 — which the old `oxigraph-worker` default hid.)
  #   Node 3-4: blazegraph (if Docker) else oxigraph  (in-process baseline)
  #   Node 5-6: sparql-http → external Dockerized Oxigraph  (EXTRA coverage of the
  #             generic external-endpoint path; Docker-only, optional)
  local store_block=""
  if [ "$node_num" -ge 1 ] && [ "$node_num" -le 2 ]; then
    # The managed oxigraph-server defaults to port 7878; multiple nodes on one
    # host must pin DISTINCT ports or the second collides ("Address already in
    # use"). Give each node its own (7900 + node_num), clear of the Dockerized
    # external Oxigraph on 7878/7879 (nodes 5-6) and a real node's 7878.
    store_block="\"store\": { \"backend\": \"oxigraph-server\", \"options\": { \"port\": $(( ${DEVNET_OXIGRAPH_BASE:-7900} + node_num )) } },"
  elif [ "$node_num" -ge 3 ] && [ "$node_num" -le 4 ]; then
    # DEVNET_BLAZEGRAPH_NS overrides the per-node namespace with a single shared one
    # (e.g. the built-in "kb") — used when Blazegraph runs as a native arm64 JAR and
    # offline namespace-creation is unavailable. To avoid two nodes colliding on one
    # namespace, only node 3 goes to Blazegraph in that mode; node 4 stays oxigraph.
    if [ "$BLAZEGRAPH_AVAILABLE" = true ] && { [ -z "${DEVNET_BLAZEGRAPH_NS:-}" ] || [ "$node_num" -eq 3 ]; }; then
      local bz_ns="${DEVNET_BLAZEGRAPH_NS:-node${node_num}}"
      store_block="\"store\": { \"backend\": \"blazegraph\", \"options\": { \"url\": \"http://127.0.0.1:${BLAZEGRAPH_PORT}/${BLAZEGRAPH_CTX}/namespace/${bz_ns}/sparql\" } },"
    else
      store_block="\"store\": { \"backend\": \"oxigraph\" },"
    fi
  elif [ "$node_num" -ge 5 ] && [ "$node_num" -le 6 ]; then
    if [ "$OXIGRAPH_SERVER_AVAILABLE" = true ]; then
      local ox_port_var="OXIGRAPH_SERVER_PORT_${node_num}"
      local ox_port="${!ox_port_var}"
      store_block="\"store\": { \"backend\": \"sparql-http\", \"options\": { \"queryEndpoint\": \"http://127.0.0.1:${ox_port}/query\", \"updateEndpoint\": \"http://127.0.0.1:${ox_port}/update\" } },"
    fi
  fi

  # Opt-in auth disable: set DEVNET_NO_AUTH=1 for frictionless local testing
  local devnet_auth_block=""
  if [ "${DEVNET_NO_AUTH:-}" = "1" ]; then
    devnet_auth_block='"auth": { "enabled": false },'
  fi
  local publisher_block=""
  local epcis_block=""
  if [ "${DEVNET_ENABLE_PUBLISHER:-}" = "1" ]; then
    publisher_block='"publisher": { "enabled": true, "pollIntervalMs": 500, "errorBackoffMs": 500, "maxRetries": 10 },'
    epcis_block="\"epcis\": { \"contextGraphId\": \"${DEVNET_EPCIS_CONTEXT_GRAPH:-devnet-test}\" },"
  fi
  local swm_sync_block=""
  case "${DEVNET_SWM_SYNC_ON_CONNECT:-1}" in
    0|false|FALSE|no|NO)
      swm_sync_block='"syncSharedMemoryOnConnect": false,'
      ;;
  esac

  # Random Sampling prover (core-only). For devnet we want a
  # persistent WAL (so `dkg rs wal-tail` / smoke tests can read the
  # trail) and a fast tick (5s) so the e2e test sees a submitted
  # proof within a few seconds of publishing instead of the 30s
  # production default. Edge nodes ignore this block — bindRandomSampling
  # short-circuits on role !== 'core' before reading any of these.
  local rs_block=""
  if [ "$node_role" = "core" ]; then
    rs_block="\"randomSampling\": { \"walPath\": \"${node_dir}/random-sampling.wal\", \"tickIntervalMs\": 5000 },"
  fi

  cat > "$node_dir/config.json" <<EOCONF
{
  "name": "devnet-node-${node_num}",
  "apiPort": ${api_port},
  "listenPort": ${libp2p_port},
  "nodeRole": "${node_role}",
  ${relay_value}
  ${store_block}
  "contextGraphs": ["devnet-test", "devnet-isolation"],
  "localBootstrapContextGraphs": ["devnet-test", "devnet-isolation"],
  ${swm_sync_block}
  "publisher": {
    "enabled": true,
    "pollIntervalMs": 12000,
    "errorBackoffMs": 5000
  },
  ${devnet_auth_block}
  ${rs_block}
  ${publisher_block}
  ${epcis_block}
  "chain": {
    "type": "evm",
    "rpcUrl": "http://127.0.0.1:${HARDHAT_PORT}",
    "hubAddress": "${hub_addr}",
    "chainId": "evm:31337"
  }
}
EOCONF

  # Generate wallets.json in the post-PR-366 format:
  #   - adminWallet: primary Hardhat key (pre-funded; used to createProfile +
  #     register operational keys via Profile.addOperationalWallets)
  #   - wallets[]: NUM_OP_WALLETS random operational wallets for parallel EVM
  #     transaction submission (need explicit ETH+TRAC funding below)
  # The admin/operational separation is enforced on-chain since PR 366 — admin
  # key holds purpose=ADMIN_KEY, operational keys hold purpose=OPERATIONAL_KEY,
  # and the two sets MUST be disjoint addresses.
  # Run from a package that has 'ethers' so require() resolves (pnpm workspace).
  local extra_addrs
  extra_addrs=$(cd "$REPO_ROOT/packages/evm-module" && node -e "
    const crypto = require('crypto');
    const { ethers } = require('ethers');
    const fs = require('fs');
    const primary = new ethers.Wallet('${HARDHAT_KEYS[$key_idx]}');
    const adminWallet = { privateKey: '${HARDHAT_KEYS[$key_idx]}', address: primary.address };
    const wallets = [];
    for (let i = 0; i < ${NUM_OP_WALLETS}; i++) {
      const key = '0x' + crypto.randomBytes(32).toString('hex');
      const w = new ethers.Wallet(key);
      wallets.push({ privateKey: key, address: w.address });
    }
    fs.writeFileSync('$node_dir/wallets.json', JSON.stringify({ adminWallet, wallets }, null, 2));
    if (process.env.DEVNET_ENABLE_PUBLISHER === '1') {
      fs.writeFileSync('$node_dir/publisher-wallets.json', JSON.stringify({ wallets: wallets.slice(0, 1) }, null, 2));
    }
    wallets.forEach(w => console.log(w.address));
  ")

  # Fund each additional wallet with ETH (gas) and TRAC (publish payments).
  local token_addr
  token_addr=$(node -e "
    try{const d=JSON.parse(require('fs').readFileSync('$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json','utf8'));
    console.log(d.contracts.Token?.evmAddress||'')}catch{console.log('')}
  " 2>/dev/null || echo "")

  while IFS= read -r addr; do
    [ -n "$addr" ] || continue
    fund_wallet "$addr"
    # Mint 1M TRAC to operational wallet (deployer = Hardhat account 0 has mint rights)
    if [ -n "$token_addr" ]; then
      cd "$REPO_ROOT/packages/evm-module" && node -e "
        const { ethers } = require('ethers');
        (async () => {
          const p = new ethers.JsonRpcProvider('http://127.0.0.1:$HARDHAT_PORT');
          const deployer = await p.getSigner(0);
          const token = new ethers.Contract('$token_addr', ['function mint(address,uint256)'], deployer);
          await (await token.mint('$addr', ethers.parseEther('1000000'))).wait();
        })();
      " 2>/dev/null
    fi
  done <<< "$extra_addrs"

  log "Node $node_num config: port=$api_port, libp2p=$libp2p_port, role=$node_role, wallets=$((NUM_OP_WALLETS + 1))"
}

# ─────────────────────────────────────────────────────────────────────────────
# Multi-version support (mixed-version devnet).
#
# By default every node launches from the freshly-built repo ("current"). To run
# a MIXED-VERSION cluster — e.g. edges lagging the cores during a rollout — set
# DEVNET_VERSION_LAYOUT to a comma-separated list of SELECTOR:REF entries:
#
#   SELECTOR : all | cores | edges | <N> | <A-B>
#   REF      : current | prev | <git-ref, e.g. v10.0.3>
#
# Later entries win, so "edges one release behind the cores" is:
#
#   DEVNET_VERSION_LAYOUT="all:current,edges:prev"
#
# N-version ready — any number of refs can coexist in one cluster:
#
#   DEVNET_VERSION_LAYOUT="1-2:current,3-4:v10.0.3,5-6:v10.0.2"
#
# "prev" resolves to DEVNET_PREV_VERSION if set, else the latest release tag —
# i.e. the version immediately preceding the code under test on main. Non-current
# refs are checked out as git worktrees under DEVNET_VERSIONS_DIR and built once
# (cached across runs; DEVNET_VERSION_REBUILD=1 forces a rebuild).
# ─────────────────────────────────────────────────────────────────────────────
DEVNET_VERSION_LAYOUT="${DEVNET_VERSION_LAYOUT:-}"
DEVNET_VERSIONS_DIR="${DEVNET_VERSIONS_DIR:-$REPO_ROOT/.devnet-versions}"

# Latest release tag (vMAJOR.MINOR.PATCH) STRICTLY BELOW the current workspace
# version, or DEVNET_PREV_VERSION if set. 'prev' must never resolve to the
# CURRENT version: right after a release the newest tag equals the workspace
# version (v10.0.3 tag while package.json says 10.0.3), and a prev==current
# layout silently builds a single-version devnet whose mixed-version suite
# self-skips — a falsely green lane. Echoes nothing when no older tag exists
# (callers guard on empty and point at DEVNET_PREV_VERSION).
resolve_prev_version() {
  if [ -n "${DEVNET_PREV_VERSION:-}" ]; then
    echo "$DEVNET_PREV_VERSION"
    return 0
  fi
  local current tag bare
  current="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || true)"
  for tag in $(git -C "$REPO_ROOT" tag --sort=-v:refname 2>/dev/null | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' || true); do
    if [ -z "$current" ]; then
      # Workspace version unreadable — degrade to the newest tag (legacy behavior).
      echo "$tag"
      return 0
    fi
    bare="${tag#v}"
    if [ "$bare" = "$current" ]; then continue; fi
    if [ "$(printf '%s\n%s\n' "$bare" "$current" | sort -V | head -1)" = "$bare" ]; then
      echo "$tag" # newest-first scan → first tag strictly below current
      return 0
    fi
  done
  echo "[devnet] resolve_prev_version: no release tag strictly below current version ${current:-unknown}; set DEVNET_PREV_VERSION explicitly" >&2
  return 0
}

# Map a version REF to its cli.js entry point. current/empty -> the repo build.
version_cli_entry() {
  local ref="$1"
  if [ -z "$ref" ] || [ "$ref" = "current" ]; then
    echo "$REPO_ROOT/packages/cli/dist/cli.js"
    return 0
  fi
  if [ "$ref" = "prev" ]; then
    ref="$(resolve_prev_version)"
  fi
  echo "$DEVNET_VERSIONS_DIR/$ref/packages/cli/dist/cli.js"
}

# A node's authoritative role from its written config (default edge).
node_role_of() {
  local node_num="$1"
  node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).nodeRole||'edge')}catch(e){process.stdout.write('edge')}" \
    "$DEVNET_DIR/node${node_num}/config.json" 2>/dev/null || printf edge
}

# Resolve the version REF node <num> (role <role>) should run, per the layout.
# Later matching entries override earlier ones.
node_version_ref() {
  local node_num="$1" role="$2" ref="current"
  local oldifs="$IFS"
  IFS=','
  local entry
  for entry in $DEVNET_VERSION_LAYOUT; do
    if [ -z "$entry" ]; then continue; fi
    local sel="${entry%%:*}" r="${entry#*:}"
    case "$sel" in
      all)   ref="$r" ;;
      cores) if [ "$role" = "core" ]; then ref="$r"; fi ;;
      edges) if [ "$role" = "edge" ]; then ref="$r"; fi ;;
      *-*)   local lo="${sel%-*}" hi="${sel#*-}"
             if [ "$node_num" -ge "$lo" ] 2>/dev/null && [ "$node_num" -le "$hi" ] 2>/dev/null; then
               ref="$r"
             fi ;;
      *)     if [ "$node_num" = "$sel" ]; then ref="$r"; fi ;;
    esac
  done
  IFS="$oldifs"
  echo "$ref"
}

# The cli.js a given node should launch from.
node_cli_entry() {
  local node_num="$1"
  local role
  role="$(node_role_of "$node_num")"
  version_cli_entry "$(node_version_ref "$node_num" "$role")"
}

# Check out <ref> as a worktree under DEVNET_VERSIONS_DIR and build it once.
prepare_version() {
  local ref="$1"
  if [ "$ref" = "prev" ]; then ref="$(resolve_prev_version)"; fi
  if [ -z "$ref" ]; then
    echo "[devnet] prepare_version: no ref resolved (set DEVNET_PREV_VERSION, or ensure release tags exist)" >&2
    return 1
  fi
  local dest="$DEVNET_VERSIONS_DIR/$ref"
  if [ -f "$dest/packages/cli/dist/cli.js" ] && [ "${DEVNET_VERSION_REBUILD:-0}" != "1" ]; then
    log "Version '$ref' already prepared at $dest"
    return 0
  fi
  mkdir -p "$DEVNET_VERSIONS_DIR"
  if [ ! -e "$dest/package.json" ]; then
    log "Checking out version '$ref' as a worktree at $dest ..."
    git -C "$REPO_ROOT" worktree add --force "$dest" "$ref"
  fi
  log "Building version '$ref' (runs once, then cached) ..."
  ( cd "$dest" && pnpm install --prefer-offline && pnpm run build )
  log "Version '$ref' prepared at $dest"
}

# Build every distinct non-current ref referenced by the layout (idempotent).
prepare_layout_versions() {
  if [ -z "$DEVNET_VERSION_LAYOUT" ]; then return 0; fi
  local oldifs="$IFS"
  IFS=','
  local entry
  local built=""
  for entry in $DEVNET_VERSION_LAYOUT; do
    if [ -z "$entry" ]; then continue; fi
    local r="${entry#*:}"
    if [ "$r" = "current" ] || [ -z "$r" ]; then continue; fi
    if [ "$r" = "prev" ]; then r="$(resolve_prev_version)"; fi
    case " $built " in *" $r "*) continue ;; esac
    built="$built $r"
    IFS="$oldifs"
    prepare_version "$r"
    IFS=','
  done
  IFS="$oldifs"
}

cmd_prepare_version() {
  prepare_version "${2:-prev}"
}

start_node() {
  local node_num="$1"
  local node_dir="$DEVNET_DIR/node${node_num}"
  local pidfile="$node_dir/devnet.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "Node $node_num already running (PID $(cat "$pidfile"))"
    return 0
  fi

  local relay_arg=""
  if [ "$node_num" -gt 1 ] && [ -f "$DEVNET_DIR/node1/multiaddr" ]; then
    relay_arg=$(cat "$DEVNET_DIR/node1/multiaddr")
  fi

  # Core mesh (default topology): a CORE node directly dials every EARLIER core
  # via `bootstrapPeers`, instead of every node hubbing through node 1. libp2p
  # connections are bidirectional and `identify` exchanges listen addresses, so
  # "dial all earlier cores" yields an all-core direct mesh once the last core is
  # up. That keeps every core directly DIALABLE for SWM substrate fan-out (the
  # StorageACK responders), so VM-publish quorum is delivered reliably point-to-
  # point instead of riding best-effort gossip (which raced and dropped quorum on
  # the all-hub-through-node-1 topology). EDGE nodes dial ALL cores — a scalable
  # hub-and-spoke spoke (O(cores) connections per edge, never edge<->edge) — so
  # an edge can still publish and reach quorum; edges never mesh with each other.
  # Node 1 (first core) dials no one and meshes via inbound dials from the rest.
  DEVNET_DIR="$DEVNET_DIR" NODE_DIR="$node_dir" NODE_NUM="$node_num" \
  NUM_CORE_NODES="$NUM_CORE_NODES" RELAY_ARG="$relay_arg" node -e "
    const fs = require('fs');
    const dir = process.env.DEVNET_DIR;
    const cfgPath = process.env.NODE_DIR + '/config.json';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (process.env.RELAY_ARG) cfg.relay = process.env.RELAY_ARG;
    const n = Number(process.env.NODE_NUM);
    // Bootstrap targets are the CORE nodes among 1..n-1, read from each node's
    // authoritative nodeRole — NOT the ordinal 'first NUM_CORE_NODES are cores',
    // since cmd_addnode can spawn a core beyond NUM_CORE_NODES (via
    // DEVNET_NODE_ROLE_OVERRIDE). A core thus meshes with every earlier core; an
    // edge spokes to every earlier core. Connections are bidirectional, so a
    // later-added core dials the earlier cores and joins the mesh.
    const peers = [];
    for (let c = 1; c < n; c++) {
      let cRole = 'edge';
      try { cRole = JSON.parse(fs.readFileSync(dir + '/node' + c + '/config.json', 'utf8')).nodeRole || 'edge'; } catch {}
      if (cRole !== 'core') continue;
      try { const m = fs.readFileSync(dir + '/node' + c + '/multiaddr', 'utf8').trim(); if (m) peers.push(m); } catch {}
    }
    if (peers.length) cfg.bootstrapPeers = peers;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  "

  # Remove any stale daemon.pid so the CLI doesn't think it's already running
  rm -f "$node_dir/daemon.pid"

  log "Starting node $node_num..."
  # DKG_WALLETS_NO_MIGRATE=1: this harness writes a plaintext wallets.json with
  # RANDOM operational keys and the staking step (cmd_start) re-reads
  # wallets[0].privateKey directly, so the daemon must NOT migrate it to an
  # encrypted keystore (GH #11). Production daemons omit this and auto-migrate.
  # Redirect console output to console.log, NOT daemon.log: the daemon already
  # tees its full log stream into $DKG_HOME/daemon.log in-process (lifecycle.ts
  # stdout/stderr tee). Pointing the shell redirect at the SAME file wrote every
  # byte through two independent fds (one positional, one append), which left
  # byte-replayed duplicate tail segments in daemon.log — and doubled the
  # rpc_usage telemetry counts the rpc-quiet-window suite sums. console.log
  # still captures pre-tee output from an early crash.
  # Version-layout aware: `node_cli_entry` returns the repo build for `current`
  # nodes and a prepared alternate-version dist for mixed-version layouts.
  local cli_entry
  cli_entry="$(node_cli_entry "$node_num")"
  log "Node $node_num launching from $cli_entry"
  # Use the CLI's detached supervisor. `restart-node` is commonly called from
  # short-lived devnet test scripts; foreground mode leaves the worker in that
  # shell's process group and can make the daemon disappear after the helper
  # exits. Plain `start` returns after the daemon is ready and leaves a detached
  # supervisor behind. Store that supervisor pid in devnet.pid so stop/restart
  # still bounce the whole node process tree.
  if ! env DKG_HOME="$node_dir" DKG_NO_BLUE_GREEN=1 DKG_WALLETS_NO_MIGRATE=1 \
    node "$cli_entry" start \
    > "$node_dir/console.log" 2>&1 < /dev/null; then
    log "WARNING: Node $node_num start command returned non-zero (check $node_dir/console.log)"
  fi
  local node_pid
  node_pid=$(refresh_node_pidfile "$node_num" || true)

  # Wait for API to be ready — relay node (1) gets extra time since first boot
  # compiles Solidity contracts which is CPU-intensive.
  local api_port=$((API_PORT_BASE + node_num - 1))
  local auth_token=""
  local -a auth_args=()
  if [ -f "$DEVNET_DIR/node1/auth.token" ]; then
    auth_token=$(tail -1 "$DEVNET_DIR/node1/auth.token" 2>/dev/null || echo "")
    if [ -n "$auth_token" ]; then
      auth_args=(-H "Authorization: Bearer $auth_token")
    fi
  fi
  local max_wait=${DEVNET_NODE_READY_TIMEOUT:-30}
  [ "$node_num" -eq 1 ] && max_wait=$(( max_wait > 120 ? max_wait : 120 ))
  local ready=false
  # CRITICAL: declare loop variable `local` so we don't clobber the OUTER
  # caller's `i` (cmd_start's `for ((i = 2; i <= NUM_NODES; i++))` calls
  # start_node "$i", and that outer `i` would get overwritten by this inner
  # loop, making the outer loop exit after the first iteration — only nodes
  # 1 and 2 would ever start.
  local i
  for i in $(seq 1 "$max_wait"); do
    [ -n "$node_pid" ] || node_pid=$(refresh_node_pidfile "$node_num" || true)
    if curl -sf "${auth_args[@]}" "http://127.0.0.1:$api_port/api/status" > /dev/null 2>&1; then
      [ -n "$node_pid" ] || node_pid=$(refresh_node_pidfile "$node_num" || true)
      log "Node $node_num ready (PID ${node_pid:-unknown}, API http://127.0.0.1:$api_port)"
      ready=true
      break
    fi
    sleep 1
  done

  if [ "$ready" = false ]; then
    log "WARNING: Node $node_num not ready after ${max_wait}s (check $node_dir/daemon.log and $node_dir/console.log)"
  fi

  # Save THIS node's multiaddr so (a) node 1 serves as the universal relay and
  # (b) later cores/edges can directly dial it to form the core mesh + spokes
  # (see the bootstrapPeers block above). Node 1's multiaddr is REQUIRED (every
  # node bootstraps off it; failure aborts); the rest are best-effort — a missing
  # one only means that node isn't a direct-dial target, it still works via the
  # relay + gossip. Retry a few times even if the initial wait timed out.
  local peer_id=""
  for attempt in $(seq 1 10); do
    local peer_info
    peer_info=$(curl -sf "${auth_args[@]}" "http://127.0.0.1:$api_port/api/status" 2>/dev/null || echo "{}")
    peer_id=$(echo "$peer_info" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c);
      process.stdin.on('end',()=>{
        try{const j=JSON.parse(d);console.log(j.peerId||'')}catch{console.log('')}
      })
    " 2>/dev/null || echo "")
    [ -n "$peer_id" ] && break
    sleep 3
  done

  if [ -n "$peer_id" ]; then
    local libp2p_port=$((LIBP2P_PORT_BASE + node_num - 1))
    echo "/ip4/127.0.0.1/tcp/${libp2p_port}/p2p/${peer_id}" > "$DEVNET_DIR/node${node_num}/multiaddr"
    log "Node $node_num multiaddr saved: /ip4/127.0.0.1/tcp/${libp2p_port}/p2p/${peer_id}"
  else
    # A CORE that fails to publish its multiaddr is silently dropped from every
    # later core's bootstrapPeers, degrading the mesh back to the gossip-only
    # quorum path this topology exists to avoid — so abort on ANY core (not just
    # node 1). Edges stay best-effort: a missing edge multiaddr just means it
    # isn't a direct-dial target, and it still works via the relay + gossip.
    local node_role="edge"
    node_role=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$node_dir/config.json','utf8')).nodeRole||'edge')}catch{process.stdout.write('edge')}" 2>/dev/null || echo edge)
    if [ "$node_role" = "core" ]; then
      log "ERROR: Could not extract multiaddr for CORE node $node_num — later cores would silently omit it from the direct mesh (gossip-only quorum). Aborting devnet start."
      return 1
    fi
    log "WARNING: Could not extract multiaddr for edge node $node_num — not a direct-dial target (still reachable via gossip)."
  fi
}

collect_devnet_node_pids() {
  local node_num="${1:-}"
  local pids="" f pid root_node ps_pids children
  if [ -n "$node_num" ]; then
    root_node="$DEVNET_DIR/node${node_num}"
    for f in "$root_node/devnet.pid" "$root_node/daemon.pid"; do
      [ -f "$f" ] || continue
      pid=$(cat "$f" 2>/dev/null || true)
      [ -n "$pid" ] && pids+=" $pid"
    done
  else
    root_node="$DEVNET_DIR/node"
    for f in "$DEVNET_DIR"/node*/devnet.pid "$DEVNET_DIR"/node*/daemon.pid; do
      [ -f "$f" ] || continue
      pid=$(cat "$f" 2>/dev/null || true)
      [ -n "$pid" ] && pids+=" $pid"
    done
  fi

  if command -v ps >/dev/null 2>&1; then
    ps_pids=$(ps eww -axo pid=,command= 2>/dev/null | awk -v root="$root_node" '
      index($0, "DKG_HOME=" root) > 0 || index($0, root "/") > 0 { print $1 }
    ' 2>/dev/null || true)
    for pid in $ps_pids; do pids+=" $pid"; done
  fi

  if [ -n "$pids" ] && command -v ps >/dev/null 2>&1; then
    children=$(ps -A -o pid=,ppid= 2>/dev/null | awk -v plist="$pids" '
      BEGIN { n = split(plist, arr, " "); for (i=1;i<=n;i++) if (arr[i] != "") parents[arr[i]] = 1 }
      { if ($2 in parents) print $1 }
    ' 2>/dev/null || true)
    for pid in $children; do pids+=" $pid"; done
  fi

  echo "$pids" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' '
}

refresh_node_pidfile() {
  local node_num="$1"
  local node_dir="$DEVNET_DIR/node${node_num}"
  local pidfile="$node_dir/devnet.pid"
  local node_pid="" worker_pid="" supervisor_pid="" pid cmd

  if [ -f "$node_dir/daemon.pid" ]; then
    worker_pid=$(cat "$node_dir/daemon.pid" 2>/dev/null || true)
  fi
  if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
    supervisor_pid=$(ps -p "$worker_pid" -o ppid= 2>/dev/null | tr -d '[:space:]' || true)
    if [ -n "$supervisor_pid" ] && [ "$supervisor_pid" != "1" ] && kill -0 "$supervisor_pid" 2>/dev/null; then
      node_pid="$supervisor_pid"
    else
      node_pid="$worker_pid"
    fi
  fi

  if [ -z "$node_pid" ]; then
    for pid in $(collect_devnet_node_pids "$node_num"); do
      kill -0 "$pid" 2>/dev/null || continue
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      case "$cmd" in
        *" daemon-supervisor"*) node_pid="$pid"; break ;;
      esac
    done
  fi

  if [ -z "$node_pid" ]; then
    for pid in $(collect_devnet_node_pids "$node_num"); do
      kill -0 "$pid" 2>/dev/null || continue
      cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
      case "$cmd" in
        *oxigraph*) continue ;;
      esac
      node_pid="$pid"
      break
    done
  fi

  if [ -n "$node_pid" ]; then
    echo "$node_pid" > "$pidfile"
    printf '%s\n' "$node_pid"
  fi
}

stop_devnet_node_processes() {
  local node_num="${1:-}"
  local pids pid any_alive node_label
  pids=$(collect_devnet_node_pids "$node_num")
  [ -n "$(echo "$pids" | tr -d ' ')" ] || return 0

  node_label="nodes"
  [ -n "$node_num" ] && node_label="node $node_num"
  log "Stopping $node_label (pids=$pids)..."
  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    kill -0 "$pid" 2>/dev/null || continue
    kill "$pid" 2>/dev/null || true
  done

  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    any_alive=false
    for pid in $pids; do
      [ "$pid" = "$$" ] && continue
      if kill -0 "$pid" 2>/dev/null; then
        any_alive=true
        break
      fi
    done
    [ "$any_alive" = false ] && break
    sleep 1
  done

  for pid in $pids; do
    [ "$pid" = "$$" ] && continue
    kill -0 "$pid" 2>/dev/null || continue
    kill -9 "$pid" 2>/dev/null || true
  done

  if [ -n "$node_num" ]; then
    rm -f "$DEVNET_DIR/node${node_num}/devnet.pid" "$DEVNET_DIR/node${node_num}/daemon.pid" "$DEVNET_DIR/node${node_num}/api.port"
  else
    rm -f "$DEVNET_DIR"/node*/devnet.pid "$DEVNET_DIR"/node*/daemon.pid "$DEVNET_DIR"/node*/api.port
  fi
}

stop_devnet_nodes_only() {
  # Stop DKG node processes only (leave Hardhat, Blazegraph, Oxigraph servers running).
  # Ensures the next start_node uses freshly written configs (e.g. store backends).
  stop_devnet_node_processes
}

start_ui() {
  if [ -f "$UI_PIDFILE" ] && kill -0 "$(cat "$UI_PIDFILE")" 2>/dev/null; then
    log "node-ui already running (PID $(cat "$UI_PIDFILE"), http://127.0.0.1:$UI_PORT/ui/)"
    return 0
  fi
  rm -f "$UI_PIDFILE"
  mkdir -p "$DEVNET_DIR"

  log "Starting node-ui Vite dev server on port $UI_PORT (talks to devnet node $UI_NODE_ID)..."

  # Start Vite in a detached process group. A plain `nohup ... & disown`
  # still inherits the caller's process group on macOS, so stop_ui's
  # `kill -TERM -$pgid` can accidentally signal the orchestrator that launched
  # the smoke test. Node's detached spawn gives the UI its own group while
  # keeping the shell script portable.
  node - "$REPO_ROOT/packages/node-ui" "$UI_LOGFILE" "$UI_PIDFILE" "$UI_NODE_ID" <<'NODE'
const { openSync, closeSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');

const [, , cwd, logFile, pidFile, uiNodeId] = process.argv;
const out = openSync(logFile, 'a');
const child = spawn('pnpm', ['dev:ui'], {
  cwd,
  detached: true,
  env: { ...process.env, DEVNET_NODE: uiNodeId },
  stdio: ['ignore', out, out],
});

writeFileSync(pidFile, `${child.pid}\n`);
child.unref();
closeSync(out);
NODE

  # Poll until Vite reports ready or we hit the budget. Vite v6 binds to
  # `localhost` only by default, which on macOS resolves to ::1 first, so we
  # probe `localhost` (browsers do too) — `127.0.0.1` would miss the ::1 bind.
  for i in $(seq 1 30); do
    if curl -sI "http://localhost:$UI_PORT/ui/" 2>/dev/null | grep -q "200 OK"; then
      log "node-ui ready (PID $(cat "$UI_PIDFILE"), http://localhost:$UI_PORT/ui/)"
      return 0
    fi
    sleep 1
  done

  log "WARNING: node-ui did not respond to HTTP within 30s (check $UI_LOGFILE)"
  return 1
}

stop_ui() {
  if [ -f "$UI_PIDFILE" ]; then
    local pid
    pid=$(cat "$UI_PIDFILE")
    if kill -0 "$pid" 2>/dev/null; then
      # Kill the whole process group so the nohup'd Vite + its esbuild/vite
      # workers all go down cleanly. macOS bash doesn't always set up a fresh
      # pgid for the child, so we fall back to killing the leader pid.
      local pgid
      pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
      if [ -n "$pgid" ] && [ "$pgid" != "0" ]; then
        kill -TERM "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      else
        kill "$pid" 2>/dev/null || true
      fi
      log "Stopped node-ui (PID $pid)"
    fi
    rm -f "$UI_PIDFILE"
  fi
}

cmd_ui() {
  local sub="${2:-status}"
  case "$sub" in
    start)   start_ui ;;
    stop)    stop_ui ;;
    restart) stop_ui; start_ui ;;
    status)
      if [ -f "$UI_PIDFILE" ] && kill -0 "$(cat "$UI_PIDFILE")" 2>/dev/null; then
        local pid
        pid=$(cat "$UI_PIDFILE")
        local http_status="DOWN"
        if curl -sI "http://localhost:$UI_PORT/ui/" 2>/dev/null | grep -q "200 OK"; then
          http_status="OK"
        fi
        echo "node-ui: RUNNING (PID $pid, port $UI_PORT, HTTP $http_status, log $UI_LOGFILE)"
      else
        echo "node-ui: STOPPED"
      fi
      ;;
    logs)
      [ -f "$UI_LOGFILE" ] || { log "No log file at $UI_LOGFILE"; return 1; }
      tail -f "$UI_LOGFILE"
      ;;
    *)
      echo "Usage: $0 ui {start|stop|restart|status|logs}"
      exit 1
      ;;
  esac
}

cmd_start() {
  log "Starting devnet with $NUM_NODES nodes..."
  if [ -n "$DEVNET_VERSION_LAYOUT" ]; then
    log "Mixed-version layout: $DEVNET_VERSION_LAYOUT"
  fi
  mkdir -p "$DEVNET_DIR"

  ensure_built
  # Build any alternate versions the layout references BEFORE starting nodes, so
  # a mixed-version cluster comes up in one `start`. No-op for the default
  # (all-current) layout.
  prepare_layout_versions
  start_hardhat
  deploy_contracts
  start_blazegraph
  start_oxigraph_servers

  # ── backend coverage summary + optional strict gate ───────────────────────
  # Nodes 1-2 run the daemon-managed `oxigraph-server` (the production default)
  # with NO Docker — the binary is auto-downloaded/cached by the daemon — so the
  # SPARQL-over-HTTP path, AND the node the UI/e2e suite drives, is ALWAYS
  # exercised. That closes the rc.16 gap where the matrix silently fell back to
  # the embedded store and the blank-node DELETE-DATA bug slipped past devnet.
  # The Docker-gated entries below (blazegraph on 3-4, an EXTERNAL Oxigraph
  # server on 5-6) are EXTRA matrix coverage; DEVNET_REQUIRE_ALL_BACKENDS=1 makes
  # their absence a hard failure for full-matrix CI.
  local bg_state ox_extra
  if [ "$BLAZEGRAPH_AVAILABLE" = true ]; then bg_state="blazegraph"; else bg_state="oxigraph in-process (blazegraph Docker unavailable)"; fi
  if [ "$OXIGRAPH_SERVER_AVAILABLE" = true ]; then ox_extra="sparql-http → external Oxigraph"; else ox_extra="(skipped — external Oxigraph Docker unavailable)"; fi
  log "Store-backend matrix:  nodes 1-2: oxigraph-server (managed, no Docker)  |  nodes 3-4: $bg_state  |  nodes 5-6: $ox_extra"
  if [ "$BLAZEGRAPH_AVAILABLE" != true ] || [ "$OXIGRAPH_SERVER_AVAILABLE" != true ]; then
    if [ "${DEVNET_REQUIRE_ALL_BACKENDS:-0}" = "1" ]; then
      log "ERROR: DEVNET_REQUIRE_ALL_BACKENDS=1 but an EXTRA Docker backend (blazegraph and/or external Oxigraph) is missing. The core oxigraph-server path IS covered on nodes 1-2, but full-matrix CI also requires the Docker images. Aborting."
      exit 1
    fi
    log "NOTE: EXTRA Docker backends (blazegraph / external Oxigraph) are not provisioned this run. The production-default oxigraph-server path IS covered on nodes 1-2; set DEVNET_REQUIRE_ALL_BACKENDS=1 to require the Docker extras too."
  fi

  # Stop any already-running devnet nodes so they pick up the config we are about to write
  stop_devnet_nodes_only

  # The chain was just freshly deployed (start_hardhat wiped the deployment
  # artifacts + marker above), so ANY persisted per-node store state is STALE —
  # it references the OLD chain. The critical case: a node's store still holds
  # the `dkg:contextGraphOnChainId` triple from a previous run, so
  # `registerContextGraph` below short-circuits on a stale "already registered"
  # view and never creates the CG on the NEW chain. The CG then reads back
  # `isContextGraphActive=false` / `publishPolicy=0`, the post-boot policy
  # assertion fails, and every VM publish hits LU-5 ("publish access-policy is
  # unknown"). Wipe each node's persisted state now that the nodes are stopped —
  # but KEEP the cached Oxigraph binary (`oxigraph/`) so we don't re-download it.
  # Nodes re-register identities + CGs and re-sync from scratch against the fresh
  # chain, which is exactly the e2e seed-from-clean model.
  if [ -d "$DEVNET_DIR" ]; then
    local nd
    for nd in "$DEVNET_DIR"/node*/; do
      [ -d "$nd" ] || continue
      find "$nd" -mindepth 1 -maxdepth 1 ! -name oxigraph -exec rm -rf {} + 2>/dev/null || true
    done
    log "Cleared stale per-node store state for the freshly-deployed chain (kept cached Oxigraph binaries)"
  fi

  # Generate a shared auth token for all devnet nodes
  local shared_token
  shared_token=$(openssl rand -base64 32 | tr -d '=/+' | head -c 43)
  log "Shared devnet auth token: $shared_token"

  # Create all node configs
  for i in $(seq 1 "$NUM_NODES"); do
    log "Creating config for node $i..."
    create_node_config "$i"
    local nd="$DEVNET_DIR/node${i}"
    printf '# DKG devnet shared auth token\n%s\n' "$shared_token" > "$nd/auth.token"
    chmod 600 "$nd/auth.token"
  done
  log "All node configs created. Starting nodes..."

  # Ensure we're in repo root so node processes inherit cwd for app loader
  cd "$REPO_ROOT" || true

  # Start node 1 (relay) first, then the rest
  start_node 1

  # macOS BSD `seq` counts DOWN when the start exceeds the stop
  # (`seq 2 1` -> "2\n1") whereas GNU seq returns empty. With NUM_NODES=1
  # the BSD path looped backwards into start_node 2, which then crashed
  # on a missing node2/config.json. Use a C-style arithmetic for loop
  # so the empty-range case is handled identically on both systems.
  for ((i = 2; i <= NUM_NODES; i++)); do
    start_node "$i"
  done

  # Wait for all nodes to create on-chain identities, then set up staking + ask prices.
  # This ensures stakeWeightedAverageAsk > 0 so publish tokenAmount doesn't revert.
  log "Waiting for nodes to register on-chain identities..."
  sleep 10

  local contracts_json="$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"

  cd "$REPO_ROOT/packages/evm-module" && node -e "
    const { ethers } = require('ethers');
    const fs = require('fs');
    (async () => {
      const provider = new ethers.JsonRpcProvider('http://127.0.0.1:$HARDHAT_PORT');
      const contracts = JSON.parse(fs.readFileSync('$contracts_json', 'utf8'));
      const c = (name) => contracts.contracts[name]?.evmAddress;

      const token    = new ethers.Contract(c('Token'),          ['function mint(address,uint256)', 'function approve(address,uint256)'], provider);
      const identity = new ethers.Contract(c('IdentityStorage'), ['function getIdentityId(address) view returns (uint72)'], provider);
      // v4.0.0 — V10 staking consolidation: stake via DKGStakingConvictionNFT.createConviction,
      // which mints a V10 NFT position, writes nodeStakeV10 in ConvictionStakingStorage, and
      // routes TRAC to the V10 vault (CSS). The legacy V8 Staking.stake path updates only
      // StakingStorage and leaves nodeStakeV10 = 0, so RandomSampling.calculateNodeScore
      // (which reads getNodeStakeV10) would compute zero and node scores would never grow.
      const stakingNFT = new ethers.Contract(
        c('DKGStakingConvictionNFT'),
        // lockTier is uint40 in V10 (L3 — widened from uint8 to support tier ids > 255).
        ['function createConviction(uint72,uint96,uint40)'],
        provider
      );
      // Identity-scoped read used by the duplicate-stake guard below.
      // ERC-721 balanceOf(opWallet) would also signal that the op wallet
      // owns at least one position, but that is not what the guard needs
      // to know - an op wallet can hold positions for OTHER identities,
      // which would skip a needed createConviction for THIS identity.
      // getNodeStakeV10(idId) reads the per-identity stake total
      // directly. Codex round 7 on PR #368.
      const css = new ethers.Contract(
        c('ConvictionStakingStorage'),
        ['function getNodeStakeV10(uint72) view returns (uint256)'],
        provider
      );
      const stakingV10Addr = c('StakingV10');
      const profile  = new ethers.Contract(c('Profile'),         ['function updateAsk(uint72,uint96)'], provider);

      // Post-PR-366: each node's wallets.json has \`adminWallet\` (the Hardhat key,
      // which holds purpose=ADMIN_KEY only) and \`wallets[]\` (random op keys
      // holding purpose=OPERATIONAL_KEY only). The reverse-lookup map
      // \`IdentityStorage.identityIds\` is operational-only by design (see
      // IdentityStorage.sol:108-110), so we MUST query identity by op wallet
      // address, not by admin/Hardhat-key address. createConviction + updateAsk
      // also need to be signed by the op wallet (the address that owns the
      // identity in the eyes of the staking + profile contracts).
      const n = $NUM_NODES;
      const opSigners = new Array(n).fill(null);
      const nodeRoles = new Array(n).fill('edge');
      // Codex round 4 on PR #368: read config.json FIRST and INDEPENDENTLY
      // of wallets.json. The previous loop did continue first
      // on parse failure BEFORE reading config, so an intended core whose
      // wallets.json was malformed silently kept the 'edge' default,
      // dropped out of coreIdxs, and the lostCores guard never fired.
      // Reading config first decouples the two failures: now lostCores
      // correctly catches the case where a node was supposed to be a
      // core but its wallets are broken.
      const configErrors = [];
      for (let i = 1; i <= n; i++) {
        const cPath = '$DEVNET_DIR/node' + i + '/config.json';
        try {
          const cfg = JSON.parse(fs.readFileSync(cPath, 'utf8'));
          // Trust the explicit role; fall back to 'edge' (NOT 'core') if
          // the field is missing — defaulting unknowns to 'core' would
          // auto-provision an on-chain identity for a node whose role we
          // cannot confirm.
          nodeRoles[i - 1] = cfg.nodeRole || 'edge';
        } catch (e) {
          configErrors.push(i);
          console.log('Node ' + i + ': failed to parse config.json (treating as edge): ' + (e && e.message || e));
        }
      }
      // Codex round 2 on PR #368: parse each node's wallets.json
      // independently. A malformed file (truncated mid-write, missing
      // wallets[0], unparseable JSON) MUST NOT throw and abort staking
      // for every node — log + skip the bad one and let the rest boot.
      // Downstream loops gate on \`opSigners[i] != null\` so skipped
      // entries never reach createConviction/updateAsk.
      for (let i = 1; i <= n; i++) {
        const wPath = '$DEVNET_DIR/node' + i + '/wallets.json';
        try {
          const w = JSON.parse(fs.readFileSync(wPath, 'utf8'));
          if (!w || !Array.isArray(w.wallets) || w.wallets.length === 0
              || !w.wallets[0] || !w.wallets[0].privateKey) {
            console.log('Node ' + i + ': wallets.json missing wallets[0].privateKey, skipping (' + wPath + ')');
            continue;
          }
          opSigners[i - 1] = new ethers.Wallet(w.wallets[0].privateKey, provider);
        } catch (e) {
          console.log('Node ' + i + ': failed to parse wallets.json: ' + (e && e.message || e));
        }
      }

      // Codex round 3 on PR #368: fail-fast if a node we INTEND to be
      // a core (its config.json said so) lost its wallets.json. The
      // earlier silent-skip here would let cmd_start succeed with a
      // half-staked devnet, then publish/ACK smoke tests would fail
      // later with much less obvious symptoms. We treat any node that
      // BOTH (a) has nodeRole=core AND (b) failed wallet parse as a
      // hard failure — print diagnostics and exit non-zero so the
      // operator fixes the wallet file before retrying.
      const lostCores = [];
      for (let i = 0; i < n; i++) {
        if (nodeRoles[i] === 'core' && opSigners[i] === null) lostCores.push(i + 1);
      }
      if (lostCores.length > 0) {
        console.error('FATAL: ' + lostCores.length + ' core node(s) have invalid wallets.json: '
          + lostCores.map(String).join(', '));
        console.error('Refusing to bootstrap a partially-provisioned devnet. Fix the wallet files and re-run.');
        process.exit(1);
      }
      // Codex round 4 on PR #368: a node whose config.json was unreadable
      // is now treated as 'edge' and silently skipped from staking. This
      // is the correct safe default IF the operator intended that node to
      // be edge — but if they intended it to be core, the lostCores
      // guard above won't catch it because nodeRoles[i] !== 'core'.
      // Surface the ambiguity loudly so the operator can confirm intent.
      if (configErrors.length > 0) {
        console.error('WARNING: ' + configErrors.length + ' node(s) have unreadable config.json: '
          + configErrors.map(String).join(', '));
        console.error('These nodes are being treated as edge (no on-chain stake). Fix config.json if any were intended to be core.');
      }

      // Wait up to 60s for all CORE nodes to have identities. Edge nodes
      // never create on-chain profiles by design (dkg-agent.ts skips
      // ensureProfile for effectiveRole='edge'), so we don't wait on them.
      // The daemon creates identities eagerly in agent.connect() (dkg-agent.ts
      // ensureProfile path), typically within ~5s of node start.
      // Skip nodes whose wallets.json failed to parse (opSigners[i] === null).
      const coreIdxs = nodeRoles
        .map((r, i) => r === 'core' && opSigners[i] !== null ? i : -1)
        .filter(i => i >= 0);
      const nodeIds = new Array(n).fill(0n);
      for (let attempt = 0; attempt < 30; attempt++) {
        let allReady = true;
        for (const i of coreIdxs) {
          if (nodeIds[i] === 0n) {
            nodeIds[i] = await identity.getIdentityId(opSigners[i].address);
          }
          if (nodeIds[i] === 0n) allReady = false;
        }
        if (allReady) break;
        const ready = coreIdxs.filter(i => nodeIds[i] > 0n).length;
        if (attempt % 5 === 4) console.log('Waiting for core identities: ' + ready + '/' + coreIdxs.length + ' ready...');
        await new Promise(r => setTimeout(r, 2000));
      }

      let staked = 0, asked = 0;
      const coreCount = coreIdxs.length;
      for (let i = 0; i < n; i++) {
        if (nodeRoles[i] !== 'core') continue;
        const opSigner = opSigners[i];
        if (!opSigner) { console.log('Node ' + (i+1) + ' (core): wallets.json invalid, skipping'); continue; }
        const idId = nodeIds[i] || await identity.getIdentityId(opSigner.address);
        if (idId === 0n) { console.log('Node ' + (i+1) + ' (core): no identity after 60s, skipping'); continue; }

        const stakeAmount = ethers.parseEther('50000');
        const askAmount = ethers.parseEther('${DEVNET_CORE_ASK_TRAC:-1}');
        // Lock tier 1 (1-month). Cheapest tier with non-zero multiplier; sufficient
        // for devnet random-sampling soak tests where we need nodeStakeV10 > 0.
        const lockTier = 1;

        // The daemon's publisher shares this op wallet (registered as the
        // StorageACK signer + first op wallet). It may have submitted txs
        // already (addKey, addOperationalWallets) by the time we reach here,
        // so we MUST query the nonce explicitly and pass it to each tx —
        // relying on ethers' default nonce manager would race the daemon
        // and yield 'nonce has already been used'.
        //
        // Codex round 1 on PR #368: use 'pending' (NOT 'latest') so the
        // count includes daemon-submitted txs already in the mempool but
        // not yet mined. 'latest' would still collide with an in-flight
        // addKey/addOperationalWallets and produce the very nonce error
        // this code path exists to prevent.
        //
        // Codex round 2 on PR #368: re-read 'pending' before EVERY tx
        // (not once per node loop). The previous code incremented a nonce at
        // call site so a failed approve advanced the local counter even
        // though the chain nonce did not, leaving createConviction +
        // updateAsk to send with an inflated nonce that would either
        // queue forever or skip a slot. Re-reading 'pending' between
        // awaits costs one extra eth_call per tx, which is negligible
        // for a 6-node devnet bootstrap.
        const sendWithFreshNonce = async (txFactory) => {
          // Retry on the daemon racing our nonce (it shares this op wallet and may
          // submit between our 'pending' read and our send) or a transient revert:
          // re-read 'pending' and resend, backing off, before giving up.
          let lastErr;
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              const freshNonce = await provider.getTransactionCount(opSigner.address, 'pending');
              const tx = await txFactory(freshNonce);
              return await tx.wait();
            } catch (e) {
              lastErr = e;
              await new Promise(r => setTimeout(r, 800 + attempt * 600));
            }
          }
          throw lastErr;
        };
        // Codex round 4 on PR #368: skip createConviction if the daemon
        // already opened a position. PR 366 wired EVMChainAdapter.ensureProfile()
        // to open a default 50k V10 conviction during agent startup, so by
        // the time this script reaches the staking loop the daemon has
        // (usually) already staked. Running createConviction again would
        // open a SECOND 50k position per core node and silently double the
        // devnet stake. We detect this by reading the per-identity V10
        // stake total — if the daemon's stake succeeded it's >0 and we skip.
        //
        // Codex round 5 on PR #368: do NOT fall through to a not-staked
        // on probe failure (transient RPC, decode error). That would
        // re-introduce the double-stake bug this guard exists to prevent.
        // Retry once with backoff; if the probe still fails, refuse to
        // run createConviction so the operator sees the symptom and
        // decides — rather than silently doubling the stake.
        // updateAsk is INDEPENDENT of stake state, so we still attempt
        // it below regardless of the probe outcome.
        //
        // Codex round 7 on PR #368: probe getNodeStakeV10(idId) instead
        // of NFT balanceOf(opSigner.address). The op wallet could hold
        // positions for OTHER identities (not in our devnet today, but
        // a wallet-scoped probe is the wrong semantic check); we want
        // to know whether THIS identity is staked.
        let probeOk = false;
        let shouldStake = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const nodeStake = await css.getNodeStakeV10(idId);
            probeOk = true;
            if (nodeStake > 0n) {
              staked++;
              console.log('Node ' + (i+1) + ' (core): daemon already staked (nodeStakeV10=' + nodeStake + '), skipping createConviction');
            } else {
              shouldStake = true;
            }
            break;
          } catch (e) {
            console.log('Node ' + (i+1) + ' (core): nodeStakeV10 probe failed (attempt ' + (attempt + 1) + '/2): ' + e.message);
            if (attempt === 0) await new Promise(r => setTimeout(r, 1500));
          }
        }
        if (!probeOk) {
          console.log('Node ' + (i+1) + ' (core): cannot verify existing conviction after retry; skipping bootstrap stake to avoid double-stake');
        } else if (shouldStake) {
          try {
            const deployer = await provider.getSigner(0);
            await (await token.connect(deployer).mint(opSigner.address, stakeAmount)).wait();
            // StakingV10.stake pulls TRAC via transferFrom(staker, address(CSS), amount)
            // gated by allowance to StakingV10. Approve StakingV10 here, NOT the NFT —
            // the NFT is only the entry point and never custodies TRAC.
            await sendWithFreshNonce((freshNonce) =>
              token.connect(opSigner).approve(stakingV10Addr, stakeAmount, { nonce: freshNonce }));
            await sendWithFreshNonce((freshNonce) =>
              stakingNFT.connect(opSigner).createConviction(idId, stakeAmount, lockTier, { nonce: freshNonce }));
            staked++;
          } catch (e) { console.log('Stake failed for node ' + (i+1) + ': ' + e.message); }
        }

        // Set ask price (independent try block — a failed stake must not
        // skip ask setup; sendWithFreshNonce re-reads 'pending' so it
        // tolerates the chain nonce having advanced or not).
        try {
          await sendWithFreshNonce((freshNonce) =>
            profile.connect(opSigner).updateAsk(idId, askAmount, { nonce: freshNonce }));
          asked++;
        } catch (e) { console.log('Ask failed for node ' + (i+1) + ': ' + e.message); }
      }
      console.log('Staked 50k TRAC for ' + staked + '/' + coreCount + ' core node(s), ask set for ' + asked + '/' + coreCount);
      // The daemon's own ensureProfile stake can land AFTER this loop (it shares the
      // op wallet; our probe raced it, then our createConviction reverted as a duplicate
      // 0x7000ca77). Re-probe all core identities (poll up to ~30s) before the FATAL gate
      // so a daemon-side stake that won the race still counts and we don't abort the boot
      // (and skip CG registration) over a timing artifact.
      if (staked < coreCount) {
        for (let poll = 0; poll < 15 && staked < coreCount; poll++) {
          await new Promise(r => setTimeout(r, 2000));
          let restaked = 0;
          for (const i of coreIdxs) {
            const idId2 = nodeIds[i] || await identity.getIdentityId(opSigners[i].address);
            if (idId2 === 0n) continue;
            try { if ((await css.getNodeStakeV10(idId2)) > 0n) restaked++; } catch (_) {}
          }
          staked = restaked;
        }
        console.log('Re-probed core stakes after settle: ' + staked + '/' + coreCount);
      }
      // Defense-in-depth: a partial-stake bootstrap (probe failure +
      // skip, or createConviction revert + skip) currently logs
      // 'staked X/Y' and continues. Operators may miss the count
      // mismatch and only notice when downstream publish/ACK smoke
      // tests fail with much less obvious symptoms. Refuse to
      // declare bootstrap successful unless every core node is
      // staked. Codex follow-up to PR #368.
      if (staked < coreCount) {
        console.error('FATAL: only ' + staked + '/' + coreCount + ' core node(s) staked — refusing to declare devnet ready');
        process.exit(1);
      }
    })();
  " 2>&1 | while read -r line; do log "$line"; done

  # Register context graphs on-chain by going through node 1's public API.
  #
  # History: this block used to call `ContextGraphV9Registry.createContextGraphV9(...)`
  # directly from the deployer account. That is the legacy V9 contextGraph
  # registry — V10 publish paths consult `ContextGraphs` + `ContextGraphStorage`
  # and surface the resulting uint256 id as `v10Id` in the API. Registering
  # on the V9 contract left nodes with no V10 record to look up, so every
  # VM publish in scripts/devnet-test.sh failed with
  # "Context graph \"devnet-test\" is not registered on-chain".
  #
  # We now delegate to `POST /api/context-graph/register` on node 1, which
  # runs the same `agent.registerContextGraph` path production nodes use
  # (calls `ContextGraphs.createContextGraph(participantAgents, metadataBatchId,
  # accessPolicy, publishPolicy, publishAuthority, publishAuthorityAccountId)`
  # — no per-CG hosting / quorum since SPEC_CG_MEMORY_MODEL — reads the
  # `ContextGraphCreated` event, writes `dkg:onChainId` + `status="registered"`
  # to _meta). Every
  # node locally bootstraps the CG on boot via the `contextGraphs` config
  # array, so node 1 already has it; the on-chain id then propagates to
  # the rest via the periodic `discoverContextGraphsFromChain` sweep.
  #
  # Prerequisite: node 1 must have a staked identity (we ran that above),
  # otherwise `registerContextGraph` bails with "cannot be registered
  # on-chain without an on-chain identity".
  log "Registering context graphs on-chain via node 1 API..."
  local register_endpoint="http://127.0.0.1:$API_PORT_BASE/api/context-graph/register"
  local register_auth_header="Authorization: Bearer $shared_token"
  local register_failures=0
  # Register two context graphs so the devnet preserves the cross-CG isolation
  # smoke path (each CG has its own subgraph + on-chain id; nodes must keep them
  # independent). A single graph would hide regressions that only surface when
  # traffic fans out across multiple contextGraphs.
  for cg in devnet-test devnet-isolation; do
    local on_chain_id=""
    local attempt
    for attempt in 1 2 3; do
      local reg_resp
      reg_resp=$(curl -sS --max-time 30 -X POST \
        -H "$register_auth_header" \
        -H "Content-Type: application/json" \
        -d "{\"id\":\"$cg\",\"accessPolicy\":0,\"publishPolicy\":1}" \
        "$register_endpoint" 2>&1 || true)
      if echo "$reg_resp" | grep -q '"onChainId"'; then
        on_chain_id=$(echo "$reg_resp" | python3 -c "import sys,json;print(json.load(sys.stdin).get('onChainId',''))" 2>/dev/null || echo '')
        log "Registered context graph: $cg (v10Id=$on_chain_id)"
        break
      elif echo "$reg_resp" | grep -q 'already registered'; then
        # Recover the existing onChainId from node 1's local view so the
        # cross-node visibility wait below has something to compare to.
        on_chain_id=$(curl -sS --max-time 10 \
          -H "$register_auth_header" \
          "http://127.0.0.1:$API_PORT_BASE/api/context-graph/list" \
          | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((g.get('onChainId','') for g in d.get('contextGraphs',[]) if g.get('id')=='$cg'), ''))" \
          2>/dev/null || echo '')
        log "Context graph already registered: $cg (v10Id=${on_chain_id:-unknown})"
        break
      else
        log "Register attempt $attempt for $cg failed: $reg_resp"
        sleep 2
      fi
    done
    if [ -z "$on_chain_id" ]; then
      log "ERROR: failed to register $cg after 3 attempts; devnet is half-configured."
      register_failures=$((register_failures + 1))
      continue
    fi

    # Devnet bootstrap CGs are public/open. The V10 contract uses
    # publishPolicy 0 = curated, 1 = open; keep an on-chain smoke assertion
    # here so product/API numeric drift is caught during local bring-up.
    local policy_check
    policy_check=$(node -e "
      const { ethers } = require('ethers');
      (async () => {
        const fs = require('fs');
        const d = JSON.parse(fs.readFileSync('$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json','utf8'));
        const storageAddr = d.contracts.ContextGraphStorage?.evmAddress;
        if (!storageAddr) throw new Error('ContextGraphStorage address missing');
        const provider = new ethers.JsonRpcProvider('http://127.0.0.1:$HARDHAT_PORT');
        const storage = new ethers.Contract(storageAddr, ['function getPublishPolicy(uint256) view returns (uint8,address)'], provider);
        const [policy] = await storage.getPublishPolicy(BigInt('$on_chain_id'));
        console.log(String(policy));
      })().catch((e) => { console.error(e.message); process.exit(1); });
    " 2>&1 || true)
    if [ "$policy_check" = "1" ]; then
      log "  on-chain publishPolicy for $cg is open (1)"
    else
      log "  ERROR: expected open publishPolicy=1 for $cg v10Id=$on_chain_id, got '$policy_check'"
      register_failures=$((register_failures + 1))
    fi

    # The on-chain id propagates to other nodes via ONTOLOGY gossip
    # (`registerContextGraph` writes the `dkg:contextGraphOnChainId` triple +
    # immediately broadcasts it). Wait until every node's local view
    # surfaces the same id before declaring the devnet ready — without
    # this wait, the next VM publish on node 2+ races the gossip and
    # rejects with "context graph is not registered on-chain".
    log "Waiting for $cg (v10Id=$on_chain_id) to be visible on all $NUM_NODES nodes..."
    local node_idx
    for node_idx in $(seq 1 "$NUM_NODES"); do
      local node_port=$((API_PORT_BASE + node_idx - 1))
      local seen_id=""
      local poll
      for poll in $(seq 1 30); do
        seen_id=$(curl -sS --max-time 5 \
          -H "$register_auth_header" \
          "http://127.0.0.1:$node_port/api/context-graph/list" 2>/dev/null \
          | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((g.get('onChainId','') for g in d.get('contextGraphs',[]) if g.get('id')=='$cg'), ''))" \
          2>/dev/null || echo '')
        if [ "$seen_id" = "$on_chain_id" ]; then
          break
        fi
        sleep 1
      done
      if [ "$seen_id" = "$on_chain_id" ]; then
        log "  node $node_idx sees $cg v10Id=$seen_id"
      else
        log "  ERROR: node $node_idx never observed v10Id=$on_chain_id for $cg (last seen='$seen_id')"
        register_failures=$((register_failures + 1))
      fi
    done
  done
  if [ "$register_failures" -gt 0 ]; then
    log "FATAL: $register_failures context-graph registration step(s) failed; aborting devnet start."
    log "Run \`./scripts/devnet.sh logs <n>\` for per-node detail. The devnet is left running for inspection — stop with \`./scripts/devnet.sh stop\`."
    return 1
  fi

  log ""
  log "=== Devnet Ready ==="
  log ""
  log "Hardhat RPC:  http://127.0.0.1:$HARDHAT_PORT"
  for i in $(seq 1 "$NUM_NODES"); do
    local api_port=$((API_PORT_BASE + i - 1))
    local role="edge"
    [ "$i" -le "$NUM_CORE_NODES" ] && role="core"
    local store_label="oxigraph-worker"
    if [ "$i" -ge 3 ] && [ "$i" -le 4 ]; then
      [ "$BLAZEGRAPH_AVAILABLE" = true ] && store_label="blazegraph" || store_label="oxigraph"
    fi
    if [ "$i" -ge 5 ]; then
      [ "$OXIGRAPH_SERVER_AVAILABLE" = true ] && store_label="oxigraph-server" || store_label="oxigraph-worker"
    fi
    log "Node $i ($role, $store_label): http://127.0.0.1:$api_port/ui"
  done
  log ""
  log "Auth token: $shared_token"
  log "  curl -H 'Authorization: Bearer $shared_token' http://127.0.0.1:$API_PORT_BASE/api/agents"
  log ""
  log "Hub address:  $(cat "$DEVNET_DIR/hardhat/hub_address" 2>/dev/null || echo 'unknown')"
  log ""
  log "To stop:      ./scripts/devnet.sh stop"
  log "To view logs: ./scripts/devnet.sh logs <node_num>"
}

cmd_stop() {
  log "Stopping devnet..."

  stop_ui

  stop_devnet_node_processes

  # Stop hardhat
  local pid
  pid=$(refresh_hardhat_pidfile || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    log "Stopped Hardhat (PID $pid)"
    sleep 1
  fi
  rm -f "$DEVNET_DIR/hardhat.pid"

  stop_blazegraph
  stop_oxigraph_servers

  # Port-sweep — kills processes still holding *this* devnet's ports after the
  # normal pidfile-based stop has run. Two modes:
  #
  #   default ("scoped"):   only kill listeners whose pid matches one we know
  #                          belongs to this devnet (hardhat.pid + each
  #                          node*/devnet.pid + supervisor/daemon pids, plus
  #                          the process-tree descendants of those). Safe to
  #                          leave on permanently — never touches unrelated
  #                          local services that happen to use 8545 etc.
  #
  #   "broad" (opt-in):     kill any listener on the configured port set,
  #                          regardless of pid provenance. Useful after an
  #                          rc.X devnet crashed and forgot its pidfiles, but
  #                          dangerous in shared environments. Enable with
  #                          `DEVNET_STOP_PORT_SWEEP_BROAD=1`.
  #
  # `DEVNET_STOP_PORT_SWEEP=0` disables both. Default is scoped sweep ON.
  if [ "${DEVNET_STOP_PORT_SWEEP:-1}" = "1" ]; then
    sweep_ports_for_devnet
  fi

  log "Devnet stopped."
}

# Collect every pid we believe belongs to this devnet by walking the on-disk
# pidfile set. Echoes a space-separated list of unique pids. Safe to call
# even when the devnet has been mostly torn down — missing files are skipped.
#
# Note: bash 3.2 (macOS default) errors on `${arr[@]}` when the array is
# empty under `set -u`. We use a plain space-separated string so the logic
# stays bash 3.2 clean.
collect_devnet_pids() {
  local pids="" f pid children
  pids="$(collect_devnet_node_pids)"
  pid=$(refresh_hardhat_pidfile || true)
  [ -n "$pid" ] && pids+=" $pid"
  for f in "$DEVNET_DIR/hardhat.pid"; do
    [ -f "$f" ] || continue
    pid=$(cat "$f" 2>/dev/null || true)
    [ -n "$pid" ] && pids+=" $pid"
  done
  # Children — node.js often forks a worker. ps -A -o pid,ppid is portable
  # across macOS and Linux; awk filters in a single pass.
  if [ -n "$pids" ] && command -v ps >/dev/null 2>&1; then
    children=$(ps -A -o pid=,ppid= 2>/dev/null | awk -v plist="$pids" '
      BEGIN { n = split(plist, arr, " "); for (i=1;i<=n;i++) if (arr[i] != "") parents[arr[i]] = 1 }
      { if ($2 in parents) print $1 }
    ' 2>/dev/null || true)
    for pid in $children; do pids+=" $pid"; done
  fi
  # De-dup, drop empties.
  echo "$pids" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' '
}

# Find and SIGTERM (then SIGKILL after a grace window) any process holding
# this devnet's known ports. Safe on macOS (lsof) and Linux (lsof). Always
# exits 0 — best-effort, never blocks the wider stop flow.
sweep_ports_for_devnet() {
  local -a ports=("$HARDHAT_PORT")
  local i
  for i in $(seq 1 "$NUM_NODES"); do
    ports+=("$((API_PORT_BASE + i - 1))")
    ports+=("$((LIBP2P_PORT_BASE + i - 1))")
  done

  if ! command -v lsof >/dev/null 2>&1; then
    log "(port-sweep skipped: lsof not on PATH)"
    return 0
  fi

  local broad="${DEVNET_STOP_PORT_SWEEP_BROAD:-0}"
  local owned_pids=""
  if [ "$broad" != "1" ]; then
    owned_pids=" $(collect_devnet_pids) "
    if [ "$owned_pids" = "  " ]; then
      # No pidfiles left — likely a crash recovery. In scoped mode we refuse
      # to fire blindly; user opts in via DEVNET_STOP_PORT_SWEEP_BROAD=1.
      log "(port-sweep skipped: no known devnet pids on disk; set DEVNET_STOP_PORT_SWEEP_BROAD=1 to sweep anyway)"
      return 0
    fi
  fi

  local stragglers=""
  local p raw_pids targeted pid
  for p in "${ports[@]}"; do
    targeted=""
    # NOTE: lsof exits 1 when no listener matches the filter. Under
    # `set -e` + `pipefail` that would abort the whole stop. Wrap with
    # `|| true` so an "empty result" is just empty, not a fatal error.
    raw_pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ' || true)
    [ -z "$(echo "$raw_pids" | tr -d ' ')" ] && continue
    if [ "$broad" = "1" ]; then
      targeted="$raw_pids"
    else
      # Scoped mode: intersect listeners with our owned pid set so we never
      # SIGKILL an unrelated local service that happens to be on 8545.
      for pid in $raw_pids; do
        if echo "$owned_pids" | grep -q " $pid "; then
          targeted+=" $pid"
        fi
      done
    fi
    if [ -z "$(echo "$targeted" | tr -d ' ')" ]; then
      if [ "$broad" != "1" ]; then
        log "Port-sweep: TCP:$p held by pid(s)=$raw_pids — NOT owned by this devnet, leaving alone"
      fi
      continue
    fi
    log "Port-sweep: TCP:$p still LISTEN — pids=$targeted (SIGTERM)"
    stragglers+=" $targeted"
    for pid in $targeted; do kill "$pid" 2>/dev/null || true; done
  done

  # Brief grace; then SIGKILL any survivor on the same port set.
  [ -n "$(echo "$stragglers" | tr -d ' ')" ] || return 0
  sleep 2
  for p in "${ports[@]}"; do
    targeted=""
    raw_pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ' || true)
    [ -z "$(echo "$raw_pids" | tr -d ' ')" ] && continue
    if [ "$broad" = "1" ]; then
      targeted="$raw_pids"
    else
      for pid in $raw_pids; do
        if echo "$owned_pids" | grep -q " $pid "; then
          targeted+=" $pid"
        fi
      done
    fi
    [ -z "$(echo "$targeted" | tr -d ' ')" ] && continue
    log "Port-sweep: TCP:$p still held after SIGTERM — pids=$targeted (SIGKILL)"
    for pid in $targeted; do kill -9 "$pid" 2>/dev/null || true; done
  done
}

cmd_status() {
  echo "=== Devnet Status ==="

  local hardhat_pid
  hardhat_pid=$(refresh_hardhat_pidfile || true)
  if [ -n "$hardhat_pid" ]; then
    echo "Hardhat:  RUNNING (PID $hardhat_pid, port $HARDHAT_PORT)"
  else
    echo "Hardhat:  STOPPED"
  fi

  for node_dir in "$DEVNET_DIR"/node*; do
    [ -d "$node_dir" ] || continue
    local node_num
    node_num=$(basename "$node_dir" | sed 's/node//')
    local api_port=$((API_PORT_BASE + node_num - 1))
    local pidfile="$node_dir/devnet.pid"
    local pid=""

    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      pid=$(cat "$pidfile")
    else
      pid=$(refresh_node_pidfile "$node_num" || true)
    fi

    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      local status_json
      status_json=$(curl -s "http://127.0.0.1:$api_port/api/status" 2>/dev/null || echo "{}")
      local peer_id
      peer_id=$(echo "$status_json" | node -e "
        let d=''; process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
          try{const j=JSON.parse(d);console.log(j.peerId?.slice(0,16)||'??')}catch{console.log('??')}
        })
      " 2>/dev/null || echo "??")
      echo "Node $node_num:   RUNNING (PID $pid, API :$api_port, peer ${peer_id}...)"
    else
      echo "Node $node_num:   STOPPED"
    fi
  done

  if [ -f "$UI_PIDFILE" ] && kill -0 "$(cat "$UI_PIDFILE")" 2>/dev/null; then
    local http_status="DOWN"
    if curl -sI "http://localhost:$UI_PORT/ui/" 2>/dev/null | grep -q "200 OK"; then
      http_status="OK"
    fi
    echo "node-ui:  RUNNING (PID $(cat "$UI_PIDFILE"), http://localhost:$UI_PORT/ui/, HTTP $http_status)"
  else
    echo "node-ui:  STOPPED  (start with: $0 ui start)"
  fi
}

cmd_logs() {
  local node_num="${2:-1}"
  local log_file="$DEVNET_DIR/node${node_num}/daemon.log"
  if [ ! -f "$log_file" ]; then
    log "No log file for node $node_num"
    return 1
  fi
  tail -f "$log_file"
}

cmd_clean() {
  cmd_stop
  log "Wiping devnet data..."
  rm -rf "$DEVNET_DIR"
  log "Clean."
}

# Bring up an additional node against an already-running devnet. The node's
# config + wallets are generated and the daemon is started, but on-chain
# wiring (createConviction, updateAsk, sharding-table membership) is left to
# the caller — the v10-stress-devnet experiment does this from the test
# itself so it can assert on every step.
#
# Usage: devnet.sh addnode <num> [core|edge]
cmd_addnode() {
  local node_num="${2:-}"
  local role="${3:-core}"
  if [ -z "$node_num" ]; then
    echo "Usage: $0 addnode <num> [core|edge]"
    exit 1
  fi
  if [ "$node_num" -lt 1 ] || [ "$node_num" -gt 10 ]; then
    echo "[devnet] node_num must be 1..10 (HARDHAT_KEYS array bound)"
    exit 1
  fi
  if [ -d "$DEVNET_DIR/node${node_num}" ]; then
    echo "[devnet] node${node_num} already exists at $DEVNET_DIR/node${node_num}"
    exit 1
  fi
  case "$role" in
    core|edge) ;;
    *) echo "[devnet] role must be 'core' or 'edge'"; exit 1 ;;
  esac
  local hardhat_pid
  hardhat_pid=$(refresh_hardhat_pidfile || true)
  if [ -z "$hardhat_pid" ]; then
    echo "[devnet] Hardhat is not running. Start the devnet first with: $0 start <N>"
    exit 1
  fi

  log "Adding node $node_num (role=$role)..."
  DEVNET_NODE_ROLE_OVERRIDE="$role" create_node_config "$node_num"

  # Reuse the cluster's shared auth token so the test can talk to the new
  # node with the same bearer used everywhere else.
  if [ -f "$DEVNET_DIR/node1/auth.token" ]; then
    local shared_token
    shared_token=$(grep -v '^#' "$DEVNET_DIR/node1/auth.token" | head -1)
    if [ -n "$shared_token" ]; then
      printf '# DKG devnet shared auth token\n%s\n' "$shared_token" \
        > "$DEVNET_DIR/node${node_num}/auth.token"
      chmod 600 "$DEVNET_DIR/node${node_num}/auth.token"
    fi
  fi

  cd "$REPO_ROOT" || exit 1
  start_node "$node_num"
  log "Node $node_num up. On-chain wiring (createConviction/updateAsk) is the caller's responsibility."
}

# Restart a single already-existing devnet node. Preserves on-chain
# state, wallets, store backends, and CG metadata — just bounces the
# daemon process so it picks up newly-built code.
#
# Usage: devnet.sh restart-node <num>
cmd_restart_node() {
  local node_num="${2:-}"
  if [ -z "$node_num" ]; then
    echo "Usage: $0 restart-node <num>"
    exit 1
  fi
  if [ ! -d "$DEVNET_DIR/node${node_num}" ]; then
    echo "[devnet] node${node_num} does not exist at $DEVNET_DIR/node${node_num} — start the devnet first."
    exit 1
  fi
  stop_devnet_node_processes "$node_num"
  cd "$REPO_ROOT" || exit 1
  start_node "$node_num"
  log "Node $node_num restarted."
}

# Stop a single already-existing devnet node. Preserves on-chain state,
# wallets, store backends, and CG metadata. Unlike ad-hoc pidfile kills,
# this uses the same process discovery as full devnet shutdown so detached
# daemon children and managed stores cannot keep the API port alive.
#
# Usage: devnet.sh stop-node <num>
cmd_stop_node() {
  local node_num="${2:-}"
  if [ -z "$node_num" ]; then
    echo "Usage: $0 stop-node <num>"
    exit 1
  fi
  if [ ! -d "$DEVNET_DIR/node${node_num}" ]; then
    echo "[devnet] node${node_num} does not exist at $DEVNET_DIR/node${node_num} — start the devnet first."
    exit 1
  fi
  stop_devnet_node_processes "$node_num"
  log "Node $node_num stopped."
}

if [ "${DEVNET_SOURCE_ONLY:-0}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

case "${1:-}" in
  start)            cmd_start ;;
  addnode)          cmd_addnode "$@" ;;
  stop-node)        cmd_stop_node "$@" ;;
  restart-node)     cmd_restart_node "$@" ;;
  prepare-version)  cmd_prepare_version "$@" ;;
  stop)         cmd_stop ;;
  status)       cmd_status ;;
  logs)         cmd_logs "$@" ;;
  clean)        cmd_clean ;;
  ui)           cmd_ui "$@" ;;
  *)
    echo "Usage: $0 {start|addnode|stop|status|logs|clean|ui} [args]"
    echo ""
    echo "  start [N]               Start devnet with N nodes (default 6)"
    echo "  addnode <num> [core|edge]  Spawn one more node against the running"
    echo "                          devnet (mid-run sync test). Caller drives"
    echo "                          on-chain identity/stake/ask. (1 <= num <= 10)"
    echo "  restart-node <num>      Restart a single already-existing devnet node"
    echo "                          (pick up new code without rebuilding state)"
    echo "  prepare-version [ref]   Check out + build an alternate version (default"
    echo "                          'prev' = latest release tag) for mixed-version"
    echo "                          runs. See DEVNET_VERSION_LAYOUT."
    echo "  stop                    Stop all devnet processes (incl. UI)"
    echo "  status                  Show running nodes (incl. UI) and their status"
    echo "  logs [N]                Tail logs for node N (default 1)"
    echo "  clean                   Stop and wipe all devnet data"
    echo "  ui {start|stop|restart|status|logs}"
    echo "               Control the node-ui Vite dev server (port \$UI_PORT,"
    echo "               default 5173). Detached via nohup so it survives"
    echo "               shell death (the SIGHUP cascade that kept killing"
    echo "               the UI when run from a Cursor agent terminal)."
    exit 1
    ;;
esac
