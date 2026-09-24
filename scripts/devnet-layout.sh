#!/usr/bin/env bash
# Port layout of this checkout's local devnet, shared by scripts/devnet.sh and
# the scripts that drive a running devnet. Source it:
#
#   source "$(dirname "$0")/devnet-layout.sh"
#
# Several devnets can share a machine, so a devnet started on non-default ports
# must never be addressed on the defaults: those belong to the other devnet,
# and a funding call or a suite's storage writes would land on its chain. Each
# variable takes the first of:
#   1. the environment;
#   2. for HARDHAT_PORT, the port of a loopback DEVNET_RPC (the variable the
#      devnet suites read);
#   3. the layout `scripts/devnet.sh start` recorded in $DEVNET_DIR/ports.env
#      (`clean` removes it with the directory);
#   4. the built-in default.
#
# Sets HARDHAT_PORT, API_PORT_BASE, LIBP2P_PORT_BASE, DEVNET_DOCKER_NAME_PREFIX,
# DEVNET_BLAZEGRAPH_PORT, DEVNET_OXIGRAPH_SERVER_PORT_5/6, DEVNET_OXIGRAPH_BASE
# and DEVNET_RPC_URL (DEVNET_RPC, else http://127.0.0.1:$HARDHAT_PORT). Exits
# when DEVNET_RPC and HARDHAT_PORT name different loopback ports.

DEVNET_DIR="${DEVNET_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.devnet}"
DEVNET_LAYOUT_FILE="$DEVNET_DIR/ports.env"
DEVNET_LAYOUT_VARS="HARDHAT_PORT API_PORT_BASE LIBP2P_PORT_BASE DEVNET_DOCKER_NAME_PREFIX DEVNET_BLAZEGRAPH_PORT DEVNET_OXIGRAPH_SERVER_PORT_5 DEVNET_OXIGRAPH_SERVER_PORT_6 DEVNET_OXIGRAPH_BASE"

DEVNET_RPC_PORT=""
if [[ "${DEVNET_RPC:-}" =~ ^https?://(127\.0\.0\.1|localhost):([0-9]+)/?$ ]]; then
  DEVNET_RPC_PORT="${BASH_REMATCH[2]}"
fi
if [ -z "${HARDHAT_PORT:-}" ] && [ -n "$DEVNET_RPC_PORT" ]; then
  HARDHAT_PORT="$DEVNET_RPC_PORT"
fi
if [ -f "$DEVNET_LAYOUT_FILE" ]; then
  while IFS='=' read -r devnet_layout_key devnet_layout_value; do
    case " $DEVNET_LAYOUT_VARS " in
      *" $devnet_layout_key "*)
        [ -n "${!devnet_layout_key:-}" ] || printf -v "$devnet_layout_key" '%s' "$devnet_layout_value"
        ;;
    esac
  done < "$DEVNET_LAYOUT_FILE"
  unset devnet_layout_key devnet_layout_value
fi

HARDHAT_PORT="${HARDHAT_PORT:-8545}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
LIBP2P_PORT_BASE="${LIBP2P_PORT_BASE:-10001}"
DEVNET_DOCKER_NAME_PREFIX="${DEVNET_DOCKER_NAME_PREFIX:-devnet}"
DEVNET_BLAZEGRAPH_PORT="${DEVNET_BLAZEGRAPH_PORT:-9999}"
DEVNET_OXIGRAPH_SERVER_PORT_5="${DEVNET_OXIGRAPH_SERVER_PORT_5:-7878}"
DEVNET_OXIGRAPH_SERVER_PORT_6="${DEVNET_OXIGRAPH_SERVER_PORT_6:-7879}"
DEVNET_OXIGRAPH_BASE="${DEVNET_OXIGRAPH_BASE:-7900}"

if [ -n "$DEVNET_RPC_PORT" ] && [ "$DEVNET_RPC_PORT" != "$HARDHAT_PORT" ]; then
  echo "[devnet] ERROR: DEVNET_RPC ($DEVNET_RPC) and HARDHAT_PORT ($HARDHAT_PORT) name different ports." >&2
  exit 1
fi
DEVNET_RPC_URL="${DEVNET_RPC:-http://127.0.0.1:$HARDHAT_PORT}"

# Write the layout this devnet runs on; called by `scripts/devnet.sh start`.
write_devnet_layout() {
  mkdir -p "$DEVNET_DIR"
  {
    echo "# Written by scripts/devnet.sh start. devnet.sh and the scripts that source"
    echo "# scripts/devnet-layout.sh reuse these unless the environment overrides them."
    local var
    for var in $DEVNET_LAYOUT_VARS; do
      echo "$var=${!var}"
    done
  } > "$DEVNET_LAYOUT_FILE"
}
