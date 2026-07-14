#!/usr/bin/env bash
#
# Private context-graph membership recovery regression harness.
#
# Reproduces the v10.0.6 bootstrap inconsistency without mocks:
#
#   * node 5 creates a curated CG and is its only member;
#   * in auto mode, node 5 enables bounded open enrollment before going offline;
#   * node 5 writes root + sub-graph shared-memory fixtures;
#   * node 5 goes offline;
#   * fresh node 6 subscribes while only unrelated cores can answer;
#   * the subscription state is inspected through both HTTP and node-ui.db;
#   * node 5 returns and node 6 requests admission; node 5 either exposes the
#     request for manual approval or automatically approves it through the
#     persisted open-enrollment policy;
#   * recovery (or the persistent v10.0.6 wedge) is measured across a node-6
#     restart.
#
# The harness defaults to a PRESTARTED six-node devnet:
#
#   ./scripts/devnet.sh start 6
#   HARNESS_EXPECT=broken ./scripts/devnet-test-private-cg-membership-recovery.sh
#   HARNESS_EXPECT=fixed ADMISSION_MODE=manual ./scripts/devnet-test-private-cg-membership-recovery.sh
#   HARNESS_EXPECT=fixed ADMISSION_MODE=auto   ./scripts/devnet-test-private-cg-membership-recovery.sh
#
# It can run the same fixed/auto scenario against four explicitly supplied
# testnet nodes. This mode stops one core at a time and therefore requires an
# explicit acknowledgement plus the exact deployed commit as a safety gate:
#
#   HARNESS_TARGET=testnet HARNESS_EXPECT=fixed ADMISSION_MODE=auto \
#     TESTNET_NODE_1_SSH=operator@host1 TESTNET_NODE_2_SSH=operator@host2 \
#     TESTNET_NODE_3_SSH=operator@host3 TESTNET_NODE_4_SSH=operator@host4 \
#     TESTNET_EXPECT_COMMIT=<deployed-git-sha> \
#     TESTNET_ALLOW_CORE_RESTARTS=I_UNDERSTAND \
#     ./scripts/devnet-test-private-cg-membership-recovery.sh
# Set TESTNET_PREFLIGHT_ONLY=1 and omit the restart acknowledgement to run
# every deployment/health check without creating a CG or stopping a node.
#
# ADMISSION_MODE defaults to manual. Auto mode requires the open-enrollment
# implementation and is intended for current/fixed builds.
#
# `broken` passes only after observing the exact false-ready state:
# synced=1, shared_memory_synced=1, meta_synced!=1, no local CG data, and at
# clean empty responses from every configured unrelated core peer. Post-approval recovery
# is still exercised and recorded, but is not required: the invariant breach is
# already the regression witness.
#
# `fixed` requires the pre-admission subscription to remain pending/not-ready,
# then requires metadata, authorization, root SWM, and sub-graph SWM to recover
# exactly and survive a node-6 restart.

# The JavaScript snippets deliberately use single-quoted shell strings and JS
# template literals; their `$` expressions belong to JavaScript, not Bash.
# The sourced helper path is computed from this script's absolute location.
# shellcheck disable=SC1091,SC2016
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT_DIR="$REPO_ROOT/scripts"
DEVNET_DIR="${DEVNET_DIR:-$REPO_ROOT/.devnet}"
API_PORT_BASE="${API_PORT_BASE:-9201}"
HARNESS_TARGET="${HARNESS_TARGET:-devnet}"
case "$HARNESS_TARGET" in
  devnet)
    CURATOR_NODE="${CURATOR_NODE:-5}"
    JOINER_NODE="${JOINER_NODE:-6}"
    NUM_NODES="${NUM_NODES:-6}"
    ;;
  testnet)
    CURATOR_NODE="${CURATOR_NODE:-1}"
    JOINER_NODE="${JOINER_NODE:-2}"
    NUM_NODES="${NUM_NODES:-4}"
    ;;
  *)
    echo "HARNESS_TARGET must be devnet or testnet (got: $HARNESS_TARGET)" >&2
    exit 2
    ;;
esac

case "$CURATOR_NODE:$JOINER_NODE:$NUM_NODES" in
  *[!0-9:]*|:*|*::*|*:) echo "CURATOR_NODE, JOINER_NODE, and NUM_NODES must be positive integers" >&2; exit 2 ;;
esac
[ "$CURATOR_NODE" -ge 1 ] && [ "$CURATOR_NODE" -le "$NUM_NODES" ] \
  || { echo "CURATOR_NODE must identify one of the configured nodes" >&2; exit 2; }
[ "$JOINER_NODE" -ge 1 ] && [ "$JOINER_NODE" -le "$NUM_NODES" ] \
  || { echo "JOINER_NODE must identify one of the configured nodes" >&2; exit 2; }
[ "$CURATOR_NODE" -ne "$JOINER_NODE" ] \
  || { echo "CURATOR_NODE and JOINER_NODE must be different" >&2; exit 2; }

UNRELATED_NODES=""
for node in $(seq 1 "$NUM_NODES"); do
  if [ "$node" -ne "$CURATOR_NODE" ] && [ "$node" -ne "$JOINER_NODE" ]; then
    UNRELATED_NODES="${UNRELATED_NODES:+$UNRELATED_NODES }$node"
  fi
done
EXPECTED_UNRELATED_RESPONDERS=$((NUM_NODES - 2))

SUB_GRAPH_NAME="${SUB_GRAPH_NAME:-ai-tools}"
ROOT_TRIPLES="${ROOT_TRIPLES:-3}"
SUB_GRAPH_TRIPLES="${SUB_GRAPH_TRIPLES:-5}"
HARNESS_EXPECT="${HARNESS_EXPECT:-}"
ADMISSION_MODE="${ADMISSION_MODE:-manual}"
AUTO_MAX_MEMBERS="${AUTO_MAX_MEMBERS:-10}"
AUTO_MAX_APPROVALS_PER_HOUR="${AUTO_MAX_APPROVALS_PER_HOUR:-5}"
HARNESS_ARTIFACT_DIR="${HARNESS_ARTIFACT_DIR:-$REPO_ROOT/.harness-artifacts}"
CATCHUP_TIMEOUT_S="${CATCHUP_TIMEOUT_S:-120}"
JOIN_DELIVERY_TIMEOUT_S="${JOIN_DELIVERY_TIMEOUT_S:-90}"
RECOVERY_TIMEOUT_S="${RECOVERY_TIMEOUT_S:-150}"
POST_RESTART_TIMEOUT_S="${POST_RESTART_TIMEOUT_S:-120}"
BROKEN_RECOVERY_OBSERVE_S="${BROKEN_RECOVERY_OBSERVE_S:-35}"
BROKEN_POST_RESTART_OBSERVE_S="${BROKEN_POST_RESTART_OBSERVE_S:-20}"
POLL_INTERVAL_S="${POLL_INTERVAL_S:-2}"
API_TIMEOUT_S="${API_TIMEOUT_S:-30}"
DEVNET_SH="$SCRIPT_DIR/devnet.sh"
TESTNET_NODE_1_SSH="${TESTNET_NODE_1_SSH:-}"
TESTNET_NODE_2_SSH="${TESTNET_NODE_2_SSH:-}"
TESTNET_NODE_3_SSH="${TESTNET_NODE_3_SSH:-}"
TESTNET_NODE_4_SSH="${TESTNET_NODE_4_SSH:-}"
TESTNET_EXPECT_COMMIT="${TESTNET_EXPECT_COMMIT:-}"
TESTNET_ALLOW_CORE_RESTARTS="${TESTNET_ALLOW_CORE_RESTARTS:-}"
TESTNET_PREFLIGHT_ONLY="${TESTNET_PREFLIGHT_ONLY:-0}"
TESTNET_MAX_ACCEPT_QUEUE="${TESTNET_MAX_ACCEPT_QUEUE:-128}"
TESTNET_SERVICE="${TESTNET_SERVICE:-dkg-v9-node}"
TESTNET_SSH_CONNECT_TIMEOUT="${TESTNET_SSH_CONNECT_TIMEOUT:-90}"

case "$HARNESS_EXPECT" in
  broken|fixed) ;;
  *)
    echo "Usage: HARNESS_EXPECT=broken|fixed $0" >&2
    exit 2
    ;;
esac

case "$ADMISSION_MODE" in
  manual|auto) ;;
  *)
    echo "Usage: HARNESS_EXPECT=broken|fixed ADMISSION_MODE=manual|auto $0" >&2
    exit 2
    ;;
esac

if [ "$ADMISSION_MODE" = "auto" ]; then
  [[ "$AUTO_MAX_MEMBERS" =~ ^[0-9]+$ ]] && [ "$AUTO_MAX_MEMBERS" -ge 2 ] \
    || { echo "AUTO_MAX_MEMBERS must be an integer >= 2 (curator + joiner)." >&2; exit 2; }
  [[ "$AUTO_MAX_APPROVALS_PER_HOUR" =~ ^[0-9]+$ ]] && [ "$AUTO_MAX_APPROVALS_PER_HOUR" -ge 1 ] \
    || { echo "AUTO_MAX_APPROVALS_PER_HOUR must be a positive integer." >&2; exit 2; }
fi

