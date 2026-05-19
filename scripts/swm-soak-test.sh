#!/usr/bin/env bash
# swm-soak-test.sh — SWM share reliability soak across the mesh
#
# Validates the SWM Reliable Fan-out plan (RFC-003) end-to-end:
# each participating peer writes one tagged quad per cycle to each
# configured context graph, then samples its local SWM to count
# how many writes from other peers actually arrived. Final report
# computes per-peer + aggregate delivery rate, with the ship-gate
# being ≥99.9% within the soak window.
#
# Topology assumptions
# --------------------
# Multiple operators run this script in parallel against their own
# daemons, all participating in the same set of context graphs.
# The CGs must already exist on every daemon and every participating
# peer must be subscribed to them (and, for curated CGs, on the
# allowlist). This script does NOT create or join CGs — operators
# coordinate that out-of-band (see SETUP STEPS below). Doing it in-
# script would require chain RPC + a shared bootstrap leader, which
# is friction we don't need for an ephemeral validation run.
#
# What it measures
# ----------------
# Three slices of /api/slo per cycle (rc.9 PR-A extended the shape):
#   - protocols.* — substrate sendReliable latencies + delivered/queued
#     counters per protocol (chat, swm-key, swm-update once PR-C lands,
#     swm-share-ack once PR-D lands)
#   - gossip.publishFailures — per-cgId count of failed gossip.publish
#     calls (was silently swallowed pre-PR-A; loud now)
#   - swm.redundantApplies — per-cgId count of (cgId, shareOpId)
#     pairs seen twice within TTL. Informs the Concern-2 dedup
#     decision in RFC-003
#
# Plus per-CG SPARQL snapshot of "how many tagged quads from non-self
# peers exist in our local SWM graph", which is the ground-truth
# delivery measurement.
#
# Ship-gate denominator (PR #572 R12)
# -----------------------------------
# Each peer publishes its OWN accepted-write count after the cycle
# loop finishes (and before the 5-min settle) under
#   urn:swm-soak-summary:<TAG>:<SOAK_COHORT_ID>
# with predicate `urn:swm-soak:writesAccepted "<count>"`. The final
# tally then uses that count — not the configured cycle target — as
# each peer's denominator. Pre-fix the denominator was always
# `SWM_TOTAL_CYCLES`, so any sender that had a local rejection
# (daemon backpressure, manual ctrl-c, etc.) would be scored below
# 100% even when every accepted write reached every receiver. The
# ship gate now strictly measures transport delivery, not the
# composite write+transport pipeline.
#
# Peers whose tombstone never arrives (e.g. their summary share
# itself was dropped, or they crashed before emitting) are reported
# as INDETERMINATE so the operator can investigate rather than
# silently bake a "missing" peer into the pass/fail metric.
#
# Expected setup (SETUP STEPS)
# ----------------------------
# 1. One operator creates each CG and shares the cgId out-of-band:
#    pnpm dkg context create \
#      --name "swm-soak-curated" \
#      --allowed-peer 12D3KooWPeer1 --allowed-peer 12D3KooWPeer2 ...
#    (for curated CGs — include EVERY participant's peerId)
#
#    pnpm dkg context create --name "swm-soak-public"
#    (for public CGs — anyone who subscribes can join)
#
# 2. Every participating operator subscribes locally:
#    pnpm dkg context subscribe <cgId>
#
# 3. Every operator confirms via `pnpm dkg context list` that they
#    see both CGs and have the expected role (member for curated,
#    subscriber for public).
#
# 4. Run this script in parallel on every participant. They will
#    each write 1 tagged quad/cycle/CG and observe the others'
#    writes via local SWM.
#
# Defaults: 1440 cycles × 30s = 12h. Aggressive enough to surface
# the rc8-postmortem "shares disappear" pathology if it recurs.
#
# Required env vars:
#   SENDER_TAG       short label uniquely identifying THIS daemon
#                    (appears in subject URI + report breakdown).
#                    MUST differ between participating peers, else
#                    the tally collapses their writes into a single
#                    sender set. No default — script exits early
#                    if unset.
#
# Optional env vars:
#   SWM_CG_CURATED   comma-separated curated CG ids (default: empty)
#   SWM_CG_PUBLIC    comma-separated public CG ids   (default: empty)
#   SWM_INTERVAL_S   start-to-start cycle cadence in seconds
#                    (default: 30). Wall-clock spacing between
#                    successive cycle starts — per-cycle work
#                    (writes + 5s settle + snapshots + /api/slo)
#                    runs INSIDE this budget rather than stacking
#                    on top of it. A cycle that exceeds the
#                    budget logs a WARN and the next cycle starts
#                    immediately. Pre-fix (PR #572 R11) the loop
#                    slept this many seconds AFTER each cycle's
#                    work, so a 12h × 30s soak actually took
#                    closer to 15h.
#   SWM_TOTAL_CYCLES number of write cycles          (default: 1440)
#   PEERS_EXPECTED   comma-separated peer tags (other ops) for
#                    per-peer delivery breakdown in summary. When
#                    set, the script requires an explicit
#                    SOAK_COHORT_ID (see below) and fails fast at
#                    boot if it's missing — otherwise each peer
#                    would silently self-filter and report 0%
#                    delivery from every other peer.
#   SOAK_COHORT_ID   shared cohort id (REQUIRED for multi-peer
#                    soaks where PEERS_EXPECTED is set — every
#                    participating peer must pass the SAME value
#                    out-of-band). For solo runs (PEERS_EXPECTED
#                    unset) this defaults to the per-invocation
#                    RUN_ID, which still rejects stale rows from
#                    prior solo runs but collapses to
#                    "this peer only" filtering by design.
#   AUTH / DKG_AUTH  bearer token; if neither is set the script
#                    falls back to ${DKG_HOME}/auth.token
#
# At least one of SWM_CG_CURATED / SWM_CG_PUBLIC MUST be set.
#
# Per-run isolation (rc.9 PR-A Codex follow-ups #5 + #8)
# ------------------------------------------------------
# Every write emits `urn:swm-soak:cohortId "<SOAK_COHORT_ID>"` plus
# `urn:swm-soak:runId "<RUN_ID>"`. The tally SPARQL filters strictly
# on the cohort id, which gives a SKEW-FREE current-run filter
# (no comparing remote `sentAt` timestamps against this host's
# clock). For multi-peer soaks, agree on a SOAK_COHORT_ID
# out-of-band — the same way you coordinate CG ids and PEERS_EXPECTED.
# Solo runs can omit it and rely on the per-invocation RUN_ID fallback,
# which still rejects stale rows from prior solo runs of the same
# operator.
#
# Usage
# -----
#   # All four operators agree out-of-band on the same
#   # SOAK_COHORT_ID (e.g. a git short-sha + day stamp); each picks
#   # a unique SENDER_TAG. SOAK_COHORT_ID can be omitted for solo
#   # runs.
#   nohup caffeinate -i bash scripts/swm-soak-test.sh \
#     SWM_CG_CURATED=swm-soak-curated \
#     SWM_CG_PUBLIC=swm-soak-public \
#     SENDER_TAG=MILES \
#     PEERS_EXPECTED=LEX,HERMES,ARX \
#     SOAK_COHORT_ID=rc9-soak-20260518-3bc52a9b \
#     >> ~/.dkg/swm-soak-test.out 2>&1 &
#   disown
#
# Stop early: pkill -f swm-soak-test.sh

