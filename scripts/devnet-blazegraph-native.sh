#!/usr/bin/env bash
#
# Native (host-JVM) Blazegraph for a MIXED-backend devnet on Apple silicon.
#
# WHY: the official Blazegraph Docker image (lyrasis/blazegraph:2.1.5) is amd64-only
# and under qemu on arm64 macOS the JVM is effectively dead (observed: ~1s of CPU in
# 4 minutes). This boots the standalone 2.1.6 JAR on the host's NATIVE arm64 JVM
# instead (~6s to ready), then seeds the per-node quads namespaces devnet.sh expects.
#
# NB the 2.1.6 standalone JAR serves under the /blazegraph webapp context (the 2.1.5
# Docker image uses /bigdata) — so start the devnet with DEVNET_BLAZEGRAPH_CTX=blazegraph:
#
#   scripts/devnet-blazegraph-native.sh start          # boot + seed node3/node4
#   DEVNET_BLAZEGRAPH_CTX=blazegraph scripts/devnet.sh start 6
#   ...
#   scripts/devnet.sh stop
#   scripts/devnet-blazegraph-native.sh stop           # <-- devnet.sh does NOT own this
#
# Stop it after every devnet: `devnet.sh start` deploys a new chain and wipes
# each node's own store, but it cannot wipe a store it did not start. `start`
# here therefore boots on an EMPTY journal (BLAZEGRAPH_KEEP_JOURNAL=1 keeps the
# previous one), so a devnet never reads the graphs of the chain before it.
#
# Environment:
#   BLAZEGRAPH_JAR           an existing standalone JAR to run, instead of
#                            downloading one into .devnet/blazegraph-native
#   BLAZEGRAPH_PORT          port to listen on (default 9999, loopback only);
#                            start the devnet with the same DEVNET_BLAZEGRAPH_PORT
#   BLAZEGRAPH_HEAP          JVM heap limit (default 1g)
#   BLAZEGRAPH_NAMESPACES    namespaces to create (default "node3 node4")
#   BLAZEGRAPH_KEEP_JOURNAL  1 = keep the journal of the previous run
#
# Commands: start (default) | stop | status
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BZ_DIR="$REPO_ROOT/.devnet/blazegraph-native"
JAR="${BLAZEGRAPH_JAR:-$BZ_DIR/blazegraph-2.1.6.jar}"
PIDFILE="$BZ_DIR/blazegraph.pid"
LOG="$BZ_DIR/blazegraph.log"
PORT="${BLAZEGRAPH_PORT:-9999}"
CTX="blazegraph" # 2.1.6 standalone JAR webapp context
NAMESPACES="${BLAZEGRAPH_NAMESPACES:-node3 node4}"
JAR_URL="https://github.com/blazegraph/database/releases/download/BLAZEGRAPH_2_1_6_RC/blazegraph.jar"

log() { echo "[bz-native] $*"; }
status_url() { echo "http://127.0.0.1:$PORT/$CTX/status"; }
ns_url() { echo "http://127.0.0.1:$PORT/$CTX/namespace"; }
is_up() { curl -sf --max-time 4 "$(status_url)" >/dev/null 2>&1; }

seed_namespace() {
  local ns="$1"
  # Properties XML comes from the shared contract module (this script's old
  # inline copy had drifted: canonical wins, adding statementIdentifiers=false
  # and textIndex=false). Idempotent: 409 EXISTS is success.
  local xml
  xml=$(mktemp)
  if ! node "$REPO_ROOT/packages/cli/blazegraph-image-metadata.cjs" --namespace-xml "$ns" > "$xml"; then
    rm -f "$xml"
    log "namespace $ns: FATAL could not render namespace properties XML"
    return 1
  fi
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$(ns_url)" -H "Content-Type: application/xml" --data-binary "@$xml")
  rm -f "$xml"
  case "$code" in
    201) log "namespace $ns: created (quads)";;
    409) log "namespace $ns: already exists";;
    *)   log "namespace $ns: UNEXPECTED HTTP $code"; return 1;;
  esac
}

cmd_start() {
  mkdir -p "$BZ_DIR"
  if is_up; then
    log "already serving on :$PORT/$CTX — its namespaces keep what an earlier devnet wrote; run '$0 stop' first for an empty store"
  else
    command -v java >/dev/null 2>&1 || { log "FATAL: no 'java' on PATH (need a native JDK)"; exit 1; }
    if [ ! -f "$JAR" ]; then
      [ -z "${BLAZEGRAPH_JAR:-}" ] || { log "FATAL: BLAZEGRAPH_JAR=$JAR does not exist"; exit 1; }
      log "downloading Blazegraph 2.1.6 JAR..."
      curl -fsSL --max-time 120 -o "$JAR" "$JAR_URL" || { log "FATAL: JAR download failed"; exit 1; }
    fi
    if [ "${BLAZEGRAPH_KEEP_JOURNAL:-0}" != "1" ] && [ -f "$BZ_DIR/blazegraph.jnl" ]; then
      rm -f "$BZ_DIR/blazegraph.jnl"
      log "removed the journal of the previous run"
    fi
    log "booting native Blazegraph on 127.0.0.1:$PORT (host JVM: $(java -version 2>&1 | head -1))"
    # `exec` makes the recorded pid the JVM itself (not a wrapper shell that
    # `stop` would kill while the JVM lives on), and leaves no process holding
    # the caller's stdout once this script returns.
    ( cd "$BZ_DIR" && exec nohup java -server -Xmx"${BLAZEGRAPH_HEAP:-1g}" -Djetty.host=127.0.0.1 -Djetty.port="$PORT" -jar "$JAR" > "$LOG" 2>&1 < /dev/null ) &
    echo $! > "$PIDFILE"
    local i
    for i in $(seq 1 40); do is_up && break; sleep 2; done
    is_up || { log "FATAL: not ready after 80s — see $LOG"; tail -8 "$LOG"; exit 1; }
    log "ready (pid $(cat "$PIDFILE"))"
  fi
  local ns
  for ns in $NAMESPACES; do seed_namespace "$ns" || exit 1; done
  if [ "$PORT" = "9999" ]; then
    log "OK — start the devnet with: DEVNET_BLAZEGRAPH_CTX=$CTX scripts/devnet.sh start 6"
  else
    log "OK — start the devnet with: DEVNET_BLAZEGRAPH_PORT=$PORT DEVNET_BLAZEGRAPH_CTX=$CTX scripts/devnet.sh start 6"
  fi
}

cmd_stop() {
  # Stop the JVM that listens on OUR port (whoever started it) and the one this
  # script recorded. Another Blazegraph on this host, on another port, belongs
  # to somebody else and is never signalled.
  local pid stopped=""
  for pid in $({ lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null; cat "$PIDFILE" 2>/dev/null; } | sort -u); do
    case "$(ps -p "$pid" -o args= 2>/dev/null)" in
      *java*.jar*) kill "$pid" 2>/dev/null && stopped="$stopped $pid" ;;
    esac
  done
  if [ -n "$stopped" ]; then log "stopped (pid$stopped)"; else log "not running"; fi
  rm -f "$PIDFILE"
}

cmd_status() {
  if is_up; then
    log "UP on :$PORT/$CTX"
    curl -s "$(ns_url)" -H "Accept: text/plain" 2>/dev/null | grep -oE "namespace/[a-zA-Z0-9]+/sparql" | sort -u | sed 's/^/  /'
  else
    log "DOWN"
  fi
}

case "${1:-start}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  *) echo "usage: $0 [start|stop|status]"; exit 2 ;;
esac