for numeric in \
  "$CURATOR_NODE" "$JOINER_NODE" "$NUM_NODES" "$ROOT_TRIPLES" \
  "$SUB_GRAPH_TRIPLES" "$CATCHUP_TIMEOUT_S" "$JOIN_DELIVERY_TIMEOUT_S" \
  "$RECOVERY_TIMEOUT_S" "$POST_RESTART_TIMEOUT_S" \
  "$TESTNET_MAX_ACCEPT_QUEUE" "$TESTNET_SSH_CONNECT_TIMEOUT"; do
  [[ "$numeric" =~ ^[0-9]+$ ]] || {
    echo "All node/count/timeout settings must be non-negative integers (got: $numeric)" >&2
    exit 2
  }
done

if [ "$HARNESS_TARGET" = "devnet" ]; then
  if [ "$NUM_NODES" -ne 6 ] || [ "$CURATOR_NODE" -ne 5 ] || [ "$JOINER_NODE" -ne 6 ]; then
    echo "Devnet mode requires the default topology: cores 1-4, curator edge 5, joiner edge 6." >&2
    exit 2
  fi
else
  if [ "$NUM_NODES" -ne 4 ]; then
    echo "Testnet mode requires exactly four core nodes." >&2
    exit 2
  fi
  [ "$HARNESS_EXPECT" = "fixed" ] || {
    echo "Testnet mode is a release gate and only supports HARNESS_EXPECT=fixed." >&2
    exit 2
  }
  [ "$TESTNET_PREFLIGHT_ONLY" = "0" ] || [ "$TESTNET_PREFLIGHT_ONLY" = "1" ] || {
    echo "TESTNET_PREFLIGHT_ONLY must be 0 or 1." >&2
    exit 2
  }
  [ -n "$TESTNET_EXPECT_COMMIT" ] || {
    echo "TESTNET_EXPECT_COMMIT is required in testnet mode." >&2
    exit 2
  }
  [[ "$TESTNET_EXPECT_COMMIT" =~ ^[0-9a-fA-F]{7,40}$ ]] || {
    echo "TESTNET_EXPECT_COMMIT must be a 7-40 character Git SHA." >&2
    exit 2
  }
  [[ "$TESTNET_SERVICE" =~ ^[a-zA-Z0-9_.@-]+$ ]] || {
    echo "TESTNET_SERVICE contains unsupported characters." >&2
    exit 2
  }
  if [ "$TESTNET_PREFLIGHT_ONLY" != "1" ] && [ "$TESTNET_ALLOW_CORE_RESTARTS" != "I_UNDERSTAND" ]; then
    echo "Full testnet mode stops one core at a time. Set TESTNET_ALLOW_CORE_RESTARTS=I_UNDERSTAND." >&2
    exit 2
  fi
fi

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
RUN_DIR="$HARNESS_ARTIFACT_DIR/private-cg-membership-recovery-$RUN_ID-$HARNESS_TARGET-$HARNESS_EXPECT-$ADMISSION_MODE"
mkdir -p "$RUN_DIR"
TESTNET_JOURNAL_SINCE="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
if [ "$HARNESS_TARGET" = "testnet" ]; then
  mkdir -p "$RUN_DIR/tmp"
  DEVNET_DIR="$RUN_DIR/tmp"
  export DEVNET_PUBLISH_STATE_FILE="$RUN_DIR/publish-state.json"
  # One KA per fixture keeps the live-network gate fast while preserving the
  # same root/sub-graph triple counts and synchronization behavior.
  export DEVNET_PUBLISH_PRESERVE_BATCH=1
fi
exec > >(tee -a "$RUN_DIR/harness.log") 2>&1

# shellcheck source=devnet-publish-helpers.sh
source "$SCRIPT_DIR/devnet-publish-helpers.sh"

CG_ID=""
CG_ENCODED=""
CURATOR_AGENT=""
CURATOR_PEER=""
JOINER_AGENT=""
JOINER_PEER=""
EXPECTED_DELEGATION_AGENT_LOWER=""
EXPECTED_DELEGATION_PEER=""
EXPECTED_DELEGATION_OP_KEY_LOWER=""
EXPECTED_DELEGATION_SCOPE=""
EXPECTED_DELEGATION_ISSUED_AT=""
EXPECTED_DELEGATION_EXPIRES_AT=""
CURATOR_STOPPED=0
JOINER_STOPPED=0
FAIL_REASON=""
BROKEN_RECOVERED_BEFORE_RESTART=0
BROKEN_RECOVERED_AFTER_RESTART=0
AUTO_APPROVAL_OBSERVED=0

log()  { echo "[private-cg-recovery] $*"; }
warn() { echo "[private-cg-recovery] WARN: $*" >&2; }
act()  { echo; echo "[private-cg-recovery] === $* ==="; }
fail() {
  FAIL_REASON="$*"
  echo "[private-cg-recovery] FAIL: $*" >&2
  exit 1
}

TESTNET_SSH_OPTIONS=(
  -o BatchMode=yes
  -o "ConnectTimeout=$TESTNET_SSH_CONNECT_TIMEOUT"
  -o ControlMaster=auto
  -o ControlPersist=600
  -o "ControlPath=/tmp/dkg-private-cg-${UID:-0}-$$-%C"
)

testnet_node_ssh() {
  case "$1" in
    1) printf '%s' "$TESTNET_NODE_1_SSH" ;;
    2) printf '%s' "$TESTNET_NODE_2_SSH" ;;
    3) printf '%s' "$TESTNET_NODE_3_SSH" ;;
    4) printf '%s' "$TESTNET_NODE_4_SSH" ;;
    *) return 1 ;;
  esac
}

base64_one_line() {
  base64 | tr -d '\r\n'
}

commit_matches() {
  local actual expected
  actual="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  expected="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
  [ -n "$actual" ] && [ -n "$expected" ] \
    && { [[ "$actual" == "$expected"* ]] || [[ "$expected" == "$actual"* ]]; }
}

testnet_probe_node() {
  local node="$1" host
  host="$(testnet_node_ssh "$node")"
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$TESTNET_SERVICE" <<'REMOTE'
set -u
service="$1"
service_active="$(systemctl is-active "$service" 2>/dev/null || true)"
current_commit="$(tr -d '\r\n' < "$HOME/.dkg/.current-commit" 2>/dev/null || true)"
active_git="$(git -C "$HOME/.dkg/releases/current" rev-parse HEAD 2>/dev/null || true)"
active_slot="$(readlink -f "$HOME/.dkg/releases/current" 2>/dev/null | sed 's#.*/##')"
accept_queue="$(ss -lnt 2>/dev/null | awk '$4 ~ /:9090$/ {print $2; exit}')"
build_running=false
for pid in $(pgrep -f 'pnpm install|build-runtime-packages|vite.*build|tsup.*cli-default|typescript/bin/tsc' 2>/dev/null || true); do
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  case "$cwd" in
    "$HOME/.dkg/releases/"*) build_running=true; break ;;
  esac
done
restart_allowed=false
sudo -n -l /usr/bin/systemctl restart "$service" >/dev/null 2>&1 \
  && restart_allowed=true
SERVICE_ACTIVE="$service_active" CURRENT_COMMIT="$current_commit" ACTIVE_GIT="$active_git" \
ACTIVE_SLOT="$active_slot" ACCEPT_QUEUE="$accept_queue" BUILD_RUNNING="$build_running" \
RESTART_ALLOWED="$restart_allowed" node -e '
  process.stdout.write(JSON.stringify({
    serviceActive: process.env.SERVICE_ACTIVE,
    currentCommit: process.env.CURRENT_COMMIT || null,
    activeGit: process.env.ACTIVE_GIT || null,
    activeSlot: process.env.ACTIVE_SLOT || null,
    acceptQueue: process.env.ACCEPT_QUEUE === "" ? null : Number(process.env.ACCEPT_QUEUE),
    buildRunning: process.env.BUILD_RUNNING === "true",
    restartAllowed: process.env.RESTART_ALLOWED === "true",
  }));
'
REMOTE
}

stop_node() {
  local node="$1" host
  if [ "$HARNESS_TARGET" = "devnet" ]; then
    "$DEVNET_SH" stop-node "$node"
    return
  fi
  host="$(testnet_node_ssh "$node")"
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" \
    sudo -n /usr/bin/systemctl stop "$TESTNET_SERVICE"
}

restart_node() {
  local node="$1" host
  if [ "$HARNESS_TARGET" = "devnet" ]; then
    "$DEVNET_SH" restart-node "$node"
    return
  fi
  host="$(testnet_node_ssh "$node")"
  ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" \
    sudo -n /usr/bin/systemctl restart "$TESTNET_SERVICE"
}

node_dir()   { echo "$DEVNET_DIR/node$1"; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }
node_db()    { echo "$(node_dir "$1")/node-ui.db"; }
node_log()   { echo "$(node_dir "$1")/daemon.log"; }
node_token() {
  grep -v '^#' "$(node_dir "$1")/auth.token" 2>/dev/null | head -1 | tr -d '\r\n'
}

urlencode() {
  VALUE="$1" node -e 'process.stdout.write(encodeURIComponent(process.env.VALUE || ""))'
}

json_get() {
  local json="$1" path="$2"
  printf '%s' "$json" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(d);
        for (const part of process.argv[1].split(".")) {
          if (!part) continue;
          value = value == null ? undefined : value[part];
        }
        if (value === undefined) return;
        if (value === null) process.stdout.write("null");
        else if (typeof value === "object") process.stdout.write(JSON.stringify(value));
        else process.stdout.write(String(value));
      } catch {}
    });
  ' "$path"
}

