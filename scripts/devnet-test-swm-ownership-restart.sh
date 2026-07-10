#!/usr/bin/env bash
#
# SWM ownership restart regression.
#
# Reproduces the Phase 0 correctness slice for issue #747 against real
# devnet daemons:
#
#   1. Node 1 promotes a root entity into the public devnet CG.
#   2. Node 2 receives the SWM data plus _shared_memory_meta owner row.
#   3. Node 1 is stopped, so the original owner is offline.
#   4. Node 2 is restarted, clearing process-local publisher ownership maps
#      while preserving its local store and without live owner help.
#   5. Node 2 attempts to promote the same root. Assertion-promote ownership
#      conflicts are advisory skips (#1116): the call returns HTTP 200 with an
#      explicit non-share outcome and must not overwrite SWM data or owner.
#
# Preconditions:
#   ./scripts/devnet.sh clean
#   ./scripts/devnet.sh start 6
#
# No bootstrap publishes are required; the script only uses the daemon HTTP API.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CONTEXT_GRAPH="${CONTEXT_GRAPH:-devnet-test}"
OWNER_NODE="${OWNER_NODE:-1}"
ATTACKER_NODE="${ATTACKER_NODE:-2}"
TMPDIR="${TMPDIR:-/tmp}"

DKG_WORKSPACE_OWNER="http://dkg.io/ontology/workspaceOwner"
SCHEMA_NAME="http://schema.org/name"

log()  { echo "[swm-own] $*"; }
warn() { echo "[swm-own] WARN: $*" >&2; }
fail() { echo "[swm-own] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[swm-own] === $1 ==="; }

node_dir()     { echo "$DEVNET_DIR/node$1"; }
node_token()   { grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()    { echo $((API_PORT_BASE + $1 - 1)); }
node_pidfile() { echo "$(node_dir "$1")/devnet.pid"; }

require_node() {
  local node="$1"
  [ -d "$(node_dir "$node")" ] || fail "node $node home missing; run ./scripts/devnet.sh start 6 first"
  [ -n "$(node_token "$node")" ] || fail "node $node auth token missing"
}

api_capture() {
  local node="$1" method="$2" path="$3" data="${4:-}" body_out="$5" code_out="$6"
  # Shadow-bug fix (#779 comprehensive devnet test follow-up): the
  # caller `api_call` pre-declares its own `local body` and `local
  # code` and passes the literal names "body" / "code" as `body_out`
  # / `code_out`. If THIS function ALSO declares `local code` (or
  # `local body`), bash's dynamic scoping makes the local declaration
  # SHADOW the caller's variable. `printf -v "$code_out" "%s" ...`
  # then writes to api_capture's local `code`, not api_call's. After
  # api_capture returns, the local copy is destroyed and api_call's
  # `code` is still empty — the `[0-9][0-9][0-9]` case in api_call
  # falls through to the `*) code="000"` arm, every probe surfaces
  # as HTTP 000, and the script aborts on a perfectly healthy daemon.
  # Use `_`-prefixed local names so they cannot collide with
  # `body_out` / `code_out` slot names the caller passes in.
  local port token tmp _code _content
  port=$(node_port "$node")
  token=$(node_token "$node")
  tmp="$(mktemp "$TMPDIR/swm-own-response-XXXXXX")"
  local -a curl_args=(-sS --max-time 180 --connect-timeout 5 -o "$tmp" -w "%{http_code}" -X "$method")
  curl_args+=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  # `set -euo pipefail` is in effect (line 22), so a bare
  # `_code=$(curl ...) ; rc=$?` would `errexit` the whole script
  # before `$?` is captured (Codex review on #778). Wrap the call in
  # `if cmd; then ... else ...; fi` — that branch is one of the
  # documented `errexit` exceptions, so a transport failure flows to
  # the `else` arm and we get a single canonical `000` back. We also
  # guard against `curl` exiting cleanly while emitting nothing
  # (rare, but `-w "%{http_code}"` can yield an empty stdout if the
  # request is aborted between connect and first byte).
  if _code=$(curl "${curl_args[@]}" 2>/dev/null); then
    [ -z "$_code" ] && _code="000"
  else
    _code="000"
  fi
  _content="$(cat "$tmp" 2>/dev/null || true)"
  rm -f "$tmp"
  printf -v "$body_out" '%s' "$_content"
  printf -v "$code_out" '%s' "$_code"
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}" body code
  api_capture "$node" "$method" "$path" "$data" body code
  # Defensive normalization for any caller that bypasses `api_capture`
  # — transport failures should always surface as a clean `000` so the
  # HTTP-status arithmetic below never blows up with "integer
  # expression expected" and obscures the real "node ack'd nothing"
  # failure mode (#774 finding #3 fired this on every probe).
  case "$code" in
    [0-9][0-9][0-9]) ;;
    *) code="000" ;;
  esac
  if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
    fail "$method $path on node $node failed with HTTP $code: $body"
  fi
  printf '%s' "$body"
}

