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

# JSON: field <json> <dot.path> -> value ("" if missing; objects/arrays JSON'd) -
field() { J="$2" node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{let j;try{j=JSON.parse(d)}catch(e){process.stdout.write("");return}let v=j;for(const k of process.env.J.split("."))v=(v==null?undefined:v[k]);process.stdout.write(v==null?"":(typeof v==="object"?JSON.stringify(v):String(v)))})' <<<"$1"; }

# Protocol constants ---------------------------------------------------------
# Resolve a string constant from the canonical core source. Callers may set
# CORE_CONSTANTS_TS explicitly; otherwise resolve it relative to this library.
protocol_const() {
  local const_name="$1" constants_file="${CORE_CONSTANTS_TS:-}" lib_dir
  if [[ -z "$constants_file" ]]; then
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    constants_file="$lib_dir/../packages/core/src/constants.ts"
  fi
  sed -nE "s|^export const ${const_name} = '([^']+)';$|\1|p" "$constants_file" 2>/dev/null | head -n 1
}
