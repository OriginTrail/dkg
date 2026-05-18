#!/usr/bin/env bash
# swm-soak-orchestrate.sh — master-side bootstrap + launcher for SWM soak
#
# Wraps the manual setup that scripts/swm-soak-test.sh requires (CG
# creation, cohort id agreement, env-var coordination across operators)
# so the master operator runs ONE command, sees a ready-to-paste
# operator brief, and (optionally) launches the local soak in one go.
#
# Followers do NOT use this script — they paste the brief into a
# terminal which runs scripts/swm-soak-test.sh directly with the
# coordinated env vars.
#
# Topology
# --------
#   master (this script)
#     - creates 1 curated CG (allowlist = self agent + OPERATOR_AGENTS)
#     - creates 1 public  CG (open subscribe)
#     - generates SOAK_COHORT_ID
#     - prints the OPERATOR BRIEF block
#     - (default) launches scripts/swm-soak-test.sh locally
#
#   followers (off this machine)
#     - update their checkout to the printed SHA on the soak branch
#     - paste the brief; brief runs the soak after `pnpm dkg subscribe`
#
# Required env vars
# -----------------
#   MASTER_TAG       short uppercase label for THIS daemon
#                    (used as SENDER_TAG locally + in CG names).
#                    Other operators use their own tag in the brief.
#                    No default; fails fast if unset.
#
# Optional env vars
# -----------------
#   OPERATOR_AGENTS  comma-separated agent addresses of OTHER operators
#                    to put on the curated CG allowlist. Empty means
#                    "solo curated CG" (still useful for catching
#                    receiver-side regressions but pointless for
#                    cross-peer transport metrics). REQUIRED for
#                    multi-peer runs.
#   OPERATOR_TAGS    comma-separated tags of OTHER operators (same
#                    order as OPERATOR_AGENTS); fed into PEERS_EXPECTED
#                    so the per-peer breakdown lines up. REQUIRED for
#                    multi-peer runs.
#   SOAK_HOURS       soak duration in hours (default: 12). Translated
#                    into SWM_TOTAL_CYCLES via SWM_INTERVAL_S.
#   SWM_INTERVAL_S   per-cycle cadence in seconds (default: 30).
#   COHORT_PREFIX    prefix for SOAK_COHORT_ID (default: rc9-soak).
#                    Cohort id becomes `${COHORT_PREFIX}-YYYYMMDD-<sha>`.
#   CG_PREFIX        prefix for both CG ids (default: swm-soak).
#                    Curated CG = `${CG_PREFIX}-curated-<sha>`,
#                    public  CG = `${CG_PREFIX}-public-<sha>`.
#                    The sha suffix prevents collisions across reruns.
#   BRIEF_ONLY       1 to stop after printing the brief (don't launch
#                    the local soak). Useful for dry runs or when the
#                    master wants to wait for follower acks before
#                    starting their own daemon's loop.
#   API              daemon base URL (default: http://127.0.0.1:9200).
#   DKG_HOME         daemon home dir (default: $HOME/.dkg). Used to
#                    locate auth.token if AUTH/DKG_AUTH unset.
#   AUTH / DKG_AUTH  bearer token; falls back to ${DKG_HOME}/auth.token
#                    if neither is set. Same precedence as swm-soak-test.sh.
#
# Usage
# -----
#   # Multi-peer soak: master with 3 followers
#   bash scripts/swm-soak-orchestrate.sh \
#     MASTER_TAG=MILES \
#     OPERATOR_AGENTS=0xLex...,0xHermes...,0xArx... \
#     OPERATOR_TAGS=LEX,HERMES,ARX
#
#   # Print the brief without launching the master's loop
#   BRIEF_ONLY=1 bash scripts/swm-soak-orchestrate.sh \
#     MASTER_TAG=MILES OPERATOR_AGENTS=0x... OPERATOR_TAGS=LEX,...
#
#   # Short overnight smoke (3h)
#   bash scripts/swm-soak-orchestrate.sh \
#     MASTER_TAG=MILES OPERATOR_AGENTS=... OPERATOR_TAGS=... SOAK_HOURS=3
#
# Stop early: pkill -f swm-soak-test.sh

set -uo pipefail

for kv in "$@"; do
  case "$kv" in
    *=*) export "$kv" ;;
  esac
done

