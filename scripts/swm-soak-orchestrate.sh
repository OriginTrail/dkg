#!/usr/bin/env bash
# swm-soak-orchestrate.sh — master-side bootstrap + launcher for the
# rc.9 reliability smoke/soak across SWM shares AND messenger DMs.
#
# Wraps the manual setup that scripts/swm-soak-test.sh + scripts/
# libp2p-soak-test.sh require (CG creation, cohort id agreement,
# env-var coordination across operators, dual-leg launch) so the
# master operator runs ONE command, sees a ready-to-paste operator
# brief, and (optionally) launches both local soaks in one go.
#
# Followers do NOT use this script — they paste the brief into a
# terminal which runs the two leaf scripts directly with the
# coordinated env vars.
#
# What gets tested
# ----------------
# Two parallel reliability legs, both scoped to the same SOAK_HOURS
# window so postmortem analysis can correlate failures:
#
#   1. SWM SHARES (scripts/swm-soak-test.sh, 1-to-N fan-out)
#      - Each peer writes one tagged quad per cycle to each
#        configured context graph (curated + public).
#      - The publisher path runs the RC9 SWM Reliable Fan-out:
#          a. Substrate fan-out via PROTOCOL_SWM_UPDATE
#             (PR-C #576) to allowlisted members.
#          b. GossipSub publish to the CG topic (always — PR-C R2
#             cross-version safety net).
#          c. SwmAckQuorum tracks delivery (PR-D #578); watchdog
#             fires substrate top-up at 30s if quorum (≥90% by
#             default) hasn't been reached; re-arms on 0x02
#             retryable sentinels (PR-H #582).
#      - Each peer samples its local SWM to count how many writes
#        from OTHER peers actually arrived. Ground-truth: SPARQL.
#      - Ship-gate metric: ≥99.9% cross-peer delivery within window.
#
#   2. MESSENGER DMs (scripts/libp2p-soak-test.sh, pair-wise)
#      - Master runs one libp2p-soak process per follower
#        (spoke topology — master at center). Each process sends
#        one tagged + sequenced /api/chat message to that follower
#        every MSG_INTERVAL_MIN minutes.
#      - Followers run one libp2p-soak back at the master (so the
#        pair is bidirectional). N peers = N-1 messenger processes
#        on the master + 1 per follower.
#      - The send path runs the Universal Messenger (PR-A — rc.9
#        reliable substrate): per-message deduplication, durable
#        outbox retry, /api/slo per-protocol histogram with
#        delivered/queued/retryable counters.
#      - Each peer's local /api/messages?from=<peer> inbox is
#        snapshotted post-send so postmortem can compute
#        per-pair delivery percentages.
#      - Ship-gate metric: ≥99.9% bidirectional delivery within window.
#
# Both legs share the same /api/slo endpoint (protocols.chat.* for
# messenger, substrateFanout.* + swmAckQuorum.* for SWM). The
# orchestrator does NOT itself ship-gate — that's the postmortem's
# job after both legs finish.
#
# Topology
# --------
#   master (this script)
#     - creates 1 curated CG (allowlist = self agent + OPERATOR_AGENTS)
#     - creates 1 public  CG (open subscribe)
#     - generates SOAK_COHORT_ID
#     - prints the OPERATOR BRIEF block
#     - (default) launches BOTH legs of the soak locally:
#         * swm-soak-test.sh (SWM, all CGs)
#         * one libp2p-soak-test.sh per follower (DM, spoke)
#
#   followers (off this machine)
#     - update their checkout to the printed SHA on the soak branch
#     - paste the brief; brief runs the two leaf scripts directly
#       with the coordinated env vars
#
# Required env vars
# -----------------
#   MASTER_TAG       short uppercase label for THIS daemon
#                    (used as SENDER_TAG locally + in CG names).
#                    Other operators use their own tag in the brief.
#                    No default; fails fast if unset.
#
# Optional env vars (multi-peer)
# ------------------------------
#   OPERATOR_TAGS    comma-separated tags of OTHER operators.
#                    Required for multi-peer runs.
#   OPERATOR_AGENTS  comma-separated agent addresses of OTHER
#                    operators (same order as OPERATOR_TAGS); fed
#                    into the curated CG allowlist. When unset, the
#                    curated CG is skipped (only the public CG runs
#                    for SWM) and the brief warns the master.
#   OPERATOR_NAMES   comma-separated agent NAMES of OTHER operators
#                    (same order as OPERATOR_TAGS); used as the
#                    `to:` field for /api/chat DMs. When unset, the
#                    messenger leg is skipped locally (the brief
#                    still includes it so operators can run it once
#                    they exchange names out of band).
#   OPERATOR_PEERS   comma-separated peer IDs of OTHER operators
#                    (same order as OPERATOR_TAGS); used by the
#                    messenger soak's preflight diagnostics
#                    (libp2p /api/peer-info probe per cycle).
#                    Optional but strongly recommended — without
#                    it postmortem can't disambiguate "my internet
#                    was down" from "their peer was unreachable".
#
# Optional env vars (cadence + scope)
# -----------------------------------
#   SOAK_HOURS       total duration in hours (default: 2 — a smoke
#                    short enough to surface obvious regressions
#                    without burning a full overnight). Use 12 or
#                    24 for the real ship-gate soak.
#   SWM_INTERVAL_S   SWM per-cycle cadence in seconds (default: 30).
#   MSG_INTERVAL_MIN messenger per-cycle cadence in minutes
#                    (default: 5). At 2h × 5min = 24 DMs per
#                    direction per pair — enough to compute a
#                    delivery rate.
#   COHORT_PREFIX    prefix for SOAK_COHORT_ID (default: rc9-soak).
#                    Cohort id becomes `${COHORT_PREFIX}-YYYYMMDD-<sha>`.
#   CG_PREFIX        prefix for both CG ids (default: swm-soak).
#                    Curated CG = `${CG_PREFIX}-curated-<sha>`,
#                    public  CG = `${CG_PREFIX}-public-<sha>`.
#                    The sha suffix prevents collisions across reruns.
#   BRIEF_ONLY       1 to stop after printing the brief (don't
#                    launch the local soaks). Useful for dry runs
#                    or while waiting for follower canaries.
#   API              daemon base URL (default: http://127.0.0.1:9200).
#   DKG_HOME         daemon home dir (default: $HOME/.dkg). Used to
#                    locate auth.token if AUTH/DKG_AUTH unset.
#   AUTH / DKG_AUTH  bearer token; falls back to ${DKG_HOME}/auth.token
#                    if neither is set. Same precedence as the
#                    leaf scripts.
#
# Usage
# -----
#   # Two-peer 2h SMOKE: master MILES with follower LEX
#   bash scripts/swm-soak-orchestrate.sh \
#     MASTER_TAG=MILES \
#     OPERATOR_TAGS=LEX \
#     OPERATOR_AGENTS=0xLexAgentAddress... \
#     OPERATOR_NAMES=lex-default \
#     OPERATOR_PEERS=12D3KooWLex...
#
#   # Multi-peer 12h SOAK (4 nodes)
#   bash scripts/swm-soak-orchestrate.sh \
#     MASTER_TAG=MILES \
#     OPERATOR_TAGS=LEX,HERMES,ARX \
#     OPERATOR_AGENTS=0xLex...,0xHermes...,0xArx... \
#     OPERATOR_NAMES=lex-default,hermes-default,arx-default \
#     OPERATOR_PEERS=12D3KooWLex...,12D3KooWHermes...,12D3KooWArx... \
#     SOAK_HOURS=12
#
#   # Brief only (waiting for operator canaries)
#   BRIEF_ONLY=1 bash scripts/swm-soak-orchestrate.sh MASTER_TAG=MILES
#
# Stop early:
#   pkill -f swm-soak-test.sh
#   pkill -f libp2p-soak-test.sh

