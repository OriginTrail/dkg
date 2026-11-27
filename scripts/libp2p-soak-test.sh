#!/usr/bin/env bash
# libp2p-soak-test.sh — bidirectional messaging soak test for DKG nodes
#
# Sends one tagged + sequenced message to RECIPIENT every INTERVAL_S
# seconds, for TOTAL_CYCLES cycles. Before each send, snapshots local
# daemon health, internet reachability, and target-peer libp2p state
# (preflight.jsonl). After each send, snapshots the inbox filtered to
# messages from RECIPIENT (inbox.jsonl). Send responses go to
# sends.jsonl. Human-readable trace goes to main.log.
#
# Two operators run this against each other to validate the
# bidirectional libp2p messaging stack over hours of real network
# conditions. Symmetric preflight on both sides disambiguates "my
# internet was down" from "remote was unreachable" from "real
# transport hiccup" in postmortem.
#
# Defaults: 18 cycles × 20min = 6h, recipient = dkg-testnet-edge,
# sender_tag = MILES, internet probe = cloudflare (1.1.1.1).
#
# Override via env vars: RECIPIENT, RECIPIENT_PEER_ID, SENDER_TAG,
# TOTAL_CYCLES, INTERVAL_S, INTERNET_PROBE_HOST, API.
# RECIPIENT_PEER_ID is optional; when set, enables per-peer preflight
# probe of /api/peer-info (PR #533 fields incl. getConnectionsReturnsForPeer).
# For a one-sided gate, set RECIPIENT_API and RECIPIENT_AUTH_FILE to require
# that node's inbox to contain each message from this exact run once.
#
# Usage (run from anywhere — logs always go to $DKG_HOME/soak-test-<ts>-<TAG>/):
#   nohup caffeinate -i bash scripts/libp2p-soak-test.sh \
#     RECIPIENT_PEER_ID=12D3Koo... \
#     >> ~/.dkg/soak-test.out 2>&1 &
#   disown
#
# Operators with a non-default home (e.g. ~/.dkg-dev) prefix with
# DKG_HOME=~/.dkg-dev so auth token + log dir resolve correctly.
#
# Stop early:
#   pkill -f libp2p-soak-test.sh

set -uo pipefail

# Accept KEY=VALUE positional args as env vars (so `bash script.sh FOO=bar`
# works the same as `FOO=bar bash script.sh`). Spotted by Lex during the
# 2026-05 rc9 soak — silent fallback to defaults is a footgun otherwise.
for kv in "$@"; do
  case "$kv" in
    *=*) export "$kv" ;;
  esac
done

RECIPIENT="${RECIPIENT:-dkg-testnet-edge}"
RECIPIENT_PEER_ID="${RECIPIENT_PEER_ID:-}"   # optional; required for per-peer preflight diagnostics
RECIPIENT_API="${RECIPIENT_API:-}"
RECIPIENT_AUTH_FILE="${RECIPIENT_AUTH_FILE:-}"
SENDER_TAG="${SENDER_TAG:-MILES}"
TOTAL_CYCLES="${TOTAL_CYCLES:-18}"
INTERVAL_S="${INTERVAL_S:-1200}"   # 20 min
FINAL_WAIT_SECONDS="${FINAL_WAIT_SECONDS:-300}"
INTERNET_PROBE_HOST="${INTERNET_PROBE_HOST:-1.1.1.1}"   # cloudflare DNS — universal, fast, no captive-portal interception

# DKG_HOME defaults to ~/.dkg but operators running dev nodes (e.g. hermes
# with ~/.dkg-dev) can override it. All filesystem paths derive from this:
# auth token, log dir, soak.out. Spotted by hermes-default during the 2026-05
# rc9 soak — they were on ~/.dkg-dev and the hardcoded ~/.dkg path broke
# auth resolution.
DKG_HOME="${DKG_HOME:-${HOME}/.dkg}"