set -uo pipefail

for kv in "$@"; do
  case "$kv" in
    *=*) export "$kv" ;;
  esac
done

SWM_CG_CURATED="${SWM_CG_CURATED:-}"
SWM_CG_PUBLIC="${SWM_CG_PUBLIC:-}"
SWM_INTERVAL_S="${SWM_INTERVAL_S:-30}"
SWM_TOTAL_CYCLES="${SWM_TOTAL_CYCLES:-1440}"
# Codex PR #572 R7 (round 3): SENDER_TAG previously defaulted to
# "MILES", which means two operators who forget to override the
# default collapse their writes into one sender set in the tally,
# silently corrupting the per-peer delivery percentages. Now
# required: no default, fail-fast if unset.
SENDER_TAG="${SENDER_TAG:-}"
PEERS_EXPECTED="${PEERS_EXPECTED:-}"

DKG_HOME="${DKG_HOME:-${HOME}/.dkg}"
API="${API:-http://127.0.0.1:9200}"

# Codex PR #572 R9 (round 3): honor an externally-supplied bearer
# before falling back to the local `auth.token` file. Pre-fix the
# script's own error message suggested `export AUTH=<token>`, but
# the loader never checked `${AUTH:-}` first — so remote / API-only
# runs (e.g. driving the soak against a daemon on another host)
# broke even when the caller had already supplied valid creds. We
# now resolve in the documented precedence
#   AUTH > DKG_AUTH > ${DKG_HOME}/auth.token
# matching the pattern in scripts/devnet-test.sh and friends.
AUTH="${AUTH:-${DKG_AUTH:-}}"
if [ -z "$AUTH" ]; then
  # Codex PR #572 R3 + R4: fail fast on missing/empty auth token.
  # Pre-fix the script omitted `set -e` AND did not validate the
  # token, so a missing or comments-only `auth.token` degraded
  # into a 12h run of unauthorized reads/writes returning empty
  # JSON, which then showed up as misleading zero-delivery output.
  # Now: explicit file-exists + non-empty checks BEFORE the long-
  # running loop, matching the precedent in scripts/devnet-test.sh.
  #
  # Codex PR #572 R4 also flagged the parser itself: `grep -v '^#'
  # | head -1` returns an empty string when the first non-comment
  # line is blank (`# header\n\ntoken` is a real shape that
  # devnet.sh writes). The replacement filters BOTH comments AND
  # blank/whitespace-only lines, then takes the first surviving
  # line, then trims surrounding whitespace.
  AUTH_TOKEN_FILE="${DKG_HOME}/auth.token"
  if [ ! -f "$AUTH_TOKEN_FILE" ]; then
    echo "ERROR: no auth token supplied and no token file at ${AUTH_TOKEN_FILE}." >&2
    echo "       Either export AUTH=<token> (or DKG_AUTH=<token>) before running," >&2
    echo "       or start the daemon first ('pnpm dkg start') so it provisions the token file." >&2
    exit 65
  fi
  AUTH=$(awk '
    # Codex PR #572 R4: first non-empty, non-comment line, trimmed.
    /^[[:space:]]*#/ { next }   # drop comment lines
    /^[[:space:]]*$/ { next }   # drop blank/whitespace-only lines
    { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print; exit }
  ' "$AUTH_TOKEN_FILE")
  if [ -z "$AUTH" ]; then
    echo "ERROR: ${AUTH_TOKEN_FILE} exists but contains no usable token (after stripping # comments and blank lines)." >&2
    echo "       Either export AUTH=<token> directly, or re-provision the file via 'pnpm dkg start'." >&2
    exit 65
  fi
fi

if [ -z "$SWM_CG_CURATED" ] && [ -z "$SWM_CG_PUBLIC" ]; then
  echo "ERROR: at least one of SWM_CG_CURATED or SWM_CG_PUBLIC must be set" >&2
  exit 64
fi

if [ -z "$SENDER_TAG" ]; then
  # Codex PR #572 R7 (round 3): require an explicit, unique tag.
  # A shared default ("MILES") silently collapses two operators'
  # writes in the tally — see banner notes in the docstring above.
  echo "ERROR: SENDER_TAG is required and must be unique across participating peers." >&2
  echo "       Set it to a short identifier for THIS daemon (e.g. SENDER_TAG=NODE-A)." >&2
  echo "       The tag appears in subject URIs and in the delivery breakdown report;" >&2
  echo "       two peers reusing the same tag will collapse into one sender set." >&2
  exit 64
fi

# Codex PR #572 R15 (round 5): SENDER_TAG is interpolated into
#   urn:swm-soak:${SENDER_TAG}:<seq>      (subject URI)
#   urn:swm-soak-summary:${SENDER_TAG}:<COHORT>
# and later parsed with `^urn:swm-soak:([^:]+):(\d+)$`. A tag
# containing a literal `:` would split the subject into the wrong
# components and the parser regex would silently drop those rows;
# whitespace would corrupt SPARQL/JSON payload escaping; non-ASCII
# would produce invalid IRIs that the daemon may accept or reject
# depending on backend. Constrain to a portable identifier shape
# now rather than spend hours debugging missing peers in the
# tally after the fact.
if ! printf '%s' "$SENDER_TAG" | grep -Eq '^[A-Za-z0-9_-]{1,32}$'; then
  echo "ERROR: SENDER_TAG must match ^[A-Za-z0-9_-]{1,32}$ (got: '${SENDER_TAG}')." >&2
  echo "       The tag is interpolated into subject URIs of the form" >&2
  echo "         urn:swm-soak:<TAG>:<seq>" >&2
  echo "       and parsed with that exact regex on the receiver side. Colons," >&2
  echo "       whitespace, non-ASCII, or empty strings will either produce" >&2
  echo "       invalid RDF or be silently excluded from the delivery counts." >&2
  exit 64
fi

# Codex PR #572 R5: each soak run emits a per-peer RUN_ID so future
# forensic tooling can attribute writes to a specific invocation
# even when SENDER_TAG is reused across runs.
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s 2>/dev/null || hostname)-$$-${SENDER_TAG}"
SOAK_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Codex PR #572 R8 (round 3): the previous R5 fix filtered tally
# results on `STR(?sentAt) >= "$SOAK_START_ISO"`, where `?sentAt`
# is a sender-reported wall-clock timestamp. That makes the result
# depend on cross-machine clock skew — a peer whose clock is
# behind this node's clock writes legitimate current-run quads
# stamped with a "stale-looking" timestamp, and our SPARQL filter
# silently drops them. The fix is to filter on a SHARED run-scoped
# identifier instead: every participating peer agrees on a
# SOAK_COHORT_ID out-of-band (same way they coordinate CG ids),
# stamps every write with it, and the tally SPARQL filters on
# exact match. No clock comparisons across machines.
#
# Solo-mode default: when SOAK_COHORT_ID is unset, fall back to the
# per-invocation RUN_ID. That gives a single operator running
# repeated soaks against the same CG protection against stale
# rows from prior runs (their own writes are tagged with the new
# RUN_ID), without forcing operators in a multi-peer cohort to
# remember an extra env var.
SOAK_COHORT_ID_EXPLICIT=1
if [ -z "${SOAK_COHORT_ID:-}" ]; then
  SOAK_COHORT_ID_EXPLICIT=0
  SOAK_COHORT_ID="$RUN_ID"