set -uo pipefail

for kv in "$@"; do
  case "$kv" in
    *=*) export "$kv" ;;
  esac
done

MASTER_TAG="${MASTER_TAG:-}"
OPERATOR_TAGS="${OPERATOR_TAGS:-}"
OPERATOR_AGENTS="${OPERATOR_AGENTS:-}"
OPERATOR_NAMES="${OPERATOR_NAMES:-}"
OPERATOR_PEERS="${OPERATOR_PEERS:-}"
SOAK_HOURS="${SOAK_HOURS:-2}"
SWM_INTERVAL_S="${SWM_INTERVAL_S:-30}"
MSG_INTERVAL_MIN="${MSG_INTERVAL_MIN:-5}"
COHORT_PREFIX="${COHORT_PREFIX:-rc9-soak}"
CG_PREFIX="${CG_PREFIX:-swm-soak}"
BRIEF_ONLY="${BRIEF_ONLY:-0}"
API="${API:-http://127.0.0.1:9200}"
DKG_HOME="${DKG_HOME:-${HOME}/.dkg}"
AUTH="${AUTH:-${DKG_AUTH:-}}"

err() { printf '\033[31m[orchestrate] %s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m[orchestrate] %s\033[0m\n' "$*" >&2; }
ok() { printf '\033[32m[orchestrate] %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m[orchestrate] %s\033[0m\n' "$*" >&2; }

