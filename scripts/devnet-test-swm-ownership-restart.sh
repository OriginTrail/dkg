#!/usr/bin/env bash
#
# SWM ownership restart regression (issue #747), graph-scoped model.
#
# Since 10.0.7 a shared Knowledge Asset lives in its author's own graph,
# did:dkg:context-graph:<cg>/_shared_memory/<author>/<n>. Ownership is that
# graph: no root-keyed dkg:workspaceOwner rows are written, and another author
# sharing the same RDF subject gets its own graph instead of a skip. Against
# real devnet daemons:
#
#   1. Node 1 shares a KA for <ROOT> into the public devnet CG.
#   2. Node 2 receives it in node 1's author graph.
#   3. Node 1 is stopped, so the original owner is offline.
#   4. Every other node is stopped too, and node 2 is restarted with no peer
#      online: the owner copy it still holds must come from its own store,
#      not from a sync-on-connect re-fetch.
#   5. Node 2 shares its own KA for the same <ROOT>; the share succeeds.
#   6. Node 1's copy is unchanged; node 2's copy is isolated in node 2's
#      author graph; node 2's WM draft drained; no root-keyed
#      dkg:workspaceOwner row exists.
#
# Node 2 stays isolated through step 6. On exit the script restarts every node
# it stopped.
#
# Preconditions:
#   ./scripts/devnet.sh clean
#   ./scripts/devnet.sh start 6
#
# No bootstrap publishes are required; the script only uses the daemon HTTP API
# and devnet.sh stop-node / restart-node.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CONTEXT_GRAPH="${CONTEXT_GRAPH:-devnet-test}"
OWNER_NODE="${OWNER_NODE:-1}"
ATTACKER_NODE="${ATTACKER_NODE:-2}"
TMPDIR="${TMPDIR:-/tmp}"

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

# Print the distinct ?value bindings of a /api/query answer whose ?g is one of
# <author>'s SWM graphs (did:dkg:context-graph:<cg>/_shared_memory/<author>/<n>).
# Fails on an answer without a bindings array.
author_swm_values() {
  local json="$1" author="$2"
  printf '%s' "$json" | PREFIX="did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory/${author}/" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const bindings = JSON.parse(d)?.result?.bindings;
        if (!Array.isArray(bindings)) process.exit(1);
        const unwrap = (cell) => {
          if (cell == null) return "";
          if (typeof cell === "object" && "value" in cell) return String(cell.value);
          const s = String(cell);
          const m = s.match(/^"((?:\\.|[^"\\])*)"(?:\^\^<[^>]+>|@[A-Za-z-]+)?$/);
          if (!m) return s;
          try { return JSON.parse("\"" + m[1] + "\""); } catch { return m[1]; }
        };
        const values = new Set();
        for (const b of bindings) {
          const graph = unwrap(b.g).replace(/^<|>$/g, "");
          const value = unwrap(b.value);
          if (graph.startsWith(process.env.PREFIX) && value) values.add(value);
        }
        for (const value of [...values].sort()) console.log(value);
      } catch {
        process.exit(1);
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

# Root-keyed ownership rows, which graph-scoped KAs no longer write.
json_workspace_owner_query_payload() {
  ROOT="$1" CG="$CONTEXT_GRAPH" node -e '
    const meta = `did:dkg:context-graph:${process.env.CG}/_shared_memory_meta`;
    console.log(JSON.stringify({
      contextGraphId: process.env.CG,
      sparql: `SELECT ?owner WHERE { GRAPH <${meta}> { <${process.env.ROOT}> <http://dkg.io/ontology/workspaceOwner> ?owner } }`,
    }));
  '
}

# On the SWM route `GRAPH ?g` binds the CG's per-KA SWM graphs.
json_swm_graph_query_payload() {
  ROOT="$1" CG="$CONTEXT_GRAPH" PRED="$SCHEMA_NAME" node -e '
    console.log(JSON.stringify({
      contextGraphId: process.env.CG,
      graphSuffix: "_shared_memory",
      sparql: `SELECT DISTINCT ?g ?value WHERE { GRAPH ?g { <${process.env.ROOT}> <${process.env.PRED}> ?value } }`,
    }));
  '
}

node_is_up() {
  curl -sf --max-time 1 -o /dev/null "http://127.0.0.1:$(node_port "$1")/api/status" >/dev/null 2>&1
}

wait_for_node_down() {
  local node="$1"
  for _ in $(seq 1 60); do
    node_is_up "$node" || return 0
    sleep 0.5
  done
  fail "node $node did not stop within 30s"
}

# Returns non-zero after 120s instead of failing, so the EXIT trap can still
# restart the remaining nodes.
wait_for_node_up() {
  local node="$1"
  for _ in $(seq 1 240); do
    node_is_up "$node" && return 0
    sleep 0.5
  done
  return 1
}

# Nodes the EXIT trap restarts: every node this script stopped, plus the
# replica once it was restarted without peers. They restart in ascending
# order, as devnet.sh start does, so each dials the earlier cores again
# (node 1 dials no one).
RESTORE_NODES=""

kill_node() {
  local node="$1"
  RESTORE_NODES="$RESTORE_NODES $node"
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh stop-node "$node" 2>&1 | sed "s/^/  [devnet] /" )
  wait_for_node_down "$node"
}

