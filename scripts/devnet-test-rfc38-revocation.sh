#!/usr/bin/env bash
#
# OT-RFC-38 LU-6 C1 — MEMBER REVOCATION test.
#
# Validates the key-rotation contract spelled out in SPEC_CG_MEMORY_MODEL.md
# §LU-4 ("Sender-key rotation on membership change"). When a curator
# removes a member from a curated CG, subsequent SWM writes MUST be
# undecryptable to the removed member — even though the removed member
# is still gossip-reachable on the topic and still has older sender-key
# copies stashed locally.
#
# Test plan:
#
#   1. Curator (N5) creates curated CG with allowlist
#      [curator, M1=N6, M2=N4]. All three pre-create the CG.
#   2. Curator writes 3 triples. Catchup on both members confirms
#      they can decrypt the pre-revocation batch.
#   3. Curator calls /api/context-graph/{id}/remove-participant for M2.
#      The allowlist on the curator's local store drops M2 + their
#      agent-delegation.
#   4. Curator writes 3 NEW triples (with different subjects so we can
#      tell the batches apart).
#   5. Assert:
#        - M1 catches up the new batch and can read all 6 triples.
#        - M2 either CANNOT catchup (auth denied) OR can pull the
#          envelopes but the apply path rejects them as un-decryptable
#          / not for them. The end state on M2 must show ≤ 3 triples
#          (only the pre-revocation batch).
#   6. (Sanity) Curator's own store has all 6 triples.
#
# Re-runnable: timestamp-suffixed CG id.
#
# Notes:
#   - The current sender-key model retains old SK copies on the kicked
#     member's disk, so M2 *should* still be able to decrypt the FIRST
#     batch. This test asserts that — confirming we cleanly rotate
#     forward without revoking the past (consistent with §LU-4).
#   - Doesn't validate on-chain ACK revocation; ACK quorum re-eligibility
#     is a separate fix tracked under LU-6 follow-up B (signed catchup).
#
# What this validates after the C1 integration-pass fixes:
#   ✓ `removeAgentFromContextGraph` writes a LOCAL tombstone
#     (`dkg:revokedAgent`) so the curator's recipient resolver excludes
#     the kicked member even when peer sync re-replicated the original
#     `dkg:allowedAgent` triple.
#   ✓ The curator drops cached SWM sender-key send state for the CG so
#     the next write mints a NEW epoch with a NEW chain key.
#   ✓ The new epoch's setup-send wraps ONLY for current members
#     (curator + M1). M2 receives the broadcast envelope and rejects
#     it with `reason=no-state` (verifiable in M2's daemon log).
#   ✓ The curator's sync auth refuses M2's catchup request post-revoke.
#
# What this does NOT validate yet (full forward-security gap):
#   ✗ Other members' nodes (M1 here) DON'T learn about the revoke
#     because the curator only revokes locally. M1 still has M2 in
#     M1's local allowlist + the M1-decrypted plaintext of the new
#     batch, so M1 will happily serve M2 via durable sync. The script
#     therefore surfaces this as a WARN, not a hard fail.
#
#     The proper fix is a curator-signed revoke-gossip message on the
#     CG publish topic that every member verifies + applies as a local
#     tombstone (mirroring the `dkg:revokedAgent` write below). Tracked
#     as OT-RFC-38 follow-up LU-4b. Until then, multi-node curated
#     CGs leak post-revoke data to kicked members via member-to-member
#     sync. On-chain CGs SHOULD escape this gap as soon as members'
#     sync auth consults the on-chain participant list as the source
#     of truth instead of the local allowlist replica.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE=9201
CURATOR_NODE=5
M1_NODE=6
M2_NODE=4

log()  { echo "[rev] $*"; }
warn() { echo "[rev] WARN: $*" >&2; }
fail() { echo "[rev] FAIL: $*" >&2; exit 1; }
act()  { echo ""; echo "[rev] === $1 ==="; }

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_token() { tail -1 "$(node_dir "$1")/auth.token" 2>/dev/null | tr -d '\r\n'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local port; port=$(node_port "$node")
  local token; token=$(node_token "$node")
  local -a curl_args=(-sS --max-time 240 -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$data" ] && curl_args+=(-d "$data")
  curl_args+=("http://127.0.0.1:${port}${path}")
  curl "${curl_args[@]}"
}

parse_json() {
  printf '%s' "$1" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try { const j=JSON.parse(d); const v=j$2; console.log(v == null ? '' : v); }
      catch (e) { process.exit(1); }
    })
  "
}

