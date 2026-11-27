#!/usr/bin/env bash
# Live-devnet regression for #1577. Stop one of four cores, publish from an edge
# (the other three can still satisfy quorum), then prove the finished collector
# left no durable StorageACK request behind on the publisher.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
PUBLISHER="${ACK_OUTBOX_PUBLISHER:-5}"
TARGET="${ACK_OUTBOX_TARGET:-4}"
CG="${DEVNET_CONTEXT_GRAPH:-devnet-test}"
DB="$DEVNET_DIR/node$PUBLISHER/node-ui.db"
stopped=0

fail() { echo "[#1577] FAIL: $*" >&2; exit 1; }
cleanup() {
  if [[ "$stopped" == 1 ]]; then "$ROOT/scripts/devnet.sh" restart-node "$TARGET" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM
. "$ROOT/scripts/devnet-lib.sh"

PROTOCOL_STORAGE_ACK="$(protocol_const PROTOCOL_STORAGE_ACK)"
PROTOCOL_STORAGE_ACK_V2="$(protocol_const PROTOCOL_STORAGE_ACK_V2)"
PROTOCOL_STORAGE_UPDATE_ACK="$(protocol_const PROTOCOL_STORAGE_UPDATE_ACK)"
[[ -n "$PROTOCOL_STORAGE_ACK" ]] || fail "canonical PROTOCOL_STORAGE_ACK is unavailable"
[[ -n "$PROTOCOL_STORAGE_ACK_V2" ]] || fail "canonical PROTOCOL_STORAGE_ACK_V2 is unavailable"
[[ -n "$PROTOCOL_STORAGE_UPDATE_ACK" ]] || fail "canonical PROTOCOL_STORAGE_UPDATE_ACK is unavailable"

for n in 1 2 3 4 5; do
  [[ "$(code_of "$(api "$n" GET /api/status)")" == 200 ]] || fail "node$n is not ready (need 4 cores + edge)"
done
[[ -f "$DB" ]] || fail "publisher database missing: $DB"

count_ack_rows() {
  (
    cd "$ROOT/packages/cli"
    DB="$DB" \
      PROTOCOL_STORAGE_ACK="$PROTOCOL_STORAGE_ACK" \
      PROTOCOL_STORAGE_ACK_V2="$PROTOCOL_STORAGE_ACK_V2" \
      PROTOCOL_STORAGE_UPDATE_ACK="$PROTOCOL_STORAGE_UPDATE_ACK" \
      node --input-type=module <<'NODE'
import Database from 'better-sqlite3';
const db = new Database(process.env.DB, { readonly: true });
const row = db.prepare(`SELECT COUNT(*) AS n FROM protocol_outbox
  WHERE protocol IN (?, ?, ?)`).get(
    process.env.PROTOCOL_STORAGE_ACK,
    process.env.PROTOCOL_STORAGE_ACK_V2,
    process.env.PROTOCOL_STORAGE_UPDATE_ACK,
  );
process.stdout.write(String(row.n)); db.close();
NODE
  )
}
baseline="$(count_ack_rows)"

"$ROOT/scripts/devnet.sh" stop-node "$TARGET" >/dev/null
stopped=1
sleep 5

name="issue-1577-$(date +%s)-$$"
subject="urn:issue:1577:$name"
api "$PUBLISHER" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$name\"}" >/dev/null
api "$PUBLISHER" POST "/api/knowledge-assets/$name/wm/write" \
  "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"ack ownership probe\\\"\",\"graph\":\"\"}]}" >/dev/null
api "$PUBLISHER" POST "/api/knowledge-assets/$name/wm/finalize" "{\"contextGraphId\":\"$CG\"}" >/dev/null
api "$PUBLISHER" POST "/api/knowledge-assets/$name/swm/share" "{\"contextGraphId\":\"$CG\"}" >/dev/null
published="$(api "$PUBLISHER" POST "/api/knowledge-assets/$name/vm/publish" "{\"contextGraphId\":\"$CG\"}")"
[[ "$(code_of "$published")" == 200 ]] || fail "publish did not reach quorum: $(body_of "$published")"
[[ "$(field "$(body_of "$published")" status)" == confirmed ]] || fail "publish was not confirmed"

rows="$(count_ack_rows)"
[[ "$rows" == "$baseline" ]] || fail "StorageACK outbox rows grew from $baseline to $rows"
echo "[#1577] PASS: collector completed with no durable StorageACK rows"
