#!/usr/bin/env bash
#
# #1241 / issue #1116 — context-graph-INDEPENDENT author seal: devnet proof.
#
# Closes the coverage gap flagged for rc19: NONE of the headline #1116 behaviors
# were exercised on a real multi-node fleet (the existing suites hardcode a
# PRE-registered CG, so they never hit the new paths). This drives them against
# a fleet, asserting the HTTP contract directly:
#
#   A. NEVER-REGISTERED CG, full lifecycle: create(local) -> write -> finalize(seal)
#      -> share(seals by default) -> /vm/publish AUTO-REGISTERS and mints.
#      The seal is produced off-chain BEFORE any on-chain registration; publish
#      confirming on a CG that was never `register`-ed is the auto-register proof
#      (without #1241 this returns 400 "not registered on-chain").
#   B. skipSeal is GONE. #1241 also shipped an unsealed share (skipSeal:true) and
#      a way to seal it afterwards in shared memory (finalize layer:"swm"). The
#      graph-scoped Knowledge Asset model removed both: an asset is finalized and
#      shared as a whole. What is left to hold is that the old requests are
#      refused with their own codes, and that a refused draft is not wedged: it
#      still finalizes, shares sealed and publishes.
#        skipSeal:true            -> 400 UNSEALED_SHARE_UNSUPPORTED
#        skipSeal:"true"          -> 400 (not a boolean)
#        finalize layer:"swm"     -> 409 LEGACY_KA_READ_ONLY
#        finalize layer:"bogus"   -> 400
#
# Requires a running devnet (./scripts/devnet.sh start 6). Creates its OWN fresh
# CG each run; does NOT mutate global chain params, so it is safe alongside the
# other suites. Self-contained (bash 3.2). scripts/devnet-comprehensive.sh runs
# it as the first phase of devnet-test-issue-1585-named-ka-swm.sh (group
# "regression").
#   Run:  ./scripts/devnet-test-seal-decouple.sh
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
TMPDIR="${TMPDIR:-/tmp}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
NODE="${NODE:-1}"
STAMP="$(node -e 'process.stdout.write(String(Date.now()))')"

PASS=0; FAIL=0
log()  { echo "[seal-decouple] $*"; }
ok()   { echo "[seal-decouple]   PASS: $*"; PASS=$((PASS+1)); }
bad()  { echo "[seal-decouple]   FAIL: $*" >&2; FAIL=$((FAIL+1)); }
act()  { echo; echo "[seal-decouple] === $* ==="; }

# Shared node auth / HTTP / JSON helpers: node_token, node_port, api, code_of,
# body_of, field. Keep this suite's 180s api timeout (publish/finalize can be slow).
# shellcheck disable=SC2034  # consumed by api() inside the sourced devnet-lib.sh
DKG_API_MAXTIME=180
. "$REPO_ROOT/scripts/devnet-lib.sh" || { echo "[seal-decouple] FATAL: cannot source devnet-lib.sh" >&2; exit 2; }
# req_ok <label> <node> <METHOD> <path> [body] — api + assert HTTP 200, else bad()
# with the failing operation's label/body (so a broken setup step surfaces HERE,
# not later as a misleading share/finalize failure).
req_ok() {
  local label="$1"; shift
  local R; R=$(api "$@")
  if [ "$(code_of "$R")" != "200" ]; then bad "$label failed (HTTP $(code_of "$R")): $(body_of "$R")"; return 1; fi
  return 0
}

# preflight
curl -sf --max-time 5 -H "Authorization: Bearer $(node_token "$NODE")" \
  "http://127.0.0.1:$(node_port "$NODE")/api/status" >/dev/null \
  || { echo "[seal-decouple] FATAL: node $NODE not reachable — run ./scripts/devnet.sh start 6" >&2; exit 2; }

CG="cgfree-$STAMP"             # deliberately NEVER registered on-chain
SUBJ="urn:seal-dc:$STAMP"

# ============================================================================
act "A. never-registered CG: create -> write -> finalize(seal) -> share -> vm/publish AUTO-REGISTERS"
# ============================================================================
NAME_A="seal-dc-a-$STAMP"

# A0: create the CG LOCALLY only (no on-chain register step — that is the point)
R=$(api "$NODE" POST /api/context-graph/create "{\"id\":\"$CG\",\"name\":\"seal-decouple $STAMP\"}")
[ "$(code_of "$R")" = "200" ] || { bad "local CG create failed (HTTP $(code_of "$R")): $(body_of "$R")"; }

# A1: create the WM assertion
R=$(api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$NAME_A\"}")
AURI=$(field "$(body_of "$R")" assertionUri)
[ -n "$AURI" ] && ok "WM assertion created on never-registered CG ($AURI)" || bad "create failed (HTTP $(code_of "$R")): $(body_of "$R")"

# A2: write a triple
WB="{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$SUBJ\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"seal-decouple A $STAMP\\\"\",\"graph\":\"\"}]}"
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_A/wm/write" "$WB")
[ "$(code_of "$R")" = "200" ] && ok "WM write succeeded" || bad "WM write failed (HTTP $(code_of "$R")): $(body_of "$R")"

# A3: finalize (SEAL) — must succeed off-chain on an UNREGISTERED CG (the #1116 core)
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_A/wm/finalize" "{\"contextGraphId\":\"$CG\"}")
if [ "$(code_of "$R")" = "200" ]; then ok "finalize SEALED the draft on an unregistered CG (CG-independent seal)"
else bad "finalize failed on unregistered CG (HTTP $(code_of "$R")): $(body_of "$R")"; fi