fi

# Codex PR #572 R10 (round 4): when `PEERS_EXPECTED` is set, the
# operator is running a coordinated multi-peer soak and EXPECTS to
# receive other peers' writes. Defaulting SOAK_COHORT_ID to the
# per-peer RUN_ID in that mode would silently make the receiver
# only count its own writes — every cross-peer percentage in the
# final report would be 0% and the operator would only discover
# this after the run completes. Fail fast at boot instead of
# burning hours of soak time on data that can't possibly answer
# the multi-peer reliability question.
if [ -n "$PEERS_EXPECTED" ] && [ "$SOAK_COHORT_ID_EXPLICIT" = "0" ]; then
  echo "ERROR: PEERS_EXPECTED is set (multi-peer soak) but SOAK_COHORT_ID was not." >&2
  echo "       In multi-peer mode every participating operator must supply the SAME" >&2
  echo "       SOAK_COHORT_ID value out-of-band; otherwise the tally SPARQL filters" >&2
  echo "       on each peer's per-invocation RUN_ID and silently reports 0% delivery" >&2
  echo "       from every remote peer. Pick a shared id (e.g. SOAK_COHORT_ID=rc9-soak-$(date -u +%Y%m%d)) and re-run." >&2
  exit 64
fi

LOG_DIR="${DKG_HOME}/swm-soak-test-$(date -u +%Y%m%d-%H%M%S)-${SENDER_TAG}"
mkdir -p "$LOG_DIR"
echo "$$" > "$LOG_DIR/pid"

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" \
    | tee -a "$LOG_DIR/main.log"
}

SELF_PEER_ID=$(curl -s --max-time 5 "$API/api/info" -H "Authorization: Bearer $AUTH" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('peerId',''))" 2>/dev/null)
if [ -z "$SELF_PEER_ID" ]; then
  log "WARN: could not resolve self peerId from /api/info; SPARQL self-exclusion will use SENDER_TAG only"
fi

# Each peer's writes use a subject URI of the form
#   urn:swm-soak:<TAG>:<seq>
# which uniquely identifies the writer + cycle within a CG. We do
# NOT embed cgId in the subject because cgIds can legally contain
# colons (see validateContextGraphId) which would defeat the
# downstream regex. The cgId is implicit because each share goes
# into that CG's named SWM graph; the receiver SPARQLs each CG's
# SWM graph individually so subject collisions across CGs are
# irrelevant. The receiver tally filters out subjects whose tag
# matches its own SENDER_TAG (self-share sanity check).
subject_for_cycle() {
  local _cgId=$1 seq=$2
  printf 'urn:swm-soak:%s:%05d' "$SENDER_TAG" "$seq"
}

