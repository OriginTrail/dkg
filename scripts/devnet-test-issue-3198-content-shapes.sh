#!/usr/bin/env bash
#
# issue-3198 content shapes: what one node shares must reach every other node,
# whatever the literal looks like and whatever store each node runs.
#
# Two of the defects behind issue 3198 were invisible to every devnet suite,
# because no suite shared anything but plain strings and integers:
#
#   1. A literal with a tab (or another control character) could not be
#      published by its author into the root of a context graph. The author
#      logged `catalog_repair_failed` on every retry, and nothing that author
#      shared into that root afterwards arrived anywhere either.
#   2. A node on Blazegraph refused an asset whose typed literal the store
#      returns in another lexical form than it was given: a whole-second
#      xsd:dateTime comes back with ".000", an integral xsd:double or xsd:float
#      with ".0". The receiver logged NQUADS_BYTE_LIMIT_EXCEEDED or "post-read
#      differs" and never activated the asset. An all-Oxigraph network never
#      showed it.
#
# What this script does. For an author on Oxigraph and then for an author on
# Blazegraph it creates a new public, unregistered context graph (the kind a
# user gets by default, whose root is carried by the author's catalog), lets
# every other node of the devnet connect to the author and subscribe, and then
# shares the battery of scripts/lib/qa/content-shapes.mjs one asset at a time:
# first into the root, then into a named sub-graph (another delivery path).
#
#   plain text -> typed literals -> text outside ASCII -> tabs -> U+0001
#   -> plain text again
#
# The typed asset comes before the ones with control characters on purpose: on
# a build with both defects it then fails on the Blazegraph receivers only,
# while the tab asset fails everywhere, so the report tells the two apart. The
# last plain asset is the one that matters most: it is the asset a user shares
# AFTER the one that could not be published.
#
# Every asset must be in shared memory on every other node within
# CONTENT_SHAPES_ARRIVAL_SECS, with the value it was written with (the same
# characters for text, the same value for a typed literal: a store may answer
# "100.0" for "100"). Afterwards the node logs written during the run must not
# hold a repeated `catalog_repair_failed` (authors) nor NQUADS_BYTE_LIMIT_EXCEEDED
# or "post-read differs" (anyone).
#
# Blazegraph is not optional. A devnet without one node on Blazegraph FAILS this
# script (it does not skip): that is the configuration in which defect 2 went
# unseen. The first report line names the store of every node. On a machine
# where the Blazegraph container cannot run (Apple silicon), start the native
# one first:
#
#   BLAZEGRAPH_JAR=/path/to/blazegraph.jar scripts/devnet-blazegraph-native.sh start
#   DEVNET_BLAZEGRAPH_CTX=blazegraph scripts/devnet.sh start 6
#   ... the run ...
#   scripts/devnet.sh stop && scripts/devnet-blazegraph-native.sh stop
#
# Exit codes: 0 every check held; 1 at least one check failed (or a node, a
# store or the devnet itself was not usable).
#
# Env knobs:
#   DEVNET_DIR, API_PORT_BASE, NUM_NODES (default 6)
#   CONTENT_SHAPES_ARRIVAL_SECS   time an asset has to reach every receiver
#                                 after its share job finished (default 90;
#                                 a healthy devnet needs 3 to 30 s)
#   CONTENT_SHAPES_JOB_SECS       time a share job has to finish (default 60)
#   CONTENT_SHAPES_SETUP_SECS     time a subscriber has to hold the graph's
#                                 definition (default 60)
#   CONTENT_SHAPES_STORES_ONLY=1  stop after the store check: answers "can this
#                                 devnet run the gate?" in a second, before a
#                                 run of hours is started on it
#   CONTENT_SHAPES_ONLY=oxigraph|blazegraph
#                                 run the batteries of one author only (to
#                                 repeat part of a failed run; not for a gate)
#   CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH=1
#                                 explicit opt-out for a devnet that cannot have
#                                 Blazegraph: the Oxigraph batteries still run
#                                 and the report says that defect 2 was not
#                                 covered. Never set it in a release gate.
#
# Run standalone against a running devnet:
#   scripts/devnet-test-issue-3198-content-shapes.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NUM_NODES="${NUM_NODES:-6}"
ARRIVAL_SECS="${CONTENT_SHAPES_ARRIVAL_SECS:-90}"
JOB_SECS="${CONTENT_SHAPES_JOB_SECS:-60}"
SETUP_SECS="${CONTENT_SHAPES_SETUP_SECS:-60}"
SUB_GRAPH="shapes"
export DKG_API_MAXTIME="${DKG_API_MAXTIME:-60}"