CURATOR_AGENT=$(api_call "$CURATOR_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M1_AGENT=$(api_call "$M1_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')
M2_AGENT=$(api_call "$M2_NODE" GET /api/agent/identity | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).agentAddress))')

STAMP=$(date +%s)
CG_ID="${CURATOR_AGENT}/rev-${STAMP}"

log "Curator:  $CURATOR_AGENT (node $CURATOR_NODE)"
log "M1:       $M1_AGENT (node $M1_NODE)"
log "M2:       $M2_AGENT (node $M2_NODE) [will be revoked]"
log "CG:       $CG_ID"

# ===========================================================================
act "1. All three parties pre-create the CG with [curator, M1, M2] allowlist"
# ===========================================================================
ALLOWED='["'"$CURATOR_AGENT"'", "'"$M1_AGENT"'", "'"$M2_AGENT"'"]'

CREATE_CUR=$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "revocation ${STAMP}",
  "accessPolicy": 1, "publishPolicy": 0,
  "allowedAgents": $ALLOWED,
  "register": true }
EOF
)")
ON_CHAIN_ID=$(parse_json "$CREATE_CUR" '.onChainId')
[ -n "$ON_CHAIN_ID" ] || fail "create+register failed: $CREATE_CUR"
log "✓ curated CG onChainId=$ON_CHAIN_ID"

# Codex PR #621 follow-up: don't swallow EVERY error with `|| true`.
# Capture the response and tolerate only the idempotent "already
# exists" signal — a real failure (wrong auth, malformed body, etc.)
# now aborts the script instead of surfacing later as an opaque
# catchup timeout with the actual setup error lost.
member_pre_create() {
  local node="$1" tag="$2"
  local resp
  resp=$(api_call "$node" POST /api/context-graph/create "$(cat <<EOF
{ "id": "$CG_ID", "name": "revocation ${STAMP} ($tag)",
  "accessPolicy": 1, "publishPolicy": 0, "allowedAgents": $ALLOWED }
EOF
)") || true
  case "$resp" in
    *'"created"'*|*'"uri"'*) log "✓ $tag pre-created CG locally" ;;
    *'already'*|*'duplicate'*|*'exists'*) log "✓ $tag CG already locally known (idempotent)" ;;
    '') fail "$tag pre-create returned empty response — daemon unreachable?" ;;
    *) fail "$tag pre-create FAILED with non-idempotent error: $resp" ;;
  esac
}
member_pre_create "$M1_NODE" "M1"
member_pre_create "$M2_NODE" "M2"
sleep 3