parse_json() {
  printf '%s' "$1" | node -e "
    let d='';
    process.stdin.on('data', c => d += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(d);
        const v = j$2;
        console.log(v == null ? '' : v);
      } catch {
        process.exit(1);
      }
    });
  "
}

binding_values() {
  local json="$1" var="$2"
  printf '%s' "$json" | VAR="$var" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const bindings = j?.result?.bindings ?? j?.bindings ?? [];
        const unwrap = (cell) => {
          if (cell == null) return "";
          if (typeof cell === "object" && "value" in cell) return String(cell.value);
          const s = String(cell);
          const m = s.match(/^"((?:\\.|[^"\\])*)"(?:\^\^<[^>]+>|@[A-Za-z-]+)?$/);
          if (!m) return s;
          try { return JSON.parse("\"" + m[1] + "\""); } catch { return m[1]; }
        };
        for (const b of bindings) {
          const v = unwrap(b[process.env.VAR]);
          if (v) console.log(v);
        }
      } catch {
        process.exit(1);
      }
    });
  '
}

bindings_count() {
  local json="$1"
  printf '%s' "$json" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const bindings = j?.result?.bindings ?? j?.bindings ?? [];
        console.log(Array.isArray(bindings) ? bindings.length : "PARSE_ERR");
      } catch {
        console.log("PARSE_ERR");
      }
    });
  '
}

quads_count() {
  local json="$1"
  printf '%s' "$json" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const quads = j?.quads ?? j?.result ?? [];
        console.log(Array.isArray(quads) ? quads.length : "PARSE_ERR");
      } catch {
        console.log("PARSE_ERR");
      }
    });
  '
}

json_write_payload() {
  ROOT="$1" VALUE="$2" CG="$CONTEXT_GRAPH" PRED="$SCHEMA_NAME" node -e '
    console.log(JSON.stringify({
      contextGraphId: process.env.CG,
      quads: [{
        subject: process.env.ROOT,
        predicate: process.env.PRED,
        object: JSON.stringify(process.env.VALUE),
        graph: "",
      }],
    }));
  '
}

json_owner_query_payload() {
  ROOT="$1" CG="$CONTEXT_GRAPH" OWNER_PRED="$DKG_WORKSPACE_OWNER" node -e '
    const metaGraph = `did:dkg:context-graph:${process.env.CG}/_shared_memory_meta`;
    console.log(JSON.stringify({
      contextGraphId: process.env.CG,
      sparql:
        `SELECT DISTINCT ?owner WHERE { GRAPH <${metaGraph}> { <${process.env.ROOT}> <${process.env.OWNER_PRED}> ?owner } }`,
    }));
  '
}

json_swm_value_query_payload() {
  ROOT="$1" CG="$CONTEXT_GRAPH" PRED="$SCHEMA_NAME" node -e '
    console.log(JSON.stringify({
      contextGraphId: process.env.CG,
      graphSuffix: "_shared_memory",
      sparql: `SELECT DISTINCT ?value WHERE { <${process.env.ROOT}> <${process.env.PRED}> ?value }`,
    }));
  '
}

wait_for_node_down() {
  local node="$1" port
  port=$(node_port "$node")
  for _ in $(seq 1 60); do
    if ! curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:${port}/api/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  fail "node $node did not stop within 30s"
}

wait_for_node_up() {
  local node="$1" port
  port=$(node_port "$node")
  for _ in $(seq 1 240); do
    if curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:${port}/api/status" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  fail "node $node did not start within 120s"
}

kill_node() {
  local node="$1"
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh stop-node "$node" 2>&1 | sed "s/^/  [devnet] /" )
  wait_for_node_down "$node"
}