# shellcheck source=devnet-lib.sh
. "$REPO_ROOT/scripts/devnet-lib.sh"
# shellcheck source=devnet-observation-helpers.sh
. "$REPO_ROOT/scripts/devnet-observation-helpers.sh"

PASS=0; FAIL=0
STARTED=$(date +%s)
say()  { echo "[issue-3198] $*"; }
ok()   { PASS=$((PASS + 1)); echo "  [PASS] $*"; }
bad()  { FAIL=$((FAIL + 1)); echo "  [FAIL] $*"; }
note() { echo "  [NOTE] $*"; }
shapes() { node "$REPO_ROOT/scripts/lib/qa/content-shapes.mjs" "$@"; }
# json <js expression over the string array a> [args...] -> one JSON document.
# Bodies are built here, never inline: bash 3.2 brace-expands `{"a":1,"b":2}`
# inside a command substitution that is itself an argument.
json() { node -e 'const a = process.argv.slice(2); console.log(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$@"; }
elapsed() { echo $(( $(date +%s) - STARTED )); }

AUTH="${DKG_AUTH:-$(node_token 1)}"
[ -n "$AUTH" ] || { say "FAIL: no auth token (export DKG_AUTH or start a devnet)"; exit 1; }

# ── Part B: which store does each node run? ─────────────────────────────────
STORE=(); ROLE=(); STORE_URL=()
UP_NODES=""; DOWN_NODES=""; BLAZE_NODES=""; OTHER_NODES=""; STORE_LINE=""
for n in $(seq 1 "$NUM_NODES"); do
  answer="$(api "$n" GET /api/status)"
  if [ "$(code_of "$answer")" != "200" ]; then DOWN_NODES="$DOWN_NODES $n"; continue; fi
  status_body="$(body_of "$answer")"
  STORE[$n]="$(field "$status_body" storeBackend)"
  ROLE[$n]="$(field "$status_body" nodeRole)"
  STORE_URL[$n]="$(field "$status_body" storeUrl)"
  UP_NODES="$UP_NODES $n"
  STORE_LINE="$STORE_LINE node$n=${STORE[$n]}(${ROLE[$n]})"
  if [ "${STORE[$n]}" = "blazegraph" ]; then BLAZE_NODES="$BLAZE_NODES $n"; else OTHER_NODES="$OTHER_NODES $n"; fi
done
say "Stores:$STORE_LINE"
[ -z "$DOWN_NODES" ] || bad "node(s)$DOWN_NODES did not answer /api/status"

store_label() { echo "node$1 (${STORE[$1]:-?})"; }

# A node that is configured for Blazegraph but cannot reach it would fail every
# step below for a reason that has nothing to do with content shapes.
for n in $BLAZE_NODES; do
  probe="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H 'Accept: application/sparql-results+json' \
    --data-urlencode 'query=ASK { ?s ?p ?o }' "${STORE_URL[$n]}" 2>/dev/null || true)"
  if [ "$probe" = "200" ]; then ok "node$n runs Blazegraph and its store answers"
  else bad "node$n is configured for Blazegraph but its store does not answer (HTTP ${probe:-none})"; fi
done

if [ -z "$BLAZE_NODES" ]; then
  if [ "${CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH:-0}" = "1" ]; then
    note "NO node runs Blazegraph and CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH=1: the store-form defect (typed literals on a Blazegraph node) is NOT covered by this run"
  else
    bad "no node of this devnet runs Blazegraph: the store-form defect cannot be seen. Start the devnet with Blazegraph (see the header of this script; scripts/devnet-blazegraph-native.sh where the container cannot run), or set CONTENT_SHAPES_ALLOW_NO_BLAZEGRAPH=1 to accept a run without it"
  fi
fi

if [ "${CONTENT_SHAPES_STORES_ONLY:-0}" = "1" ]; then
  say "CONTENT_SHAPES_STORES_ONLY=1: store check only, nothing was shared ($PASS passed, $FAIL failed)"
  [ "$FAIL" -eq 0 ]; exit $?
fi

first_of() { local wanted="$1" n; shift; for n in "$@"; do [ "${ROLE[$n]:-}" = "$wanted" ] && { echo "$n"; return 0; }; done; return 1; }
# The Oxigraph author is an Edge when there is one (the node a user runs).
# shellcheck disable=SC2086
OX_AUTHOR="$(first_of edge $OTHER_NODES || echo "${OTHER_NODES# }" | cut -d' ' -f1)"
# shellcheck disable=SC2086
BZ_AUTHOR="$(echo "${BLAZE_NODES# }" | cut -d' ' -f1)"

# ── log marks: only what the nodes write from here on is judged ──────────────
LOG_MARK=()
for n in $UP_NODES; do LOG_MARK[$n]="$(wc -c < "$DEVNET_DIR/node$n/daemon.log" 2>/dev/null | tr -d ' ' || echo 0)"; done
log_since_mark() { tail -c "+$(( ${LOG_MARK[$1]:-0} + 1 ))" "$DEVNET_DIR/node$1/daemon.log" 2>/dev/null; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_GRAPHS=""    # "<author>|<context graph id>" per line, for the log checks

# 0 when the node lists the graph with its access policy, which it knows only
# from the definition. An unanswered or unreadable listing counts as "not yet".
has_definition() {
  local n="$1" cg="$2" listing
  listing="$(body_of "$(api "$n" GET /api/context-graph/list)")"
  CG="$cg" node -e 'let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
    let graphs = []; try { graphs = JSON.parse(d).contextGraphs || []; } catch {}
    const g = graphs.find(x => x.id === process.env.CG);
    process.exit(g && g.accessPolicy ? 0 : 1); })' <<<"$listing"
}

# "<node> <key>" per line: the first asset of the current battery a node missed.
MISSED_FIRST=""

# share_and_expect <label> <author> <context graph> <sub-graph or ""> <key> <receivers...>
share_and_expect() {
  local label="$1" author="$2" cg="$3" sub="$4" key="$5"; shift 5
  local receivers="$*" where="root" name subject body answer code job state job_view started shared_at
  [ -z "$sub" ] || where="sub-graph"
  name="i3198-${STAMP}-${label}-${where}-${key}"
  name="$(printf '%s' "$name" | tr 'A-Z' 'a-z')"
  subject="urn:issue3198:${STAMP}:${label}:${where}:${key}"
  local what="$label author $(store_label "$author"), $where, $key ($(shapes describe "$key"))"

  body="$(shapes body "$key" "$cg" "$name" "$subject" "$sub")"
  answer="$(api "$author" POST /api/knowledge-assets "$body")"; code="$(code_of "$answer")"
  if [ "$code" != "200" ] && [ "$code" != "201" ]; then
    bad "$what: the author refused the asset: HTTP $code $(body_of "$answer" | head -c 300)"; return 0
  fi
  body="$(json '{ contextGraphId: a[0], entities: "all", ...(a[1] ? { subGraphName: a[1] } : {}) }' "$cg" "$sub")"
  answer="$(api "$author" POST "/api/knowledge-assets/$name/swm/share-async" "$body")"; code="$(code_of "$answer")"
  job="$(field "$(body_of "$answer")" jobId)"
  if [ "$code" != "200" ] || [ -z "$job" ]; then
    bad "$what: the share was not accepted: HTTP $code $(body_of "$answer" | head -c 300)"; return 0
  fi
  shared_at="$(date +%s)"; state="queued"; job_view=""
  while [ $(( $(date +%s) - shared_at )) -lt "$JOB_SECS" ]; do
    job_view="$(body_of "$(api "$author" GET "/api/knowledge-assets/swm/share-jobs/$job")")"
    state="$(field "$job_view" state)"
    case "$state" in succeeded|failed) break ;; esac
    sleep 1
  done
  if [ "$state" != "succeeded" ]; then
    bad "$what: the share job ended '$state' after $(( $(date +%s) - shared_at ))s: $(field "$job_view" lastError | head -c 300)"
    return 0
  fi

  # The author itself, then every receiver, until all hold it or the time is up.
  local sparql scope prefix pending still n rows status verdict arrived="" missing="" different=""
  sparql="SELECT ?g ?p ?o WHERE { GRAPH ?g { <$subject> ?p ?o } }"
  scope="$(json '{ contextGraphId: a[0], includeContextGraphPartitions: true }' "$cg")"
  prefix="did:dkg:context-graph:$cg/${sub:+$sub/}_shared_memory"
  pending="$author $receivers"; started="$(date +%s)"
  while :; do
    still=""
    for n in $pending; do
      status=0
      rows="$(devnet_query_api_settling "http://127.0.0.1:$(node_port "$n")" "$AUTH" "$sparql" o bindings "$scope" 2>/dev/null)" || status=$?
      if [ "$status" -eq 0 ]; then
        status=0; verdict="$(printf '%s' "$rows" | shapes check "$key" "$prefix")" || status=$?
      else
        verdict="no valid read"; status=1
      fi
      case "$status" in
        0) arrived="$arrived node$n:$(( $(date +%s) - shared_at ))s" ;;
        4) different="$different $(store_label "$n"): ${verdict#different }." ;;
        *) still="$still $n" ;;
      esac
    done
    pending="$still"
    [ -n "$pending" ] || break
    [ $(( $(date +%s) - started )) -lt "$ARRIVAL_SECS" ] || break
    sleep 2
  done
  # A node that missed an asset of this battery usually misses the ones after
  # it too. The report names the first one, which is the one to look at.
  local earlier
  for n in $pending; do
    earlier="$(printf '%s\n' "$MISSED_FIRST" | awk -v node="$n" '$1 == node { print $2; exit }')"
    if [ -n "$earlier" ]; then missing="$missing $(store_label "$n") [first missed: $earlier]"
    else missing="$missing $(store_label "$n")"; MISSED_FIRST="$MISSED_FIRST
