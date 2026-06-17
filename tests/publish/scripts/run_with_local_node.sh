#!/usr/bin/env bash
#
# One-command local v10 run: START your local DKG node -> run the v10 publish
# test -> SHUT THE NODE DOWN (always, via a trap — even if the test fails).
#
# Reads from .env (tests/publish/.env):
#   DKG_API_URL          used to derive the API port (default http://127.0.0.1:9200)
#   LOCAL_NODE_DKG_HOME  the node's DKG_HOME (e.g. /Users/you/dkg-qa-testnet-c)
#   LOCAL_NODE_CLI       path to the monorepo cli.js (e.g. /Users/you/dkg/packages/cli/dist/cli.js)
# Optional: LOCAL_NODE_LOG (default /tmp/dkg-local-node.log), LOCAL_NODE_MESH_MIN (default 2)
#
# If a node is already on the API port, it is USED as-is (not started/stopped).
set -u
cd "$(dirname "$0")/.."   # tests/publish/

env_get() { grep -m1 -E "^$1=" .env 2>/dev/null | cut -d= -f2- ; }

API_URL="$(env_get DKG_API_URL)"; API_URL="${API_URL:-${DKG_API_URL:-http://127.0.0.1:9200}}"
PORT="$(printf '%s' "$API_URL" | sed -E 's#.*:([0-9]+).*#\1#')"; PORT="${PORT:-9200}"
DKG_HOME_VAL="$(env_get LOCAL_NODE_DKG_HOME)"
CLI_VAL="$(env_get LOCAL_NODE_CLI)"
LOGF="$(env_get LOCAL_NODE_LOG)"; LOGF="${LOGF:-/tmp/dkg-local-node.log}"
MESH_MIN="$(env_get LOCAL_NODE_MESH_MIN)"; MESH_MIN="${MESH_MIN:-2}"

STARTED_BY_US=false
NODE_PID=""
status_code() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/status" 2>/dev/null || echo 000; }
peers_now()  { curl -s "http://127.0.0.1:$PORT/api/status" 2>/dev/null | grep -oE '"connectedPeers":[0-9]+' | grep -oE '[0-9]+' | head -1; }

cleanup() {
  if [ "$STARTED_BY_US" = true ]; then
    echo ""
    echo "▼ Shutting down the local node we started ..."
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill 2>/dev/null || true
    [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true
    sleep 3
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null || true
    echo "▼ Node stopped."
  fi
}
trap cleanup EXIT INT TERM

if [ "$(status_code)" = "200" ]; then
  echo "● A node is already up on :$PORT — using it (will NOT start/stop it)."
else
  : "${DKG_HOME_VAL:?Set LOCAL_NODE_DKG_HOME in .env (the node DKG_HOME); no node is running on :$PORT to use}"
  : "${CLI_VAL:?Set LOCAL_NODE_CLI in .env (path to packages/cli/dist/cli.js)}"
  echo "▲ Starting local node (DKG_HOME=$DKG_HOME_VAL, port $PORT) ..."
  DKG_HOME="$DKG_HOME_VAL" DKG_NO_BLUE_GREEN=1 node "$CLI_VAL" start > "$LOGF" 2>&1 &
  NODE_PID=$!
  STARTED_BY_US=true
  echo "  launcher pid $NODE_PID, log: $LOGF"

  echo -n "  waiting for API"
  for _ in $(seq 1 90); do
    [ "$(status_code)" = "200" ] && { echo " ready."; break; }
    echo -n "."; sleep 2
  done
  [ "$(status_code)" = "200" ] || { echo " TIMEOUT — node never came up (see $LOGF)"; exit 1; }

  echo -n "  waiting for mesh (>=$MESH_MIN peers)"
  for _ in $(seq 1 45); do
    p="$(peers_now)"; p="${p:-0}"
    [ "$p" -ge "$MESH_MIN" ] 2>/dev/null && { echo " ok ($p peers)."; break; }
    echo -n "."; sleep 2
  done
fi

echo "▶ Running v10 publish test ..."
npx mocha src/v10-publish-test.spec.js --timeout 7200000 --exit
# cleanup() runs on exit and stops the node if we started it.
