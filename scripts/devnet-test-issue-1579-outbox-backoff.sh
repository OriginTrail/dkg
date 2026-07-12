#!/usr/bin/env bash
# Live-devnet regression for #1579. A cooling-down reliable message is seeded
# into node1's durable outbox, node2 is restarted/reconnected, and the row must
# remain untouched until its scheduled next_attempt_at. On the buggy build the
# connection:open hook immediately sends/removes (or advances) the row.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DB="$DEVNET_DIR/node1/node-ui.db"
MESSAGE_ID="devnet-issue-1579-$(date +%s)"

fail() { echo "[#1579] FAIL: $*" >&2; exit 1; }
cleanup() {
  DB="$DB" MESSAGE_ID="$MESSAGE_ID" node --input-type=module <<'NODE' >/dev/null 2>&1 || true
import Database from 'better-sqlite3';
const db = new Database(process.env.DB);
db.prepare('DELETE FROM protocol_outbox WHERE message_id = ?').run(process.env.MESSAGE_ID);
db.close();
NODE
}
trap cleanup EXIT

[[ -f "$DB" ]] || fail "node1 database missing; start a devnet first"
. "$ROOT/scripts/devnet-lib.sh"

status2="$(body_of "$(api 2 GET /api/status)")"
peer2="$(field "$status2" peerId)"
[[ -n "$peer2" ]] || fail "node2 peerId unavailable"

DB="$DB" PEER="$peer2" MESSAGE_ID="$MESSAGE_ID" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
import { encodeReliableEnvelope, PROTOCOL_MESSAGE } from './packages/core/dist/index.js';
const now = Date.now();
const payload = encodeReliableEnvelope({
  messageId: process.env.MESSAGE_ID,
  version: 1,
  tsMs: now,
  payload: new TextEncoder().encode('{"type":"chat","text":"#1579 probe"}'),
});
const db = new Database(process.env.DB);
db.prepare(`INSERT INTO protocol_outbox
  (peer_id, protocol, message_id, payload, attempts, first_failure_at,
   last_attempt_at, next_attempt_at, last_error)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`)
  .run(process.env.PEER, PROTOCOL_MESSAGE, process.env.MESSAGE_ID,
    Buffer.from(payload), now, now, now + 60 * 60 * 1000, 'devnet probe');
db.close();
NODE

"$ROOT/scripts/devnet.sh" restart-node 2 >/dev/null
for _ in $(seq 1 60); do
  [[ "$(code_of "$(api 2 GET /api/status)")" == 200 ]] && break
  sleep 1
done
[[ "$(code_of "$(api 2 GET /api/status)")" == 200 ]] || fail "node2 did not restart"

connect="$(api 1 POST /api/connect "{\"peerId\":\"$peer2\"}")"
[[ "$(code_of "$connect")" == 200 ]] || fail "node1 could not reconnect to node2"
sleep 5

row="$(DB="$DB" MESSAGE_ID="$MESSAGE_ID" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.env.DB, { readonly: true });
const row = db.prepare('SELECT attempts, next_attempt_at FROM protocol_outbox WHERE message_id = ?').get(process.env.MESSAGE_ID);
process.stdout.write(row ? JSON.stringify(row) : 'missing');
db.close();
NODE
)"
[[ "$row" != missing ]] || fail "cooling row was drained on connection-open"
attempts="$(field "$row" attempts)"
[[ "$attempts" == 1 ]] || fail "connection-open advanced attempts to $attempts"
echo "[#1579] PASS: reconnect preserved the cooling-down outbox row"