$n $key"; fi
  done
  if [ -z "$missing" ] && [ -z "$different" ]; then
    ok "$what: in shared memory on every node after$arrived"
  else
    bad "$what:${missing:+ NOT in shared memory ${ARRIVAL_SECS}s after the share job finished on$missing.}${different:+ Another value on$different}${arrived:+ Arrived:$arrived}"
  fi
}

# run_graph <label> <author>: one new public graph, every other node subscribed,
# the battery into the root and then into the sub-graph.
run_graph() {
  local label="$1" author="$2" address cg body answer n receivers="" address_of_author key waited
  say "── $label author: $(store_label "$author") [${ROLE[$author]}] ── (t+$(elapsed)s)"
  address="$(field "$(body_of "$(api "$author" GET /api/agent/identity)")" agentAddress)"
  [ -n "$address" ] || { bad "$label author: node$author did not report its agent address"; return 0; }
  cg="$address/issue-3198-$label-$STAMP"
  body="$(json '{ id: a[0], name: "issue 3198 content shapes (" + a[1] + " author)", accessPolicy: 0, publishPolicy: 1, register: false }' "$cg" "$label")"
  answer="$(api "$author" POST /api/context-graph/create "$body")"
  [ "$(field "$(body_of "$answer")" created)" = "$cg" ] || { bad "$label author: the context graph was not created: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; return 0; }
  body="$(json '{ contextGraphId: a[0], subGraphName: a[1] }' "$cg" "$SUB_GRAPH")"
  answer="$(api "$author" POST /api/sub-graph/create "$body")"
  [ "$(field "$(body_of "$answer")" created)" = "$SUB_GRAPH" ] || { bad "$label author: the sub-graph was not created: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; return 0; }
  RUN_GRAPHS="$RUN_GRAPHS$author|$cg
"
  say "graph $cg"

  # A subscriber asks the peers it is connected to for the graph's definition,
  # once. Two Edges of a devnet are not connected to each other, so every
  # receiver connects to the author first, as a member that was given the
  # creator's address does.
  address_of_author="$(cat "$DEVNET_DIR/node$author/multiaddr" 2>/dev/null || true)"
  for n in $UP_NODES; do
    [ "$n" != "$author" ] || continue
    if [ -n "$address_of_author" ]; then
      body="$(json '{ multiaddr: a[0] }' "$address_of_author")"
      answer="$(api "$n" POST /api/connect "$body")"
      [ "$(code_of "$answer")" = "200" ] || note "node$n could not connect to the author: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 200)"
    fi
    body="$(json '{ contextGraphId: a[0], includeSharedMemory: true }' "$cg")"
    answer="$(api "$n" POST /api/context-graph/subscribe "$body")"
    if [ "$(code_of "$answer")" != "200" ]; then
      bad "$label author: node$n could not subscribe: HTTP $(code_of "$answer") $(body_of "$answer" | head -c 300)"; continue
    fi
    receivers="$receivers $n"
  done
  # Every receiver must hold the definition before the first share. One more
  # subscribe half-way is what a client does when the first one found nothing.
  local with_definition="" since asked_again have
  for n in $receivers; do
    since="$(date +%s)"; asked_again=""; have=""
    while :; do
      if has_definition "$n" "$cg"; then have=1; break; fi
      waited=$(( $(date +%s) - since ))
      [ "$waited" -lt "$SETUP_SECS" ] || break
      if [ -z "$asked_again" ] && [ "$waited" -ge $(( SETUP_SECS / 2 )) ]; then
        asked_again=1
        body="$(json '{ contextGraphId: a[0], includeSharedMemory: true }' "$cg")"
        api "$n" POST /api/context-graph/subscribe "$body" >/dev/null
      fi
      sleep 1
    done
    if [ -n "$have" ]; then with_definition="$with_definition $n"
    else bad "$label author: $(store_label "$n") holds no definition of the graph ${SETUP_SECS}s after it subscribed; nothing shared into it can be expected there"; fi
  done
  receivers="$with_definition"
  [ -n "$receivers" ] || { bad "$label author: no subscriber is ready, the battery was not run"; return 0; }
  say "receivers:$(for n in $receivers; do printf ' %s' "$(store_label "$n")"; done) (t+$(elapsed)s)"

  MISSED_FIRST=""
  for key in $BATTERY; do
    # shellcheck disable=SC2086
    share_and_expect "$label" "$author" "$cg" "" "$key" $receivers
  done
  MISSED_FIRST=""
  for key in $BATTERY; do
    # shellcheck disable=SC2086
    share_and_expect "$label" "$author" "$cg" "$SUB_GRAPH" "$key" $receivers
  done
}

# A battery that could not be read would share nothing and pass on the log
# checks alone.
BATTERY="$(shapes list | tr '\n' ' ')"
[ "$(printf '%s' "$BATTERY" | wc -w | tr -d ' ')" -ge 6 ] || { say "FAIL: the battery of scripts/lib/qa/content-shapes.mjs could not be read"; exit 1; }

# CONTENT_SHAPES_ONLY=oxigraph|blazegraph runs one author only (for a rerun
# while investigating a failure; a release gate runs both).
case "${CONTENT_SHAPES_ONLY:-}" in
  "") ;;
  oxigraph) BZ_AUTHOR=""; note "CONTENT_SHAPES_ONLY=oxigraph: the Blazegraph author was NOT run" ;;
  blazegraph) OX_AUTHOR="skip"; note "CONTENT_SHAPES_ONLY=blazegraph: the Oxigraph author was NOT run" ;;
  *) bad "CONTENT_SHAPES_ONLY must be 'oxigraph' or 'blazegraph'" ;;