join_request_present() {
  local json="$1" agent="$2"
  printf '%s' "$json" | AGENT="$agent" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        if (!Array.isArray(j.requests)) {
          process.stdout.write("invalid");
          return;
        }
        const target = process.env.AGENT.toLowerCase();
        process.stdout.write(j.requests.some(
          r => String(r.agentAddress || "").toLowerCase() === target,
        ) ? "1" : "0");
      } catch { process.stdout.write("invalid"); }
    });
  '
}

assert_open_join_policy() {
  local response="$1" label="$2"
  [ "$(json_get "$response" mode)" = "open" ] \
    || fail "$label did not report mode=open: $response"
  [ "$(json_get "$response" source)" = "persisted" ] \
    || fail "$label did not report a persisted policy: $response"
  [ "$(json_get "$response" maxMembers)" = "$AUTO_MAX_MEMBERS" ] \
    || fail "$label reported the wrong member cap: $response"
  [ "$(json_get "$response" maxApprovalsPerHour)" = "$AUTO_MAX_APPROVALS_PER_HOUR" ] \
    || fail "$label reported the wrong hourly approval cap: $response"
}

json_empty_response_count() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const root = JSON.parse(d);
        let total = 0;
        const visit = value => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (key === "emptyResponses" && Number.isFinite(Number(child))) total += Number(child);
            else visit(child);
          }
        };
        visit(root);
        process.stdout.write(String(total));
      } catch { process.stdout.write("0"); }
    });
  '
}

json_inserted_triple_count() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const root = JSON.parse(d);
        let total = 0;
        const visit = value => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if ((key === "insertedMetaTriples" || key === "insertedDataTriples")
                && Number.isFinite(Number(child))) total += Number(child);
            else visit(child);
          }
        };
        visit(root);
        process.stdout.write(String(total));
      } catch { process.stdout.write("0"); }
    });
  '
}

sanitize_stream() {
  node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      d = d
        .replace(/("(?:signature|privateKey|private_key|authToken|auth_token|token)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2")
        .replace(/0x[0-9a-f]{96,}/gi, "<redacted-long-hex>");
      process.stdout.write(d);
    });
  '
}

save_artifact() {
  local name="$1" content="${2:-}"
  printf '%s\n' "$content" | sanitize_stream > "$RUN_DIR/$name"
}

api_call() {
  local node="$1" method="$2" path="$3" data="${4:-}"
  local request_timeout="${API_TIMEOUT_OVERRIDE:-$API_TIMEOUT_S}"
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    local host path_b64 data_b64
    host="$(testnet_node_ssh "$node")"
    path_b64="$(printf '%s' "$path" | base64_one_line)"
    data_b64="-"
    [ -n "$data" ] && data_b64="$(printf '%s' "$data" | base64_one_line)"
    ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- \
      "$method" "$path_b64" "$data_b64" "$request_timeout" <<'REMOTE'
set -euo pipefail
method="$1"
path="$(printf '%s' "$2" | base64 -d)"
data=""
[ "$3" = "-" ] || data="$(printf '%s' "$3" | base64 -d)"
timeout="$4"
token="$(grep -v '^#' "$HOME/.dkg/auth.token" 2>/dev/null | head -n1 | tr -d '\r\n')"
port="$(tr -d '\r\n' < "$HOME/.dkg/api.port" 2>/dev/null || printf '9200')"
host="$(tailscale ip -4 | head -n1)"
[ -n "$token" ] && [ -n "$host" ]
args=(
  -sS --max-time "$timeout" -X "$method"
  -H "Authorization: Bearer $token"
  -H 'Content-Type: application/json'
)
[ -n "$data" ] && args+=(-d "$data")
args+=("http://${host}:${port}${path}")
curl "${args[@]}"
REMOTE
    return
  fi
  local token port
  token="$(node_token "$node")"
  port="$(node_port "$node")"
  [ -n "$token" ] || return 1
  local -a args=(
    -sS --max-time "$request_timeout" -X "$method"
    -H "Authorization: Bearer $token"
    -H 'Content-Type: application/json'
  )
  [ -n "$data" ] && args+=(-d "$data")
  args+=("http://127.0.0.1:${port}${path}")
  curl "${args[@]}"
}

node_ready() {
  local node="$1" body
  body="$(API_TIMEOUT_OVERRIDE=5 api_call "$node" GET /api/status 2>/dev/null || true)"
  [ -n "$(json_get "$body" peerId)" ]
}

wait_node_ready() {
  local node="$1" timeout="${2:-90}" start
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    if node_ready "$node"; then return 0; fi
    sleep 1
  done
  return 1
}

wait_node_down() {
  local node="$1" timeout="${2:-45}" start
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    if [ "$HARNESS_TARGET" = "testnet" ]; then
      local host state
      host="$(testnet_node_ssh "$node")"
      state="$(ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$TESTNET_SERVICE" 2>/dev/null <<'REMOTE' || true
systemctl is-active "$1"
REMOTE
)"
      [ "$state" != "active" ] && return 0
    elif ! node_ready "$node"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

node_role() {
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    local status
    status="$(api_call "$1" GET /api/status 2>/dev/null || true)"
    json_get "$status" nodeRole
    return
  fi
  local config
  config="$(node_dir "$1")/config.json"
  node -e '
    const fs = require("fs");
    try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).nodeRole || ""); }
    catch {}
  ' "$config"
}

db_subscription_row() {
  local node="$1" db
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    local host cg_b64
    host="$(testnet_node_ssh "$node")"
    cg_b64="$(printf '%s' "$CG_ID" | base64_one_line)"
    ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- "$cg_b64" <<'REMOTE'
set -euo pipefail
cg="$(printf '%s' "$1" | base64 -d)"
db="$HOME/.dkg/node-ui.db"
[ -f "$db" ] || { printf 'null'; exit 0; }
cd "$HOME/.dkg/releases/current/packages/cli"
DB_PATH="$db" DB_CG_ID="$cg" node --input-type=commonjs <<'NODE'
const Database = require('better-sqlite3');

try {
  const db = new Database(process.env.DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  const row = db.prepare(`
    SELECT context_graph_id, subscribed, synced, shared_memory_synced,
           meta_synced, on_chain_id, sync_scoped, updated_at
      FROM context_graph_subscriptions
     WHERE context_graph_id = ?
  `).get(process.env.DB_CG_ID);
  db.close();
  process.stdout.write(JSON.stringify(row || null));
} catch {
  process.stdout.write('null');
}
NODE
REMOTE
    return
  fi
  db="$(node_db "$node")"
  [ -f "$db" ] || { printf 'null'; return 0; }
  # Open the live WAL database read-only (not immutable) so SQLite still sees
  # committed WAL frames while the daemon is running. Resolve better-sqlite3
  # from packages/cli, which owns the daemon-side subscription-store wiring.
  (
    cd "$REPO_ROOT/packages/cli"
    DB_PATH="$db" DB_CG_ID="$CG_ID" node --input-type=module <<'NODE'
import Database from 'better-sqlite3';

try {
  const db = new Database(process.env.DB_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  const row = db.prepare(`
    SELECT context_graph_id, subscribed, synced, shared_memory_synced,
           meta_synced, on_chain_id, sync_scoped, updated_at
      FROM context_graph_subscriptions
     WHERE context_graph_id = ?
  `).get(process.env.DB_CG_ID);
  db.close();
  process.stdout.write(JSON.stringify(row || null));
} catch {
  process.stdout.write('null');
}
NODE
  )
}

wait_subscription_row() {
  local timeout="${1:-15}" start row
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    row="$(db_subscription_row "$JOINER_NODE")"
    if [ "$row" != "null" ] && [ -n "$row" ]; then
      printf '%s' "$row"
      return 0
    fi
    sleep 1
  done
  return 1
}

sparql_count() {
  printf '%s' "$1" | node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const bindings = j?.result?.bindings ?? j?.result?.results?.bindings ?? j?.results?.bindings ?? j?.bindings ?? [];
        const b = bindings[0] || {};
        const term = b.n ?? b.cnt ?? b.count;
        const raw = term && typeof term === "object" ? term.value : term;
        const match = String(raw ?? "").match(/-?\d+/);
        if (match) process.stdout.write(match[0]);
      } catch {}
    });
  '
}

# The query API returns an empty bindings array (rather than COUNT=0) when the
# caller has no local catalog entry for the requested private graph. For the
# pre-admission security checks, both forms mean "no readable local material".
count_is_absent() {
  [ -z "${1:-}" ] || [ "$1" = "0" ]
}

query_count() {
  local node="$1" graph_suffix="$2" pattern="$3" sub_graph="${4:-}" body response
  body="$(CG="$CG_ID" SUFFIX="$graph_suffix" PATTERN="$pattern" SUB="$sub_graph" node -e '
    const suffix = process.env.SUFFIX;
    const subGraph = process.env.SUB;
    const graphPattern = suffix === "_meta"
      ? `GRAPH <did:dkg:context-graph:${process.env.CG}/_meta> { ${process.env.PATTERN} }`
      : process.env.PATTERN;
    const out = {
      contextGraphId: process.env.CG,
      sparql: `SELECT (COUNT(*) AS ?n) WHERE { ${graphPattern} }`,
    };
    // `_meta` is not a memory-layer route. It is queried through the
    // query engine same-CG explicit-GRAPH allow-list; passing the unknown
    // suffix used to silently route this probe to the data graph and report
    // a false zero after an otherwise successful recovery.
    if (suffix !== "_meta") out.graphSuffix = suffix;
    if (subGraph) out.subGraphName = subGraph;
    process.stdout.write(JSON.stringify(out));
  ')"
  response="$(api_call "$node" POST /api/query "$body" 2>/dev/null || true)"
  sparql_count "$response"
}

