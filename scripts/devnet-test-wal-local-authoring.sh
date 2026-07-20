#!/usr/bin/env bash
# OT-RFC-65 WAL-013 cumulative real-daemon acceptance. Run against an already
# started devnet in either mode:
#
#   DEVNET_SYNC_MODE=legacy   ./scripts/devnet.sh start 2
#   WAL_EXPECT_MODE=legacy    ./scripts/devnet-test-wal-local-authoring.sh
#
#   DEVNET_SYNC_MODE=parallel ./scripts/devnet.sh start 2
#   WAL_EXPECT_MODE=parallel  ./scripts/devnet-test-wal-local-authoring.sh
#
# Parallel mode proves one graph-scoped public share becomes exactly one local
# durable WalObject/checkpoint and replays across restart. Node 2 must remain
# unchanged: WAL-019, not WAL-013, owns network reconciliation. Legacy mode
# proves the same API lifecycle has no WAL response or on-disk side effect.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NODE="${WAL_AUTHORING_NODE:-1}"
OBSERVER_NODE="${WAL_OBSERVER_NODE:-2}"
EXPECTED_MODE="${WAL_EXPECT_MODE:-parallel}"
CONTEXT_GRAPH="${WAL_CONTEXT_GRAPH:-devnet-test}"
CONTROL_DB="$DEVNET_DIR/node$NODE/wal-v1/objects/objects.sqlite"
OBSERVER_CONTROL_DB="$DEVNET_DIR/node$OBSERVER_NODE/wal-v1/objects/objects.sqlite"
INSPECTOR="$REPO_ROOT/scripts/lib/wal-control-state.mjs"

. "$REPO_ROOT/scripts/devnet-lib.sh"

fail() { echo "[wal-authoring-devnet] FAIL: $*" >&2; exit 1; }
log() { echo "[wal-authoring-devnet] $*"; }

json_assert() {
  local value="$1" program="$2" label="$3"
  VALUE="$value" node -e "const value=JSON.parse(process.env.VALUE); ${program}" \
    || fail "$label: $value"
}

request() {
  local node="$1" method="$2" path="$3" body="${4:-}" response code
  response="$(api "$node" "$method" "$path" "$body")"
  code="$(code_of "$response")"
  [ "$code" = "200" ] || [ "$code" = "201" ] \
    || fail "node $node $method $path returned HTTP $code: $(body_of "$response")"
  body_of "$response"
}

status="$(request "$NODE" GET /api/status)"
[ "$(field "$status" wal.mode)" = "$EXPECTED_MODE" ] \
  || fail "node $NODE mode is $(field "$status" wal.mode), expected $EXPECTED_MODE"
[ "$(field "$status" wal.synchronizationAuthority)" = "legacy" ] \
  || fail "WAL unexpectedly became synchronization authority"

before='{"exists":false,"objects":0,"checkpoints":0,"idempotencyRecords":0,"localCommitWork":0,"packedObjects":0}'
observer_before="$before"
if [ -f "$CONTROL_DB" ]; then before="$(node "$INSPECTOR" "$CONTROL_DB")"; fi
if [ -f "$OBSERVER_CONTROL_DB" ]; then observer_before="$(node "$INSPECTOR" "$OBSERVER_CONTROL_DB")"; fi

suffix="$(date +%s)-$$"
name="wal-013-$EXPECTED_MODE-$suffix"
subject="urn:dkg:wal:devnet:$suffix"
request "$NODE" POST /api/knowledge-assets \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$name\"}" >/dev/null
request "$NODE" POST "/api/knowledge-assets/$name/wm/write" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"quads\":[{\"subject\":\"$subject\",\"predicate\":\"https://schema.org/name\",\"object\":\"\\\"WAL-013 devnet\\\"\",\"graph\":\"\"}]}" >/dev/null
request "$NODE" POST "/api/knowledge-assets/$name/wm/finalize" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" >/dev/null
first="$(request "$NODE" POST "/api/knowledge-assets/$name/swm/share" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")"

if [ "$EXPECTED_MODE" = "legacy" ]; then
  json_assert "$first" \
    'if (Object.prototype.hasOwnProperty.call(value,"wal")) throw new Error("legacy response contains WAL"); if(value.swmShared!==true) throw new Error("legacy share failed")' \
    "legacy response changed"
  [ ! -e "$DEVNET_DIR/node$NODE/wal-v1" ] \
    || fail "legacy mode created the isolated WAL runtime root"
  DEVNET_DIR="$DEVNET_DIR" API_PORT_BASE="$API_PORT_BASE" \
    "$REPO_ROOT/scripts/devnet.sh" restart-node "$NODE" >/dev/null
  replay="$(request "$NODE" POST "/api/knowledge-assets/$name/swm/share" \
    "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")"
  json_assert "$replay" \
    'if (Object.prototype.hasOwnProperty.call(value,"wal")) throw new Error("legacy replay contains WAL"); if(!value.shareOperationId) throw new Error("legacy replay lost operation ID")' \
    "legacy restart replay changed"
  [ ! -e "$DEVNET_DIR/node$NODE/wal-v1" ] \
    || fail "legacy restart created the WAL runtime root"
  log "PASS: legacy lifecycle and restart produced zero WAL side effects"
  exit 0
fi
[ "$EXPECTED_MODE" = "parallel" ] || fail "WAL_EXPECT_MODE must be legacy or parallel"

json_assert "$first" \
  'const w=value.wal; if(value.swmShared!==true||!value.shareOperationId||w?.mode!=="parallel"||w.status!=="committed"||w.propagationStatus!=="not-claimed"||w.objects?.length!==1||w.failures?.length!==0||w.objects[0].walStatus!=="committed"||w.objects[0].materializationStatus!=="pending") throw new Error("invalid first WAL receipt")' \
  "parallel first receipt mismatch"