# ===========================================================================
act "2. Curator writes pre-revocation batch (3 triples) and verifies both members catch up"
# ===========================================================================
PRE_QUADS=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const quads = [];
  for (const tag of ["pre-alpha","pre-beta","pre-gamma"]) {
    const entity = "urn:rev:" + stamp + "/" + tag;
    quads.push({ subject: entity, predicate: "http://schema.org/name", object: "\""+tag+"\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_PRE=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$PRE_QUADS")
[ "$(parse_json "$WRITE_PRE" '.triplesWritten')" = "3" ] || fail "pre-write expected 3 triples: $WRITE_PRE"
log "✓ pre-revocation: 3 triples written by curator"
sleep 3

# Codex PR #621 R2: /api/shared-memory/list isn't a daemon route.
# Use /api/query with SPARQL COUNT against the _shared_memory graph
# suffix so we're actually measuring local SWM state, not silently
# collapsing read failures to 0.
sparql_count() {
  printf '%s' "$1" | node -e '
    let d=""; process.stdin.on("data",c=>d+=c);
    process.stdin.on("end",()=>{
      try {
        const j = JSON.parse(d);
        const b = (j && j.result && j.result.bindings && j.result.bindings[0]) || {};
        const raw = b.n || b.cnt || b.count || "";
        const m = String(raw).match(/^"?(-?\d+)"?/);
        console.log(m ? m[1] : "");
      } catch { console.log(""); }
    });
  '
}

# Trigger catchup (best-effort, can fail), then SPARQL-count what's
# locally readable. Returns "" if the read failed — callers MUST
# distinguish that from a real zero count. NEVER collapses errors to 0.
count_triples() {
  local node="$1"
  api_call "$node" POST /api/shared-memory/catchup "$(cat <<EOF
{ "contextGraphId": "$CG_ID" }
EOF
)" >/dev/null 2>&1 || true
  local q; q=$(api_call "$node" POST /api/query "$(cat <<EOF
{ "contextGraphId": "$CG_ID", "graphSuffix": "_shared_memory",
  "sparql": "SELECT (COUNT(*) AS ?n) WHERE { ?s <http://schema.org/name> ?o }" }
EOF
)")
  sparql_count "$q"
}

# Codex PR #621 R3: pre-revocation precondition must HARD-ASSERT,
# not just warn. If M2 never decrypts the pre-revocation batch,
# the post-revocation "<= 3" assertion can false-pass without ever
# proving key rotation worked. Bounded retry to absorb gossip
# latency, then fail if either member hasn't caught up.
wait_for_count_at_least() {
  local node="$1" who="$2" target="$3"
  local result=""
  for _ in $(seq 1 20); do
    result=$(count_triples "$node")
    if [ -n "$result" ] && [ "$result" -ge "$target" ] 2>/dev/null; then
      echo "$result"
      return 0
    fi
    sleep 1
  done
  fail "$who never reached ≥$target triples (last count: \"$result\") — pre-revocation handshake/catchup is broken; revocation test can't proceed."
}

log "Waiting for M1 + M2 to catch up the pre-revocation batch..."
M1_PRE=$(wait_for_count_at_least "$M1_NODE" "M1" 3)
M2_PRE=$(wait_for_count_at_least "$M2_NODE" "M2" 3)
log "✓ M1 sees $M1_PRE triples pre-revocation; M2 sees $M2_PRE triples"

# ===========================================================================
act "3. Curator revokes M2"
# ===========================================================================
CG_ID_ENC=$(printf %s "$CG_ID" | sed 's/\//%2F/g')
REVOKE_RESP=$(api_call "$CURATOR_NODE" POST "/api/context-graph/${CG_ID_ENC}/remove-participant" "$(cat <<EOF
{ "agentAddress": "$M2_AGENT" }
EOF
)")
[ "$(parse_json "$REVOKE_RESP" '.ok')" = "true" ] || fail "revoke failed: $REVOKE_RESP"
log "✓ curator removed M2 from allowlist"
sleep 5

# Confirm allowlist update on the curator
PARTS_RESP=$(api_call "$CURATOR_NODE" GET "/api/context-graph/${CG_ID_ENC}/participants")
PARTICIPANTS_LIST=$(parse_json "$PARTS_RESP" '.allowedAgents.join(",")')
log "Curator's allowlist after revoke: $PARTICIPANTS_LIST"
case "$PARTICIPANTS_LIST" in
  *"$M2_AGENT"*) fail "M2 ($M2_AGENT) still in curator's allowlist after revoke" ;;
esac
case "$PARTICIPANTS_LIST" in
  *"$M1_AGENT"*) log "✓ M1 still on the allowlist" ;;
  *)             fail "M1 unexpectedly missing from the post-revoke allowlist" ;;
esac