root_count() {
  query_count "$1" _shared_memory '?s <http://schema.org/name> ?o'
}

subgraph_count() {
  query_count "$1" _shared_memory '?s <http://schema.org/name> ?o' "$SUB_GRAPH_NAME"
}

meta_count() {
  query_count "$1" _meta '?s ?p ?o'
}

private_policy_count() {
  query_count "$1" _meta \
    "<did:dkg:context-graph:$CG_ID> <https://dkg.network/ontology#accessPolicy> \"private\""
}

joiner_allowlist_count() {
  query_count "$1" _meta \
    "<did:dkg:context-graph:$CG_ID> <https://dkg.network/ontology#allowedAgent> \"$JOINER_AGENT\""
}

joiner_delegation_count() {
  local delegation_subject pattern
  if [ -z "$EXPECTED_DELEGATION_AGENT_LOWER" ] \
    || [ -z "$EXPECTED_DELEGATION_PEER" ] \
    || [ -z "$EXPECTED_DELEGATION_OP_KEY_LOWER" ] \
    || [ -z "$EXPECTED_DELEGATION_ISSUED_AT" ] \
    || [ -z "$EXPECTED_DELEGATION_EXPIRES_AT" ]; then
    printf '0'
    return 0
  fi
  delegation_subject="did:dkg:agent-delegation:$CG_ID:$EXPECTED_DELEGATION_AGENT_LOWER"
  pattern="<$delegation_subject> <https://dkg.network/ontology#delegationAgent> \"$EXPECTED_DELEGATION_AGENT_LOWER\" ;
    <https://dkg.network/ontology#delegationIssuedAt> \"$EXPECTED_DELEGATION_ISSUED_AT\" ;
    <https://dkg.network/ontology#delegationExpiresAt> \"$EXPECTED_DELEGATION_EXPIRES_AT\" ;
    <https://dkg.network/ontology#allowedDelegateePeer> \"$EXPECTED_DELEGATION_PEER\" ;
    <https://dkg.network/ontology#allowedDelegateeKey> \"$EXPECTED_DELEGATION_OP_KEY_LOWER\" ."
  query_count "$1" _meta "$pattern"
}

context_graph_exists() {
  local node="$1" response
  response="$(api_call "$node" GET "/api/context-graph/exists?id=$CG_ENCODED" 2>/dev/null || true)"
  json_get "$response" exists
}

catchup_status() {
  api_call "$JOINER_NODE" GET "/api/sync/catchup-status?contextGraphId=$CG_ENCODED" 2>/dev/null || true
}

poll_catchup_terminal() {
  local start status response last=""
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$CATCHUP_TIMEOUT_S" ]; do
    response="$(catchup_status)"
    status="$(json_get "$response" status)"
    if [ -n "$status" ] && [ "$status" != "$last" ]; then
      # The caller captures this function's stdout as the terminal JSON body.
      # Keep progress on stderr so it reaches the transcript without corrupting
      # that captured JSON value.
      log "catch-up status: $status" >&2
      last="$status"
    fi
    case "$status" in
      done|failed|denied|unreachable)
        printf '%s' "$response"
        return 0
        ;;
    esac
    sleep "$POLL_INTERVAL_S"
  done
  return 1
}

build_swm_payload() {
  local count="$1" label="$2" sub_graph="${3:-}"
  CG="$CG_ID" COUNT="$count" LABEL="$label" SUB="$sub_graph" RUN="$RUN_ID" node -e '
    const count = Number(process.env.COUNT);
    const quads = [];
    for (let i = 0; i < count; i++) {
      quads.push({
        subject: `urn:private-cg-recovery:${process.env.RUN}:${process.env.LABEL}:${i}`,
        predicate: "http://schema.org/name",
        object: `"private-cg-recovery-${process.env.LABEL}-${i}"`,
        graph: `did:dkg:context-graph:${process.env.CG}`,
      });
    }
    const out = { contextGraphId: process.env.CG, quads };
    if (process.env.SUB) out.subGraphName = process.env.SUB;
    process.stdout.write(JSON.stringify(out));
  '
}

subscription_flags_ready() {
  local row="$1"
  [ "$(json_get "$row" subscribed)" = "1" ] \
    && [ "$(json_get "$row" synced)" = "1" ] \
    && [ "$(json_get "$row" shared_memory_synced)" = "1" ] \
    && [ "$(json_get "$row" meta_synced)" = "1" ]
}

full_recovery_present() {
  local row root sub meta policy allowed delegation
  row="$(db_subscription_row "$JOINER_NODE")"
  subscription_flags_ready "$row" || return 1
  root="$(root_count "$JOINER_NODE")"
  sub="$(subgraph_count "$JOINER_NODE")"
  meta="$(meta_count "$JOINER_NODE")"
  policy="$(private_policy_count "$JOINER_NODE")"
  allowed="$(joiner_allowlist_count "$JOINER_NODE")"
  delegation="$(joiner_delegation_count "$JOINER_NODE")"
  [ "$root" = "$ROOT_TRIPLES" ] \
    && [ "$sub" = "$SUB_GRAPH_TRIPLES" ] \
    && [ -n "$meta" ] && [ "$meta" -gt 0 ] \
    && [ "$policy" = "1" ] \
    && [ "$allowed" = "1" ] \
    && [ "$delegation" -ge 1 ] 2>/dev/null
}

wait_full_recovery() {
  local timeout="$1" start
  start="$(date +%s)"
  while [ $(( $(date +%s) - start )) -lt "$timeout" ]; do
    if full_recovery_present; then return 0; fi
    sleep "$POLL_INTERVAL_S"
  done
  return 1
}

list_row() {
  local response
  response="$(api_call "$JOINER_NODE" GET /api/context-graph/list 2>/dev/null || true)"
  printf '%s' "$response" | CG="$CG_ID" node -e '
    let d = "";
    process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const row = (j.contextGraphs || []).find(x => x && x.id === process.env.CG);
        process.stdout.write(JSON.stringify(row || null));
      } catch { process.stdout.write("null"); }
    });
  '
}

assert_fixed_list_state() {
  local row
  row="$(list_row)"
  [ "$row" != "null" ] || fail "recovered CG is absent from node $JOINER_NODE /api/context-graph/list"
  [ "$(json_get "$row" callerInvolved)" = "true" ] \
    || fail "recovered CG does not report callerInvolved=true: $row"
  [ "$(json_get "$row" subscribed)" = "true" ] \
    || fail "recovered CG does not report subscribed=true: $row"
  [ "$(json_get "$row" synced)" = "true" ] \
    || fail "recovered CG does not report synced=true: $row"
}

snapshot_phase() {
  local phase="$1" row list subscriptions catchup root sub meta policy allowed delegation
  row="$(db_subscription_row "$JOINER_NODE" 2>/dev/null || printf 'null')"
  list="$(api_call "$JOINER_NODE" GET /api/context-graph/list 2>/dev/null || true)"
  subscriptions="$(api_call "$JOINER_NODE" GET /api/context-graph/subscriptions 2>/dev/null || true)"
  catchup="$(catchup_status)"
  root="$(root_count "$JOINER_NODE")"
  sub="$(subgraph_count "$JOINER_NODE")"
  meta="$(meta_count "$JOINER_NODE")"
  policy="$(private_policy_count "$JOINER_NODE")"
  allowed="$(joiner_allowlist_count "$JOINER_NODE")"
  delegation="$(joiner_delegation_count "$JOINER_NODE")"
  save_artifact "$phase-subscription-db.json" "$row"
  save_artifact "$phase-context-graph-list.json" "$list"
  save_artifact "$phase-subscriptions-api.json" "$subscriptions"
  save_artifact "$phase-catchup.json" "$catchup"
  save_artifact "$phase-counts.json" "$(ROOT="$root" SUB="$sub" META="$meta" POLICY="$policy" ALLOWED="$allowed" DELEGATION="$delegation" DELEGATION_AGENT="$EXPECTED_DELEGATION_AGENT_LOWER" DELEGATION_PEER="$EXPECTED_DELEGATION_PEER" DELEGATION_KEY="$EXPECTED_DELEGATION_OP_KEY_LOWER" DELEGATION_SCOPE="$EXPECTED_DELEGATION_SCOPE" DELEGATION_ISSUED="$EXPECTED_DELEGATION_ISSUED_AT" DELEGATION_EXPIRES="$EXPECTED_DELEGATION_EXPIRES_AT" node -e '
    process.stdout.write(JSON.stringify({
      rootSwm: process.env.ROOT || null,
      subgraphSwm: process.env.SUB || null,
      meta: process.env.META || null,
      privatePolicy: process.env.POLICY || null,
      joinerAllowed: process.env.ALLOWED || null,
      joinerDelegationTupleMatches: process.env.DELEGATION || null,
      expectedDelegation: {
        agentAddress: process.env.DELEGATION_AGENT || null,
        delegateePeerId: process.env.DELEGATION_PEER || null,
        delegateeOpKey: process.env.DELEGATION_KEY || null,
        scope: process.env.DELEGATION_SCOPE || null,
        issuedAtMs: process.env.DELEGATION_ISSUED || null,
        expiresAtMs: process.env.DELEGATION_EXPIRES || null,
      },
    }, null, 2));
  ')"
}

