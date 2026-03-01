#!/usr/bin/env bash
#
# Local DKG Devnet — spins up a Hardhat chain + N DKG nodes for local testing.
#
# Usage:
#   ./scripts/devnet.sh start [N]   Start devnet with N nodes (default 5)
#   ./scripts/devnet.sh stop         Stop all devnet processes
#   ./scripts/devnet.sh status       Show running devnet processes
#   ./scripts/devnet.sh logs [N]     Tail logs for node N (1-based)
#   ./scripts/devnet.sh clean        Stop and wipe all devnet data
#
# Environment:
#   DEVNET_DIR    Base directory for devnet data (default: .devnet)
#   HARDHAT_PORT  Hardhat node port (default: 8545)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
HARDHAT_PORT="${HARDHAT_PORT:-8545}"
NUM_NODES="${2:-5}"
API_PORT_BASE=9201
LIBP2P_PORT_BASE=10001

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

ensure_built() {
  if [ ! -f "$REPO_ROOT/packages/cli/dist/cli.js" ]; then
    log "Building project..."
    cd "$REPO_ROOT" && pnpm run build
  fi
}

start_hardhat() {
  local pidfile="$DEVNET_DIR/hardhat.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "Hardhat node already running (PID $(cat "$pidfile"))"
    return 0
  fi

  log "Starting Hardhat node on port $HARDHAT_PORT..."
  mkdir -p "$DEVNET_DIR/hardhat"

  cd "$REPO_ROOT/packages/evm-module"
  npx hardhat node --port "$HARDHAT_PORT" \
    > "$DEVNET_DIR/hardhat/node.log" 2>&1 &
  local hh_pid=$!
  echo "$hh_pid" > "$pidfile"
  log "Hardhat node started (PID $hh_pid)"

  # Wait for it to be ready
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$HARDHAT_PORT" \
         -X POST -H "Content-Type: application/json" \
         -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
         > /dev/null 2>&1; then
      log "Hardhat node ready"
      return 0
    fi
    sleep 1
  done

  log "ERROR: Hardhat node failed to start within 30s"
  return 1
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
    npx hardhat deploy --network localhost \
    > "$DEVNET_DIR/hardhat/deploy.log" 2>&1

  # Extract Hub address from deployment
  local hub_addr
  hub_addr=$(grep -o '"Hub":"0x[a-fA-F0-9]*"' "$REPO_ROOT/packages/evm-module/deployments/hardhat_contracts.json" 2>/dev/null \
    | head -1 | cut -d'"' -f4 || echo "")

  if [ -z "$hub_addr" ]; then
    # Try alternate extraction from deploy log
    hub_addr=$(grep "Hub deployed" "$DEVNET_DIR/hardhat/deploy.log" 2>/dev/null \
      | grep -o '0x[a-fA-F0-9]*' | head -1 || echo "")
  fi

  if [ -z "$hub_addr" ]; then
    log "WARNING: Could not extract Hub address. Check $DEVNET_DIR/hardhat/deploy.log"
    hub_addr="0x0000000000000000000000000000000000000000"
  fi

  echo "$hub_addr" > "$DEVNET_DIR/hardhat/hub_address"
  touch "$marker"
  log "Contracts deployed. Hub address: $hub_addr"
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

  # Node 1 is the relay
  if [ "$node_num" -eq 1 ]; then
    node_role="core"
  fi

  # Create config
  cat > "$node_dir/config.json" <<EOCONF
{
  "name": "devnet-node-${node_num}",
  "apiPort": ${api_port},
  "listenPort": ${libp2p_port},
  "nodeRole": "${node_role}",
  "paranets": ["devnet-test"],
  "chain": {
    "type": "evm",
    "rpcUrl": "http://127.0.0.1:${HARDHAT_PORT}",
    "hubAddress": "${hub_addr}",
    "chainId": "evm:31337"
  }
}
EOCONF

  # Create wallets.json with hardhat key
  cat > "$node_dir/wallets.json" <<EOWAL
{
  "wallets": [
    {
      "privateKey": "${HARDHAT_KEYS[$key_idx]}",
      "address": "auto"
    }
  ]
}
EOWAL

  log "Node $node_num config: port=$api_port, libp2p=$libp2p_port, role=$node_role"
}

