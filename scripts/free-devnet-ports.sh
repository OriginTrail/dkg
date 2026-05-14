#!/usr/bin/env bash
#
# Free every port the devnet binds before a fresh start so we don't
# hit EADDRINUSE from leftover processes.
#
# Two reclamation strategies, in order:
#
#   1. macOS launchd: if `ai.openclaw.gateway` is loaded, unload it.
#      That agent has KeepAlive=true with ThrottleInterval=1, so plain
#      `kill` is futile — the process respawns in ~1 second and grabs
#      its ports back before the devnet daemon can bind. Unloading the
#      agent stops the respawn. Use `--restore-openclaw` to load it
#      again at the end of a test run.
#
#   2. Brute-force: kill any remaining process listening on the
#      devnet's well-known ports via `lsof -t`. Cross-platform
#      (macOS + Linux); silent when nothing is bound.
#
# Always exits 0 so it can chain in front of `devnet.sh`.
#
set -uo pipefail

PORTS=(8545 9201 9202 9203 9204 9205 9206 10001 10002 10003 10004 10005 10006)
OPENCLAW_PLIST="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
OPENCLAW_LABEL="ai.openclaw.gateway"

mode="prepare"
if [ "${1:-}" = "--restore-openclaw" ]; then
  mode="restore"
fi

if [ "$mode" = "restore" ]; then
  if [ "$(uname -s)" = "Darwin" ] && [ -f "$OPENCLAW_PLIST" ]; then
    if ! launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "$OPENCLAW_LABEL"; then
      launchctl load "$OPENCLAW_PLIST" 2>/dev/null && \
        echo "[free-devnet-ports] reloaded $OPENCLAW_LABEL"
    fi
  fi
  exit 0
fi

if [ "$(uname -s)" = "Darwin" ] && [ -f "$OPENCLAW_PLIST" ]; then
  if launchctl list 2>/dev/null | awk '{print $3}' | grep -qx "$OPENCLAW_LABEL"; then
    launchctl unload "$OPENCLAW_PLIST" 2>/dev/null && \
      echo "[free-devnet-ports] unloaded $OPENCLAW_LABEL (will be reloaded at end of run)"
  fi
fi

for port in "${PORTS[@]}"; do
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "[free-devnet-ports] killing $(echo "$pids" | tr '\n' ' ')(port $port)"
    kill -9 $pids 2>/dev/null || true
  fi
done

exit 0