collect_filtered_logs() {
  [ -n "$CG_ID" ] || return 0
  local node log_path host cg_b64 since_b64
  for node in $(seq 1 "$NUM_NODES"); do
    if [ "$HARNESS_TARGET" = "testnet" ]; then
      host="$(testnet_node_ssh "$node")"
      cg_b64="$(printf '%s' "$CG_ID" | base64_one_line)"
      since_b64="$(printf '%s' "$TESTNET_JOURNAL_SINCE" | base64_one_line)"
      ssh "${TESTNET_SSH_OPTIONS[@]}" "$host" /bin/bash -s -- \
        "$TESTNET_SERVICE" "$cg_b64" "$since_b64" <<'REMOTE' 2>/dev/null \
        | sanitize_stream > "$RUN_DIR/node${node}-cg-filtered.log" || true
service="$1"
cg="$(printf '%s' "$2" | base64 -d)"
since="$(printf '%s' "$3" | base64 -d)"
journalctl -u "$service" --since "$since" --no-pager 2>/dev/null \
  | grep -F -- "$cg" | tail -n 500 || true
REMOTE
      continue
    fi
    log_path="$(node_log "$node")"
    [ -f "$log_path" ] || continue
    grep -F "$CG_ID" "$log_path" 2>/dev/null | tail -n 500 | sanitize_stream \
      > "$RUN_DIR/node${node}-cg-filtered.log" || true
  done
}

write_summary() {
  local exit_code="$1"
  TARGET="$HARNESS_TARGET" EXPECT="$HARNESS_EXPECT" ADMISSION="$ADMISSION_MODE" \
    PREFLIGHT_ONLY="$TESTNET_PREFLIGHT_ONLY" EXPECTED_COMMIT="$TESTNET_EXPECT_COMMIT" \
    EXIT_CODE="$exit_code" RUN_ID_ENV="$RUN_ID" \
    CG="$CG_ID" CURATOR="$CURATOR_NODE" JOINER="$JOINER_NODE" \
    AUTO_OBSERVED="$AUTO_APPROVAL_OBSERVED" AUTO_MEMBERS="$AUTO_MAX_MEMBERS" \
    AUTO_HOURLY="$AUTO_MAX_APPROVALS_PER_HOUR" \
    FAILURE="$FAIL_REASON" RECOVERED_BEFORE="$BROKEN_RECOVERED_BEFORE_RESTART" \
    RECOVERED_AFTER="$BROKEN_RECOVERED_AFTER_RESTART" node -e '
      process.stdout.write(JSON.stringify({
        runId: process.env.RUN_ID_ENV,
        target: process.env.TARGET,
        expectation: process.env.EXPECT,
        admissionMode: process.env.ADMISSION,
        preflightOnly: process.env.PREFLIGHT_ONLY === "1",
        expectedCommit: process.env.EXPECTED_COMMIT || null,
        exitCode: Number(process.env.EXIT_CODE),
        contextGraphId: process.env.CG || null,
        curatorNode: Number(process.env.CURATOR),
        joinerNode: Number(process.env.JOINER),
        failure: process.env.FAILURE || null,
        autoApproval: {
          enabled: process.env.ADMISSION === "auto",
          observed: process.env.AUTO_OBSERVED === "1",
          maxMembers: process.env.ADMISSION === "auto" ? Number(process.env.AUTO_MEMBERS) : null,
          maxApprovalsPerHour: process.env.ADMISSION === "auto" ? Number(process.env.AUTO_HOURLY) : null,
        },
        brokenModeRecovery: {
          beforeJoinerRestart: process.env.RECOVERED_BEFORE === "1",
          afterJoinerRestart: process.env.RECOVERED_AFTER === "1",
        },
      }, null, 2));
    ' | sanitize_stream > "$RUN_DIR/summary.json"
}

cleanup() {
  local exit_code=$?
  trap - EXIT
  set +e
  collect_filtered_logs

  if [ "$JOINER_STOPPED" -eq 1 ]; then
    warn "cleanup: restarting node $JOINER_NODE"
    restart_node "$JOINER_NODE" >/dev/null 2>&1
    wait_node_ready "$JOINER_NODE" 90 || warn "cleanup: node $JOINER_NODE did not become ready"
  fi
  if [ "$CURATOR_STOPPED" -eq 1 ]; then
    warn "cleanup: restarting node $CURATOR_NODE"
    restart_node "$CURATOR_NODE" >/dev/null 2>&1
    wait_node_ready "$CURATOR_NODE" 90 || warn "cleanup: node $CURATOR_NODE did not become ready"
  fi

  write_summary "$exit_code"
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    for node in $(seq 1 "$NUM_NODES"); do
      host="$(testnet_node_ssh "$node")"
      ssh "${TESTNET_SSH_OPTIONS[@]}" -O exit "$host" >/dev/null 2>&1 || true
    done
  fi
  log "artifacts: $RUN_DIR"
  exit "$exit_code"
}
trap cleanup EXIT

cd "$REPO_ROOT"

act "Preflight: $HARNESS_TARGET topology and release health"
for command in curl node base64; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done
if [ "$HARNESS_TARGET" = "devnet" ]; then
  [ -x "$DEVNET_SH" ] || fail "missing executable: $DEVNET_SH"
else
  command -v ssh >/dev/null 2>&1 || fail "required command not found: ssh"
fi

SEEN_TESTNET_PEERS=" "
for node in $(seq 1 "$NUM_NODES"); do
  if [ "$HARNESS_TARGET" = "devnet" ]; then
    [ -f "$(node_dir "$node")/auth.token" ] || fail "node $node auth token is missing under $DEVNET_DIR"
    [ -f "$(node_db "$node")" ] || fail "node $node database is missing: $(node_db "$node")"
  else
    host="$(testnet_node_ssh "$node")"
    [ -n "$host" ] || fail "TESTNET_NODE_${node}_SSH is required"
    [[ "$host" != -* ]] || fail "TESTNET_NODE_${node}_SSH must not begin with '-'"
  fi
  wait_node_ready "$node" 15 || fail "node $node is not API-ready"
  role="$(node_role "$node")"
  expected_role=core
  if [ "$HARNESS_TARGET" = "devnet" ] && [ "$node" -gt 4 ]; then
    expected_role=edge
  fi
  [ "$role" = "$expected_role" ] \
    || fail "node $node role is '$role', expected '$expected_role' for the deterministic topology"
  status="$(api_call "$node" GET /api/status)"
  save_artifact "preflight-node${node}-status.json" "$status"
  peer="$(json_get "$status" peerId)"
  [ -n "$peer" ] || fail "node $node status omitted peerId"
  if [ "$HARNESS_TARGET" = "testnet" ]; then
    [ "$(json_get "$status" networkConfig)" = "testnet" ] \
      || fail "node $node is not configured for testnet: $status"
    [ "$(json_get "$status" hasIdentity)" = "true" ] \
      || fail "node $node has no on-chain identity"
    status_commit="$(json_get "$status" commit)"
    commit_matches "$status_commit" "$TESTNET_EXPECT_COMMIT" \
      || fail "node $node API serves commit '${status_commit:-unknown}', expected $TESTNET_EXPECT_COMMIT"
    [ "$(json_get "$status" updateAvailable)" != "true" ] \
      || fail "node $node still reports an update available"
    latest_commit="$(json_get "$status" latestCommit)"
    if [ -n "$latest_commit" ] && [ "$latest_commit" != "null" ]; then
      commit_matches "$latest_commit" "$TESTNET_EXPECT_COMMIT" \
        || fail "node $node update channel points at $latest_commit, expected $TESTNET_EXPECT_COMMIT"
    fi
    probe="$(testnet_probe_node "$node")" || fail "could not probe testnet node $node over SSH"
    save_artifact "preflight-node${node}-host.json" "$probe"
    [ "$(json_get "$probe" serviceActive)" = "active" ] \
      || fail "node $node service is not active: $probe"
    [ "$(json_get "$probe" buildRunning)" = "false" ] \
      || fail "node $node is still building an auto-update: $probe"
    [ "$(json_get "$probe" restartAllowed)" = "true" ] \
      || fail "node $node SSH user lacks passwordless restart permission for $TESTNET_SERVICE"
    current_commit="$(json_get "$probe" currentCommit)"
    active_git="$(json_get "$probe" activeGit)"
    commit_matches "$current_commit" "$TESTNET_EXPECT_COMMIT" \
      || fail "node $node .current-commit is '${current_commit:-unknown}', expected $TESTNET_EXPECT_COMMIT"
    commit_matches "$active_git" "$TESTNET_EXPECT_COMMIT" \
      || fail "node $node active release is '${active_git:-unknown}', expected $TESTNET_EXPECT_COMMIT"
    accept_queue="$(json_get "$probe" acceptQueue)"
    [[ "$accept_queue" =~ ^[0-9]+$ ]] \
      || fail "node $node peer accept queue is unreadable: $probe"
    [ "$accept_queue" -le "$TESTNET_MAX_ACCEPT_QUEUE" ] \
      || fail "node $node peer accept queue is $accept_queue, above safe threshold $TESTNET_MAX_ACCEPT_QUEUE"
    case "$SEEN_TESTNET_PEERS" in
      *" $peer "*) fail "testnet nodes are not distinct; peer $peer appears more than once" ;;
    esac
    SEEN_TESTNET_PEERS="$SEEN_TESTNET_PEERS$peer "
    log "node $node ready (role=$role, commit=${status_commit:0:8}, queue=$accept_queue, peer=$peer)"
  else
    log "node $node ready (role=$role, peer=$peer)"
  fi