MASTER_TAG="${MASTER_TAG:-}"
OPERATOR_AGENTS="${OPERATOR_AGENTS:-}"
OPERATOR_TAGS="${OPERATOR_TAGS:-}"
SOAK_HOURS="${SOAK_HOURS:-12}"
SWM_INTERVAL_S="${SWM_INTERVAL_S:-30}"
COHORT_PREFIX="${COHORT_PREFIX:-rc9-soak}"
CG_PREFIX="${CG_PREFIX:-swm-soak}"
BRIEF_ONLY="${BRIEF_ONLY:-0}"
API="${API:-http://127.0.0.1:9200}"
DKG_HOME="${DKG_HOME:-${HOME}/.dkg}"
AUTH="${AUTH:-${DKG_AUTH:-}}"

err() { printf '\033[31m[orchestrate] %s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m[orchestrate] %s\033[0m\n' "$*" >&2; }
ok() { printf '\033[32m[orchestrate] %s\033[0m\n' "$*" >&2; }

[ -n "$MASTER_TAG" ] || { err "MASTER_TAG is required"; exit 1; }

case "$MASTER_TAG" in
  *[!A-Z0-9_]*) err "MASTER_TAG must be uppercase letters/digits/underscore only (got: $MASTER_TAG)"; exit 1 ;;
esac

if [ -n "$OPERATOR_AGENTS" ] && [ -z "$OPERATOR_TAGS" ]; then
  err "OPERATOR_AGENTS is set but OPERATOR_TAGS is empty — both must be set together"; exit 1
fi
if [ -z "$OPERATOR_AGENTS" ] && [ -n "$OPERATOR_TAGS" ]; then
  err "OPERATOR_TAGS is set but OPERATOR_AGENTS is empty — both must be set together"; exit 1
fi

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

# ── derive ids ────────────────────────────────────────────────
COHORT_ID="${COHORT_PREFIX}-${TODAY}-${SHA_SHORT}"
CURATED_SLUG="${CG_PREFIX}-curated-${SHA_SHORT}"
PUBLIC_SLUG="${CG_PREFIX}-public-${SHA_SHORT}"
CURATED_CG="${MASTER_AGENT}/${CURATED_SLUG}"
PUBLIC_CG="${MASTER_AGENT}/${PUBLIC_SLUG}"
SWM_TOTAL_CYCLES=$(( (SOAK_HOURS * 3600) / SWM_INTERVAL_S ))

info "cohort id: ${COHORT_ID}"
info "curated CG: ${CURATED_CG}"
info "public  CG: ${PUBLIC_CG}"
info "soak: ${SOAK_HOURS}h × ${SWM_INTERVAL_S}s cadence = ${SWM_TOTAL_CYCLES} cycles"

# ── create CGs ────────────────────────────────────────────────
# Build --allowed-agent args for curated CG: master + all operators.
ALLOWED_ARGS=("--allowed-agent" "${MASTER_AGENT}")
if [ -n "$OPERATOR_AGENTS" ]; then
  IFS=',' read -r -a operator_agents_arr <<< "$OPERATOR_AGENTS"
  for a in "${operator_agents_arr[@]}"; do
    a="${a// /}"
    [ -n "$a" ] || continue
    ALLOWED_ARGS+=("--allowed-agent" "$a")
  done
fi

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

create_cg "${CURATED_SLUG}" "${ALLOWED_ARGS[@]}"
create_cg "${PUBLIC_SLUG}"

# Idempotent local subscribe (create auto-subscribes but rerun-safe).
pnpm --silent dkg subscribe "${CURATED_CG}" >/dev/null 2>&1 || true
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

cat <<EOF


╭──────────────────────────────────────────────────────────────╮
│  SWM SOAK — OPERATOR BRIEF (copy-paste to followers)         │
╰──────────────────────────────────────────────────────────────╯

Branch:        soak/messenger-rc9-everything
Commit SHA:    ${SHA_FULL}
Soak budget:   ${SOAK_HOURS}h × ${SWM_INTERVAL_S}s cadence = ${SWM_TOTAL_CYCLES} cycles
Curated CG:    ${CURATED_CG}
Public  CG:    ${PUBLIC_CG}
Cohort ID:     ${COHORT_ID}
Master:        ${MASTER_TAG} (agent=${MASTER_AGENT}, peer=${MASTER_PEER_ID})
Followers:     ${BRIEF_TAGS:-<none — solo run>}

