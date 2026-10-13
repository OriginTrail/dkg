#!/usr/bin/env bash
#
# issue-3198 relay-only share: two Edges whose only route to each other is a
# circuit through a relay must still deliver a share into a named sub-graph.
#
# The third defect behind issue 3198. On a public network two Edges behind NATs
# reach each other only through a Core that relays for them. A share into the
# ROOT of a public context graph crossed that link (the author's catalog is
# fetched over request/response streams, which run through a relay). A share
# into a named SUB-GRAPH never did: its recipients were the peers GossipSub
# reports as subscribed, GossipSub does not run over a relayed connection, and
# the direct delivery skipped peers reached through a relay.
#
# No devnet suite could see it, because every devnet node can dial every other
# on loopback. This script builds the missing topology with real daemons:
#
#   - it adds two temporary Edges whose config makes them ANNOUNCE, in place of
#     their listen addresses, a loopback port nobody listens on and their
#     circuit address through node 1 (a Core, so a relay). A peer then knows
#     about each of them what it knows about a node behind a NAT: a direct
#     address that does not work and a relay address that does. The override
#     is in place from the node's first start (DEVNET_ADDNODE_CONFIG_OVERRIDES
#     of `devnet.sh addnode`), so no peer ever learns the real listen port;
#   - one of them dials the other through the relay, and the link is checked on
#     both ends before anything is concluded from it and again at the end:
#     at least one connection, every one of them relayed.
#
# The Cores are kept out of the graph. A Core that discovers a public context
# graph subscribes to it ("auto-subscribed for core hosting") and then forwards
# its gossip; both Edges are connected to every Core, so on a devnet a share can
# reach the second Edge that way a few seconds or a few minutes after the graph
# was created, whatever the relayed link does (seen: a run passed that way while
# the author delivered nothing itself). On the public network no Core carried
# the pair's gossip. So as soon as the graph exists, and before anything is
# shared, every Core subscribes to it and unsubscribes again: a node does not
# re-activate a subscription its operator ended. The script checks before the
# first share and at the end that every Core says it does not follow the graph.
# It fails if one does, and also if one cannot be asked (an error, an answer
# that is not its listing): in both cases nothing it saw is about the link.
#
# Then the first Edge creates a public, unregistered context graph with a
# sub-graph, the second subscribes, and, in this order:
#
#   1. a share into the SUB-GRAPH, made as soon as the second Edge holds the
#      graph's definition, must arrive within RELAY_ONLY_ARRIVAL_SECS of its
#      share job finishing. This is
#      the defect: before the fix nothing delivered it. It also covers the
#      author learning in time that it has a follower.
#   2. a share into the root must arrive (control: the link, the subscription
#      and the definition work; this held before the fix too).
#   3. a second share into the sub-graph, made right after the root share,
#      must arrive as well. The author also offers the root share to the
#      peers it delivers to, and they refuse it by design (the root is
#      carried by the catalog). A delivery rule that holds that refusal
#      against the peer skips it for the next two minutes, and a user who
#      shares into the root and then into a sub-graph loses the second share.
#
# A node also PULLS the shared memory of the graphs it follows from its peers
# every few minutes, which could carry a late share into its window by luck.
# The windows of steps 1 and 3 do not overlap, so one pull cannot serve both.
#
# The two temporary nodes are stopped and removed on exit, also after a failure;
# after a failure their logs are kept under $DEVNET_DIR/issue-3198-relay-only/.
#
# Exit codes: 0 every check held; 1 a check failed; 3 the devnet cannot host the
# scenario (the two node numbers are taken, or node 1 is not a Core) and nothing
# was exercised.
#
# Env knobs:
#   DEVNET_DIR, API_PORT_BASE
#   RELAY_ONLY_NODE_A / RELAY_ONLY_NODE_B   numbers of the temporary nodes (7, 8)
#   RELAY_ONLY_ARRIVAL_SECS                 time a share has to arrive (default 45)
#   RELAY_ONLY_SETTLE_SECS                  extra wait between the subscription
#                                           and the first share (default 0; for
#                                           telling "the author did not know its
#                                           follower yet" from "nothing delivers")
#   RELAY_ONLY_SETUP_SECS                   time each setup step has (default 90)
#   RELAY_ONLY_KEEP_NODES=1                 leave the two nodes running (debugging)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NODE_A="${RELAY_ONLY_NODE_A:-7}"
NODE_B="${RELAY_ONLY_NODE_B:-8}"
ARRIVAL_SECS="${RELAY_ONLY_ARRIVAL_SECS:-45}"
SETUP_SECS="${RELAY_ONLY_SETUP_SECS:-90}"
SETTLE_SECS="${RELAY_ONLY_SETTLE_SECS:-0}"
SUB_GRAPH="relayed"
# Nobody listens on the discard port: a dial of it is refused at once.
DEAD_DIRECT_ADDRESS="/ip4/127.0.0.1/tcp/9"
export DKG_API_MAXTIME="${DKG_API_MAXTIME:-60}"

# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh"
# shellcheck source=devnet-observation-helpers.sh
. "$REPO_ROOT/scripts/devnet-observation-helpers.sh"
# shellcheck source=devnet-listing-helpers.sh
. "$REPO_ROOT/scripts/devnet-listing-helpers.sh"

PASS=0; FAIL=0
STARTED=$(date +%s)
say()  { echo "[issue-3198-relay] $*"; }
ok()   { PASS=$((PASS + 1)); echo "  [PASS] $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "  [FAIL] $*"; }
note() { echo "  [NOTE] $*"; }
skip() { say "SKIP: $*"; exit 3; }
shapes() { node "$REPO_ROOT/scripts/lib/qa/content-shapes.mjs" "$@"; }
json() { node -e 'const a = process.argv.slice(2); console.log(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$@"; }
elapsed() { echo $(( $(date +%s) - STARTED )); }
finish() {
  echo
  say "Results: $PASS passed, $FAIL failed in $(elapsed)s"
  [ "$FAIL" -eq 0 ]; exit $?
}

STARTED_NODES=""
cleanup() {
  local n kept
  [ "${RELAY_ONLY_KEEP_NODES:-0}" != "1" ] || { [ -z "$STARTED_NODES" ] || say "RELAY_ONLY_KEEP_NODES=1: node(s)$STARTED_NODES left running"; return 0; }
  kept="$DEVNET_DIR/issue-3198-relay-only/$(date -u +%Y%m%dT%H%M%SZ)"
  for n in $STARTED_NODES; do
    "$REPO_ROOT/scripts/devnet.sh" stop-node "$n" >/dev/null 2>&1 || true
    # The nodes are gone after this; what they logged is the only evidence of a failure.
    if [ "$FAIL" -gt 0 ] && [ -f "$DEVNET_DIR/node$n/daemon.log" ]; then
      mkdir -p "$kept" && cp "$DEVNET_DIR/node$n/daemon.log" "$kept/node$n.daemon.log" && say "kept the log of node$n: $kept/node$n.daemon.log"
    fi
    rm -rf "$DEVNET_DIR/node$n"
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── can this devnet host the scenario? ───────────────────────────────────────
RELAY_ADDRESS="$(cat "$DEVNET_DIR/node1/multiaddr" 2>/dev/null || true)"
[ -n "$RELAY_ADDRESS" ] || skip "no devnet: $DEVNET_DIR/node1/multiaddr is missing"
node_up 1 || skip "node 1 does not answer"
[ "$(field "$(body_of "$(api 1 GET /api/status)")" nodeRole)" = "core" ] || skip "node 1 is not a Core, so it does not relay"
for n in "$NODE_A" "$NODE_B"; do
  [ ! -d "$DEVNET_DIR/node$n" ] || skip "$DEVNET_DIR/node$n already exists (set RELAY_ONLY_NODE_A / RELAY_ONLY_NODE_B)"
done
AUTH="${DKG_AUTH:-$(node_token 1)}"

# ── two Edges that announce no working direct address ────────────────────────
OVERRIDES="$(json '{ announceAddresses: [a[0], a[1] + "/p2p-circuit"] }' "$DEAD_DIRECT_ADDRESS" "$RELAY_ADDRESS")"
PEER_ID=()
for n in "$NODE_A" "$NODE_B"; do
  STARTED_NODES="$STARTED_NODES $n"
  if ! DEVNET_ADDNODE_CONFIG_OVERRIDES="$OVERRIDES" "$REPO_ROOT/scripts/devnet.sh" addnode "$n" edge >"$DEVNET_DIR/addnode-$n.log" 2>&1; then
    bad "temporary node $n could not be added: $(tail -3 "$DEVNET_DIR/addnode-$n.log" | tr '\n' ' ' | cut -c1-300)"; finish
  fi
  rm -f "$DEVNET_DIR/addnode-$n.log"
  waited=0
  until node_up "$n"; do [ "$waited" -lt "$SETUP_SECS" ] || break; sleep 1; waited=$((waited + 1)); done
  node_up "$n" || { bad "temporary node $n did not answer within ${SETUP_SECS}s"; finish; }
  PEER_ID[$n]="$(field "$(body_of "$(api "$n" GET /api/status)")" peerId)"
  [ -n "${PEER_ID[$n]}" ] || { bad "temporary node $n reports no peer id"; finish; }
done
say "temporary Edges: node$NODE_A and node$NODE_B, relay node1 (t+$(elapsed)s)"

# link <from> <to>: "<connections to that peer> <how many of them are relayed>"
link() {
  body_of "$(api "$1" GET /api/connections)" | PEER="${PEER_ID[$2]}" node -e 'let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
    let all = []; try { all = JSON.parse(d).connections || []; } catch {}
    const mine = all.filter(c => c.peerId === process.env.PEER);
    console.log(mine.length + " " + mine.filter(c => c.transport === "relayed").length); })'
}
# The whole point of the scenario: a link, and nothing but relayed connections on it.
relay_only_link() { # <when>
  local a b
  a="$(link "$NODE_A" "$NODE_B")"; b="$(link "$NODE_B" "$NODE_A")"
  if [ "${a%% *}" -ge 1 ] && [ "${a%% *}" = "${a##* }" ] && [ "${b%% *}" -ge 1 ] && [ "${b%% *}" = "${b##* }" ]; then
    ok "$1: the two Edges are connected through the relay only (node$NODE_A: ${a%% *} relayed, node$NODE_B: ${b%% *} relayed)"; return 0
  fi
  bad "$1: the link is not relay-only (node$NODE_A holds ${a%% *} connection(s) to node$NODE_B, ${a##* } relayed; node$NODE_B holds ${b%% *} to node$NODE_A, ${b##* } relayed); nothing below says anything about a relayed link"
  return 1
}

# The dial is retried: a node can be reached through the relay only once its
# reservation there exists, which its start does not wait for.
CIRCUIT_TO_A="$RELAY_ADDRESS/p2p-circuit/p2p/${PEER_ID[$NODE_A]}"
body="$(json '{ multiaddr: a[0] }' "$CIRCUIT_TO_A")"
waited=0; connected=""
while [ "$waited" -lt "$SETUP_SECS" ]; do
  answer="$(api "$NODE_B" POST /api/connect "$body")"
  [ "$(code_of "$answer")" != "200" ] || { connected=1; break; }
  sleep 2; waited=$((waited + 2))
done
[ -n "$connected" ] || { bad "node$NODE_B could not dial node$NODE_A through the relay within ${SETUP_SECS}s: $(body_of "$answer" | head -c 300)"; finish; }
relay_only_link "before the first share" || finish

# ── a public graph with a sub-graph, followed across the relayed link ────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ADDRESS="$(field "$(body_of "$(api "$NODE_A" GET /api/agent/identity)")" agentAddress)"
[ -n "$ADDRESS" ] || { bad "node$NODE_A did not report its agent address"; finish; }
CG="$ADDRESS/issue-3198-relay-$STAMP"

body="$(json '{ id: a[0], name: "issue 3198 relay-only share", accessPolicy: 0, publishPolicy: 1, register: false }' "$CG")"
answer="$(api "$NODE_A" POST /api/context-graph/create "$body")"
[ "$(field "$(body_of "$answer")" created)" = "$CG" ] || { bad "the context graph was not created: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; finish; }
body="$(json '{ contextGraphId: a[0], subGraphName: a[1] }' "$CG" "$SUB_GRAPH")"
answer="$(api "$NODE_A" POST /api/sub-graph/create "$body")"
[ "$(field "$(body_of "$answer")" created)" = "$SUB_GRAPH" ] || { bad "the sub-graph was not created: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; finish; }
say "graph $CG"

# Keep the Cores out of the graph (see the header). A Core can subscribe only
# once the graph exists (it asks the creator, which it is connected to); the
# subscription is ended at once, and an ended subscription is not re-activated
# when the Core later discovers the graph by itself.
# Which nodes are Cores is read from the devnet's own files, not from an API
# answer: a Core that does not answer must not drop out of the list unnoticed.
CORES=""
graph_body="$(json '{ contextGraphId: a[0] }' "$CG")"
for dir in "$DEVNET_DIR"/node*/; do
  n="${dir%/}"; n="${n##*/node}"
  case "$n" in ''|*[!0-9]*) continue ;; esac
  [ "$n" != "$NODE_A" ] && [ "$n" != "$NODE_B" ] || continue
  role="$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).nodeRole || "edge")); } catch { process.stdout.write("unreadable"); }' "${dir}config.json")"
  case "$role" in
    core) ;;
    edge) continue ;;
    *) bad "the role of node$n could not be read from ${dir}config.json; it may be a Core that carries the graph"; finish ;;
  esac
  CORES="$CORES $n"
  waited=0
  while :; do
    answer="$(api "$n" POST /api/context-graph/subscribe "$graph_body")"
    [ "$(code_of "$answer")" != "200" ] || break
    [ "$waited" -lt "$SETUP_SECS" ] || { bad "Core node$n could not be kept out of the graph (subscribe: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 200))"; finish; }
    sleep 2; waited=$((waited + 2))
  done
  answer="$(api "$n" POST /api/context-graph/unsubscribe "$graph_body")"
  [ "$(code_of "$answer")" = "200" ] || { bad "Core node$n could not be kept out of the graph (unsubscribe: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 200))"; finish; }