done

PACKAGE_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"
{
  echo "gitCommit=$(git rev-parse HEAD 2>/dev/null || true)"
  echo "gitDescribe=$(git describe --tags --always --dirty 2>/dev/null || true)"
  echo "packageVersion=$PACKAGE_VERSION"
  echo "harnessTarget=$HARNESS_TARGET"
  echo "testnetExpectedCommit=$TESTNET_EXPECT_COMMIT"
  echo "devnetDir=$DEVNET_DIR"
  echo "apiPortBase=$API_PORT_BASE"
  echo "admissionMode=$ADMISSION_MODE"
  echo "autoMaxMembers=$AUTO_MAX_MEMBERS"
  echo "autoMaxApprovalsPerHour=$AUTO_MAX_APPROVALS_PER_HOUR"
} > "$RUN_DIR/runtime.txt"

if [ "$HARNESS_TARGET" = "testnet" ] && [ "$TESTNET_PREFLIGHT_ONLY" = "1" ]; then
  log "PASS (testnet preflight only): all four nodes are healthy on $TESTNET_EXPECT_COMMIT; no state was changed."
  exit 0
fi

CURATOR_IDENTITY="$(api_call "$CURATOR_NODE" GET /api/agent/identity)"
JOINER_IDENTITY="$(api_call "$JOINER_NODE" GET /api/agent/identity)"
CURATOR_AGENT="$(json_get "$CURATOR_IDENTITY" agentAddress)"
CURATOR_PEER="$(json_get "$CURATOR_IDENTITY" peerId)"
JOINER_AGENT="$(json_get "$JOINER_IDENTITY" agentAddress)"
JOINER_PEER="$(json_get "$JOINER_IDENTITY" peerId)"
[ -n "$CURATOR_AGENT" ] && [ -n "$CURATOR_PEER" ] \
  || fail "could not resolve node $CURATOR_NODE curator identity"
[ -n "$JOINER_AGENT" ] && [ -n "$JOINER_PEER" ] \
  || fail "could not resolve node $JOINER_NODE joiner identity"
save_artifact "curator-identity.json" "$CURATOR_IDENTITY"
save_artifact "joiner-identity.json" "$JOINER_IDENTITY"
log "curator: node $CURATOR_NODE agent=$CURATOR_AGENT peer=$CURATOR_PEER"
log "joiner:  node $JOINER_NODE agent=$JOINER_AGENT peer=$JOINER_PEER"

STAMP="$(date -u +%s)"
CG_ID="${CURATOR_AGENT}/private-cg-recovery-${STAMP}-$$"
CG_ENCODED="$(urlencode "$CG_ID")"

act "Create a curated CG with only the curator allowlisted"
CREATE_BODY="$(CG="$CG_ID" CURATOR="$CURATOR_AGENT" RUN="$RUN_ID" node -e '
  process.stdout.write(JSON.stringify({
    id: process.env.CG,
    name: `private-cg-recovery ${process.env.RUN}`,
    description: "Private CG membership recovery harness",
    accessPolicy: 1,
    publishPolicy: 0,
    allowedAgents: [process.env.CURATOR],
    register: true,
  }));
')"
CREATE_RESPONSE="$(api_call "$CURATOR_NODE" POST /api/context-graph/create "$CREATE_BODY")"
ON_CHAIN_ID="$(json_get "$CREATE_RESPONSE" onChainId)"
[ -n "$ON_CHAIN_ID" ] && [ "$ON_CHAIN_ID" != "null" ] \
  || fail "curated CG create/register failed: $CREATE_RESPONSE"
save_artifact "create-response.json" "$CREATE_RESPONSE"
log "created $CG_ID (onChainId=$ON_CHAIN_ID)"

if [ "$ADMISSION_MODE" = "auto" ]; then
  act "Enable bounded open enrollment before the curator restart"
  OPEN_POLICY_BODY="$(MODE=open MAX_MEMBERS="$AUTO_MAX_MEMBERS" MAX_HOURLY="$AUTO_MAX_APPROVALS_PER_HOUR" node -e '
    process.stdout.write(JSON.stringify({
      mode: process.env.MODE,
      maxMembers: Number(process.env.MAX_MEMBERS),
      maxApprovalsPerHour: Number(process.env.MAX_HOURLY),
      acknowledgeOpenEnrollment: true,
    }));
  ')"
  OPEN_POLICY_RESPONSE="$(api_call "$CURATOR_NODE" PUT "/api/context-graph/$CG_ENCODED/join-policy" "$OPEN_POLICY_BODY" 2>/dev/null || true)"
  save_artifact "join-policy-enable-response.json" "$OPEN_POLICY_RESPONSE"
  assert_open_join_policy "$OPEN_POLICY_RESPONSE" "open-enrollment enable response"

  OPEN_POLICY_STATUS="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-policy" 2>/dev/null || true)"
  save_artifact "join-policy-before-curator-restart.json" "$OPEN_POLICY_STATUS"
  assert_open_join_policy "$OPEN_POLICY_STATUS" "open-enrollment status before curator restart"
  log "open enrollment enabled: maxMembers=$AUTO_MAX_MEMBERS maxApprovalsPerHour=$AUTO_MAX_APPROVALS_PER_HOUR"
fi

SUBGRAPH_RESPONSE="$(api_call "$CURATOR_NODE" POST /api/sub-graph/create \
  "$(CG="$CG_ID" SUB="$SUB_GRAPH_NAME" node -e 'process.stdout.write(JSON.stringify({contextGraphId:process.env.CG,subGraphName:process.env.SUB}))')")"
[ "$(json_get "$SUBGRAPH_RESPONSE" created)" = "$SUB_GRAPH_NAME" ] \
  || fail "sub-graph create failed: $SUBGRAPH_RESPONSE"
save_artifact "subgraph-create-response.json" "$SUBGRAPH_RESPONSE"

act "Seed and verify $ROOT_TRIPLES root + $SUB_GRAPH_TRIPLES sub-graph SWM triples"
ROOT_WRITE="$(devnet_create_shared_ka "$CURATOR_NODE" \
  "$(build_swm_payload "$ROOT_TRIPLES" root)" private-cg-recovery-root)"
[ "$(json_get "$ROOT_WRITE" triplesWritten)" = "$ROOT_TRIPLES" ] \
  || fail "root SWM write failed: $ROOT_WRITE"
SUB_WRITE="$(devnet_create_shared_ka "$CURATOR_NODE" \
  "$(build_swm_payload "$SUB_GRAPH_TRIPLES" sub "$SUB_GRAPH_NAME")" private-cg-recovery-sub)"
[ "$(json_get "$SUB_WRITE" triplesWritten)" = "$SUB_GRAPH_TRIPLES" ] \
  || fail "sub-graph SWM write failed: $SUB_WRITE"
save_artifact "root-write-summary.json" "$ROOT_WRITE"
save_artifact "subgraph-write-summary.json" "$SUB_WRITE"

CURATOR_ROOT="$(root_count "$CURATOR_NODE")"
CURATOR_SUB="$(subgraph_count "$CURATOR_NODE")"
[ "$CURATOR_ROOT" = "$ROOT_TRIPLES" ] \
  || fail "curator root SWM count is '$CURATOR_ROOT', expected $ROOT_TRIPLES"
[ "$CURATOR_SUB" = "$SUB_GRAPH_TRIPLES" ] \
  || fail "curator sub-graph SWM count is '$CURATOR_SUB', expected $SUB_GRAPH_TRIPLES"
log "curator fixture verified: root=$CURATOR_ROOT subgraph=$CURATOR_SUB"

act "Prove unrelated nodes ($UNRELATED_NODES) and joiner $JOINER_NODE do not already hold the private CG"
for node in $UNRELATED_NODES "$JOINER_NODE"; do
  exists="$(context_graph_exists "$node")"
  root="$(root_count "$node")"
  sub="$(subgraph_count "$node")"
  meta="$(meta_count "$node")"
  [ "$exists" = "false" ] \
    || fail "node $node already reports contextGraphExists=$exists for the private CG; empty-peer precondition is invalid"
  if ! count_is_absent "$root" || ! count_is_absent "$sub" || ! count_is_absent "$meta"; then
    fail "node $node already has private-CG material (root=${root:-unreadable} sub=${sub:-unreadable} meta=${meta:-unreadable})"
  fi
  log "node $node is unrelated: exists=false root=0 subgraph=0 meta=0"
done

act "Stop curator node $CURATOR_NODE"
CURATOR_STOPPED=1
stop_node "$CURATOR_NODE"
wait_node_down "$CURATOR_NODE" 45 \
  || fail "curator node $CURATOR_NODE did not become unreachable"
log "curator is offline; unrelated core peers remain online"