start_node() {
  local node_num="$1"
  local node_dir="$DEVNET_DIR/node${node_num}"
  local pidfile="$node_dir/daemon.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "Node $node_num already running (PID $(cat "$pidfile"))"
    return 0
  fi

  local relay_arg=""
  if [ "$node_num" -gt 1 ] && [ -f "$DEVNET_DIR/node1/multiaddr" ]; then
    relay_arg=$(cat "$DEVNET_DIR/node1/multiaddr")
  fi

  # Update config with relay address if available
  if [ -n "$relay_arg" ]; then
    # Use node to patch JSON (portable)
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$node_dir/config.json','utf8'));
      cfg.relay = '$relay_arg';
      fs.writeFileSync('$node_dir/config.json', JSON.stringify(cfg, null, 2));
    "
  fi

  log "Starting node $node_num..."
  DKG_HOME="$node_dir" \
    node "$REPO_ROOT/packages/cli/dist/cli.js" start --foreground \
    > "$node_dir/daemon.log" 2>&1 &
  local node_pid=$!
  echo "$node_pid" > "$pidfile"

  # Wait for API to be ready
  local api_port=$((API_PORT_BASE + node_num - 1))
  for i in $(seq 1 20); do
    if curl -s "http://127.0.0.1:$api_port/api/status" > /dev/null 2>&1; then
      log "Node $node_num ready (PID $node_pid, API http://127.0.0.1:$api_port)"

      # For node 1 (relay), save its multiaddr so other nodes can connect
      if [ "$node_num" -eq 1 ]; then
        local peer_info
        peer_info=$(curl -s "http://127.0.0.1:$api_port/api/status" 2>/dev/null || echo "{}")
        local peer_id
        peer_id=$(echo "$peer_info" | node -e "
          let d=''; process.stdin.on('data',c=>d+=c);
          process.stdin.on('end',()=>{
            try{const j=JSON.parse(d);console.log(j.peerId||'')}catch{console.log('')}
          })
        " 2>/dev/null || echo "")

        if [ -n "$peer_id" ]; then
          local libp2p_port=$((LIBP2P_PORT_BASE))
          echo "/ip4/127.0.0.1/tcp/${libp2p_port}/p2p/${peer_id}" > "$DEVNET_DIR/node1/multiaddr"
          log "Relay multiaddr saved: /ip4/127.0.0.1/tcp/${libp2p_port}/p2p/${peer_id}"
        fi
      fi
      return 0
    fi
    sleep 1
  done

  log "WARNING: Node $node_num not ready after 20s (check $node_dir/daemon.log)"
}

cmd_start() {
  log "Starting devnet with $NUM_NODES nodes..."
  mkdir -p "$DEVNET_DIR"

  ensure_built
  start_hardhat
  deploy_contracts

  # Create all node configs
  for i in $(seq 1 "$NUM_NODES"); do
    create_node_config "$i"
  done

  # Start node 1 (relay) first, then the rest
  start_node 1

  for i in $(seq 2 "$NUM_NODES"); do
    start_node "$i"
  done

  log ""
  log "=== Devnet Ready ==="
  log ""
  log "Hardhat RPC:  http://127.0.0.1:$HARDHAT_PORT"
  for i in $(seq 1 "$NUM_NODES"); do
    local api_port=$((API_PORT_BASE + i - 1))
    local role="edge"
    [ "$i" -eq 1 ] && role="relay"
    log "Node $i ($role): http://127.0.0.1:$api_port/ui"
  done
  log ""
  log "Hub address:  $(cat "$DEVNET_DIR/hardhat/hub_address" 2>/dev/null || echo 'unknown')"
  log ""
  log "To stop:      ./scripts/devnet.sh stop"
  log "To view logs: ./scripts/devnet.sh logs <node_num>"
}

cmd_stop() {
  log "Stopping devnet..."

  # Stop nodes
  for pidfile in "$DEVNET_DIR"/node*/daemon.pid; do
    [ -f "$pidfile" ] || continue
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "Stopped node (PID $pid)"
    fi
    rm -f "$pidfile"
  done

  # Stop hardhat
  if [ -f "$DEVNET_DIR/hardhat.pid" ]; then
    local pid
    pid=$(cat "$DEVNET_DIR/hardhat.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "Stopped Hardhat (PID $pid)"
    fi
    rm -f "$DEVNET_DIR/hardhat.pid"
  fi

  log "Devnet stopped."
}

cmd_status() {
  echo "=== Devnet Status ==="

  if [ -f "$DEVNET_DIR/hardhat.pid" ] && kill -0 "$(cat "$DEVNET_DIR/hardhat.pid")" 2>/dev/null; then
    echo "Hardhat:  RUNNING (PID $(cat "$DEVNET_DIR/hardhat.pid"), port $HARDHAT_PORT)"
  else
    echo "Hardhat:  STOPPED"
  fi

  for node_dir in "$DEVNET_DIR"/node*; do
    [ -d "$node_dir" ] || continue
    local node_num
    node_num=$(basename "$node_dir" | sed 's/node//')
    local api_port=$((API_PORT_BASE + node_num - 1))
    local pidfile="$node_dir/daemon.pid"

    if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
      local status_json
      status_json=$(curl -s "http://127.0.0.1:$api_port/api/status" 2>/dev/null || echo "{}")
      local peer_id
      peer_id=$(echo "$status_json" | node -e "
        let d=''; process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
          try{const j=JSON.parse(d);console.log(j.peerId?.slice(0,16)||'??')}catch{console.log('??')}
        })
      " 2>/dev/null || echo "??")
      echo "Node $node_num:   RUNNING (PID $(cat "$pidfile"), API :$api_port, peer ${peer_id}...)"
    else
      echo "Node $node_num:   STOPPED"
    fi
  done
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

case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   cmd_logs "$@" ;;
  clean)  cmd_clean ;;
  *)
    echo "Usage: $0 {start|stop|status|logs|clean} [args]"
    echo ""
    echo "  start [N]    Start devnet with N nodes (default 5)"
    echo "  stop         Stop all devnet processes"
    echo "  status       Show running nodes and their status"
    echo "  logs [N]     Tail logs for node N (default 1)"
    echo "  clean        Stop and wipe all devnet data"
    exit 1
    ;;
esac