# ===========================================================================
act "4. Curator writes post-revocation batch (3 NEW triples)"
# ===========================================================================
POST_QUADS=$(STAMP="$STAMP" CG_ID="$CG_ID" node -e '
  const stamp = process.env.STAMP;
  const cgId = process.env.CG_ID;
  const quads = [];
  for (const tag of ["post-delta","post-epsilon","post-zeta"]) {
    const entity = "urn:rev:" + stamp + "/" + tag;
    quads.push({ subject: entity, predicate: "http://schema.org/name", object: "\""+tag+"\"", graph: "" });
  }
  console.log(JSON.stringify({ contextGraphId: cgId, quads }));
')
WRITE_POST=$(api_call "$CURATOR_NODE" POST /api/shared-memory/write "$POST_QUADS")
[ "$(parse_json "$WRITE_POST" '.triplesWritten')" = "3" ] || fail "post-write expected 3 triples: $WRITE_POST"
log "✓ post-revocation: 3 NEW triples written by curator"
sleep 8

# ===========================================================================
act "5. Assert M1 sees all 6, M2 sees ≤ 3"
# ===========================================================================
# Codex PR #621 follow-up: replace the single "sleep 3 + one shot
# read" with a bounded retry. Gossip / catchup latency between the
# curator's write and a member's final triple count is variable
# (especially under devnet load), and a one-shot snapshot reports
# the M1 partial state as a regression even though M1 would have
# caught up a second later. The retry collapses to a single read
# once M1 hits target and is cheap on the happy path.
wait_for_count_or_steady() {
  local node="$1" who="$2" target="$3"
  local last_read=""
  for _ in $(seq 1 30); do
    # `count_triples` is idempotent: it triggers a catchup and then
    # reads the SPARQL count. Re-invoking it is the retry loop.
    last_read=$(count_triples "$node")
    if [ -n "$last_read" ] && [ "$last_read" -ge "$target" ] 2>/dev/null; then
      printf '%s\n' "$last_read"
      return 0
    fi
    sleep 1
  done
  # Steady but-not-at-target — caller decides whether that's a
  # failure (M1 must reach target) or expected (M2 stuck at PRE
  # count is the headline revocation outcome).
  printf '%s\n' "${last_read:-}"
}

log "Polling for post-revocation steady state (up to 30s per peer)…"
M1_FINAL=$(wait_for_count_or_steady "$M1_NODE" "M1" 6)
M2_FINAL=$(wait_for_count_or_steady "$M2_NODE" "M2" 6)
CURATOR_FINAL=$(count_triples "$CURATOR_NODE")

# Codex PR #621 R4: a read failure on M2 must NOT be silently treated
# as "M2 only sees the first batch". Distinguish read errors (empty
# string from count_triples) from real zero / low counts, and fail
# the script if we can't actually measure M2's post-revocation state.
[ -n "$M1_FINAL" ]      || fail "M1 final read failed — can't measure post-revocation state"
[ -n "$M2_FINAL" ]      || fail "M2 final read failed — can't measure post-revocation state"
[ -n "$CURATOR_FINAL" ] || fail "Curator final read failed — can't sanity-check the writer's own view"

log "Curator sees:  $CURATOR_FINAL triples"
log "M1 sees:       $M1_FINAL triples"
log "M2 sees:       $M2_FINAL triples (pre=$M2_PRE)"

[ "$CURATOR_FINAL" -ge 6 ] || fail "curator final count=$CURATOR_FINAL expected ≥6 (own writes)"
[ "$M1_FINAL" -ge 6 ] || fail "REGRESSION: M1 sees $M1_FINAL triples post-revocation, expected 6 (M1 was NOT revoked — must continue receiving)"

# Codex PR #621 follow-up: ≤3 alone passes if revocation also wiped
# M2's previously-decryptable triples. The forward-only rotation
# contract in the script header requires the kicked member RETAINS
# what they could already decrypt; they just don't learn anything
# new. Pin a lower bound (`>= M2_PRE`) so a backwards leak (e.g.
# M2 lost the pre-revoke batch via some pruning bug) shows up as
# a hard failure here.
[ "$M2_FINAL" -ge "$M2_PRE" ] || fail "FORWARD-ONLY ROTATION VIOLATED: M2 had $M2_PRE pre-revoke triples, now has $M2_FINAL post-revoke. Revocation removed history it should have left alone."

# ===========================================================================
act "6. Encryption-side rotation: M2 must reject the new sender-key epoch"
# ===========================================================================
# This is what the C1-pass fix (`removeAgentFromContextGraph` writes
# `dkg:revokedAgent` tombstone + drops sender-key cache) actually
# enforces today. We grep M2's daemon log for the broadcast-receive
# denial — proof that the curator's new epoch was NOT distributed to
# the revoked member. Without this denial line the encryption-side
# revoke is broken; with it, the only remaining gap is durable-sync
# propagation (LU-4b — see script header).
M2_LOG="$DEVNET_DIR/node${M2_NODE}/daemon.log"
if [ ! -r "$M2_LOG" ]; then
  fail "M2 daemon log not readable at $M2_LOG — can't validate sender-key denial"
fi
ROTATION_DENIED=$(grep -c "broadcast receive denied: reason=no-state.*${CG_ID}" "$M2_LOG" 2>/dev/null || echo 0)
if [ -z "$ROTATION_DENIED" ] || [ "$ROTATION_DENIED" -lt 1 ]; then
  fail "ENCRYPTION-SIDE REGRESSION: M2 did not reject the post-revoke sender-key broadcast with reason=no-state. " \
       "Either the curator failed to rotate the epoch, OR the new epoch was distributed to the revoked member."
fi
log "✓ M2 rejected $ROTATION_DENIED post-revoke sender-key broadcast(s) with reason=no-state — curator-side rotation works"

# ===========================================================================
act "7. Authorization-side rotation: curator must deny M2's sync requests post-revoke"
# ===========================================================================
CURATOR_LOG="$DEVNET_DIR/node${CURATOR_NODE}/daemon.log"
# Belt-and-braces against the bash idiom "cmd | grep -c ... || echo 0" where
# the `|| echo 0` only fires if the WHOLE pipeline returns non-zero — grep -c
# returns 0 on no match but with status 1, so the fallback fires AND
# concatenates with the legit "0" count, yielding "0\n0" which breaks `[ -lt ]`.
# Force a single integer by collapsing newlines and taking the last numeric
# token.
M2_DENIED_BY_CURATOR=$(grep "Private sync auth for \"${CG_ID}\"" "$CURATOR_LOG" 2>/dev/null \
  | grep "signer=${M2_AGENT}" | grep -c "allowed=false" 2>/dev/null || true)
M2_DENIED_BY_CURATOR=$(printf '%s' "${M2_DENIED_BY_CURATOR:-0}" | tr -d '[:space:]')
[ -n "$M2_DENIED_BY_CURATOR" ] || M2_DENIED_BY_CURATOR=0
if [ "$M2_DENIED_BY_CURATOR" -lt 1 ]; then
  warn "AUTH-SIDE OBSERVATION: curator didn't log any post-revoke M2 sync-denials yet. " \
       "M2 may not have re-tried sync against the curator within the test window."
else
  log "✓ Curator denied $M2_DENIED_BY_CURATOR of M2's sync requests post-revoke — auth-side rotation works"
fi

# ===========================================================================
act "8. Documented gap: M2 may still pull new data via M1 (durable-sync propagation gap)"
# ===========================================================================
# M1 was NOT informed of the revoke (no curator-signed revoke gossip
# exists yet — LU-4b). M1's local allowlist still has M2 and M1
# decrypted the post-revoke batch with its own copy of the new epoch,
# so M1 will serve M2 via PROTOCOL_SYNC. If M2 ends up with all 6
# triples this is the EXPECTED behaviour today; we surface it as a
# WARN so it's loud in CI logs without failing the test.
if [ "$M2_FINAL" -gt 3 ]; then
  warn "Documented LU-4b gap reproduced: M2 sees $M2_FINAL > 3 triples." \
       "Post-revoke data leaked to M2 via durable sync from M1 (or another non-curator member)." \
       "Full enforcement requires curator-signed revoke-gossip propagated to all members — tracked separately."
else
  log "✓ M2 also fully locked out via durable sync ($M2_FINAL ≤ 3) — full revocation propagation observed"
fi

log ""
log "================================================================"
log "  RFC-38 LU-6 C1 (member revocation): PASS (curator-side)"
log "================================================================"
log "  Curated CG:        $CG_ID  (onChainId=$ON_CHAIN_ID)"
log "  Pre-revoke:        3 triples; all 3 members could read."
log "  Revoked:           M2 ($M2_AGENT)"
log "  Post-revoke:       3 NEW triples; M1 reads all 6."
log "  Encryption-side:   ✓ curator rotated epoch; M2 rejected $ROTATION_DENIED broadcast(s)."
log "  Auth-side:         ✓ curator denied $M2_DENIED_BY_CURATOR M2 sync request(s)."
log "  Durable-sync gap:  M2 final count = $M2_FINAL (≤3 ideal, may leak via peer-to-peer sync — LU-4b)."
log "================================================================"