[ -n "$MASTER_TAG" ] || { err "MASTER_TAG is required"; exit 1; }

case "$MASTER_TAG" in
  *[!A-Z0-9_]*) err "MASTER_TAG must be uppercase letters/digits/underscore only (got: $MASTER_TAG)"; exit 1 ;;
esac

# Length-check the comma-separated operator lists. If any of them
# is set, OPERATOR_TAGS must be set first and the lengths must
# match — otherwise the per-operator zip below silently misaligns
# (e.g. operator LEX's agent address gets sent to HERMES's CG
# allowlist).
count_csv() { [ -z "$1" ] && echo 0 || echo "$1" | awk -F',' '{print NF}'; }
N_TAGS=$(count_csv "$OPERATOR_TAGS")
N_AGENTS=$(count_csv "$OPERATOR_AGENTS")
N_NAMES=$(count_csv "$OPERATOR_NAMES")
N_PEERS=$(count_csv "$OPERATOR_PEERS")

if [ "$N_TAGS" = "0" ] && { [ "$N_AGENTS" != "0" ] || [ "$N_NAMES" != "0" ] || [ "$N_PEERS" != "0" ]; }; then
  err "OPERATOR_AGENTS/NAMES/PEERS set but OPERATOR_TAGS is empty — provide tags first so the lists align"; exit 1
fi
for var_pair in "OPERATOR_AGENTS:$N_AGENTS" "OPERATOR_NAMES:$N_NAMES" "OPERATOR_PEERS:$N_PEERS"; do
  name=${var_pair%%:*}
  count=${var_pair##*:}
  if [ "$count" != "0" ] && [ "$count" != "$N_TAGS" ]; then
    err "$name has $count entries but OPERATOR_TAGS has $N_TAGS — lists must align positionally"; exit 1
  fi
done

if [ -z "$AUTH" ]; then
  AUTH_FILE="${DKG_HOME}/auth.token"
  [ -s "$AUTH_FILE" ] || { err "no AUTH/DKG_AUTH and ${AUTH_FILE} is missing or empty"; exit 1; }
  AUTH="$(grep -v '^#' "$AUTH_FILE" | grep -v '^$' | head -1)"
  [ -n "$AUTH" ] || { err "${AUTH_FILE} contains no usable token (only comments/blank lines)"; exit 1; }
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { err "not inside a git checkout"; exit 1; }
cd "$REPO_ROOT"

SHA_FULL="$(git rev-parse HEAD)"
SHA_SHORT="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
TODAY="$(date -u +%Y%m%d)"

info "preflight: branch=${BRANCH} sha=${SHA_SHORT} api=${API}"

# ── daemon preflight ──────────────────────────────────────────
identity_json="$(curl -s -H "Authorization: Bearer ${AUTH}" "${API}/api/agent/identity")"
case "$identity_json" in
  *agentAddress*) : ;;
  *)
    err "daemon /api/agent/identity returned: ${identity_json}"
    err "is the daemon up at ${API} and is AUTH valid?"
    exit 1
    ;;
esac