done
# The precondition everything below rests on: every Core says that it does not
# follow the graph. A Core whose listing cannot be read has said nothing, and
# that fails the check exactly as a Core that follows the graph does.
cores_kept_out() { # <when>
  local status=0
  # shellcheck disable=SC2086
  devnet_following "$CG" $CORES || status=$?
  case "$status" in
    0) ok "$1: no Core follows the graph, so only the relayed link can carry a sub-graph share"; return 0 ;;
    1) bad "$1: Core(s)$DEVNET_FOLLOWING follow the graph although their subscription was ended: their gossip can carry a share, so nothing here says the relayed link delivered" ;;
    *) bad "$1: whether a Core follows the graph could not be established for$DEVNET_FOLLOWING_UNKNOWN${DEVNET_FOLLOWING:+ (and$DEVNET_FOLLOWING do follow it)}; without that nothing here says the relayed link delivered" ;;
  esac
  return 1
}
[ -n "$CORES" ] || { bad "no Core found under $DEVNET_DIR: there is nothing to keep out of the graph, and no relay either"; finish; }
cores_kept_out "before the first share" || finish
say "Cores$CORES are kept out of the graph (t+$(elapsed)s)"

subscribe_body="$(json '{ contextGraphId: a[0], includeSharedMemory: true }' "$CG")"
answer="$(api "$NODE_B" POST /api/context-graph/subscribe "$subscribe_body")"
[ "$(code_of "$answer")" = "200" ] || { bad "node$NODE_B could not subscribe: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; finish; }
# One more subscribe half-way is what a client does when the first one found nothing.
since="$(date +%s)"; asked_again=""; have=""
while :; do
  if devnet_has_definition "$NODE_B" "$CG"; then have=1; break; fi
  waited=$(( $(date +%s) - since ))
  [ "$waited" -lt "$SETUP_SECS" ] || break
  if [ -z "$asked_again" ] && [ "$waited" -ge $(( SETUP_SECS / 2 )) ]; then
    asked_again=1
    api "$NODE_B" POST /api/context-graph/subscribe "$subscribe_body" >/dev/null
  fi
  sleep 1
done
[ -n "$have" ] || { bad "node$NODE_B holds no definition of the graph ${SETUP_SECS}s after it subscribed (its listing last said: $DEVNET_LISTING_ANSWER)"; finish; }
say "node$NODE_B follows the graph (t+$(elapsed)s)"
case "$SETTLE_SECS" in ''|*[!0-9]*) SETTLE_SECS=0 ;; esac
if [ "$SETTLE_SECS" -gt 0 ]; then
  say "RELAY_ONLY_SETTLE_SECS: waiting ${SETTLE_SECS}s before the first share"
  sleep "$SETTLE_SECS"
