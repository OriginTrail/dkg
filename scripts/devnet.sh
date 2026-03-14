#!/usr/bin/env bash
#
# Local DKG Devnet — spins up a Hardhat chain + N DKG nodes for local testing.
#
# Usage:
#   ./scripts/devnet.sh start [N]   Start devnet with N nodes (default 6)
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
NUM_NODES="${2:-6}"
API_PORT_BASE=9201
LIBP2P_PORT_BASE=10001
NUM_OP_WALLETS=3
BLAZEGRAPH_PORT=9999
BLAZEGRAPH_CONTAINER="devnet-blazegraph"
OXIGRAPH_SERVER_PORT_5=7878
OXIGRAPH_SERVER_PORT_6=7879
OXIGRAPH_CONTAINER_5="devnet-oxigraph-5"
OXIGRAPH_CONTAINER_6="devnet-oxigraph-6"

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

start_hardhat() {
  local pidfile="$DEVNET_DIR/hardhat.pid"

  if [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "Hardhat node already running (PID $(cat "$pidfile"))"
    return 0
  fi

  log "Starting Hardhat node on port $HARDHAT_PORT..."
  mkdir -p "$DEVNET_DIR/hardhat"

  cd "$REPO_ROOT/packages/evm-module"

  # Remove stale deployment artifacts + marker so the fresh chain starts clean
  rm -f "$REPO_ROOT/packages/evm-module/deployments/hardhat_contracts.json"
  rm -f "$REPO_ROOT/packages/evm-module/deployments/localhost_contracts.json"
  rm -f "$DEVNET_DIR/hardhat/deployed"

  npx hardhat node --port "$HARDHAT_PORT" --no-deploy \
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

  # Lower minimumRequiredSignatures to 1 for devnet (default is 3, but the
  # agent doesn't yet collect peer receiver signatures).
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
        await (await ps.setMinimumRequiredSignatures(1)).wait();
        console.log('minimumRequiredSignatures set to 1');
      })();
    " 2>&1 | while read -r line; do log "$line"; done
  fi

  touch "$marker"
  log "Contracts deployed. Hub address: $hub_addr"
}

BLAZEGRAPH_AVAILABLE=false

start_blazegraph() {
  if ! docker info > /dev/null 2>&1; then
    log "Docker not available — nodes 3-4 will use Oxigraph instead of Blazegraph"
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

  log "Starting Blazegraph (Docker) on port $BLAZEGRAPH_PORT..."
  if ! docker run -d --name "$BLAZEGRAPH_CONTAINER" \
    -p "$BLAZEGRAPH_PORT:8080" \
    lyrasis/blazegraph:2.1.5 > /dev/null 2>&1; then
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
          -d "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<properties>
  <entry key=\"com.bigdata.rdf.sail.namespace\">$ns</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.quads\">true</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.statementIdentifiers\">false</entry>
  <entry key=\"com.bigdata.rdf.store.AbstractTripleStore.textIndex\">false</entry>
  <entry key=\"com.bigdata.rdf.sail.truthMaintenance\">false</entry>
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
  if ! docker info > /dev/null 2>&1; then
    log "Docker not available — nodes 5-6 will use Oxigraph (in-process) instead of Oxigraph server"
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
  for name in $OXIGRAPH_CONTAINER_5 $OXIGRAPH_CONTAINER_6; do
    if docker inspect "$name" > /dev/null 2>&1; then
      docker rm -f "$name" > /dev/null 2>&1 || true
      log "Stopped Oxigraph server ($name)"
    fi
  done
}

