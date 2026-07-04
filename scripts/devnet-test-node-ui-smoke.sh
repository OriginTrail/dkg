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
COOKIE_JAR="/tmp/rc12-ui-cookies.txt"
HEADER_FILE="/tmp/rc12-ui-headers.txt"

ok()   { PASS=$((PASS+1)); echo "  PASS: $*"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $*"; }
cleanup() {
  "$REPO_ROOT/scripts/devnet.sh" ui stop > /dev/null 2>&1 || true
}
trap cleanup EXIT

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
  if grep -q "Node UI not built" /tmp/rc12-ui-index.html; then
    fail "UI index is the diagnostic not-built fallback"
  else
    ok "UI index is not the not-built fallback"
  fi
  if grep -q "__DKG_TOKEN__" /tmp/rc12-ui-index.html; then
    fail "UI index exposes legacy window.__DKG_TOKEN__ bootstrap"
  else
    ok "UI index does not expose window.__DKG_TOKEN__"
  fi
else
  fail "Vite did not respond on http://localhost:$UI_PORT/ui/ within 30s"
fi

if [ "$ready" = true ]; then
  asset_fail=0
  for asset in $(grep -Eo 'src="[^"]+|href="[^"]+' /tmp/rc12-ui-index.html | cut -d'"' -f2 | grep -E '\.(js|css)($|\?)' | head -20); do
    case "$asset" in
      http*) asset_url="$asset" ;;
      /ui/*) asset_url="http://localhost:$UI_PORT$asset" ;;
      ./*) asset_url="http://localhost:$UI_PORT/ui/${asset#./}" ;;
      *) asset_url="http://localhost:$UI_PORT/ui/$asset" ;;
    esac
    if ! curl -sf "$asset_url" -o /dev/null 2>/dev/null; then
      asset_fail=$((asset_fail+1))
      fail "referenced UI asset missing: $asset_url"
    fi
  done
  if [ "$asset_fail" -eq 0 ]; then ok "referenced JS/CSS assets are fetchable"; fi

  rm -f "$COOKIE_JAR" "$HEADER_FILE"
  if curl -sf -c "$COOKIE_JAR" "http://localhost:$UI_PORT/api/dashboard/session/status" -o /tmp/rc12-ui-session-before.json 2>/dev/null; then
    if grep -q '"authenticated"[[:space:]]*:[[:space:]]*false' /tmp/rc12-ui-session-before.json; then
      ok "dashboard session starts unauthenticated"
    else
      fail "dashboard session status before bootstrap was unexpected"
    fi
  else
    fail "dashboard session status endpoint failed before bootstrap"
  fi

  protected_code=$(curl -s -o /tmp/rc12-ui-protected-before.json -w "%{http_code}" "http://localhost:$UI_PORT/api/agents" 2>/dev/null || echo "000")
  if [ "$protected_code" = "401" ]; then
    ok "protected API rejects browser without session"
  else
    fail "protected API without session returned HTTP $protected_code"
  fi

  bootstrap_code=$(curl -s -X POST -b "$COOKIE_JAR" -c "$COOKIE_JAR" -D "$HEADER_FILE" -H "Origin: http://localhost:$UI_PORT" -o /tmp/rc12-ui-session-after.json -w "%{http_code}" "http://localhost:$UI_PORT/api/dashboard/session/loopback" 2>/dev/null || echo "000")
  if [ "$bootstrap_code" = "200" ] && grep -qi "httponly" "$HEADER_FILE" && grep -qi "samesite=strict" "$HEADER_FILE"; then
    ok "loopback dashboard session bootstrap sets HttpOnly SameSite cookie"
  else
    fail "loopback dashboard session bootstrap failed or missed cookie attributes (HTTP $bootstrap_code)"
  fi

  protected_after=$(curl -s -b "$COOKIE_JAR" -o /tmp/rc12-ui-protected-after.json -w "%{http_code}" "http://localhost:$UI_PORT/api/agents" 2>/dev/null || echo "000")
  if [ "$protected_after" = "200" ]; then
    ok "protected API succeeds with dashboard session cookie"
  else
    fail "protected API with dashboard session returned HTTP $protected_after"
  fi

  rm -f /tmp/rc12-ui-events.headers /tmp/rc12-ui-events.txt /tmp/rc12-ui-events.err
  curl -s -N -b "$COOKIE_JAR" -D /tmp/rc12-ui-events.headers -o /tmp/rc12-ui-events.txt "http://localhost:$UI_PORT/api/events" 2>/tmp/rc12-ui-events.err &
  sse_pid=$!
  sleep 2
  kill "$sse_pid" 2>/dev/null || true
  wait "$sse_pid" 2>/dev/null || true
  if grep -Eq '^HTTP/[0-9.]+ 200' /tmp/rc12-ui-events.headers && grep -qi 'content-type: text/event-stream' /tmp/rc12-ui-events.headers; then
    ok "SSE opens as event-stream without token query using dashboard session"
  else
    fail "SSE did not open as event-stream without token query"
    cat /tmp/rc12-ui-events.headers /tmp/rc12-ui-events.err 2>/dev/null | sed 's/^/    /' | head -20
  fi
fi

echo "=== Summary: PASS=$PASS FAIL=$FAIL ==="
if [ "$FAIL" -gt 0 ]; then exit 1; fi
exit 0