fi

# share_and_expect <what> <sub-graph or ""> <tag> <shape key>: node A shares, node B must hold it in time.
share_and_expect() {
  local what="$1" sub="$2" tag="$3" key="$4" name subject body answer job state job_view shared_at started rows status verdict sparql scope prefix
  name="i3198-relay-$(printf '%s' "$STAMP" | tr 'A-Z' 'a-z')-$tag"
  subject="urn:issue3198:relay:$STAMP:$tag"
  body="$(shapes body "$key" "$CG" "$name" "$subject" "$sub")"
  answer="$(api "$NODE_A" POST /api/knowledge-assets "$body")"
  case "$(code_of "$answer")" in 200|201) ;; *) bad "$what: node$NODE_A refused the asset: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; return 1 ;; esac
  body="$(json '{ contextGraphId: a[0], entities: "all", ...(a[1] ? { subGraphName: a[1] } : {}) }' "$CG" "$sub")"
  answer="$(api "$NODE_A" POST "/api/knowledge-assets/$name/swm/share-async" "$body")"
  job="$(field "$(body_of "$answer")" jobId)"
  [ "$(code_of "$answer")" = "200" ] && [ -n "$job" ] || { bad "$what: the share was not accepted: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; return 1; }
  shared_at="$(date +%s)"; state="queued"; job_view=""
  while [ $(( $(date +%s) - shared_at )) -lt "$SETUP_SECS" ]; do
    job_view="$(body_of "$(api "$NODE_A" GET "/api/knowledge-assets/swm/share-jobs/$job")")"
    state="$(field "$job_view" state)"
    case "$state" in succeeded|failed) break ;; esac
    sleep 1
  done
  [ "$state" = "succeeded" ] || { bad "$what: the share job ended '$state': $(field "$job_view" lastError | head -c 300)"; return 1; }
  # The time to arrive runs from the end of the share job, as in the
  # content-shapes script; the report counts from the share itself.
  sparql="SELECT ?g ?p ?o WHERE { GRAPH ?g { <$subject> ?p ?o } }"
  scope="$(json '{ contextGraphId: a[0], includeContextGraphPartitions: true }' "$CG")"
  prefix="did:dkg:context-graph:$CG/${sub:+$sub/}_shared_memory"
  started="$(date +%s)"
  while :; do
    status=0
    rows="$(devnet_query_api_settling "http://127.0.0.1:$(node_port "$NODE_B")" "$AUTH" "$sparql" o bindings "$scope" 2>/dev/null)" || status=$?
    if [ "$status" -eq 0 ]; then
      status=0; verdict="$(printf '%s' "$rows" | shapes check "$key" "$prefix")" || status=$?
      [ "$status" -ne 0 ] || { ok "$what: at node$NODE_B $(( $(date +%s) - shared_at ))s after the share"; return 0; }
      [ "$status" -ne 4 ] || { bad "$what: at node$NODE_B with another value: ${verdict#different }"; return 1; }
    fi
    [ $(( $(date +%s) - started )) -lt "$ARRIVAL_SECS" ] || break
    sleep 1
  done
  bad "$what: NOT at node$NODE_B ${ARRIVAL_SECS}s after its share job finished"
  return 1
}

share_and_expect "a share into the sub-graph" "$SUB_GRAPH" sub-1 plain
share_and_expect "a share into the root (control)" "" root plain
share_and_expect "a share into the sub-graph right after the root share" "$SUB_GRAPH" sub-2 plain-after
relay_only_link "after the last share"
cores_kept_out "after the last share"
finish