esac
if [ "$OX_AUTHOR" = "skip" ]; then :
elif [ -n "$OX_AUTHOR" ]; then run_graph oxigraph "$OX_AUTHOR"
else bad "no node on an Oxigraph store to be the author"; fi
if [ -n "$BZ_AUTHOR" ]; then run_graph blazegraph "$BZ_AUTHOR"; fi

# ── the logs of this run ─────────────────────────────────────────────────────
# The defects were loud in the logs long before anybody looked at the data.
# Neither line names its context graph, so the check is by node and by time:
# what a node wrote since this script started.
#   - An author that cannot publish a catalog row logs catalog_repair_failed on
#     every retry, with a growing "consecutiveFailures". One such line with a
#     count of 0 or 1 is a retry that then succeeded (a full devnet run has a
#     few); two failures in a row are not.
#   - A receiver that reads a row back in another form logs the refusal with
#     NQUADS_BYTE_LIMIT_EXCEEDED or "post-read differs" / "post-read failed". A
#     full devnet run without the defect has no such line on any node.
say "── node logs written during this run ── (t+$(elapsed)s)"
AUTHORS="$(printf '%s\n' "$RUN_GRAPHS" | awk -F'|' 'NF == 2 { print $1 }' | sort -u | tr '\n' ' ')"
for n in $AUTHORS; do
  found="$(log_since_mark "$n" | grep -F '"event":"catalog_repair_failed"' || true)"
  repeated="$(printf '%s\n' "$found" | grep -E '"consecutiveFailures":([2-9]|[1-9][0-9]+)' || true)"
  if [ -n "$repeated" ]; then
    bad "author node$n logged catalog_repair_failed $(printf '%s\n' "$found" | wc -l | tr -d ' ') time(s), failing repeatedly; one of them: $(printf '%s\n' "$repeated" | head -1 | cut -c1-320)"
  else
    ok "author node$n logged no repeated catalog_repair_failed"
    [ -z "$found" ] || note "author node$n logged catalog_repair_failed $(printf '%s\n' "$found" | wc -l | tr -d ' ') time(s) and recovered each time"
  fi
done
refused=0
for n in $UP_NODES; do
  found="$(log_since_mark "$n" | grep -E 'NQUADS_BYTE_LIMIT_EXCEEDED|post-read (differs|failed)' || true)"
  [ -n "$found" ] || continue
  refused=1
  bad "$(store_label "$n") refused what it read back from its store $(printf '%s\n' "$found" | wc -l | tr -d ' ') time(s); first: $(printf '%s\n' "$found" | head -1 | sed 's/^.*\[DKGAgent\] //' | cut -c1-320)"
done
[ "$refused" -ne 0 ] || ok "no node refused what it read back from its store (no NQUADS_BYTE_LIMIT_EXCEEDED, no \"post-read differs\")"

echo
say "Stores:$STORE_LINE"
say "Results: $PASS passed, $FAIL failed in $(elapsed)s"
[ "$FAIL" -eq 0 ]
