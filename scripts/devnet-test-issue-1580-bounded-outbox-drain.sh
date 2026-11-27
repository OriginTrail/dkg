#!/usr/bin/env bash
# Live-devnet regression for #1580. Seed 250 immediately-due rows and assert one
# scheduler pass consumes/reschedules no more than the configured default batch
# of 100. The unfixed drain loads the full due set in one unbounded pass.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
DB="$DEVNET_DIR/node1/node-ui.db"
PREFIX="devnet-issue-1580-$(date +%s)-"

fail() { echo "[#1580] FAIL: $*" >&2; exit 1; }
cleanup() {
  DB="$DB" PREFIX="$PREFIX" node --input-type=module <<'NODE' >/dev/null 2>&1 || true
import Database from 'better-sqlite3';
const db = new Database(process.env.DB);
db.prepare('DELETE FROM protocol_outbox WHERE message_id LIKE ?').run(`${process.env.PREFIX}%`);
db.close();
NODE
}
trap cleanup EXIT
[[ -f "$DB" ]] || fail "node1 database missing; start a devnet first"
. "$ROOT/scripts/devnet-lib.sh"

status2="$(body_of "$(api 2 GET /api/status)")"
peer2="$(field "$status2" peerId)"
[[ -n "$peer2" ]] || fail "node2 peerId unavailable"

DB="$DB" PEER="$peer2" PREFIX="$PREFIX" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
import { encodeReliableEnvelope, PROTOCOL_MESSAGE } from './packages/core/dist/index.js';
const db = new Database(process.env.DB);
const insert = db.prepare(`INSERT INTO protocol_outbox
  (peer_id, protocol, message_id, payload, attempts, first_failure_at,
   last_attempt_at, next_attempt_at, last_error)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`);
const now = Date.now();
const seed = db.transaction(() => {
  for (let i = 0; i < 250; i += 1) {
    const id = `${process.env.PREFIX}${String(i).padStart(3, '0')}`;
    const payload = encodeReliableEnvelope({
      messageId: id, version: 1, tsMs: now,
      payload: new TextEncoder().encode(`invalid-inner-payload-${i}`),
    });
    insert.run(process.env.PEER, PROTOCOL_MESSAGE, id, Buffer.from(payload), now, now, now - 1, 'probe');
  }
});
seed();
db.close();
NODE

remaining=250
for _ in $(seq 1 75); do
  remaining="$(DB="$DB" PREFIX="$PREFIX" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.env.DB, { readonly: true });
const row = db.prepare('SELECT COUNT(*) AS n FROM protocol_outbox WHERE message_id LIKE ?').get(`${process.env.PREFIX}%`);
process.stdout.write(String(row.n)); db.close();
NODE
)"
  [[ "$remaining" -lt 250 ]] && break
  sleep 1
done
[[ "$remaining" -lt 250 ]] || fail "periodic scheduler did not start within 75s"
sleep 2

remaining="$(DB="$DB" PREFIX="$PREFIX" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.env.DB, { readonly: true });
const row = db.prepare('SELECT COUNT(*) AS n FROM protocol_outbox WHERE message_id LIKE ?').get(`${process.env.PREFIX}%`);
process.stdout.write(String(row.n)); db.close();
NODE
)"
processed=$((250 - remaining))
[[ "$processed" -le 100 ]] || fail "one drain processed $processed rows (batch limit is 100)"
[[ "$processed" -gt 0 ]] || fail "no rows were processed"
echo "[#1580] PASS: first live drain was bounded ($processed/250 rows)"