MASTER_AGENT="$(printf '%s' "$identity_json" | sed -n 's/.*"agentAddress":"\([^"]*\)".*/\1/p')"
MASTER_PEER_ID="$(printf '%s' "$identity_json" | sed -n 's/.*"peerId":"\([^"]*\)".*/\1/p')"
[ -n "$MASTER_AGENT" ] || { err "could not extract agentAddress from identity response"; exit 1; }
[ -n "$MASTER_PEER_ID" ] || { err "could not extract peerId from identity response"; exit 1; }

ok "daemon up: agent=${MASTER_AGENT} peer=${MASTER_PEER_ID}"

# ── derive ids + cycle budgets ───────────────────────────────
COHORT_ID="${COHORT_PREFIX}-${TODAY}-${SHA_SHORT}"
CURATED_SLUG="${CG_PREFIX}-curated-${SHA_SHORT}"
PUBLIC_SLUG="${CG_PREFIX}-public-${SHA_SHORT}"
CURATED_CG="${MASTER_AGENT}/${CURATED_SLUG}"
PUBLIC_CG="${MASTER_AGENT}/${PUBLIC_SLUG}"
SWM_TOTAL_CYCLES=$(( (SOAK_HOURS * 3600) / SWM_INTERVAL_S ))
MSG_INTERVAL_S=$(( MSG_INTERVAL_MIN * 60 ))
MSG_TOTAL_CYCLES=$(( (SOAK_HOURS * 60) / MSG_INTERVAL_MIN ))

# Decide which legs run locally + appear in the brief.
SKIP_CURATED=0
if [ -z "$OPERATOR_AGENTS" ]; then
  SKIP_CURATED=1
  if [ -n "$OPERATOR_TAGS" ]; then
    warn "OPERATOR_AGENTS not set — skipping curated CG (allowlist needs addresses). Public CG SWM still runs."
  fi
fi
WITH_MESSENGER=0
if [ -n "$OPERATOR_NAMES" ]; then
  WITH_MESSENGER=1
elif [ -n "$OPERATOR_TAGS" ]; then
  warn "OPERATOR_NAMES not set — skipping local messenger leg. SWM leg still runs."
fi

info "cohort id: ${COHORT_ID}"
[ "$SKIP_CURATED" = "0" ] && info "curated CG: ${CURATED_CG}" || info "curated CG: <skipped — no OPERATOR_AGENTS>"
info "public  CG: ${PUBLIC_CG}"
info "SWM leg:     ${SOAK_HOURS}h × ${SWM_INTERVAL_S}s   = ${SWM_TOTAL_CYCLES} cycles"
if [ "$WITH_MESSENGER" = "1" ]; then
  info "messenger:   ${SOAK_HOURS}h × ${MSG_INTERVAL_MIN}min = ${MSG_TOTAL_CYCLES} DMs per follower"
else
  info "messenger:   <skipped locally>"
fi

# ── create CGs ────────────────────────────────────────────────
create_cg() {
  local slug="$1"; shift
  info "creating CG: ${slug}"
  if pnpm --silent dkg context-graph create "${slug}" --name "${slug}" "$@" 2>&1 | tee /tmp/.swm-soak-create-${slug}.log; then
    ok "CG created: ${slug}"
  else
    if grep -qiE 'already exists|duplicate|exists' /tmp/.swm-soak-create-${slug}.log; then
      info "CG ${slug} already exists — reusing"
    else
      err "CG create failed for ${slug}; see /tmp/.swm-soak-create-${slug}.log"
      exit 1
    fi
  fi
}

if [ "$SKIP_CURATED" = "0" ]; then
  # Build --allowed-agent args for curated CG: master + all operators.
  ALLOWED_ARGS=("--allowed-agent" "${MASTER_AGENT}")
  IFS=',' read -r -a operator_agents_arr <<< "$OPERATOR_AGENTS"
  for a in "${operator_agents_arr[@]}"; do
    a="${a// /}"
    [ -n "$a" ] || continue
    ALLOWED_ARGS+=("--allowed-agent" "$a")
  done
  create_cg "${CURATED_SLUG}" "${ALLOWED_ARGS[@]}"
  pnpm --silent dkg subscribe "${CURATED_CG}" >/dev/null 2>&1 || true
fi
create_cg "${PUBLIC_SLUG}"
pnpm --silent dkg subscribe "${PUBLIC_CG}" >/dev/null 2>&1 || true
ok "local subscribes verified"

# ── operator brief ────────────────────────────────────────────
BRIEF_TAGS="$OPERATOR_TAGS"
if [ -n "$BRIEF_TAGS" ]; then
  ALL_TAGS="${MASTER_TAG},${BRIEF_TAGS}"
  MASTER_PEERS_EXPECTED="$BRIEF_TAGS"
else
  ALL_TAGS="${MASTER_TAG}"
  MASTER_PEERS_EXPECTED=""
fi

# Determine the master's agent NAME for the brief (so followers
# know who to use as RECIPIENT for /api/chat). /api/info is the
# authoritative source — /api/agent/identity returns the address
# but not the name.
info_json="$(curl -s -H "Authorization: Bearer ${AUTH}" "${API}/api/info")"
MASTER_NAME="$(printf '%s' "$info_json" | sed -n 's/.*"agentName":"\([^"]*\)".*/\1/p')"
if [ -z "$MASTER_NAME" ] || [ "$MASTER_NAME" = "null" ]; then
  MASTER_NAME='<your-agent-name>'
  warn "/api/info returned agentName=null — operators will need to fill in the RECIPIENT field manually"
  warn "to fix: relaunch your daemon with 'pnpm dkg start --name <NAME>'"
fi

CURATED_LINE="${CURATED_CG}"
[ "$SKIP_CURATED" = "1" ] && CURATED_LINE="<skipped — no operator agent addresses supplied>"

# Pre-render the conditional curated-CG lines for the follower
# brief. Can't inline `$(printf ... \n)` in a heredoc because
# command substitution strips trailing newlines, which collapses
# the next heredoc line onto the same physical row.
FOLLOWER_SUBSCRIBE_BLOCK=""
FOLLOWER_SWM_LAUNCH_BLOCK=""
if [ "$SKIP_CURATED" = "0" ]; then
  FOLLOWER_SUBSCRIBE_BLOCK=$(printf '  pnpm dkg subscribe %s\n  pnpm dkg subscribe %s' \
    "${CURATED_CG}" "${PUBLIC_CG}")
  FOLLOWER_SWM_LAUNCH_BLOCK=$(printf '  nohup caffeinate -i bash scripts/swm-soak-test.sh \\\n    SWM_CG_CURATED=%s \\\n    SWM_CG_PUBLIC=%s \\\n    SENDER_TAG=<your_tag> \\\n    PEERS_EXPECTED=<other_tags_comma_separated> \\\n    SOAK_COHORT_ID=%s \\\n    SWM_TOTAL_CYCLES=%s \\\n    >> ~/.dkg/swm-soak-test.out 2>&1 &\n  disown' \
    "${CURATED_CG}" "${PUBLIC_CG}" "${COHORT_ID}" "${SWM_TOTAL_CYCLES}")
else
  FOLLOWER_SUBSCRIBE_BLOCK=$(printf '  pnpm dkg subscribe %s' "${PUBLIC_CG}")
  FOLLOWER_SWM_LAUNCH_BLOCK=$(printf '  nohup caffeinate -i bash scripts/swm-soak-test.sh \\\n    SWM_CG_PUBLIC=%s \\\n    SENDER_TAG=<your_tag> \\\n    PEERS_EXPECTED=<other_tags_comma_separated> \\\n    SOAK_COHORT_ID=%s \\\n    SWM_TOTAL_CYCLES=%s \\\n    >> ~/.dkg/swm-soak-test.out 2>&1 &\n  disown' \
    "${PUBLIC_CG}" "${COHORT_ID}" "${SWM_TOTAL_CYCLES}")
fi

cat <<EOF


╭──────────────────────────────────────────────────────────────╮
│  rc.9 SOAK — OPERATOR BRIEF (copy-paste to followers)        │
│  Tests BOTH legs: SWM shares + Universal Messenger DMs       │
╰──────────────────────────────────────────────────────────────╯

Branch:        soak/messenger-rc9-everything
Commit SHA:    ${SHA_FULL}
Duration:      ${SOAK_HOURS}h
SWM cadence:   ${SWM_INTERVAL_S}s  (${SWM_TOTAL_CYCLES} cycles total)
Msg cadence:   ${MSG_INTERVAL_MIN}min (${MSG_TOTAL_CYCLES} DMs per pair per direction)
Curated CG:    ${CURATED_LINE}
Public  CG:    ${PUBLIC_CG}
Cohort ID:     ${COHORT_ID}
Master:        ${MASTER_TAG}
               agent address = ${MASTER_AGENT}
               agent name    = ${MASTER_NAME}
               peer id       = ${MASTER_PEER_ID}
Followers:     ${BRIEF_TAGS:-<none — solo run>}

─── follower onboarding (paste this into the follower's chat) ───

Hi! We're running a 2-leg reliability soak from the rc.9 soak
branch:
  • SWM SHARES — 1-to-N quad fan-out into two context graphs
  • MESSENGER  — bidirectional /api/chat DMs with the master

To join, please run the following on the machine where your
DKG daemon lives:

  # 1. Update checkout to the agreed soak SHA
  cd <path/to/dkg>
  git fetch origin soak/messenger-rc9-everything
  git checkout soak/messenger-rc9-everything
  git reset --hard ${SHA_FULL}
  pnpm install --frozen-lockfile
  pnpm build

  # 2. Restart daemon with NO blue-green (we want every write +
  #    DM hitting the same node — no migration weirdness)
  pkill -f dkg-daemon || true
  DKG_NO_BLUE_GREEN=1 pnpm dkg start &
  disown

  # 3. Canaries — confirm you are on the right SHA + the new
  #    protocols are registered (look for swm-update +
  #    swm-share-ack in the /api/slo protocols list)
  curl -s http://127.0.0.1:9200/api/info \\
    | jq '{peerId, agentAddress, agentName, version}'
  curl -s -H "Authorization: Bearer \$(grep -v '^#' ~/.dkg/auth.token | head -1)" \\
    http://127.0.0.1:9200/api/slo | jq '.protocols // [] | map(.protocol)'

  # Send back FOUR things so we can wire you in:
  #   - peerId
  #   - agentAddress
  #   - agentName       (from /api/info)
  #   - canary outputs verbatim

  # 4. Subscribe to the context graph(s)
${FOLLOWER_SUBSCRIBE_BLOCK}

  # 5a. Launch the SWM-shares leg
  #     All participating tags:  ${ALL_TAGS}
  #     SENDER_TAG     = your own tag (sticks on your writes)
  #     PEERS_EXPECTED = OTHER tags, comma-separated
${FOLLOWER_SWM_LAUNCH_BLOCK}

  # 5b. Launch the MESSENGER leg — bidirectional /api/chat DMs
  #     with the master ${MASTER_TAG} (${MASTER_NAME}).
  #     Each cycle sends one DM to the master and snapshots
  #     your inbox for replies. The master runs the mirror.
  nohup caffeinate -i bash scripts/libp2p-soak-test.sh \\
    RECIPIENT=${MASTER_NAME} \\
    RECIPIENT_PEER_ID=${MASTER_PEER_ID} \\
    SENDER_TAG=<your_tag> \\
    TOTAL_CYCLES=${MSG_TOTAL_CYCLES} \\
    INTERVAL_S=${MSG_INTERVAL_S} \\
    >> ~/.dkg/libp2p-soak-test.out 2>&1 &
  disown

  # 6. Confirm both are running
  pgrep -af 'swm-soak-test.sh|libp2p-soak-test.sh'
  tail -f ~/.dkg/swm-soak-test.out      # ctrl-c after a cycle
  tail -f ~/.dkg/libp2p-soak-test.out   # ctrl-c after a cycle

Both legs run ${SOAK_HOURS} hours then write a final summary block to
their respective .out files. Send both blocks back when done.

─── master commands (this machine) ─────────────────────────────

EOF

printf '  # SWM leg\n'
printf '  nohup caffeinate -i bash scripts/swm-soak-test.sh \\\n'
[ "$SKIP_CURATED" = "0" ] && printf '    SWM_CG_CURATED=%s \\\n' "${CURATED_CG}"
printf '    SWM_CG_PUBLIC=%s \\\n' "${PUBLIC_CG}"
printf '    SENDER_TAG=%s \\\n' "${MASTER_TAG}"
printf '    PEERS_EXPECTED=%s \\\n' "${MASTER_PEERS_EXPECTED}"
printf '    SOAK_COHORT_ID=%s \\\n' "${COHORT_ID}"
printf '    SWM_TOTAL_CYCLES=%s \\\n' "${SWM_TOTAL_CYCLES}"
printf '    SWM_INTERVAL_S=%s \\\n' "${SWM_INTERVAL_S}"
printf '    >> %s/.dkg/swm-soak-test.out 2>&1 &\n' "${HOME}"
printf '  disown\n\n'

if [ "$WITH_MESSENGER" = "1" ]; then
  IFS=',' read -r -a op_names_arr <<< "$OPERATOR_NAMES"
  IFS=',' read -r -a op_tags_arr  <<< "$OPERATOR_TAGS"
  IFS=',' read -r -a op_peers_arr <<< "$OPERATOR_PEERS"
  for i in "${!op_names_arr[@]}"; do
    op_name="${op_names_arr[$i]// /}"
    op_tag="${op_tags_arr[$i]:-${op_name}}"
    op_peer="${op_peers_arr[$i]:-}"
    printf '  # Messenger leg → %s (%s)\n' "${op_tag}" "${op_name}"
    printf '  nohup caffeinate -i bash scripts/libp2p-soak-test.sh \\\n'
    printf '    RECIPIENT=%s \\\n' "${op_name}"
    [ -n "$op_peer" ] && printf '    RECIPIENT_PEER_ID=%s \\\n' "${op_peer}"
    printf '    SENDER_TAG=%s \\\n' "${MASTER_TAG}"
    printf '    TOTAL_CYCLES=%s \\\n' "${MSG_TOTAL_CYCLES}"
    printf '    INTERVAL_S=%s \\\n' "${MSG_INTERVAL_S}"
    printf '    >> %s/.dkg/libp2p-soak-%s.out 2>&1 &\n' "${HOME}" "${op_tag}"
    printf '  disown\n\n'
  done
else
  printf '  # Messenger leg: <skipped — no OPERATOR_NAMES supplied>\n\n'
fi

if [ "$BRIEF_ONLY" = "1" ]; then
  ok "BRIEF_ONLY=1 — stopping here without launching local soaks"
  exit 0
fi

# ── launch local soaks ────────────────────────────────────────
mkdir -p "${HOME}/.dkg"

info "launching SWM soak (output: ${HOME}/.dkg/swm-soak-test.out)"
SWM_ENV=(AUTH="$AUTH"
  SWM_CG_PUBLIC="${PUBLIC_CG}"
  SENDER_TAG="${MASTER_TAG}"
  PEERS_EXPECTED="${MASTER_PEERS_EXPECTED}"
  SOAK_COHORT_ID="${COHORT_ID}"
  SWM_TOTAL_CYCLES="${SWM_TOTAL_CYCLES}"
  SWM_INTERVAL_S="${SWM_INTERVAL_S}")
[ "$SKIP_CURATED" = "0" ] && SWM_ENV+=(SWM_CG_CURATED="${CURATED_CG}")
env "${SWM_ENV[@]}" nohup bash scripts/swm-soak-test.sh \
  >> "${HOME}/.dkg/swm-soak-test.out" 2>&1 &
SWM_PID=$!
disown $SWM_PID
sleep 2
if kill -0 $SWM_PID 2>/dev/null; then
  ok "SWM soak running (pid=${SWM_PID})"
else
  err "SWM soak exited within 2s; check ${HOME}/.dkg/swm-soak-test.out"
  tail -20 "${HOME}/.dkg/swm-soak-test.out" >&2 || true
  exit 1
fi

if [ "$WITH_MESSENGER" = "1" ]; then
  IFS=',' read -r -a op_names_arr <<< "$OPERATOR_NAMES"
  IFS=',' read -r -a op_tags_arr  <<< "$OPERATOR_TAGS"
  IFS=',' read -r -a op_peers_arr <<< "$OPERATOR_PEERS"
  for i in "${!op_names_arr[@]}"; do
    op_name="${op_names_arr[$i]// /}"
    op_tag="${op_tags_arr[$i]:-${op_name}}"
    op_peer="${op_peers_arr[$i]:-}"
    out_file="${HOME}/.dkg/libp2p-soak-${op_tag}.out"
    info "launching messenger soak → ${op_tag} (${op_name}) (output: ${out_file})"
    MSG_ENV=(AUTH="$AUTH"
      RECIPIENT="$op_name"
      SENDER_TAG="${MASTER_TAG}-${op_tag}"
      TOTAL_CYCLES="${MSG_TOTAL_CYCLES}"
      INTERVAL_S="${MSG_INTERVAL_S}")
    [ -n "$op_peer" ] && MSG_ENV+=(RECIPIENT_PEER_ID="$op_peer")
    env "${MSG_ENV[@]}" nohup bash scripts/libp2p-soak-test.sh \
      >> "$out_file" 2>&1 &
    MSG_PID=$!
    disown $MSG_PID
    sleep 2
    if kill -0 $MSG_PID 2>/dev/null; then
      ok "messenger soak → ${op_tag} running (pid=${MSG_PID})"
    else
      err "messenger soak → ${op_tag} exited within 2s; check ${out_file}"
      tail -20 "$out_file" >&2 || true
    fi
  done
fi

ok "all local soaks launched — ${SOAK_HOURS}h smoke window started at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
ok "watch:   tail -f ${HOME}/.dkg/swm-soak-test.out  (SWM)"
[ "$WITH_MESSENGER" = "1" ] && ok "         tail -f ${HOME}/.dkg/libp2p-soak-*.out      (messenger)"
ok "stop:    pkill -f 'swm-soak-test.sh|libp2p-soak-test.sh'"
