#!/bin/bash
# Local fleet (M3 substitute — no VPS required): spawns our own DKG edge nodes
# INSIDE the Jenkins job container and runs the layered suite against them,
# including a VERSION-PINNED CONTROL node. This is what gives us release
# attribution ("only the new version degraded") without waiting for hardware.
#
# The Jenkins agent has 12 CPU / 32 GB / ~600 GB free, and reaches the testnet
# beacons over Tailscale, so 3 local edges are comfortable.
#
#   RC_FLEET_VERSION        version for publisher+receiver (default: testnet dist-tag)
#   RC_FLEET_CONTROL_VERSION  pinned older version for the control node
#                             (default: previous patch of RC_FLEET_VERSION; empty = skip control)
#   RC_FLEET_BASE_PORT      default 9411
#   RC_FLEET_CG             CG to publish into (default: this week's public CG)
set -euo pipefail

BASE_PORT="${RC_FLEET_BASE_PORT:-9411}"
WS="${WORKSPACE:-$(pwd)}/rc-fleet"
HARNESS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"   # tests/publish

TESTNET_VERSION="$(npm view @origintrail-official/dkg dist-tags.testnet 2>/dev/null || echo '')"
FLEET_VERSION="${RC_FLEET_VERSION:-$TESTNET_VERSION}"
# previous patch, e.g. 10.0.11 -> 10.0.10 (crude but right for our release line)
DEFAULT_CONTROL="$(echo "$FLEET_VERSION" | awk -F. '{ if ($3 > 0) printf "%s.%s.%d", $1, $2, $3-1 }')"
CONTROL_VERSION="${RC_FLEET_CONTROL_VERSION-$DEFAULT_CONTROL}"

echo "🚢 local fleet: publisher+receiver v${FLEET_VERSION}, control v${CONTROL_VERSION:-<none>}"
rm -rf "$WS"; mkdir -p "$WS"

declare -A HOME_OF PORT_OF BIN_OF TOKEN_OF
PORT_OF[publisher]=$BASE_PORT
PORT_OF[receiver]=$((BASE_PORT+1))
PORT_OF[control]=$((BASE_PORT+2))

install_version() { # version -> prints bin path
  local v="$1" dir="$WS/pkg-$v"
  if [ ! -x "$dir/node_modules/.bin/dkg" ]; then
    mkdir -p "$dir"; ( cd "$dir" && npm install --no-audit --no-fund --loglevel=error "@origintrail-official/dkg@$v" >/dev/null 2>&1 )
  fi
  echo "$dir/node_modules/.bin/dkg"
}

start_node() { # role version
  local role="$1" version="$2" home="$WS/home-$role" port="${PORT_OF[$role]}"
  local bin; bin="$(install_version "$version")"
  mkdir -p "$home"
  cat > "$home/config.json" <<EOF
{ "name": "rc-fleet-$role-$(date -u +%H%M%S)", "nodeRole": "edge", "networkConfig": "testnet", "apiPort": $port, "store": { "backend": "oxigraph" } }
EOF
  HOME_OF[$role]="$home"; BIN_OF[$role]="$bin"
  DKG_HOME="$home" nohup "$bin" start -f > "$WS/$role.log" 2>&1 &
  echo $! > "$WS/$role.pid"
  echo "• $role starting (v$version, port $port)"
}

wait_node() { # role
  local role="$1" port="${PORT_OF[$1]}"
  for _ in $(seq 1 72); do
    if curl -sf -m 4 "http://127.0.0.1:$port/api/status" > /dev/null; then
      TOKEN_OF[$role]="$(cat "${HOME_OF[$role]}/auth.token")"
      echo "✅ $role up on :$port"
      return 0
    fi
    sleep 5
  done
  echo "❌ $role never came up"; tail -30 "$WS/$role.log"; return 1
}

cleanup() {
  for role in "${!HOME_OF[@]}"; do
    DKG_HOME="${HOME_OF[$role]}" "${BIN_OF[$role]}" stop >/dev/null 2>&1 || kill "$(cat "$WS/$role.pid" 2>/dev/null)" 2>/dev/null || true
  done
}
trap cleanup EXIT

ROLES=(publisher receiver)
[ -n "$CONTROL_VERSION" ] && ROLES+=(control)

for role in "${ROLES[@]}"; do
  if [ "$role" = "control" ]; then start_node "$role" "$CONTROL_VERSION"; else start_node "$role" "$FLEET_VERSION"; fi
done
for role in "${ROLES[@]}"; do wait_node "$role"; done

# Fund every fresh node's wallets from the testnet faucet (fresh homes start empty).
for role in "${ROLES[@]}"; do
  echo "💰 funding $role"
  TESTNET1_API_URL="http://127.0.0.1:${PORT_OF[$role]}" V10_TOKEN_TESTNET1="${TOKEN_OF[$role]}" \
    node "$HARNESS_DIR/scripts/ensure_wallets_funded.mjs" || echo "⚠️ funding step reported an issue for $role (continuing; publishes may fail)"
done

CG="${RC_FLEET_CG:-}"
if [ -z "$CG" ]; then
  CG="$(node -e "import('$HARNESS_DIR/scripts/release_cert/layered_suite.mjs').then(m => console.log(m.weeklyCgNames().public))")"
fi
echo "• target CG: $CG"

# Receiver (and control) subscribe so the SWM receiver-verification leg is real.
for role in receiver ${CONTROL_VERSION:+control}; do
  curl -sf -X POST "http://127.0.0.1:${PORT_OF[$role]}/api/context-graph/subscribe" \
    -H "Authorization: Bearer ${TOKEN_OF[$role]}" -H 'Content-Type: application/json' \
    -d "{\"contextGraphId\":\"$CG\",\"includeSharedMemory\":true}" > /dev/null && echo "• $role subscribed"
done

run_layered() { # publisherRole receiverRole tag
  local p="$1" r="$2" tag="$3"
  echo "▶️  layered run [$tag]"
  RC_PUBLISHER_URL="http://127.0.0.1:${PORT_OF[$p]}" RC_PUBLISHER_TOKEN_ENV=RC_TOK_P \
  RC_RECEIVER_URL="http://127.0.0.1:${PORT_OF[$r]}" RC_RECEIVER_TOKEN_ENV=RC_TOK_R \
  RC_TOK_P="${TOKEN_OF[$p]}" RC_TOK_R="${TOKEN_OF[$r]}" \
  RC_CG_PUBLIC="$CG" RC_NODE_LABEL="$tag" \
    node "$HARNESS_DIR/scripts/release_cert/layered_suite.mjs" || echo "⚠️ layered run [$tag] reported failures (recorded)"
}

run_layered publisher receiver "fleet-current"
if [ -n "$CONTROL_VERSION" ]; then
  run_layered control receiver "fleet-control-v$CONTROL_VERSION"
fi

echo "✅ local fleet run complete"