restart_node() {
  local node="$1"
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh restart-node "$node" 2>&1 | sed "s/^/  [devnet] /" )
  wait_for_node_up "$node"
}

OWNER_STOPPED=0
restart_owner_if_stopped() {
  if [ "$OWNER_STOPPED" -eq 1 ]; then
    log "trap: restarting owner node $OWNER_NODE so the devnet stays usable"
    restart_node "$OWNER_NODE" || warn "trap: failed to restart owner node $OWNER_NODE"
  fi
}
trap restart_owner_if_stopped EXIT

get_peer_id() {
  local node="$1" identity
  identity=$(api_call "$node" GET /api/agent/identity)
  parse_json "$identity" '.peerId'
}

assertion_create_write_finalize() {
  local node="$1" assertion="$2" root="$3" value="$4" response count payload assertion_uri merkle_root
  response=$(api_call "$node" POST /api/knowledge-assets "{\"contextGraphId\":\"$CONTEXT_GRAPH\",\"name\":\"$assertion\"}")
  assertion_uri=$(parse_json "$response" '.assertionUri')
  [ -n "$assertion_uri" ] || fail "create response missing assertionUri: $response"

  payload=$(json_write_payload "$root" "$value")
  response=$(api_call "$node" POST "/api/knowledge-assets/${assertion}/wm/write" "$payload")
  count=$(parse_json "$response" '.written')
  [ "$count" = "1" ] || fail "expected one written quad for $assertion, got '$count': $response"

  response=$(api_call "$node" POST "/api/knowledge-assets/${assertion}/wm/finalize" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
  merkle_root=$(parse_json "$response" '.merkleRoot')
  [ -n "$merkle_root" ] || fail "finalize response missing merkleRoot: $response"
}

promote_expect_success() {
  local node="$1" assertion="$2" response count
  response=$(api_call "$node" POST "/api/knowledge-assets/${assertion}/swm/share" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
  count=$(parse_json "$response" '.promotedCount')
  [ "$count" = "1" ] || fail "expected one promoted quad for $assertion, got '$count': $response"
}

assert_cross_owner_promote_skipped() {
  local code="$1" body="$2"
  [ "$code" -ge 200 ] && [ "$code" -lt 300 ] || return 1
  printf '%s' "$body" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      try {
        const result = JSON.parse(input);
        const valid = result.swmShared === false &&
          result.promotedCount === 0 &&
          result.sealed === false &&
          result.publishReady === false;
        process.exit(valid ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

owner_values_on_node() {
  local node="$1" root="$2" response
  response=$(api_call "$node" POST /api/query "$(json_owner_query_payload "$root")")
  binding_values "$response" owner
}

swm_values_on_node() {
  local node="$1" root="$2" response
  response=$(api_call "$node" POST /api/query "$(json_swm_value_query_payload "$root")")
  binding_values "$response" value
}

wait_for_owner_meta() {
  local node="$1" root="$2" expected_owner="$3" values
  for _ in $(seq 1 90); do
    values="$(owner_values_on_node "$node" "$root" 2>/dev/null || true)"
    if [ "$values" = "$expected_owner" ]; then
      return 0
    fi
    sleep 1
  done
  fail "node $node did not observe durable owner '$expected_owner' for $root; last owners='$values'"
}

wait_for_swm_value() {
  local node="$1" root="$2" expected_value="$3" values
  for _ in $(seq 1 90); do
    values="$(swm_values_on_node "$node" "$root" 2>/dev/null || true)"
    if printf '%s\n' "$values" | grep -Fxq "$expected_value"; then
      return 0
    fi
    sleep 1
  done
  fail "node $node did not observe SWM value '$expected_value' for $root; last values='$values'"
}

require_node "$OWNER_NODE"
require_node "$ATTACKER_NODE"
wait_for_node_up "$OWNER_NODE"
wait_for_node_up "$ATTACKER_NODE"

OWNER_PEER=$(get_peer_id "$OWNER_NODE")
ATTACKER_PEER=$(get_peer_id "$ATTACKER_NODE")
[ -n "$OWNER_PEER" ] || fail "owner peer id missing"
[ -n "$ATTACKER_PEER" ] || fail "attacker peer id missing"
[ "$OWNER_PEER" != "$ATTACKER_PEER" ] || fail "owner and attacker peer IDs unexpectedly match"

STAMP="$(date +%s)-$$"
ROOT="urn:swm-ownership-restart:${STAMP}"
OWNER_ASSERTION="swm-owner-${STAMP}"
ATTACKER_ASSERTION="swm-attacker-${STAMP}"
OWNER_VALUE="owner-original-${STAMP}"
ATTACKER_VALUE="attacker-overwrite-${STAMP}"

log "Context graph: $CONTEXT_GRAPH"
log "Owner:        node $OWNER_NODE peer=$OWNER_PEER"
log "Attacker:     node $ATTACKER_NODE peer=$ATTACKER_PEER"
log "Root:         $ROOT"

act "1. Owner promotes a root into SWM"
assertion_create_write_finalize "$OWNER_NODE" "$OWNER_ASSERTION" "$ROOT" "$OWNER_VALUE"
promote_expect_success "$OWNER_NODE" "$OWNER_ASSERTION"
log "owner promote succeeded"

act "2. Replica has SWM data and durable owner metadata"
wait_for_swm_value "$ATTACKER_NODE" "$ROOT" "$OWNER_VALUE"
wait_for_owner_meta "$ATTACKER_NODE" "$ROOT" "$OWNER_PEER"
log "node $ATTACKER_NODE has owner metadata before restart"

act "3. Stop owner so enforcement cannot depend on live owner gossip"
OWNER_STOPPED=1
kill_node "$OWNER_NODE"
log "owner node $OWNER_NODE is offline"

act "4. Restart replica to clear process-local ownership state while owner is offline"
restart_node "$ATTACKER_NODE"
wait_for_swm_value "$ATTACKER_NODE" "$ROOT" "$OWNER_VALUE"
wait_for_owner_meta "$ATTACKER_NODE" "$ROOT" "$OWNER_PEER"
log "node $ATTACKER_NODE still has durable owner metadata after offline-owner restart"

act "5. Cross-owner promote must be advisory-skipped from durable local metadata"
assertion_create_write_finalize "$ATTACKER_NODE" "$ATTACKER_ASSERTION" "$ROOT" "$ATTACKER_VALUE"

PROMOTE_BODY=""
PROMOTE_CODE=""
api_capture "$ATTACKER_NODE" POST "/api/knowledge-assets/${ATTACKER_ASSERTION}/swm/share" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}" PROMOTE_BODY PROMOTE_CODE
assert_cross_owner_promote_skipped "$PROMOTE_CODE" "$PROMOTE_BODY" \
  || fail "cross-owner promote must return the advisory non-share contract (HTTP 200, swmShared=false, promotedCount=0, sealed=false, publishReady=false); got HTTP $PROMOTE_CODE: $PROMOTE_BODY"
log "cross-owner promote returned the advisory non-share contract"

act "6. Blocked/skipped promote left WM, SWM, and ownership metadata intact"
ASSERTION_QUERY=$(api_call "$ATTACKER_NODE" GET "/api/knowledge-assets/${ATTACKER_ASSERTION}/wm/quads?contextGraphId=$CONTEXT_GRAPH")
ASSERTION_CT=$(quads_count "$ASSERTION_QUERY")
[ "$ASSERTION_CT" = "1" ] || fail "attacker WM assertion should still have 1 quad after failed promote, got '$ASSERTION_CT': $ASSERTION_QUERY"

VALUES_AFTER="$(swm_values_on_node "$ATTACKER_NODE" "$ROOT")"
printf '%s\n' "$VALUES_AFTER" | grep -Fxq "$OWNER_VALUE" \
  || fail "owner SWM value missing after failed promote; values='$VALUES_AFTER'"
if printf '%s\n' "$VALUES_AFTER" | grep -Fxq "$ATTACKER_VALUE"; then
  fail "attacker value leaked into SWM after failed promote; values='$VALUES_AFTER'"
fi

OWNERS_AFTER="$(owner_values_on_node "$ATTACKER_NODE" "$ROOT")"
[ "$OWNERS_AFTER" = "$OWNER_PEER" ] \
  || fail "owner metadata changed after failed promote; owners='$OWNERS_AFTER', expected '$OWNER_PEER'"

log "PASS: durable SWM ownership prevents cross-author overwrite after restart while owner is offline"