# A4: full share — seals by default; expect sealed=true, publishReady=true
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_A/swm/share" "{\"contextGraphId\":\"$CG\"}")
SEALED=$(field "$(body_of "$R")" sealed); READY=$(field "$(body_of "$R")" publishReady)
[ "$SEALED" = "true" ] && ok "share seals-by-default (sealed=true, publishReady=$READY)" \
  || bad "share did not seal by default (sealed=$SEALED HTTP $(code_of "$R")): $(body_of "$R")"

# A5: vm/publish — must AUTO-REGISTER the never-registered CG then mint
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_A/vm/publish" "{\"contextGraphId\":\"$CG\"}")
PCODE=$(code_of "$R"); PSTATUS=$(field "$(body_of "$R")" status); KAID=$(field "$(body_of "$R")" kaId)
if [ "$PCODE" = "200" ] && { [ "$PSTATUS" = "confirmed" ] || [ "$PSTATUS" = "finalized" ]; }; then
  ok "vm/publish AUTO-REGISTERED + minted on the never-registered CG (status=$PSTATUS kaId=$KAID)"
elif grep -qi 'not registered' <<<"$(body_of "$R")"; then
  bad "vm/publish did NOT auto-register (regression): $(body_of "$R")"
else
  bad "vm/publish failed (HTTP $PCODE status=$PSTATUS): $(body_of "$R")"
fi

# ============================================================================
act "B. skipSeal and seal-in-SWM are refused, and the refused draft stays usable"
# ============================================================================
NAME_B="seal-dc-b-$STAMP"
SUBJ_B="urn:seal-dc-b:$STAMP"
# The create route answers 201 for a new draft.
R=$(api "$NODE" POST /api/knowledge-assets "{\"contextGraphId\":\"$CG\",\"name\":\"$NAME_B\"}")
case "$(code_of "$R")" in 200|201) : ;; *) bad "B-setup create failed (HTTP $(code_of "$R")): $(body_of "$R")" ;; esac
req_ok "B-setup write" "$NODE" POST "/api/knowledge-assets/$NAME_B/wm/write" \
  "{\"contextGraphId\":\"$CG\",\"quads\":[{\"subject\":\"$SUBJ_B\",\"predicate\":\"http://schema.org/name\",\"object\":\"\\\"refused unsealed share $STAMP\\\"\",\"graph\":\"\"}]}"

R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/swm/share" "{\"contextGraphId\":\"$CG\",\"skipSeal\":true}")
if [ "$(code_of "$R")" = "400" ] && [ "$(field "$(body_of "$R")" code)" = "UNSEALED_SHARE_UNSUPPORTED" ]; then
  ok "skipSeal:true is refused (400 UNSEALED_SHARE_UNSUPPORTED)"
else
  bad "skipSeal:true was not refused with UNSEALED_SHARE_UNSUPPORTED (HTTP $(code_of "$R")): $(body_of "$R")"
fi
# strict-boolean guard: a string "true" must 400
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/swm/share" "{\"contextGraphId\":\"$CG\",\"skipSeal\":\"true\"}")
[ "$(code_of "$R")" = "400" ] && ok "non-boolean skipSeal rejected with 400" \
  || bad "non-boolean skipSeal not rejected (HTTP $(code_of "$R")): $(body_of "$R")"

R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/wm/finalize" "{\"contextGraphId\":\"$CG\",\"layer\":\"swm\"}")
if [ "$(code_of "$R")" = "409" ] && [ "$(field "$(body_of "$R")" code)" = "LEGACY_KA_READ_ONLY" ]; then
  ok "finalize layer=swm is refused (409 LEGACY_KA_READ_ONLY)"
else
  bad "finalize layer=swm was not refused with LEGACY_KA_READ_ONLY (HTTP $(code_of "$R")): $(body_of "$R")"
fi
# invalid layer must 400
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/wm/finalize" "{\"contextGraphId\":\"$CG\",\"layer\":\"bogus\"}")
[ "$(code_of "$R")" = "400" ] && ok "invalid finalize layer rejected with 400" \
  || bad "invalid finalize layer not rejected (HTTP $(code_of "$R"))"

# None of the refusals may have wedged the draft.
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/wm/finalize" "{\"contextGraphId\":\"$CG\"}")
[ "$(code_of "$R")" = "200" ] && ok "the refused draft still finalizes" \
  || bad "the refused draft does not finalize (HTTP $(code_of "$R")): $(body_of "$R")"
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/swm/share" "{\"contextGraphId\":\"$CG\"}")
SEALED_B=$(field "$(body_of "$R")" sealed); READY_B=$(field "$(body_of "$R")" publishReady)
if [ "$SEALED_B" = "true" ] && [ "$READY_B" = "true" ]; then
  ok "the refused draft shares sealed and publish-ready"
else
  bad "the refused draft did not share sealed (sealed=$SEALED_B publishReady=$READY_B; HTTP $(code_of "$R")): $(body_of "$R")"
fi
R=$(api "$NODE" POST "/api/knowledge-assets/$NAME_B/vm/publish" "{\"contextGraphId\":\"$CG\"}")
PS2=$(field "$(body_of "$R")" status)
{ [ "$(code_of "$R")" = "200" ] && { [ "$PS2" = "confirmed" ] || [ "$PS2" = "finalized" ]; }; } \
  && ok "the refused draft then published (status=$PS2)" \
  || bad "the refused draft failed to publish (HTTP $(code_of "$R") status=$PS2): $(body_of "$R")"

# ============================================================================
echo
log "──────── SUMMARY ────────"
log "PASS=$PASS  FAIL=$FAIL  (CG=$CG)"
[ "$FAIL" -eq 0 ] && { log "ALL SEAL-DECOUPLE CHECKS PASSED"; exit 0; } || { log "SOME CHECKS FAILED"; exit 1; }