restart_node() {
  local node="$1"
  ( cd "$REPO_ROOT" && ./scripts/devnet.sh restart-node "$node" 2>&1 | sed "s/^/  [devnet] /" )
  wait_for_node_up "$node"
}

restore_nodes() {
  local node
  for node in $(printf '%s\n' $RESTORE_NODES | sort -nu); do
    log "trap: restarting node $node so the devnet stays usable"
    restart_node "$node" || warn "trap: node $node did not come back within 120s"
  done
}
trap restore_nodes EXIT

# Every running devnet node except the replica.
other_running_nodes() {
  local dir node
  for dir in "$DEVNET_DIR"/node[0-9]*; do
    node="${dir##*/node}"
    [[ "$node" =~ ^[0-9]+$ ]] || continue
    [ "$node" = "$ATTACKER_NODE" ] && continue
    if node_is_up "$node"; then echo "$node"; fi
  done
}

assert_no_connected_peers() {
  local node="$1" status peers
  status=$(api_call "$node" GET /api/status)
  peers=$(parse_json "$status" '.connectedPeers')
  [ "$peers" = "0" ] || fail "node $node is connected to '$peers' peer(s); the check needs it isolated"
}

get_peer_id() {
  local node="$1" identity
  identity=$(api_call "$node" GET /api/agent/identity)
  parse_json "$identity" '.peerId'
}

# Sets SEAL_AUTHOR to the lower-cased seal author, the <author> segment of the
# KA's SWM graph.
SEAL_AUTHOR=""
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
  SEAL_AUTHOR=$(parse_json "$response" '.authorAddress' | tr '[:upper:]' '[:lower:]')
  [[ "$SEAL_AUTHOR" =~ ^0x[0-9a-f]{40}$ ]] || fail "finalize response has no EVM authorAddress: $response"
}

promote_expect_success() {
  local node="$1" assertion="$2" response count
  response=$(api_call "$node" POST "/api/knowledge-assets/${assertion}/swm/share" "{\"contextGraphId\":\"$CONTEXT_GRAPH\"}")
  count=$(parse_json "$response" '.promotedCount')
  [ "$count" = "1" ] || fail "expected one promoted quad for $assertion, got '$count': $response"
}

