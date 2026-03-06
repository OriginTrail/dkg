#!/usr/bin/env bash
#
# Start 3 local DKG nodes for OriginTrail Game local play.
# No chain needed — game coordination works via gossipsub only.
#
# Usage:
#   ./scripts/play-local.sh start   Start 3 nodes
#   ./scripts/play-local.sh stop    Stop all nodes
#   ./scripts/play-local.sh status  Show running nodes
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Resolve monorepo root: scripts -> origin-trail-game -> packages -> dkg-v9
DKG_V9_ROOT="$(cd "$OT_ROOT/../.." && pwd)"
CLI_JS="$DKG_V9_ROOT/packages/cli/dist/cli.js"
PLAY_DIR="$OT_ROOT/.play-nodes"
AUTH_TOKEN="origin-trail-game-local-play"
NUM_NODES=3

log() { echo "[origin-trail-game] $*"; }

create_node() {
  local n=$1
  local api_port=$((19200 + n - 1))
  local p2p_port=$((19300 + n - 1))
  local dir="$PLAY_DIR/node${n}"
  mkdir -p "$dir"

  local role="edge"
  local relay_line=""
  if [ "$n" -eq 1 ]; then
    role="core"
    relay_line='"relay": "none",'
  fi

  cat > "$dir/config.json" <<EOF
{
  "name": "ot-player-${n}",
  "apiPort": ${api_port},
  "listenPort": ${p2p_port},
  "nodeRole": "${role}",
  ${relay_line}
  "paranets": ["origin-trail-game"],
  "auth": { "enabled": true, "tokens": ["${AUTH_TOKEN}"] }
}
EOF

  echo "$AUTH_TOKEN" > "$dir/auth.token"
  log "Node $n configured: API=http://127.0.0.1:${api_port} P2P=${p2p_port}"
}

start_nodes() {
  if [ ! -f "$CLI_JS" ]; then
    log "ERROR: dkg-v9 CLI not built. Run: cd $DKG_V9_ROOT && pnpm run build"
    exit 1
  fi

  # Clean up old nodes
  stop_nodes 2>/dev/null || true
  rm -rf "$PLAY_DIR"
  mkdir -p "$PLAY_DIR"

  # Create configs
  for n in $(seq 1 $NUM_NODES); do
    create_node "$n"
  done

  # Start node 1 (relay) — must run from dkg-v9 root so app loader finds origin-trail-game
  log "Starting node 1 (relay)..."
  (cd "$DKG_V9_ROOT" && DKG_HOME="$PLAY_DIR/node1" node "$CLI_JS" start --foreground) \
    > "$PLAY_DIR/node1/daemon.log" 2>&1 &
  echo $! > "$PLAY_DIR/node1/play.pid"

  # Wait for node 1
  local api1=19200
  for i in $(seq 1 30); do
    if curl -s "http://127.0.0.1:$api1/api/status" > /dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  # Get node 1 multiaddr
  local status
  status=$(curl -s "http://127.0.0.1:$api1/api/status" 2>/dev/null)
  local peer_id
  peer_id=$(echo "$status" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).peerId)}catch{console.log('')}})")
  local relay="/ip4/127.0.0.1/tcp/19300/p2p/${peer_id}"
  log "Node 1 ready (relay=$relay)"

  # Start nodes 2..N with relay
  for n in $(seq 2 $NUM_NODES); do
    local dir="$PLAY_DIR/node${n}"
    node -e "
      const fs=require('fs');
      const cfg=JSON.parse(fs.readFileSync('$dir/config.json','utf8'));
      cfg.relay='$relay';
      fs.writeFileSync('$dir/config.json',JSON.stringify(cfg,null,2));
    "

    log "Starting node $n..."
    (cd "$DKG_V9_ROOT" && DKG_HOME="$dir" node "$CLI_JS" start --foreground) \
      > "$dir/daemon.log" 2>&1 &
    echo $! > "$dir/play.pid"
  done

  # Wait for all nodes
  for n in $(seq 2 $NUM_NODES); do
    local port=$((19200 + n - 1))
    for i in $(seq 1 20); do
      if curl -s "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done
    log "Node $n ready"
  done

  sleep 2
  echo ""
  log "=== All $NUM_NODES nodes running! ==="
  echo ""
  log "Open these URLs in 3 separate browser tabs:"
  for n in $(seq 1 $NUM_NODES); do
    local port=$((19200 + n - 1))
    echo "  Player $n: http://127.0.0.1:${port}/apps/origin-trail-game/"
  done
  echo ""
  log "Auth token for API calls: $AUTH_TOKEN"
  log "Node UI (any node):      http://127.0.0.1:19200/ui"
  log "Stop with:               ./scripts/play-local.sh stop"
  log "Logs in:                 $PLAY_DIR/node{1,2,3}/daemon.log"
}

stop_nodes() {
  for n in $(seq 1 $NUM_NODES); do
    local pidfile="$PLAY_DIR/node${n}/play.pid"
    if [ -f "$pidfile" ]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null || true
        log "Stopped node $n (PID $pid)"
      fi
    fi
  done
  # Kill any stragglers on API and P2P ports
  for n in $(seq 1 $NUM_NODES); do
    for base in 19200 19300; do
      local port=$((base + n - 1))
      local pid
      pid=$(lsof -ti ":$port" 2>/dev/null || true)
      [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
  done
  # Wait for ports to actually be released
  for n in $(seq 1 $NUM_NODES); do
    for base in 19200 19300; do
      local port=$((base + n - 1))
      for i in $(seq 1 15); do
        if ! lsof -ti ":$port" > /dev/null 2>&1; then break; fi
        sleep 0.5
      done
    done
  done
  log "All nodes stopped"
}

show_status() {
  for n in $(seq 1 $NUM_NODES); do
    local port=$((19200 + n - 1))
    if curl -s "http://127.0.0.1:$port/api/status" > /dev/null 2>&1; then
      log "Node $n: RUNNING on http://127.0.0.1:$port"
    else
      log "Node $n: not running"
    fi
  done
}

case "${1:-start}" in
  start)  start_nodes ;;
  stop)   stop_nodes ;;
  status) show_status ;;
  *)      echo "Usage: $0 {start|stop|status}"; exit 1 ;;
esac