write_one_share() {
  local cgId=$1 seq=$2 total=$3
  local ts subject body resp
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  subject=$(subject_for_cycle "$cgId" "$seq")
  body=$(python3 -c "
import json
print(json.dumps({
  'contextGraphId': '$cgId',
  'quads': [{
    'subject': '$subject',
    'predicate': 'urn:swm-soak:sentBy',
    'object': '\"$SENDER_TAG\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:sentAt',
    'object': '\"$ts\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:seq',
    'object': '\"$seq/$total\"',
    'graph': '',
  }, {
    # Codex PR #572 R5: per-invocation RUN_ID for forensic
    # attribution. Unique per script invocation per peer.
    'subject': '$subject',
    'predicate': 'urn:swm-soak:runId',
    'object': '\"$RUN_ID\"',
    'graph': '',
  }, {
    # Codex PR #572 R8 (round 3): shared cohort id is the actual
    # tally filter — replaces the wall-clock comparison so a
    # peer with a skewed system clock doesn't get filtered out.
    'subject': '$subject',
    'predicate': 'urn:swm-soak:cohortId',
    'object': '\"$SOAK_COHORT_ID\"',
    'graph': '',
  }],
}))
")
  resp=$(curl -s --max-time 30 -X POST "$API/api/shared-memory/write" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"cgId":"%s","seq":%d,"sent_ts":"%s","subject":"%s","resp":%s}\n' \
    "$cgId" "$seq" "$ts" "$subject" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/writes.jsonl"
  local ok
  ok=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  print('ok' if d.get('shareOperationId') else 'fail')
except: print('fail')
" 2>/dev/null)
  log "  write cg=$cgId seq=$seq → $ok"
}

snapshot_swm_inbox() {
  # SPARQL the SWM graph for each configured CG. Counts:
  #   - total tagged quads (any sender)
  #   - per-sender breakdown (sender tag extracted from subject URI)
  # SELECT against the SWM named graph. The "tag" is extracted from
  # the subject pattern urn:swm-soak:<TAG>:<seq>.
  #
  # Codex PR #572 R8 (round 3): filter on the shared cohort id
  # rather than the sender-reported `sentAt` timestamp. The earlier
  # R5 fix used `STR(?sentAt) >= "$SOAK_START_ISO"` which compared
  # a REMOTE wall-clock timestamp against THIS host's clock — a
  # peer whose system clock was a few seconds behind the receiver
  # would write legitimate current-run quads stamped with a
  # "stale" timestamp, and the filter silently dropped them. With
  # the cohort filter every participating peer stamps its writes
  # with the same SOAK_COHORT_ID (out-of-band coordinated), and
  # the tally accepts only those writes — no clock comparisons,
  # no skew dependency.
  local label=$1 cgId=$2 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local swm_graph="did:dkg:context-graph:${cgId}/_shared_memory"
  local sparql
  sparql=$(cat <<SPARQL
SELECT DISTINCT ?s WHERE {
  GRAPH <${swm_graph}> {
    ?s <urn:swm-soak:sentBy>   ?tag ;
       <urn:swm-soak:cohortId> "${SOAK_COHORT_ID}" .
  }
}
SPARQL
)
  local body resp
  body=$(python3 -c "import json; print(json.dumps({'sparql': '''$sparql''', 'contextGraphId': '$cgId'}))")
  resp=$(curl -s --max-time 30 -X POST "$API/api/query" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"label":"%s","cgId":"%s","ts":"%s","data":%s}\n' \
    "$label" "$cgId" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/swm-inbox.jsonl"
  local summary
  summary=$(printf '%s' "$resp" | python3 -c "
import json, re, sys, os
self_tag = '$SENDER_TAG'
try:
  d = json.loads(sys.stdin.read())
  # Codex PR #572 R1: /api/query wraps SPARQL results as
  # {result: {bindings: [...]}}. Pre-fix this parser only looked
  # at the top-level 'bindings' key on dict payloads (the else
  # branch was dead code since json.loads of any JSON object
  # always returns a dict), so every inbox snapshot was reported
  # as empty even when SWM data had arrived. Try the wrapped
  # location first, then fall back to a bare 'bindings' for
  # forward-compatibility with any future flatter shape.
  rows = []
  if isinstance(d, dict):
    inner = d.get('result')
    if isinstance(inner, dict) and isinstance(inner.get('bindings'), list):
      rows = inner['bindings']
    elif isinstance(d.get('bindings'), list):
      rows = d['bindings']
  by_tag = {}
  for r in rows:
    s = r.get('s', '')
    if isinstance(s, dict): s = s.get('value','')
    s = s.strip('<>')
    m = re.match(r'^urn:swm-soak:([^:]+):(\d+)$', s)
    if not m: continue
    tag, seq = m.group(1), m.group(2)
    by_tag.setdefault(tag, set()).add(seq)
  parts = []
  for tag in sorted(by_tag):
    n = len(by_tag[tag])
    parts.append(f'{tag}={n}{\" (self)\" if tag == self_tag else \"\"}')
  if not parts:
    print('inbox=empty')
  else:
    print('cg=' + '$cgId' + ' rows=' + str(sum(len(v) for v in by_tag.values())) + ' breakdown[' + ', '.join(parts) + ']')
except Exception as e:
  print(f'inbox=err({e})')
" 2>/dev/null)
  log "  swm-inbox snapshot ($label): $summary"
}

snapshot_slo() {
  # rc.9 PR-A extended /api/slo from {protocols} to
  # {protocols, gossip, swm}. This script consumes all three:
  #   - protocols.* — substrate sendReliable latencies per protocol
  #   - gossip.publishFailures — per-cgId silent-failure counter
  #   - swm.redundantApplies — per-cgId redundant-delivery counter
  local label=$1 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local resp
  resp=$(curl -s --max-time 10 "${API}/api/slo" \
    -H "Authorization: Bearer $AUTH")
  printf '{"label":"%s","ts":"%s","data":%s}\n' \
    "$label" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/slo.jsonl"
  local summary
  # Codex PR #572 R6: include overflow buckets + truncated flags in
  # the running summary. Pre-fix the summary printed only
  # `sum(perCg_map)`, which under-reports once either map hits its
  # configured cap and starts evicting smallest counters into
  # `*Overflow`. The endpoint documents the correct grand total as
  # `sum(map) + overflow`; soak diagnostics must reflect that or
  # operators chasing a stuck-share incident will see misleading
  # zero/low values during the exact regime they care about.
  #
  # Also surface:
  #   - `publishFailuresTruncated` → marks the per-cgId breakdown
  #     in `gossip.publishFailures` as partial (totals still
  #     accurate via overflow).
  #   - `redundantAppliesTruncated` → same, for swm.redundantApplies.
  #   - `redundantAppliesLowerBound` → sticky flag set when
  #     seenShareOps cap eviction trimmed a still-live entry, so
  #     `redundantApplies` is a lower bound for the window.
  summary=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  protos = (d or {}).get('protocols', {}) or {}
  gossip = (d or {}).get('gossip', {}) or {}
  swm = (d or {}).get('swm', {}) or {}
  parts = []
  for proto, s in sorted(protos.items()):
    short = proto.split('/')[-1]
    p99 = s.get('p99Ms')
    p99_s = f'{p99}ms' if p99 is not None else 'n/a'
    parts.append(f'{short}=d{s.get(\"delivered\", 0)}/q{s.get(\"queued\", 0)} p99={p99_s}')
  pubfail_perCg = sum((gossip.get('publishFailures') or {}).values())
  pubfail_overflow = gossip.get('publishFailuresOverflow', 0) or 0
  pubfail_truncated = bool(gossip.get('publishFailuresTruncated'))
  pubfail_total = pubfail_perCg + pubfail_overflow
  redundant_perCg = sum((swm.get('redundantApplies') or {}).values())
  redundant_overflow = swm.get('redundantAppliesOverflow', 0) or 0
  redundant_truncated = bool(swm.get('redundantAppliesTruncated'))
  redundant_lower_bound = bool(swm.get('redundantAppliesLowerBound'))
  redundant_total = redundant_perCg + redundant_overflow
  pubfail_flag = ' [TRUNCATED]' if pubfail_truncated else ''
  redundant_flags = []
  if redundant_truncated: redundant_flags.append('TRUNCATED')
  if redundant_lower_bound: redundant_flags.append('LOWER-BOUND')
  redundant_flag = (' [' + '|'.join(redundant_flags) + ']') if redundant_flags else ''
  proto_s = ' '.join(parts) if parts else '(no substrate traffic yet)'
  print(
    f'slo: {proto_s} | '
    f'gossip.failures={pubfail_total}{pubfail_flag} (perCg={pubfail_perCg} overflow={pubfail_overflow}) | '
    f'swm.redundant={redundant_total}{redundant_flag} (perCg={redundant_perCg} overflow={redundant_overflow})'
  )
except Exception as e:
  print(f'slo=err({e})')
" 2>/dev/null)
  log "  $summary"
}

# Codex PR #572 R12 (round 4): emit a self-described "writes
# accepted" tombstone for this peer at the end of the cycle loop,
# BEFORE the 5-min settle window, so receivers can use the
# correct per-peer denominator in the final tally.
#
# Pre-fix the final summary computed `pct = got / cycles * 100`
# where `cycles` was the CONFIGURED total. Any sender that had
# local rejections (backpressure, daemon hiccup, ctrl-c after
# partial run) reduced its accepted-writes count below `cycles`,
# and even with 100% transport delivery the receiver would
# report it as failing the 99.9% ship gate. That conflates
# "writes the peer ever submitted" with "writes the network
# delivered to me" — the ship gate is meant to measure the
# latter only.
#
# Fix: each peer publishes its own accepted-write count under
#   urn:swm-soak-summary:<TAG>:<COHORT_ID>
#   ─ urn:swm-soak:writesAccepted "<count>"
#   ─ urn:swm-soak:cohortId "<COHORT_ID>"
#   ─ urn:swm-soak:sentBy "<TAG>"
# AFTER the cycle loop completes, then receivers SPARQL for
# those summary subjects during the final snapshot and use each
# peer's published `writesAccepted` as the denominator. Peers
# whose summary share didn't arrive (transport loss of the
# summary itself, or peer crashed before emit) are marked
# INDETERMINATE in the report rather than being scored against
# the configured cycle count.
#
# Subject scheme is distinct from per-cycle `urn:swm-soak:<TAG>:<seq>`
# so the per-cycle regex in the final-summary parser doesn't pick
# up the summary subject.
emit_writes_accepted_summary() {
  # Codex PR #572 R13 (round 5): count accepted writes scoped to
  # the *current* cgId. Pre-fix the grep was unfiltered, so a soak
  # against N>1 context graphs emitted the same global aggregate
  # writesAccepted=count value into every CG's tombstone. The
  # receiver then divided per-CG observations by the aggregate
  # cross-CG count, producing per-CG percentages of ~100/N% even
  # under perfect delivery.
  local cgId=$1 ts subject writes_accepted body resp ok
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  subject="urn:swm-soak-summary:${SENDER_TAG}:${SOAK_COHORT_ID}"
  writes_accepted=$(python3 -c "
import json, sys
n = 0
try:
  with open('$LOG_DIR/writes.jsonl') as f:
    for line in f:
      try:
        r = json.loads(line)
      except Exception:
        continue
      if r.get('cgId') != '$cgId': continue
      resp = r.get('resp')
      if isinstance(resp, dict) and resp.get('shareOperationId'):
        n += 1
except FileNotFoundError:
  pass
print(n)
" 2>/dev/null)
  body=$(python3 -c "
import json
print(json.dumps({
  'contextGraphId': '$cgId',
  'quads': [{
    'subject': '$subject',
    'predicate': 'urn:swm-soak:writesAccepted',
    'object': '\"$writes_accepted\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:sentBy',
    'object': '\"$SENDER_TAG\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:cohortId',
    'object': '\"$SOAK_COHORT_ID\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:runId',
    'object': '\"$RUN_ID\"',
    'graph': '',
  }, {
    'subject': '$subject',
    'predicate': 'urn:swm-soak:sentAt',
    'object': '\"$ts\"',
    'graph': '',
  }],
}))
")
  resp=$(curl -s --max-time 30 -X POST "$API/api/shared-memory/write" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"cgId":"%s","writesAccepted":%d,"ts":"%s","subject":"%s","resp":%s}\n' \
    "$cgId" "$writes_accepted" "$ts" "$subject" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/writes-accepted-summaries.jsonl"
  ok=$(printf '%s' "$resp" | python3 -c "
import json, sys
try:
  d = json.loads(sys.stdin.read())
  print('ok' if d.get('shareOperationId') else 'fail')
except: print('fail')
" 2>/dev/null)
  log "  writes-accepted-summary cg=$cgId tag=$SENDER_TAG writesAccepted=$writes_accepted → $ok"
}

snapshot_writes_accepted_summaries() {
  # SPARQL the SWM graph for writes-accepted summary tombstones
  # from EVERY peer in the cohort (including self). Receivers
  # consume the resulting jsonl to populate the per-peer
  # denominator in the final tally.
  local cgId=$1 ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local swm_graph="did:dkg:context-graph:${cgId}/_shared_memory"
  local sparql
  sparql=$(cat <<SPARQL
SELECT ?s ?tag ?writesAccepted WHERE {
  GRAPH <${swm_graph}> {
    ?s <urn:swm-soak:cohortId>      "${SOAK_COHORT_ID}" ;
       <urn:swm-soak:sentBy>        ?tag ;
       <urn:swm-soak:writesAccepted> ?writesAccepted .
  }
}
SPARQL
)
  local body resp
  body=$(python3 -c "import json; print(json.dumps({'sparql': '''$sparql''', 'contextGraphId': '$cgId'}))")
  resp=$(curl -s --max-time 30 -X POST "$API/api/query" \
    -H "Authorization: Bearer $AUTH" \
    -H "Content-Type: application/json" \
    -d "$body")
  printf '{"cgId":"%s","ts":"%s","data":%s}\n' \
    "$cgId" "$ts" "${resp:-{\"error\":\"empty response\"\}}" \
    >> "$LOG_DIR/writes-accepted-summaries-observed.jsonl"
}

split_cgs() {
  local raw=$1
  if [ -z "$raw" ]; then return; fi
  printf '%s' "$raw" | tr ',' '\n' | sed '/^$/d'
}

# Build ALL_CGS via a single CSV → `read -ra` so bash 3.2 (macOS
# default) doesn't trip its `set -u` "unbound variable" quirk on
# arrays populated solely via `+=` inside `while ... < <(...)`
# subshells. `read -ra` assigns elements directly, which bash 3.2
# tracks correctly. We've already required at least one of
# SWM_CG_CURATED / SWM_CG_PUBLIC above, so ALL_CGS is guaranteed
# non-empty before any `"${ALL_CGS[@]}"` expansion below.
ALL_CGS_CSV=""
[ -n "$SWM_CG_CURATED" ] && ALL_CGS_CSV="$SWM_CG_CURATED"
[ -n "$SWM_CG_PUBLIC" ] && ALL_CGS_CSV="${ALL_CGS_CSV:+$ALL_CGS_CSV,}$SWM_CG_PUBLIC"
IFS=',' read -ra ALL_CGS <<< "$ALL_CGS_CSV"

trap 'log "INTERRUPTED — stopping at cycle ${seq:-?}"; exit 130' INT TERM

log "=== START swm-soak-test ==="
log "  sender_tag=$SENDER_TAG"
log "  run_id=$RUN_ID"
log "  soak_cohort_id=$SOAK_COHORT_ID$( [ "$SOAK_COHORT_ID_EXPLICIT" = "0" ] && printf ' (defaulted to RUN_ID — solo-mode filter; set SOAK_COHORT_ID to receive other peers writes)' )"
log "  soak_start_iso=$SOAK_START_ISO"
log "  self_peer_id=${SELF_PEER_ID:-<unresolved>}"
log "  curated_cgs=${SWM_CG_CURATED:-<none>}"
log "  public_cgs=${SWM_CG_PUBLIC:-<none>}"
log "  total_cycles=$SWM_TOTAL_CYCLES"
log "  interval_s=$SWM_INTERVAL_S"
log "  peers_expected=${PEERS_EXPECTED:-<unset, summary skips per-peer breakdown>}"
log "  log_dir=$LOG_DIR"
log "  pid=$$"
log ""
log "Baseline SLO + inbox snapshot (before first write):"
for cg in "${ALL_CGS[@]}"; do snapshot_swm_inbox "baseline" "$cg"; done
snapshot_slo "baseline"
log ""

# Codex PR #572 R11 (round 4): SWM_INTERVAL_S is documented as the
# spacing between cycles, but the pre-fix loop slept the full
# interval AFTER doing the writes + 5s settle + snapshots + SLO
# fetch. At 30s interval × 5s settle × ~1–2s per HTTP roundtrip,
# the actual cycle cadence drifted to ~37–40s and a "12h soak"
# stretched to closer to 15h.
#
# Now: each cycle has a target END timestamp `next_cycle_target_s`
# = `cycle_start_s + SWM_INTERVAL_S`. After all per-cycle work, we
# sleep for whatever remains until that target (or warn + skip if
# the cycle blew the budget). The 5s settle, the snapshots, and
# the SLO fetch are all INSIDE the budget, so the start-to-start
# cadence stays at SWM_INTERVAL_S regardless of measurement
# overhead. If the per-cycle work exceeds the budget the warning
# surfaces immediately rather than silently extending wall-clock
# duration.
next_cycle_target_s=$(( $(date +%s) + SWM_INTERVAL_S ))
for seq in $(seq 1 "$SWM_TOTAL_CYCLES"); do
  log "--- CYCLE $seq/$SWM_TOTAL_CYCLES ---"
  for cg in "${ALL_CGS[@]}"; do
    write_one_share "$cg" "$seq" "$SWM_TOTAL_CYCLES"
  done
  sleep 5
  for cg in "${ALL_CGS[@]}"; do
    snapshot_swm_inbox "post-cycle-$seq" "$cg"
  done
  snapshot_slo "post-cycle-$seq"
  if [ "$seq" -lt "$SWM_TOTAL_CYCLES" ]; then
    now_s=$(date +%s)
    remain_s=$(( next_cycle_target_s - now_s ))
    if [ "$remain_s" -gt 0 ]; then
      sleep "$remain_s"
    elif [ "$remain_s" -lt 0 ]; then
      log "WARN: cycle $seq overran SWM_INTERVAL_S=${SWM_INTERVAL_S}s budget by $(( -remain_s ))s; cadence has drifted. Consider raising SWM_INTERVAL_S or reducing per-cycle work."
    fi
    next_cycle_target_s=$(( next_cycle_target_s + SWM_INTERVAL_S ))
  fi
done

log ""
# Codex PR #572 R12 (round 4): emit per-CG writes-accepted
# tombstone BEFORE settle so receivers have time to observe it
# and use it as the per-peer denominator in the final tally.
# (See `emit_writes_accepted_summary` for the rationale.)
log "Publishing per-peer writes-accepted tombstone before settle window..."
for cg in "${ALL_CGS[@]}"; do emit_writes_accepted_summary "$cg"; done

log "All cycles done. Waiting 5min for any late inbound to settle (gossip mesh, substrate retries, runSyncOnConnect catch-up)..."
sleep 300
for cg in "${ALL_CGS[@]}"; do snapshot_swm_inbox "final" "$cg"; done
for cg in "${ALL_CGS[@]}"; do snapshot_writes_accepted_summaries "$cg"; done
snapshot_slo "final"

log ""
log "=== END swm-soak-test ==="
log ""
log "Summary:"
writes_total=$(wc -l < "$LOG_DIR/writes.jsonl" | tr -d ' ')
log "  total writes attempted: $writes_total"
writes_ok=$(grep -c '"shareOperationId"' "$LOG_DIR/writes.jsonl" 2>/dev/null || echo 0)
log "  writes accepted by local daemon: $writes_ok"
log ""
log "Per-CG final inbox (delivery validation — operators cross-reference):"
log ""
ALL_CGS_CSV=$(IFS=','; printf '%s' "${ALL_CGS[*]}")
python3 <<PYTHON | tee -a "$LOG_DIR/main.log"
import json, os, re
log_dir = "$LOG_DIR"
self_tag = "$SENDER_TAG"
peers_expected = [p.strip() for p in "$PEERS_EXPECTED".split(',') if p.strip()]
# Codex PR #572 R14 (round 5): seed the report set from the
# configured CG list so a context graph that observed ZERO final
# rows (total failure: nothing — even our own writes — landed in
# its local SWM) is still surfaced in the breakdown as
# INDETERMINATE rather than being silently omitted because it
# never appeared in `by_cg_final`.
all_cgs_configured = [c.strip() for c in "$ALL_CGS_CSV".split(',') if c.strip()]
cycles = $SWM_TOTAL_CYCLES

# Codex PR #572 R12 (round 4): build per-(cg, sender) denominator
# table from the writes-accepted summary tombstones each peer
# emits before the settle window. denom_by_cg[cg][tag] = peer's
# self-reported accepted-write count. Pre-fix the denominator was
# always `cycles`, so any sender with local rejections (e.g. a
# crash mid-run or a daemon backpressure event that returned no
# shareOperationId) would be scored against an unreachable target
# even with 100% transport delivery, conflating sender-side
# rejection with network loss. With the tombstone the ship gate
# now strictly measures transport reliability.
denom_by_cg = {}
try:
  with open(os.path.join(log_dir, 'writes-accepted-summaries-observed.jsonl')) as f:
    for line in f:
      rec = json.loads(line)
      cg = rec.get('cgId')
      if not cg: continue
      data = rec.get('data') or {}
      rows = []
      if isinstance(data, dict):
        inner = data.get('result')
        if isinstance(inner, dict) and isinstance(inner.get('bindings'), list):
          rows = inner['bindings']
        elif isinstance(data.get('bindings'), list):
          rows = data['bindings']
      bucket = denom_by_cg.setdefault(cg, {})
      for r in rows:
        tag_v = r.get('tag', '')
        if isinstance(tag_v, dict): tag_v = tag_v.get('value', '')
        wa_v = r.get('writesAccepted', '')
        if isinstance(wa_v, dict): wa_v = wa_v.get('value', '')
        if not tag_v: continue
        try: wa_int = int(wa_v)
        except (TypeError, ValueError): continue
        prev = bucket.get(tag_v)
        if prev is None or wa_int > prev:
          bucket[tag_v] = wa_int
except FileNotFoundError:
  pass

by_cg_final = {}
try:
  with open(os.path.join(log_dir, 'swm-inbox.jsonl')) as f:
    for line in f:
      rec = json.loads(line)
      if rec.get('label') != 'final': continue
      cg = rec['cgId']
      # Codex PR #572 R1: /api/query wraps results as
      # {result: {bindings: [...]}}. Pre-fix this parser read the
      # top-level `data.bindings` (always absent), so the final
      # summary saw zero rows on every record. Same wrap-unwrap
      # as snapshot_swm_inbox above.
      data = rec.get('data') or {}
      rows = []
      if isinstance(data, dict):
        inner = data.get('result')
        if isinstance(inner, dict) and isinstance(inner.get('bindings'), list):
          rows = inner['bindings']
        elif isinstance(data.get('bindings'), list):
          rows = data['bindings']
      # Codex PR #572 R2: the regex match + tag/seq assignment +
      # `by_cg_final[cg] = by_tag` were all misindented out of
      # their respective loops pre-fix — `m = re.match(...)` ran
      # once per record (on whatever `s` happened to be at the
      # end of the per-binding loop), `continue` jumped past the
      # remaining records of the file (not the remaining
      # bindings), and `by_cg_final[cg] = by_tag` ran exactly
      # once after the whole file was read, keeping only the LAST
      # final record. Net result: multi-row / multi-CG runs
      # silently undercounted delivery to zero on all but one CG.
      # Now: per-binding statements stay inside `for r in rows`,
      # per-record assignment stays inside `for line in f`, and
      # we ACCUMULATE into `by_cg_final[cg]` (merging share-op
      # sequence sets per tag) so if the same `final` cgId
      # appears more than once across the jsonl no rows are lost.
      bucket = by_cg_final.setdefault(cg, {})
      for r in rows:
        s = r.get('s', '')
        if isinstance(s, dict): s = s.get('value', '')
        s = s.strip('<>')
        m = re.match(r'^urn:swm-soak:([^:]+):(\d+)$', s)
        if not m: continue
        tag, seq = m.group(1), m.group(2)
        bucket.setdefault(tag, set()).add(seq)
except FileNotFoundError:
  print('  (no swm-inbox.jsonl)')

# Codex PR #572 R13 (round 5): per-CG self denominator. Pre-fix
# this counted the entire writes.jsonl regardless of cgId, so on
# multi-CG runs every CG's "self" row showed denom=cycles*cgCount
# while the numerator only contained that CG's observations,
# producing per-CG percentages of ~100/cgCount% even under
# perfect delivery. Same scope rule is now applied to peer
# tombstones via the writes-accepted-summary subject — each
# tombstone is published per CG with that CG's accepted count.
self_writes_accepted_by_cg = {}
try:
  with open(os.path.join(log_dir, 'writes.jsonl')) as f:
    for line in f:
      try:
        rec = json.loads(line)
      except Exception:
        continue
      cg = rec.get('cgId')
      resp = rec.get('resp')
      if not cg or not isinstance(resp, dict): continue
      if resp.get('shareOperationId'):
        self_writes_accepted_by_cg[cg] = self_writes_accepted_by_cg.get(cg, 0) + 1
except FileNotFoundError:
  pass
have_writes_jsonl = bool(self_writes_accepted_by_cg) or os.path.exists(os.path.join(log_dir, 'writes.jsonl'))

def denominator_for(cg, tag):
  # Self: use locally-counted accepted writes for this CG
  # (ground truth, no transport dependence).
  if tag == self_tag:
    if not have_writes_jsonl:
      return ('self', None, False)
    return ('self', self_writes_accepted_by_cg.get(cg, 0), True)
  # Peer: use the writes-accepted tombstone if observed.
  wa = (denom_by_cg.get(cg) or {}).get(tag)
  if wa is not None:
    return ('peer-tombstone', wa, True)
  # No tombstone observed for this peer in this CG: indeterminate.
  return ('missing', None, False)

# Codex PR #572 R14 (round 5): iterate over CONFIGURED CGs so a
# total-failure CG (no inbox rows at all) still appears in the
# report. Union with by_cg_final keys catches unexpected CGs that
# somehow show up in the inbox without being configured (defense
# in depth).
report_cgs = sorted(set(all_cgs_configured) | set(by_cg_final.keys()))
for cg in report_cgs:
  by_tag = by_cg_final.get(cg, {})
  if cg not in by_cg_final:
    print(f'  cg={cg}: [no `final` SWM-inbox rows observed for this CG — INDETERMINATE; total transport failure or final SPARQL errored]')
  else:
    print(f'  cg={cg}:')
  src, denom, ok = denominator_for(cg, self_tag)
  got = len(by_tag.get(self_tag, set()))
  if not ok:
    print(f'    self ({self_tag}): {got} observed (no local writes.jsonl — INDETERMINATE)')
  elif denom == 0:
    print(f'    self ({self_tag}): {got}/0 — no accepted writes recorded locally for this CG (script wrote nothing here)')
  else:
    pct = (got / denom * 100.0) if denom else 0.0
    sanity = '' if got == denom else f'  [WARN: observed {got} self-shares but accepted {denom} locally]'
    print(f'    self ({self_tag}): {got}/{denom} = {pct:.2f}% (denom=local writes.jsonl){sanity}')

  others_seen = sorted(t for t in by_tag if t != self_tag)
  reportable = peers_expected if peers_expected else others_seen
  for peer in reportable:
    got = len(by_tag.get(peer, set()))
    src, denom, ok = denominator_for(cg, peer)
    if not ok:
      print(f'    from {peer}: {got} observed (no writes-accepted tombstone in cg — INDETERMINATE; review writes-accepted-summaries-observed.jsonl)')
      continue
    if denom == 0:
      print(f'    from {peer}: {got}/0 — peer reported zero accepted writes for this CG (peer ran but did not write here)')
      continue
    pct = (got / denom * 100.0) if denom else 0.0
    ship_gate = '' if pct >= 99.9 else '  [BELOW 99.9% — review postmortem]'
    print(f'    from {peer}: {got}/{denom} = {pct:.2f}% (denom=peer tombstone){ship_gate}')
  if peers_expected:
    unexpected = [t for t in others_seen if t not in peers_expected]
    if unexpected:
      print(f'    unexpected senders observed: {unexpected}')
PYTHON
log ""
log "Detailed logs:"
log "  writes:                          $LOG_DIR/writes.jsonl"
log "  swm-inbox:                       $LOG_DIR/swm-inbox.jsonl  (per-cycle SPARQL snapshots of each CG's local SWM)"
log "  slo:                             $LOG_DIR/slo.jsonl        (per-cycle /api/slo: protocols + gossip + swm sections)"
log "  writes-accepted-emitted:         $LOG_DIR/writes-accepted-summaries.jsonl          (this peer's published accepted-write tombstones)"
log "  writes-accepted-observed:        $LOG_DIR/writes-accepted-summaries-observed.jsonl (other peers' tombstones — denominators for the ship gate)"
log "  trace:                           $LOG_DIR/main.log"
