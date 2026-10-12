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
# better-sqlite3 is a dependency of packages/cli, not of the repository root:
# every step that opens the node's database runs there, and reaches the core
# package by its name.
sqlite() { ( cd "$ROOT/packages/cli" && node --input-type=module ); }
cleanup() {
  DB="$DB" PREFIX="$PREFIX" sqlite <<'NODE' >/dev/null 2>&1 || true
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

DB="$DB" PEER="$peer2" PREFIX="$PREFIX" sqlite <<'NODE'
import Database from 'better-sqlite3';
import { encodeReliableEnvelope, PROTOCOL_MESSAGE } from '@origintrail-official/dkg-core';
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

# A row the drain took is either gone (delivered) or still there with one more
# attempt on it (the peer did not accept it and the row moved along its backoff
# ladder). Both count as processed: counting only the rows that disappeared
# reads a pass whose sends were all refused as "the scheduler never ran".
processed_rows() {
  DB="$DB" PREFIX="$PREFIX" sqlite <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.env.DB, { readonly: true });
const row = db.prepare(`SELECT COUNT(*) AS kept, COALESCE(SUM(attempts > 1), 0) AS retried
  FROM protocol_outbox WHERE message_id LIKE ?`).get(`${process.env.PREFIX}%`);
process.stdout.write(String(250 - row.kept + row.retried)); db.close();
NODE
}

processed=0
for _ in $(seq 1 75); do
  processed="$(processed_rows)"
  [[ "$processed" -gt 0 ]] && break
  sleep 1
done
[[ "$processed" -gt 0 ]] || fail "periodic scheduler did not process any of the 250 due rows within 75s"

# Follow that pass to its end. The count rises while the pass works through its
# page and then rests until the next tick (30 s apart). A pass that is not
# bounded goes on past the batch size without resting.
previous="$processed"; steady=0; timeline="$processed"
for _ in $(seq 1 60); do
  sleep 1
  processed="$(processed_rows)"
  timeline="$timeline $processed"
  if [[ "$processed" == "$previous" ]]; then steady=$((steady + 1)); else steady=0; previous="$processed"; fi
  [[ "$steady" -ge 5 || "$processed" -gt 100 ]] && break
done
[[ "$processed" -le 100 ]] || fail "one drain processed $processed rows without resting (batch limit is 100); rows processed, second by second: $timeline"
[[ "$steady" -ge 5 ]] || fail "the first drain did not come to rest within 60s; rows processed, second by second: $timeline"

# The node's own account of the page it loaded must agree.
slo="$(body_of "$(api 1 GET /api/slo)")"
last_page="$(field "$slo" outbox.lastBatchEntries)"
[[ "$last_page" =~ ^[0-9]+$ && "$last_page" -gt 0 && "$last_page" -le 100 ]] \
  || fail "node1 reports a last drain page of '${last_page:-nothing}' rows (expected 1 to 100): $(field "$slo" outbox)"
echo "[#1580] PASS: first live drain was bounded ($processed/250 rows processed before it rested; node1 reports a page of $last_page)"