stop_blazegraph() {
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

  # Node 1 is the relay
  if [ "$node_num" -eq 1 ]; then
    node_role="core"
  fi

  # All devnet nodes start with relay="none" to prevent falling back to testnet
  # relays from network/testnet.json. Nodes 2+ get their relay overridden in
  # start_node() to point at node 1's local multiaddr.
  local relay_value='"relay": "none",'

  # Backend assignment:
  #   Node 1-2: oxigraph-worker  (worker thread, file-persisted — production default)
  #   Node 3-4: oxigraph          (in-process, no worker thread — comparison baseline)
  #   Node 5-6: blazegraph        (remote SPARQL, if Docker available — else oxigraph-worker)
  local store_block=""
  if [ "$node_num" -ge 3 ] && [ "$node_num" -le 4 ]; then
    if [ "$BLAZEGRAPH_AVAILABLE" = true ]; then
      store_block="\"store\": { \"backend\": \"blazegraph\", \"options\": { \"url\": \"http://127.0.0.1:${BLAZEGRAPH_PORT}/bigdata/namespace/node${node_num}/sparql\" } },"
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

  # Create config
  cat > "$node_dir/config.json" <<EOCONF
{
  "name": "devnet-node-${node_num}",
  "apiPort": ${api_port},
  "listenPort": ${libp2p_port},
  "nodeRole": "${node_role}",
  ${relay_value}
  ${store_block}
  "paranets": ["devnet-test", "origin-trail-game"],
  ${devnet_auth_block}
  "chain": {
    "type": "evm",
    "rpcUrl": "http://127.0.0.1:${HARDHAT_PORT}",
    "hubAddress": "${hub_addr}",
    "chainId": "evm:31337"
  }
}
EOCONF

  # Generate wallets.json: primary Hardhat key + NUM_OP_WALLETS additional
  # operational wallets for parallel EVM transaction submission.
  # Run from a package that has 'ethers' so require() resolves (pnpm workspace).
  local extra_addrs
  extra_addrs=$(cd "$REPO_ROOT/packages/evm-module" && node -e "
    const crypto = require('crypto');
    const { ethers } = require('ethers');
    const fs = require('fs');
    const primary = new ethers.Wallet('${HARDHAT_KEYS[$key_idx]}');
    const wallets = [{ privateKey: '${HARDHAT_KEYS[$key_idx]}', address: primary.address }];
    for (let i = 0; i < ${NUM_OP_WALLETS}; i++) {
      const key = '0x' + crypto.randomBytes(32).toString('hex');
      const w = new ethers.Wallet(key);
      wallets.push({ privateKey: key, address: w.address });
    }
    fs.writeFileSync('$node_dir/wallets.json', JSON.stringify({ wallets }, null, 2));
    wallets.slice(1).forEach(w => console.log(w.address));
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

  # Update config with relay address if available
  if [ -n "$relay_arg" ]; then
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$node_dir/config.json','utf8'));
      cfg.relay = '$relay_arg';
      fs.writeFileSync('$node_dir/config.json', JSON.stringify(cfg, null, 2));
    "
  fi

  # Remove any stale daemon.pid so the CLI doesn't think it's already running
  rm -f "$node_dir/daemon.pid"

  log "Starting node $node_num..."
  DKG_HOME="$node_dir" \
    node "$REPO_ROOT/packages/cli/dist/cli.js" start --foreground \
    > "$node_dir/daemon.log" 2>&1 &
  local node_pid=$!
  echo "$node_pid" > "$pidfile"

  # Wait for API to be ready — relay node (1) gets extra time since first boot
  # compiles Solidity contracts which is CPU-intensive.
  local api_port=$((API_PORT_BASE + node_num - 1))
  local max_wait=30
  [ "$node_num" -eq 1 ] && max_wait=120
  local ready=false
  for i in $(seq 1 "$max_wait"); do
    if curl -s "http://127.0.0.1:$api_port/api/status" > /dev/null 2>&1; then
      log "Node $node_num ready (PID $node_pid, API http://127.0.0.1:$api_port)"
      ready=true
      break
    fi
    sleep 1
  done

  if [ "$ready" = false ]; then
    log "WARNING: Node $node_num not ready after ${max_wait}s (check $node_dir/daemon.log)"
  fi

  # For node 1 (relay), save its multiaddr so other nodes can connect.
  # Retry a few times even if initial wait timed out — node may still be booting.
  if [ "$node_num" -eq 1 ]; then
    local peer_id=""
    for attempt in $(seq 1 10); do
      local peer_info
      peer_info=$(curl -s "http://127.0.0.1:$api_port/api/status" 2>/dev/null || echo "{}")
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
      local libp2p_port=$((LIBP2P_PORT_BASE))
      echo "/ip4/127.0.0.1/tcp/${libp2p_port}/p2p/${peer_id}" > "$DEVNET_DIR/node1/multiaddr"
      log "Relay multiaddr saved: /ip4/127.0.0.1/tcp/${libp2p_port}/p2p/${peer_id}"
    else
      log "ERROR: Could not extract relay multiaddr for node 1 — aborting devnet start"
      return 1
    fi
  fi
}

stop_devnet_nodes_only() {
  # Stop DKG node processes only (leave Hardhat, Blazegraph, Oxigraph servers running).
  # Ensures the next start_node uses freshly written configs (e.g. store backends).
  for pidfile in "$DEVNET_DIR"/node*/devnet.pid; do
    [ -f "$pidfile" ] || continue
    local pid
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      log "Stopped node (PID $pid) for config refresh"
    fi
    rm -f "$pidfile"
  done
}

cmd_start() {
  log "Starting devnet with $NUM_NODES nodes..."
  mkdir -p "$DEVNET_DIR"

  ensure_built
  start_hardhat
  deploy_contracts
  start_blazegraph
  start_oxigraph_servers

  # Stop any already-running devnet nodes so they pick up the config we are about to write
  stop_devnet_nodes_only

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

  for i in $(seq 2 "$NUM_NODES"); do
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
      const staking  = new ethers.Contract(c('Staking'),         ['function stake(uint72,uint96)'], provider);
      const profile  = new ethers.Contract(c('Profile'),         ['function updateAsk(uint72,uint96)'], provider);

      const stakingAddr = c('Staking');
      const signers = await provider.listAccounts();
      const n = Math.min(signers.length, $NUM_NODES);

      // Wait up to 60s for ALL nodes to have identities, not just the first
      const nodeIds = new Array(n).fill(0n);
      for (let attempt = 0; attempt < 30; attempt++) {
        let allReady = true;
        for (let i = 0; i < n; i++) {
          if (nodeIds[i] === 0n) {
            nodeIds[i] = await identity.getIdentityId(signers[i].address);
          }
          if (nodeIds[i] === 0n) allReady = false;
        }
        if (allReady) break;
        const ready = nodeIds.filter(id => id > 0n).length;
        if (attempt % 5 === 4) console.log('Waiting for identities: ' + ready + '/' + n + ' ready...');
        await new Promise(r => setTimeout(r, 2000));
      }

      let staked = 0, asked = 0;
      for (let i = 0; i < n; i++) {
        const signer = signers[i];
        const idId = nodeIds[i] || await identity.getIdentityId(signer.address);
        if (idId === 0n) { console.log('Node ' + (i+1) + ': no identity after 60s, skipping'); continue; }

        const stakeAmount = ethers.parseEther('50000');
        const askAmount = ethers.parseEther('1');
        try {
          const deployer = await provider.getSigner(0);
          await (await token.connect(deployer).mint(signer.address, stakeAmount)).wait();
          await (await token.connect(signer).approve(stakingAddr, stakeAmount)).wait();
          await (await staking.connect(signer).stake(idId, stakeAmount)).wait();
          staked++;
        } catch (e) { console.log('Stake failed for node ' + (i+1) + ': ' + e.message); }

        // Set ask price
        try {
          await (await profile.connect(signer).updateAsk(idId, askAmount)).wait();
          asked++;
        } catch (e) { console.log('Ask failed for node ' + (i+1) + ': ' + e.message); }
      }
      console.log('Staked 50k TRAC for ' + staked + '/' + n + ' node(s), ask set for ' + asked + '/' + n);
    })();
  " 2>&1 | while read -r line; do log "$line"; done

  # Register paranets once from the deployer account so nodes don't each attempt it
  log "Registering paranets on-chain..."
  cd "$REPO_ROOT/packages/evm-module" && node -e "
    const { ethers } = require('ethers');
    const fs = require('fs');
    (async () => {
      const provider = new ethers.JsonRpcProvider('http://127.0.0.1:$HARDHAT_PORT');
      const deployer = await provider.getSigner(0);
      const contracts = JSON.parse(fs.readFileSync('$contracts_json', 'utf8'));
      const registryAddr = contracts.contracts.ParanetV9Registry?.evmAddress;
      if (!registryAddr) { console.log('ParanetV9Registry not deployed, skipping'); return; }
      const abi = JSON.parse(fs.readFileSync('$REPO_ROOT/packages/evm-module/abi/ParanetV9Registry.json', 'utf8'));
      const registry = new ethers.Contract(registryAddr, abi, deployer);
      const paranets = ['devnet-test', 'origin-trail-game'];
      for (const name of paranets) {
        const onChainId = ethers.keccak256(ethers.toUtf8Bytes(name));
        try {
          const tx = await registry.createParanetV9(onChainId, 0);
          await tx.wait();
          console.log('Registered paranet: ' + name + ' (' + onChainId.slice(0, 16) + '...)');
        } catch (e) {
          const data = e.data || e.message?.match(/data=\"(0x[0-9a-f]+)\"/)?.[1];
          if (data === '0x8f53dc71' || e.message?.includes('ParanetAlreadyExists')) {
            console.log('Paranet already exists: ' + name);
          } else {
            console.log('Failed to register ' + name + ': ' + e.message);
          }
        }
      }
    })();
  " 2>&1 | while read -r line; do log "$line"; done

  log ""
  log "=== Devnet Ready ==="
  log ""
  log "Hardhat RPC:  http://127.0.0.1:$HARDHAT_PORT"
  for i in $(seq 1 "$NUM_NODES"); do
    local api_port=$((API_PORT_BASE + i - 1))
    local role="edge"
    [ "$i" -eq 1 ] && role="relay"
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

  # Stop nodes
  for pidfile in "$DEVNET_DIR"/node*/devnet.pid; do
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

  stop_blazegraph
  stop_oxigraph_servers

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
    local pidfile="$node_dir/devnet.pid"

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
    echo "  start [N]    Start devnet with N nodes (default 6)"
    echo "  stop         Stop all devnet processes"
    echo "  status       Show running nodes and their status"
    echo "  logs [N]     Tail logs for node N (default 1)"
    echo "  clean        Stop and wipe all devnet data"
    exit 1
    ;;
esac