# Wait until <author>'s SWM graphs on the node hold exactly one value for <root>.
wait_for_author_swm_value() {
  local node="$1" root="$2" author="$3" expected="$4" body="" code="" values=""
  for _ in $(seq 1 90); do
    api_capture "$node" POST /api/query "$(json_swm_graph_query_payload "$root")" body code
    if [ "$code" = "200" ] && values="$(author_swm_values "$body" "$author")" && [ "$values" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  fail "node $node did not hold exactly '$expected' for $root in the SWM graphs of $author; last values='$values' (HTTP $code: ${body:0:500})"
}

require_node "$OWNER_NODE"
require_node "$ATTACKER_NODE"
wait_for_node_up "$OWNER_NODE" || fail "node $OWNER_NODE is not up"
wait_for_node_up "$ATTACKER_NODE" || fail "node $ATTACKER_NODE is not up"

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

act "1. Owner shares a KA for the root into SWM"
assertion_create_write_finalize "$OWNER_NODE" "$OWNER_ASSERTION" "$ROOT" "$OWNER_VALUE"
OWNER_AUTHOR="$SEAL_AUTHOR"
log "owner author: $OWNER_AUTHOR"
promote_expect_success "$OWNER_NODE" "$OWNER_ASSERTION"
wait_for_author_swm_value "$OWNER_NODE" "$ROOT" "$OWNER_AUTHOR" "$OWNER_VALUE"
log "owner share succeeded into its own author graph"

act "2. Replica holds the owner copy in the owner author graph"
wait_for_author_swm_value "$ATTACKER_NODE" "$ROOT" "$OWNER_AUTHOR" "$OWNER_VALUE"
log "node $ATTACKER_NODE has the owner copy before restart"

act "3. Stop owner so nothing depends on live owner gossip"
kill_node "$OWNER_NODE"
log "owner node $OWNER_NODE is offline"

act "4. Isolate the replica and restart it"
# Every other node also holds the owner copy, and node 2 syncs SWM from each
# peer it connects to. With all of them stopped, a copy node 2 holds after the
# restart can only come from its own store.
for other in $(other_running_nodes); do
  kill_node "$other"
done
RESTORE_NODES="$RESTORE_NODES $ATTACKER_NODE"
restart_node "$ATTACKER_NODE" || fail "node $ATTACKER_NODE did not come back within 120s"
assert_no_connected_peers "$ATTACKER_NODE"
wait_for_author_swm_value "$ATTACKER_NODE" "$ROOT" "$OWNER_AUTHOR" "$OWNER_VALUE"
assert_no_connected_peers "$ATTACKER_NODE"
log "node $ATTACKER_NODE kept the owner copy across a restart with no peer online"

act "5. Second author shares the same root into its own graph"
assertion_create_write_finalize "$ATTACKER_NODE" "$ATTACKER_ASSERTION" "$ROOT" "$ATTACKER_VALUE"
ATTACKER_AUTHOR="$SEAL_AUTHOR"
log "attacker author: $ATTACKER_AUTHOR"
[ "$ATTACKER_AUTHOR" != "$OWNER_AUTHOR" ] || fail "owner and attacker share one author ($OWNER_AUTHOR); use nodes with distinct agents"
promote_expect_success "$ATTACKER_NODE" "$ATTACKER_ASSERTION"
log "cross-author share succeeded"

act "6. Owner copy unchanged; attacker copy isolated in its own author graph"
# Still isolated: no peer can repair an owner copy the share clobbered.
wait_for_author_swm_value "$ATTACKER_NODE" "$ROOT" "$ATTACKER_AUTHOR" "$ATTACKER_VALUE"
wait_for_author_swm_value "$ATTACKER_NODE" "$ROOT" "$OWNER_AUTHOR" "$OWNER_VALUE"
assert_no_connected_peers "$ATTACKER_NODE"

WM_RESPONSE=$(api_call "$ATTACKER_NODE" GET "/api/knowledge-assets/${ATTACKER_ASSERTION}/wm/quads?contextGraphId=$CONTEXT_GRAPH")
WM_COUNT=$(parse_json "$WM_RESPONSE" '.quads?.length')
[ "$WM_COUNT" = "0" ] || fail "attacker WM draft should drain after a successful share, got '$WM_COUNT' quads: $WM_RESPONSE"

OWNER_ROWS=$(api_call "$ATTACKER_NODE" POST /api/query "$(json_workspace_owner_query_payload "$ROOT")")
OWNER_ROW_COUNT=$(parse_json "$OWNER_ROWS" '.result?.bindings?.length')
[ "$OWNER_ROW_COUNT" = "0" ] || fail "expected no root-keyed workspaceOwner rows for $ROOT, got '$OWNER_ROW_COUNT': $OWNER_ROWS"

log "PASS: a cross-author share of the same root lands in its own author graph and leaves the offline owner's copy intact after an isolated restart"