API="${API:-http://127.0.0.1:9200}"
AUTH=$(grep -v '^#' "${DKG_HOME}/auth.token" | head -1)
if [ -n "$RECIPIENT_API" ] && [ ! -f "$RECIPIENT_AUTH_FILE" ]; then
  echo "RECIPIENT_AUTH_FILE is required with RECIPIENT_API" >&2
  exit 2
fi
SOAK_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

LOG_DIR="${DKG_HOME}/soak-test-$(date -u +%Y%m%d-%H%M%S)-${SENDER_TAG}"
mkdir -p "$LOG_DIR"
echo "$$" > "$LOG_DIR/pid"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" \
    | tee -a "$LOG_DIR/main.log"
}

send_one() {
  local seq=$1 total=$2 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local body
  body=$(printf '{"to":"%s","text":"%s soak-test run=%s seq=%d/%d ts=%s"}' \
    "$RECIPIENT" "$SENDER_TAG" "$SOAK_RUN_ID" "$seq" "$total" "$ts")
  local resp
  resp=$(curl -s --max-time 60 -X POST "$API/api/chat" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"seq":%d,"sent_ts":"%s","resp":%s}\n' \
    "$seq" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/sends.jsonl"
  log "  send seq=$seq → ${resp:0:140}"
}

preflight_snapshot() {
  local label=$1 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local status_json
  status_json=$(curl -s --max-time 10 "$API/api/status" -H "Authorization: Bearer $AUTH")

  local net_start net_end net_rtt_ms net_ok
  net_start=$(python3 -c 'import time;print(int(time.time()*1000))')
  if curl -sS --max-time 5 -o /dev/null "http://${INTERNET_PROBE_HOST}" 2>/dev/null; then
    net_ok=true
  else
    net_ok=false
  fi
  net_end=$(python3 -c 'import time;print(int(time.time()*1000))')
  net_rtt_ms=$((net_end - net_start))

  local peer_json='null'
  if [ -n "$RECIPIENT_PEER_ID" ]; then
    peer_json=$(curl -s --max-time 10 \
      "$API/api/peer-info?peerId=$RECIPIENT_PEER_ID" \
      -H "Authorization: Bearer $AUTH")
    peer_json="${peer_json:-null}"
  fi

  printf '{"label":"%s","ts":"%s","local":%s,"internet":{"host":"%s","ok":%s,"rtt_ms":%d},"peer":%s}\n' \
    "$label" "$ts" "${status_json:-null}" "$INTERNET_PROBE_HOST" "$net_ok" "$net_rtt_ms" "$peer_json" \
    >> "$LOG_DIR/preflight.jsonl"

  local summary
  summary=$(python3 -c "
import json, sys
try:
  l = json.loads('''${status_json:-null}''')
  peers = l.get('connectedPeers', '?')
  relay = 'relay+' if l.get('relayConnected') else 'relay-'
  conn = l.get('connections', {})
  local_s = f'peers={peers} {relay} direct={conn.get(\"direct\", \"?\")} relayed={conn.get(\"relayed\", \"?\")}'
except Exception as e:
  local_s = f'local=err({e})'

net_s = 'net+' if '${net_ok}' == 'true' else 'net-'

try:
  p = json.loads('''${peer_json:-null}''') if '''${peer_json:-null}''' != 'null' else None
  if p:
    last_seen_ms = p.get('lastSeen') or 0
    age_s = ((${net_end} - last_seen_ms) // 1000) if last_seen_ms else -1
    peer_s = (
      f'peer.connected={p.get(\"connected\")} '
      f'raw={p.get(\"rawConnectionCount\", \"?\")} '
      f'forPeer={p.get(\"getConnectionsReturnsForPeer\", \"?\")} '
      f'addrs={(p.get(\"peerStore\") or {{}}).get(\"knownMultiaddrCount\", \"?\")} '
      f'outbox={(p.get(\"outbox\") or {{}}).get(\"pendingCount\", \"?\")} '
      f'lastSeen={age_s}s'
    )
  else:
    peer_s = 'peer=skipped(no RECIPIENT_PEER_ID)'
except Exception as e:
  peer_s = f'peer=err({e})'

print(f'{local_s} | {net_s} | {peer_s}')
" 2>/dev/null)
  log "  preflight ($label): $summary"
}

snapshot_slo() {
  # rc.9 PR-12. Snapshots the Universal Messenger SLO histogram
  # across ALL protocols (chat, skill, swm-key, private-access,
  # query, join, ack, verify). Source of truth for the ship-gate
  # 99.9%/15s SLO measurement. JSON dump goes to slo.jsonl; the
  # human-readable summary line appears in main.log alongside the
  # per-cycle preflight + inbox snapshots.
  local label=$1 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local resp
  resp=$(curl -s --max-time 10 "${API}/api/slo" \
    -H "Authorization: Bearer $AUTH")
  printf '{"label":"%s","ts":"%s","data":%s}\n' \
    "$label" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/slo.jsonl"
  local summary
  summary=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  protos = (d or {}).get('protocols', {}) or {}
  if not protos:
    print('slo=(no traffic yet)')
  else:
    parts = []
    for proto, s in sorted(protos.items()):
      short = proto.split('/')[-1]
      p99 = s.get('p99Ms')
      p99_s = f'{p99}ms' if p99 is not None else 'n/a'
      parts.append(f'{short}=d{s.get(\"delivered\", 0)}/q{s.get(\"queued\", 0)} p99={p99_s}')
    print('slo: ' + ', '.join(parts))
except Exception as e:
  print(f'slo=err({e})')
" 2>/dev/null)
  log "  $summary"
}

snapshot_inbox() {
  local label=$1 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local resp
  resp=$(curl -s --max-time 30 \
    "${API}/api/messages?peer=${RECIPIENT}&direction=in&limit=200&order=desc" \
    -H "Authorization: Bearer $AUTH")
  printf '{"label":"%s","ts":"%s","data":%s}\n' \
    "$label" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/inbox.jsonl"
  local count
  count=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  msgs = d.get('messages', []) if isinstance(d, dict) else (d if isinstance(d, list) else [])
  soak = sum(1 for m in msgs if 'soak-test' in (m.get('text') or ''))
  print(f'total_in={len(msgs)} soak_test_in={soak}')
except Exception as e:
  print(f'(parse error: {e})')
" 2>/dev/null)
  log "  inbox snapshot ($label): $count"
}

# In a one-sided devnet run, the sender's inbound inbox is expected to be
# empty. When the recipient's API is supplied, inspect that node's inbox and
# prove every sequence from this exact run was delivered once.
verify_recipient_inbox() {
  [ -n "$RECIPIENT_API" ] || return 0
  local recipient_auth resp verdict
  recipient_auth=$(grep -v '^#' "$RECIPIENT_AUTH_FILE" | tail -1 | tr -d '\r\n')
  [ -n "$recipient_auth" ] || { log "  recipient auth file is empty"; return 1; }
  resp=$(curl -fsS --max-time 30 \
    "$RECIPIENT_API/api/messages?direction=in&limit=200&order=desc" \
    -H "Authorization: Bearer $recipient_auth") || return 1
  verdict=$(printf '%s' "$resp" | SOAK_RUN_ID="$SOAK_RUN_ID" TOTAL_CYCLES="$TOTAL_CYCLES" python3 -c '
import json, os, re, sys
try:
  body = json.load(sys.stdin)
  messages = body["messages"]
  if not isinstance(messages, list): raise ValueError("missing messages")
  total = int(os.environ["TOTAL_CYCLES"])
  run = re.escape(os.environ["SOAK_RUN_ID"])
  pattern = re.compile(r"\bsoak-test run=" + run + r" seq=(\d+)/(\d+)\b")
  seen = []
  for message in messages:
    match = pattern.search(message.get("text", ""))
    if match and int(match.group(2)) == total: seen.append(int(match.group(1)))
  missing = sorted(set(range(1, total + 1)) - set(seen))
  unexpected = sorted(set(seen) - set(range(1, total + 1)))
  duplicate = sorted(seq for seq in set(seen) if seen.count(seq) != 1)
  print(f"recipient receipts={len(seen)}/{total} missing={missing} duplicate={duplicate} unexpected={unexpected}")
  if missing or duplicate or unexpected: sys.exit(1)
except Exception as error:
  print(f"recipient inbox unreadable: {error}")
  sys.exit(1)
') || { log "  $verdict"; return 1; }
  log "  $verdict"
}

trap 'log "INTERRUPTED — stopping at cycle ${seq:-?}"; exit 130' INT TERM

log "=== START soak-test ==="
log "  recipient=$RECIPIENT"
log "  recipient_peer_id=${RECIPIENT_PEER_ID:-<unset, per-peer preflight skipped>}"
log "  sender_tag=$SENDER_TAG"
log "  run_id=$SOAK_RUN_ID"
log "  total_cycles=$TOTAL_CYCLES"
log "  interval_s=$INTERVAL_S"
log "  internet_probe=$INTERNET_PROBE_HOST"
log "  log_dir=$LOG_DIR"
log "  pid=$$"
log ""
log "Baseline preflight + inbox + SLO snapshot (before first send):"
preflight_snapshot "baseline"
snapshot_inbox "baseline"
snapshot_slo "baseline"
log ""

for seq in $(seq 1 "$TOTAL_CYCLES"); do
  log "--- CYCLE $seq/$TOTAL_CYCLES ---"
  preflight_snapshot "pre-send-$seq"
  send_one "$seq" "$TOTAL_CYCLES"
  sleep 5
  snapshot_inbox "post-send-$seq"
  snapshot_slo "post-send-$seq"
  if [ "$seq" -lt "$TOTAL_CYCLES" ]; then
    log "  ... sleeping ${INTERVAL_S}s until next cycle"
    sleep "$INTERVAL_S"
  fi
done

log ""
log "All cycles done. Waiting ${FINAL_WAIT_SECONDS}s for any queued/retried inbound to land..."
sleep "$FINAL_WAIT_SECONDS"
snapshot_inbox "final"
snapshot_slo "final"
verify_recipient_inbox || { log "FAIL: recipient did not receive every tagged message from this run"; exit 1; }

log ""
log "=== END soak-test ==="
log ""
log "Summary:"
sends_count=$(wc -l < "$LOG_DIR/sends.jsonl" | tr -d ' ')
log "  total sends: $sends_count"
delivered=$(grep -c '"delivered":true' "$LOG_DIR/sends.jsonl" 2>/dev/null || echo 0)
log "  delivered: $delivered"
queued=$(grep -c '"queued":true' "$LOG_DIR/sends.jsonl" 2>/dev/null || echo 0)
log "  queued (transport-failed, retried): $queued"
acl_rejects=$(grep -c 'unauthorized' "$LOG_DIR/sends.jsonl" 2>/dev/null || echo 0)
log "  ACL-rejected: $acl_rejects"
final_in=$(tail -1 "$LOG_DIR/inbox.jsonl" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.readline())
  msgs = d['data'].get('messages', []) if isinstance(d.get('data'), dict) else []
  soak = sum(1 for m in msgs if 'soak-test' in (m.get('text') or ''))
  print(soak)
except: print(0)
")
log "  inbound soak-test messages received: $final_in (expected: $TOTAL_CYCLES from peer)"
log ""
log "Detailed logs:"
log "  sends:  $LOG_DIR/sends.jsonl"
log "  inbox:  $LOG_DIR/inbox.jsonl"
log "  slo:    $LOG_DIR/slo.jsonl  (per-cycle /api/slo dumps across all 8 protocols)"
log "  trace:  $LOG_DIR/main.log"