object_id="$(field "$first" wal.objects.0.walObjectId)"
checkpoint_id="$(field "$first" wal.objects.0.checkpointId)"
share_operation_id="$(field "$first" shareOperationId)"
[ -n "$object_id" ] && [ -n "$checkpoint_id" ] && [ -n "$share_operation_id" ] \
  || fail "parallel receipt omitted durable identities: $first"

after="$(node "$INSPECTOR" "$CONTROL_DB" "$object_id")"
BEFORE="$before" AFTER="$after" OBJECT_ID="$object_id" CHECKPOINT_ID="$checkpoint_id" node -e '
  const before=JSON.parse(process.env.BEFORE), after=JSON.parse(process.env.AFTER);
  const fail=(m)=>{throw new Error(m)};
  if(after.quickCheck!=="ok") fail(`quick_check=${after.quickCheck}`);
  if(after.objects!==before.objects+1) fail(`objects ${before.objects}->${after.objects}`);
  if(after.checkpoints!==before.checkpoints+1) fail(`checkpoints ${before.checkpoints}->${after.checkpoints}`);
  if(after.idempotencyRecords!==before.idempotencyRecords+1) fail(`idempotency ${before.idempotencyRecords}->${after.idempotencyRecords}`);
  if(after.localCommitWork!==before.localCommitWork+1) fail(`work ${before.localCommitWork}->${after.localCommitWork}`);
  if(after.packedObjects!==before.packedObjects+1) fail(`packed ${before.packedObjects}->${after.packedObjects}`);
  if(after.object?.objectId!==process.env.OBJECT_ID||after.object?.checkpointId!==process.env.CHECKPOINT_ID) fail("receipt does not name durable object/checkpoint");
  if(after.object?.origin!=="LOCAL"||after.object?.canonicalLength!==after.object?.packedLength) fail("object is not a complete packed local atom");
  if(after.object?.idempotencyStatus!=="MATERIALIZATION_PENDING"||after.object?.localCommitState!=="QUEUED") fail("post-commit state mismatch");
' || fail "parallel durable-state delta mismatch: before=$before after=$after"

replay="$(request "$NODE" POST "/api/knowledge-assets/$name/swm/share" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")"
FIRST="$first" REPLAY="$replay" node -e '
  const first=JSON.parse(process.env.FIRST), replay=JSON.parse(process.env.REPLAY);
  if(replay.promotedCount!==0||replay.shareOperationId!==first.shareOperationId) throw new Error("legacy operation replay changed");
  const a=first.wal.objects[0], b=replay.wal?.objects?.[0];
  if(replay.wal?.status!=="committed"||b?.walStatus!=="already-committed"||b.walObjectId!==a.walObjectId||b.checkpointId!==a.checkpointId) throw new Error("WAL idempotent replay changed");
' || fail "immediate replay mismatch: $replay"
[ "$(node "$INSPECTOR" "$CONTROL_DB" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(d).objects)))')" = "$(field "$after" objects)" ] \
  || fail "immediate replay created another object"

DEVNET_DIR="$DEVNET_DIR" API_PORT_BASE="$API_PORT_BASE" \
  "$REPO_ROOT/scripts/devnet.sh" restart-node "$NODE" >/dev/null
restarted_status="$(request "$NODE" GET /api/status)"
[ "$(field "$restarted_status" wal.mode)" = "parallel" ] \
  && [ "$(field "$restarted_status" wal.synchronizationAuthority)" = "legacy" ] \
  || fail "restart changed the synchronization-authority boundary: $restarted_status"
post_restart="$(request "$NODE" POST "/api/knowledge-assets/$name/swm/share" \
  "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")"
FIRST="$first" REPLAY="$post_restart" node -e '
  const first=JSON.parse(process.env.FIRST), replay=JSON.parse(process.env.REPLAY);
  const a=first.wal.objects[0], b=replay.wal?.objects?.[0];
  if(replay.shareOperationId!==first.shareOperationId||b?.walStatus!=="already-committed"||b.walObjectId!==a.walObjectId||b.checkpointId!==a.checkpointId) throw new Error("restart replay changed WAL identity");
' || fail "restart replay mismatch: $post_restart"

final="$(node "$INSPECTOR" "$CONTROL_DB" "$object_id")"
FINAL="$final" AFTER="$after" node -e '
  const final=JSON.parse(process.env.FINAL), after=JSON.parse(process.env.AFTER);
  for(const key of ["objects","checkpoints","idempotencyRecords","localCommitWork","packedObjects"]) if(final[key]!==after[key]) throw new Error(`${key} changed on replay`);
  if(final.object?.objectId!==after.object?.objectId) throw new Error("durable object changed");
' || fail "restart replay changed durable counts: $final"

observer_after="$observer_before"
if [ -f "$OBSERVER_CONTROL_DB" ]; then observer_after="$(node "$INSPECTOR" "$OBSERVER_CONTROL_DB")"; fi
OBSERVER_BEFORE="$observer_before" OBSERVER_AFTER="$observer_after" node -e '
  const before=JSON.parse(process.env.OBSERVER_BEFORE), after=JSON.parse(process.env.OBSERVER_AFTER);
  for(const key of ["objects","checkpoints","idempotencyRecords","localCommitWork","packedObjects"]) if(after[key]!==before[key]) throw new Error(`observer ${key} changed before WAL-019`);
' || fail "observer received WAL state before reconciliation was enabled"

log "PASS: one durable local atom/checkpoint, stable immediate/restart replay, legacy sync authority, no false propagation"