─── follower onboarding (paste this into the follower's chat) ───

Hi! We're running the SWM Reliable Fan-out soak from the rc.9
soak branch. To join, please run the following on your machine
where the DKG daemon lives:

  # 1. Update checkout to the agreed soak SHA
  cd <path/to/dkg>
  git fetch origin soak/messenger-rc9-everything
  git checkout soak/messenger-rc9-everything
  git reset --hard ${SHA_FULL}
  pnpm install --frozen-lockfile
  pnpm build

  # 2. Restart daemon with NO blue-green (we want all writes
  #    hitting the same node, no migration weirdness)
  pkill -f dkg-daemon || true
  DKG_NO_BLUE_GREEN=1 pnpm dkg start &
  disown

  # 3. Canaries — confirm you are on the right SHA + the new
  #    protocols are registered (swm-update + swm-share-ack
  #    must appear in /api/slo's protocols list)
  curl -s http://127.0.0.1:9200/api/info | jq '{peerId, agentAddress, version}'
  curl -s -H "Authorization: Bearer \$(grep -v '^#' ~/.dkg/auth.token | head -1)" \\
    http://127.0.0.1:9200/api/slo | jq '.protocols // [] | map(.protocol)'

  # Send YOUR peerId + agentAddress + canary output back so we can
  # add you to the curated CG allowlist.

  # 4. Once you receive the cgIds (after step 3), subscribe to both
  pnpm dkg subscribe ${CURATED_CG}
  pnpm dkg subscribe ${PUBLIC_CG}

  # 5. Launch the soak.
  #    All participating tags:  ${ALL_TAGS}
  #    SENDER_TAG     = your own tag from the list above (this is
  #                     the tag attached to YOUR writes)
  #    PEERS_EXPECTED = the OTHER tags (everyone except your own),
  #                     comma-separated; this is who you expect
  #                     writes to ARRIVE from in your local SWM
  nohup caffeinate -i bash scripts/swm-soak-test.sh \\
    SWM_CG_CURATED=${CURATED_CG} \\
    SWM_CG_PUBLIC=${PUBLIC_CG} \\
    SENDER_TAG=<your_tag> \\
    PEERS_EXPECTED=<other_tags_comma_separated> \\
    SOAK_COHORT_ID=${COHORT_ID} \\
    >> ~/.dkg/swm-soak-test.out 2>&1 &
  disown

  # 6. Confirm it's running
  pgrep -af swm-soak-test.sh
  tail -f ~/.dkg/swm-soak-test.out   # ctrl-c after a cycle or two

The soak runs ${SOAK_HOURS} hours then writes a final summary
block to ~/.dkg/swm-soak-test.out. Send that block back when done.

─── master command (this machine) ──────────────────────────────

EOF

LOCAL_PEERS_EXPECTED="${MASTER_PEERS_EXPECTED}"
LOCAL_CMD="nohup caffeinate -i bash scripts/swm-soak-test.sh \\
    SWM_CG_CURATED=${CURATED_CG} \\
    SWM_CG_PUBLIC=${PUBLIC_CG} \\
    SENDER_TAG=${MASTER_TAG} \\
    PEERS_EXPECTED=${LOCAL_PEERS_EXPECTED} \\
    SOAK_COHORT_ID=${COHORT_ID} \\
    SWM_TOTAL_CYCLES=${SWM_TOTAL_CYCLES} \\
    SWM_INTERVAL_S=${SWM_INTERVAL_S} \\
    >> ${HOME}/.dkg/swm-soak-test.out 2>&1 &"

printf '%s\n  disown\n\n' "$LOCAL_CMD"

if [ "$BRIEF_ONLY" = "1" ]; then
  ok "BRIEF_ONLY=1 — stopping here without launching local soak"
  exit 0
fi

# ── launch local soak ─────────────────────────────────────────
mkdir -p "${HOME}/.dkg"
info "launching local soak (output: ${HOME}/.dkg/swm-soak-test.out)"

env AUTH="$AUTH" \
  SWM_CG_CURATED="${CURATED_CG}" \
  SWM_CG_PUBLIC="${PUBLIC_CG}" \
  SENDER_TAG="${MASTER_TAG}" \
  PEERS_EXPECTED="${LOCAL_PEERS_EXPECTED}" \
  SOAK_COHORT_ID="${COHORT_ID}" \
  SWM_TOTAL_CYCLES="${SWM_TOTAL_CYCLES}" \
  SWM_INTERVAL_S="${SWM_INTERVAL_S}" \
  nohup bash scripts/swm-soak-test.sh \
  >> "${HOME}/.dkg/swm-soak-test.out" 2>&1 &
SOAK_PID=$!
disown $SOAK_PID

sleep 2
if kill -0 $SOAK_PID 2>/dev/null; then
  ok "soak launched (pid=${SOAK_PID})"
  ok "tail -f ${HOME}/.dkg/swm-soak-test.out to watch"
  ok "pkill -f swm-soak-test.sh to stop early"
else
  err "soak process exited within 2s; check ${HOME}/.dkg/swm-soak-test.out"
  tail -20 "${HOME}/.dkg/swm-soak-test.out" >&2 || true
  exit 1
fi
