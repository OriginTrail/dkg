#!/usr/bin/env bash
#
# node-ui smoke test: starts the Vite dev server pointed at devnet
# node 1, waits for HTTP 200 on /ui/, fetches the bundled UI, then
# stops Vite cleanly. PASS if Vite serves a non-empty index payload.
set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# `vite` doesn't read UI_PORT from env — it uses its config (5173).
# So we either pass --port to vite (would require patching devnet.sh
# start_ui to forward it) or just use vite's default. We use the
# default and rely on devnet.sh stop_ui to clean up across runs.
export UI_PORT="${UI_PORT:-5173}"
export UI_NODE_ID="${UI_NODE_ID:-1}"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }

echo "=== node-ui smoke (UI_PORT=$UI_PORT, talking to devnet node $UI_NODE_ID) ==="

"$REPO_ROOT/scripts/devnet.sh" ui start > /tmp/rc12-ui-start.log 2>&1
if [ $? -ne 0 ]; then
  fail "ui start failed (see /tmp/rc12-ui-start.log)"
  cat /tmp/rc12-ui-start.log | sed 's/^/  /' | head -30
  echo "=== Summary: PASS=$PASS FAIL=$FAIL ==="
  exit 1
fi
ok "Vite dev server started"

# Poll for /ui/
ready=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$UI_PORT/ui/" -o /tmp/rc12-ui-index.html 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" = true ]; then
  ok "GET http://localhost:$UI_PORT/ui/ returned 200"
  if [ -s /tmp/rc12-ui-index.html ] && grep -qiE "<html|<body|<title|<!doctype" /tmp/rc12-ui-index.html; then
    bytes=$(wc -c < /tmp/rc12-ui-index.html | tr -d ' ')
    ok "UI index payload looks HTML-shaped (${bytes} bytes)"
  else
    fail "UI index payload empty or not HTML"
  fi
else
  fail "Vite did not respond on http://localhost:$UI_PORT/ui/ within 30s"
fi

# Best-effort: clean up
"$REPO_ROOT/scripts/devnet.sh" ui stop > /dev/null 2>&1 || true

echo "=== Summary: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
