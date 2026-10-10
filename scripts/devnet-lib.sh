#!/usr/bin/env bash
#
# devnet-lib.sh — shared helpers for the devnet proof/soak scripts. SOURCE this
# (`. "$REPO_ROOT/scripts/devnet-lib.sh"`), do not execute it.
#
# Centralizes the node auth / HTTP / JSON-extraction helpers that were copied
# (and drifting) across devnet-test-*.sh and devnet-soak.sh. Result accounting
# (ok/bad/log and the PASS/FAIL counters) is deliberately left in each script:
# the prefixes differ and devnet-soak.sh uses a timestamped tee-to-logfile log().
#
# Contract — the sourcing script must export/set before use:
#   DEVNET_DIR        path to the devnet home (.devnet)
#   API_PORT_BASE     base API port (node N → API_PORT_BASE + N - 1)
# Optional:
#   DKG_API_MAXTIME   curl --max-time for api() (seconds, default 120)
#
# bash 3.2 compatible. No side effects on source (only function definitions).

# node auth + addressing -----------------------------------------------------
node_token() { grep -v '^#' "$DEVNET_DIR/node$1/auth.token" 2>/dev/null | tr -d '[:space:]'; }
node_port()  { echo $((API_PORT_BASE + $1 - 1)); }

# HTTP: api <node> <METHOD> <path> [body] -> stdout "<httpcode>\n<body>" --------
api() {
  local n="$1" m="$2" p="$3" b="${4:-}" port token tmp code
  port=$(node_port "$n"); token=$(node_token "$n"); tmp="$(mktemp "${TMPDIR:-/tmp}/dkg-api-XXXXXX")"
  local -a a=(-sS --max-time "${DKG_API_MAXTIME:-120}" --connect-timeout 5 -o "$tmp" -w '%{http_code}' -X "$m"
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  [ -n "$b" ] && a+=(--data "$b")
  code=$(curl "${a[@]}" "http://127.0.0.1:${port}${p}" 2>/dev/null || echo 000)
  printf '%s\n' "$code"; cat "$tmp" 2>/dev/null; rm -f "$tmp"
}
code_of() { printf '%s' "$1" | head -1; }
body_of() { printf '%s' "$1" | tail -n +2; }
# node_up <node> -> exit 0 when the node's daemon answers /api/status with HTTP 200.
node_up() { [ "$(code_of "$(api "$1" GET /api/status)")" = "200" ]; }

# JSON: field <json> <dot.path> -> value ("" if missing; objects/arrays JSON'd) -
field() { J="$2" node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{let j;try{j=JSON.parse(d)}catch(e){process.stdout.write("");return}let v=j;for(const k of process.env.J.split("."))v=(v==null?undefined:v[k]);process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))})' <<<"$1"; }

# Protocol constants ---------------------------------------------------------
# Resolve a string constant through the built core package API. This is a real
# module/export boundary: harmless TypeScript formatting changes cannot break
# devnet scripts that consume canonical wire identifiers.
protocol_const() {
  local const_name="$1" lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$lib_dir/lib/core-constant.mjs" "$const_name"
}


# After a positively owned store has been paused, verify cached ordinary status
# and the explicit reachability probe. Caller supplies status_body(), say(), fail().
check_paused_store_status() {
  local plain_started paused_status plain_elapsed last_ready_count next_paused_status
  local paused_probe paused_reachability
  plain_started="$(date +%s)"
  paused_status="$(status_body '/api/status')"
  plain_elapsed="$(( $(date +%s) - plain_started ))"
  [ "$plain_elapsed" -lt 5 ] || fail "ordinary /api/status blocked for ${plain_elapsed}s on the paused store"
  [ "$(field "$paused_status" storeQuadsStatus)" = "ready" ] || fail "ordinary status lost its cached count while the store was paused: $paused_status"
  # A refresh may finish after the healthy read but before SIGSTOP. The last
  # ready answer after the pause is the baseline for subsequent outage reads.
  last_ready_count="$(field "$paused_status" storeQuads)"
  [ -n "$last_ready_count" ] || fail "ordinary status lost its ready count: $paused_status"
  plain_started="$(date +%s)"
  next_paused_status="$(status_body '/api/status')"
  plain_elapsed="$(( $(date +%s) - plain_started ))"
  [ "$plain_elapsed" -lt 5 ] || fail "second ordinary /api/status blocked for ${plain_elapsed}s on the paused store"
  [ "$(field "$next_paused_status" storeQuadsStatus)" = "ready" ] || fail "ordinary status lost its cached count: $next_paused_status"
  [ "$(field "$next_paused_status" storeQuads)" = "$last_ready_count" ] || fail "ordinary status changed the last ready count during the outage: $next_paused_status"
  [ -z "$(field "$paused_status" storeReachability)" ] || fail "ordinary status unexpectedly probed the paused store: $paused_status"
  [ -z "$(field "$next_paused_status" storeReachability)" ] || fail "second ordinary status unexpectedly probed the paused store: $next_paused_status"
  paused_probe="$(status_body '/api/status?probeStore=true')"
  paused_reachability="$(field "$paused_probe" storeReachability)"
  case "$paused_reachability" in
    no-answer|unreachable) : ;;
    *) fail "explicit status probe did not report the paused store as unavailable: $paused_probe" ;;
  esac
  say "OK: ordinary status stayed responsive with its cached count; explicit probe reported ${paused_reachability}"
}