act "Joiner subscribes before admission while curator is offline"
SUBSCRIBE_RESPONSE="$(api_call "$JOINER_NODE" POST /api/context-graph/subscribe \
  "$(CG="$CG_ID" node -e 'process.stdout.write(JSON.stringify({contextGraphId:process.env.CG,includeSharedMemory:true}))')")"
[ "$(json_get "$SUBSCRIBE_RESPONSE" subscribed)" = "$CG_ID" ] \
  || fail "joiner subscribe failed: $SUBSCRIBE_RESPONSE"
save_artifact "pre-admission-subscribe-response.json" "$SUBSCRIBE_RESPONSE"

CATCHUP_RESPONSE="$(poll_catchup_terminal)" \
  || fail "pre-admission catch-up did not reach a terminal state within ${CATCHUP_TIMEOUT_S}s"
save_artifact "pre-admission-catchup-terminal.json" "$CATCHUP_RESPONSE"
CATCHUP_STATE="$(json_get "$CATCHUP_RESPONSE" status)"
EMPTY_RESPONSES="$(json_empty_response_count "$CATCHUP_RESPONSE")"
INSERTED_TRIPLES="$(json_inserted_triple_count "$CATCHUP_RESPONSE")"
RESULT_DATA_SYNCED="$(json_get "$CATCHUP_RESPONSE" result.dataSynced)"
RESULT_SWM_SYNCED="$(json_get "$CATCHUP_RESPONSE" result.sharedMemorySynced)"
SYNC_CAPABLE_PEERS="$(json_get "$CATCHUP_RESPONSE" result.syncCapablePeers)"
PEERS_RESPONDED="$(json_get "$CATCHUP_RESPONSE" result.peersResponded)"
DURABLE_EMPTY_PEERS="$(json_get "$CATCHUP_RESPONSE" result.cleanPlaneCompletions.durable.emptyPeers)"
SHARED_MEMORY_EMPTY_PEERS="$(json_get "$CATCHUP_RESPONSE" result.cleanPlaneCompletions.sharedMemory.emptyPeers)"
[ -n "$PEERS_RESPONDED" ] && [ "$PEERS_RESPONDED" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
  || fail "catch-up received replies from only ${PEERS_RESPONDED:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
[ -n "$DURABLE_EMPTY_PEERS" ] && [ "$DURABLE_EMPTY_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
  || fail "durable catch-up completed empty with only ${DURABLE_EMPTY_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
if [ "$HARNESS_EXPECT" = "broken" ]; then
  [ -n "$SHARED_MEMORY_EMPTY_PEERS" ] && [ "$SHARED_MEMORY_EMPTY_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
    || fail "shared-memory catch-up completed empty with only ${SHARED_MEMORY_EMPTY_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
else
  # A fixed node may fail closed as soon as durable sync proves that no peer
  # has authoritative metadata. In that stricter path shared-memory sync has
  # no authorized graph plan to execute, so zero shared-memory responses is
  # expected. Older fixed builds may still complete the plane against all four
  # unrelated peers; reject only a partial plane completion.
  [ "$SHARED_MEMORY_EMPTY_PEERS" = "0" ] \
    || { [ -n "$SHARED_MEMORY_EMPTY_PEERS" ] && [ "$SHARED_MEMORY_EMPTY_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null; } \
    || fail "shared-memory catch-up partially completed with ${SHARED_MEMORY_EMPTY_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS unrelated peers: $CATCHUP_RESPONSE"
fi
[ -n "$SYNC_CAPABLE_PEERS" ] && [ "$SYNC_CAPABLE_PEERS" -ge "$EXPECTED_UNRELATED_RESPONDERS" ] 2>/dev/null \
  || fail "catch-up reached only ${SYNC_CAPABLE_PEERS:-0}/$EXPECTED_UNRELATED_RESPONDERS sync-capable unrelated peers: $CATCHUP_RESPONSE"
[ "$INSERTED_TRIPLES" = "0" ] \
  && [ "$RESULT_DATA_SYNCED" = "0" ] \
  && [ "$RESULT_SWM_SYNCED" = "0" ] \
  || fail "pre-admission catch-up unexpectedly inserted private-CG material: $CATCHUP_RESPONSE"

SUB_ROW="$(wait_subscription_row 20)" \
  || fail "joiner subscription row was not persisted"
ROOT_BEFORE="$(root_count "$JOINER_NODE")"
SUB_BEFORE="$(subgraph_count "$JOINER_NODE")"
META_BEFORE="$(meta_count "$JOINER_NODE")"
if ! count_is_absent "$ROOT_BEFORE" || ! count_is_absent "$SUB_BEFORE" || ! count_is_absent "$META_BEFORE"; then
  fail "pre-admission joiner unexpectedly holds CG material (root=${ROOT_BEFORE:-unreadable} sub=${SUB_BEFORE:-unreadable} meta=${META_BEFORE:-unreadable})"
fi

SUBSCRIBED_FLAG="$(json_get "$SUB_ROW" subscribed)"
SYNCED_FLAG="$(json_get "$SUB_ROW" synced)"
SHARED_FLAG="$(json_get "$SUB_ROW" shared_memory_synced)"
META_FLAG="$(json_get "$SUB_ROW" meta_synced)"
[ "$SUBSCRIBED_FLAG" = "1" ] || fail "subscription row is not active: $SUB_ROW"

if [ "$HARNESS_EXPECT" = "broken" ]; then
  [ "$CATCHUP_STATE" = "done" ] \
    || fail "broken oracle expected catch-up status=done, got '$CATCHUP_STATE'"
  [ "$SYNCED_FLAG" = "1" ] && [ "$SHARED_FLAG" = "1" ] && [ "$META_FLAG" != "1" ] \
    || fail "broken oracle not observed; expected synced=1 shared_memory_synced=1 meta_synced!=1, got $SUB_ROW"
  log "RED ORACLE OBSERVED: status=done syncCapablePeers=$SYNC_CAPABLE_PEERS emptyResponses=$EMPTY_RESPONSES synced=1 shared=1 meta=${META_FLAG:-null}, with no metadata or data"
else
  [ "$SYNCED_FLAG" != "1" ] && [ "$SHARED_FLAG" != "1" ] && [ "$META_FLAG" != "1" ] \
    || fail "fixed oracle violated: pre-admission state claims readiness: $SUB_ROW"
  log "GREEN PRECONDITION: syncCapablePeers=$SYNC_CAPABLE_PEERS emptyResponses=$EMPTY_RESPONSES but subscription remains pending/not-ready"
fi
snapshot_phase pre-admission

act "Restart curator and deliver a signed admission request"
restart_node "$CURATOR_NODE"
wait_node_ready "$CURATOR_NODE" 90 \
  || fail "curator node $CURATOR_NODE did not become ready after restart"
CURATOR_STOPPED=0

if [ "$ADMISSION_MODE" = "auto" ]; then
  OPEN_POLICY_AFTER_RESTART="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-policy" 2>/dev/null || true)"
  save_artifact "join-policy-after-curator-restart.json" "$OPEN_POLICY_AFTER_RESTART"
  assert_open_join_policy "$OPEN_POLICY_AFTER_RESTART" "open-enrollment status after curator restart"
  log "persisted open-enrollment policy survived the curator restart"
fi

SIGN_RESPONSE="$(api_call "$JOINER_NODE" POST "/api/context-graph/$CG_ENCODED/sign-join" '{}')"
[ "$(json_get "$SIGN_RESPONSE" ok)" = "true" ] \
  || fail "sign-join failed: $(json_get "$SIGN_RESPONSE" error)"
DELEGATION="$(json_get "$SIGN_RESPONSE" delegation)"
[ -n "$DELEGATION" ] && [ "$DELEGATION" != "null" ] \
  || fail "sign-join returned no delegation"
EXPECTED_DELEGATION_AGENT="$(json_get "$DELEGATION" agentAddress)"
EXPECTED_DELEGATION_PEER="$(json_get "$DELEGATION" delegateePeerId)"
EXPECTED_DELEGATION_OP_KEY="$(json_get "$DELEGATION" delegateeOpKey)"
EXPECTED_DELEGATION_SCOPE="$(json_get "$DELEGATION" scope)"
EXPECTED_DELEGATION_ISSUED_AT="$(json_get "$DELEGATION" issuedAtMs)"
EXPECTED_DELEGATION_EXPIRES_AT="$(json_get "$DELEGATION" expiresAtMs)"
EXPECTED_DELEGATION_AGENT_LOWER="$(printf '%s' "$EXPECTED_DELEGATION_AGENT" | tr '[:upper:]' '[:lower:]')"
EXPECTED_DELEGATION_OP_KEY_LOWER="$(printf '%s' "$EXPECTED_DELEGATION_OP_KEY" | tr '[:upper:]' '[:lower:]')"
JOINER_AGENT_LOWER="$(printf '%s' "$JOINER_AGENT" | tr '[:upper:]' '[:lower:]')"
[ "$EXPECTED_DELEGATION_AGENT_LOWER" = "$JOINER_AGENT_LOWER" ] \
  || fail "signed delegation agent does not match the joining member: $DELEGATION"
[ "$EXPECTED_DELEGATION_PEER" = "$JOINER_PEER" ] \
  || fail "signed delegation peer does not match the joining node: $DELEGATION"
[[ "$EXPECTED_DELEGATION_OP_KEY_LOWER" =~ ^0x[[:xdigit:]]{40}$ ]] \
  || fail "signed delegation has no valid operational delegatee key: $DELEGATION"
[ "$(SCOPE="$EXPECTED_DELEGATION_SCOPE" CG="$CG_ID" node -e '
  const scope = process.env.SCOPE || "";
  const cg = process.env.CG || "";
  process.stdout.write(scope.startsWith("sync:deployment=") && scope.endsWith(`:${cg}`) ? "1" : "0");
')" = "1" ] || fail "signed delegation scope is not bound to this deployment and context graph: $DELEGATION"
[[ "$EXPECTED_DELEGATION_ISSUED_AT" =~ ^[0-9]+$ ]] \
  && [[ "$EXPECTED_DELEGATION_EXPIRES_AT" =~ ^[0-9]+$ ]] \
  && [ "$EXPECTED_DELEGATION_EXPIRES_AT" -gt "$EXPECTED_DELEGATION_ISSUED_AT" ] \
  && [ "$EXPECTED_DELEGATION_EXPIRES_AT" -gt "$(node -e 'process.stdout.write(String(Date.now()))')" ] \
  || fail "signed delegation has an invalid or expired validity window: $DELEGATION"

REQUEST_BODY="$(DELEGATION="$DELEGATION" CURATOR_PEER_ENV="$CURATOR_PEER" node -e '
  process.stdout.write(JSON.stringify({
    delegation: JSON.parse(process.env.DELEGATION),
    curatorPeerId: process.env.CURATOR_PEER_ENV,
    agentName: "private-cg-recovery-harness",
  }));
')"

REQUEST_RESPONSE=""
REQUEST_STATUS=""
REQUEST_START="$(date +%s)"
while [ $(( $(date +%s) - REQUEST_START )) -lt "$JOIN_DELIVERY_TIMEOUT_S" ]; do
  REQUEST_RESPONSE="$(api_call "$JOINER_NODE" POST "/api/context-graph/$CG_ENCODED/request-join" "$REQUEST_BODY" 2>/dev/null || true)"
  REQUEST_STATUS="$(json_get "$REQUEST_RESPONSE" status)"
  case "$REQUEST_STATUS" in
    approved|already-member) break ;;
    pending)
      # Manual admission is expected to stop at pending. Open enrollment can
      # transiently return pending after a curator restart until the joiner's
      # active encryption key has propagated again, so keep retrying the same
      # signed request within the bounded delivery window.
      [ "$ADMISSION_MODE" = "manual" ] && break
      ;;
  esac
  sleep 3
done
save_artifact "join-request-response.json" "$REQUEST_RESPONSE"

if [ "$ADMISSION_MODE" = "manual" ]; then
  [ "$REQUEST_STATUS" = "pending" ] \
    || fail "join request was not delivered as pending within ${JOIN_DELIVERY_TIMEOUT_S}s: $REQUEST_RESPONSE"

  PENDING_FOUND=0
  PENDING_RESPONSE=""
  PENDING_START="$(date +%s)"
  while [ $(( $(date +%s) - PENDING_START )) -lt "$JOIN_DELIVERY_TIMEOUT_S" ]; do
    PENDING_RESPONSE="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-requests" 2>/dev/null || true)"
    PENDING_FOUND="$(join_request_present "$PENDING_RESPONSE" "$JOINER_AGENT")"
    [ "$PENDING_FOUND" = "1" ] && break
    sleep 2
  done
  save_artifact "curator-pending-join-requests.json" "$PENDING_RESPONSE"
  [ "$PENDING_FOUND" = "1" ] \
    || fail "curator never exposed the joiner's pending request"

  APPROVE_RESPONSE="$(api_call "$CURATOR_NODE" POST "/api/context-graph/$CG_ENCODED/approve-join" \
    "$(AGENT="$JOINER_AGENT" node -e 'process.stdout.write(JSON.stringify({agentAddress:process.env.AGENT}))')")"
  save_artifact "approve-response.json" "$APPROVE_RESPONSE"
  [ "$(json_get "$APPROVE_RESPONSE" status)" = "approved" ] \
    || fail "approve-join failed: $APPROVE_RESPONSE"
  log "curator manually approved $JOINER_AGENT"
else
  [ "$REQUEST_STATUS" = "approved" ] \
    || fail "open enrollment did not automatically approve the join request: $REQUEST_RESPONSE"
  [ "$(json_get "$REQUEST_RESPONSE" autoApproved)" = "true" ] \
    || fail "approved join response did not identify automatic approval: $REQUEST_RESPONSE"
  [ "$(json_get "$REQUEST_RESPONSE" alreadyMember)" = "true" ] \
    || fail "automatic approval response omitted the rolling-upgrade alreadyMember alias: $REQUEST_RESPONSE"
  AUTO_APPROVAL_OBSERVED=1

  PENDING_RESPONSE="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-requests" 2>/dev/null || true)"
  save_artifact "curator-join-requests-after-auto-approval.json" "$PENDING_RESPONSE"
  PENDING_FOUND="$(join_request_present "$PENDING_RESPONSE" "$JOINER_AGENT")"
  [ "$PENDING_FOUND" != "invalid" ] \
    || fail "curator join-request list was unreadable after automatic approval: $PENDING_RESPONSE"
  [ "$PENDING_FOUND" = "0" ] \
    || fail "automatically approved joiner remained in the pending-request list: $PENDING_RESPONSE"

  OPEN_POLICY_AFTER_APPROVAL="$(api_call "$CURATOR_NODE" GET "/api/context-graph/$CG_ENCODED/join-policy" 2>/dev/null || true)"
  save_artifact "join-policy-after-auto-approval.json" "$OPEN_POLICY_AFTER_APPROVAL"
  assert_open_join_policy "$OPEN_POLICY_AFTER_APPROVAL" "open-enrollment status after automatic approval"
  AUTO_APPROVALS_LAST_HOUR="$(json_get "$OPEN_POLICY_AFTER_APPROVAL" approvalsLastHour)"
  AUTO_MEMBER_COUNT="$(json_get "$OPEN_POLICY_AFTER_APPROVAL" memberCount)"
  [ -n "$AUTO_APPROVALS_LAST_HOUR" ] && [ "$AUTO_APPROVALS_LAST_HOUR" -ge 1 ] 2>/dev/null \
    || fail "automatic approval was not reflected in policy usage: $OPEN_POLICY_AFTER_APPROVAL"
  [ "$AUTO_MEMBER_COUNT" = "2" ] \
    || fail "automatic approval did not produce the expected curator + joiner membership: $OPEN_POLICY_AFTER_APPROVAL"
  log "curator automatically approved $JOINER_AGENT; no manual approve-join call was made"
fi

act "Measure post-approval metadata/data recovery"
if [ "$HARNESS_EXPECT" = "fixed" ]; then
  wait_full_recovery "$RECOVERY_TIMEOUT_S" \
    || { snapshot_phase post-approval-timeout; fail "fixed build did not recover metadata + exact SWM fixtures within ${RECOVERY_TIMEOUT_S}s"; }
  assert_fixed_list_state
  log "recovered: metadata private+allowlisted+delegated, root=$ROOT_TRIPLES, subgraph=$SUB_GRAPH_TRIPLES"
else
  if wait_full_recovery "$BROKEN_RECOVERY_OBSERVE_S"; then
    BROKEN_RECOVERED_BEFORE_RESTART=1
    log "v10.0.6 red invariant was observed, but approval subsequently healed the node"
  else
    log "v10.0.6 remains wedged after approval (recorded as part of the red witness)"
  fi
fi
snapshot_phase post-approval

act "Restart joiner node $JOINER_NODE and recheck durable state"
JOINER_STOPPED=1
restart_node "$JOINER_NODE"
wait_node_ready "$JOINER_NODE" 90 \
  || fail "joiner node $JOINER_NODE did not become ready after restart"
JOINER_STOPPED=0

if [ "$HARNESS_EXPECT" = "fixed" ]; then
  wait_full_recovery "$POST_RESTART_TIMEOUT_S" \
    || { snapshot_phase post-restart-timeout; fail "fixed state did not survive/recover after joiner restart"; }
  assert_fixed_list_state
  log "restart persistence verified"
else
  if wait_full_recovery "$BROKEN_POST_RESTART_OBSERVE_S"; then
    BROKEN_RECOVERED_AFTER_RESTART=1
    log "restart/post-approval reconciliation eventually healed the node; the earlier false-ready red oracle remains proven"
  else
    row_after="$(db_subscription_row "$JOINER_NODE")"
    root_after="$(root_count "$JOINER_NODE")"
    sub_after="$(subgraph_count "$JOINER_NODE")"
    meta_after="$(meta_count "$JOINER_NODE")"
    log "wedge persisted after restart: row=$row_after root=${root_after:-unreadable} sub=${sub_after:-unreadable} meta=${meta_after:-unreadable}"
  fi
fi
snapshot_phase post-restart

echo
if [ "$HARNESS_EXPECT" = "broken" ]; then
  log "PASS (broken oracle, $ADMISSION_MODE approval): the build claimed a private CG was synced without authoritative metadata or data."
else
  log "PASS (fixed oracle, $ADMISSION_MODE approval): empty unrelated responses never claimed readiness; admission recovery survived restart."
fi
log "CG: $CG_ID"
log "artifacts: $RUN_DIR"
