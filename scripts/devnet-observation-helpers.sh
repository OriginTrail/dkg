#!/usr/bin/env bash
# Bash 3.2. New helper results: PASS/0, FAIL/1, INCONCLUSIVE/2.
# The capture always writes a frame; it never substitutes a transport failure
# with a successful body. Consumers MUST check the parser's status explicitly.
devnet_capture() {
  local tmp http ec
  tmp=$(mktemp "${TMPDIR:-/tmp}/dkg-observation.XXXXXX") || return 2
  if http=$(curl -sS --max-time "${DKG_OBSERVATION_MAXTIME:-30}" --connect-timeout 5 -o "$tmp" -w '%{http_code}' "$@"); then ec=0; else ec=$?; fi
  printf '%s\n%s\n' "$ec" "$http"
  cat "$tmp"
  rm -f "$tmp"
}

devnet_observe() {
  local helper_dir
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  node "$helper_dir/lib/qa/query-observation-cli.mjs" "$@"
}

# Explicit legacy suite adapter: existing scripts expose exit 1 for any failed
# test. The helper's exit 2 denotes invalid evidence, not a product failure.
devnet_observation_abort() {
  echo '  [INCONCLUSIVE] Invalid query observation; legacy suite exits 1' >&2
  exit 1
}

devnet_count_at_least() {
  node -e 'const [a,b]=process.argv.slice(1); if (!/^[0-9]+$/.test(a) || !/^[0-9]+$/.test(b)) process.exit(2); process.exit(BigInt(a)>=BigInt(b)?0:1)' "$1" "$2"
}

# One API query as a capture frame: base URL, token, SPARQL, scope JSON.
devnet_query_api_frame() {
  local api="$1" token="$2" sparql="$3" scope="${4:-}" body
  [ -n "$scope" ] || scope='{}'
  body=$(node -e '
    try {
      const scope = JSON.parse(process.argv[2]);
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw Error();
      console.log(JSON.stringify({ ...scope, sparql: process.argv[1] }));
    } catch {
      console.error("INCONCLUSIVE: invalid query scope"); process.exitCode = 2;
    }
  ' "$sparql" "$scope") || return 2
  devnet_capture -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data "$body" "${api%/}/api/query"
}

# Explicit API observation: base URL, token, SPARQL, binding, mode, scope JSON.
# Metrics are validated once; bindings mode emits an array for cell inspection.
devnet_query_api() {
  local api="$1" token="$2" sparql="$3" binding="$4" mode="$5" scope="${6:-}" response
  response=$(devnet_query_api_frame "$api" "$token" "$sparql" "$scope") || return 2
  printf '%s' "$response" | devnet_observe "$mode" "$binding" api "${@:7}"
}

# Poll form of devnet_query_api, for a step that waits for replication to a
# member. While the member's read authority is still settling, the query route
# answers a retryable 503 with code CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE,
# and the documented client behaviour is to ask again. Inside a poll that one
# answer is "nothing yet": this prints 0 and succeeds, and the poll's own
# deadline still fails the step if the data never arrives. Every other answer
# is devnet_query_api's, so a 503 with another code, or one that is not marked
# retryable, stays invalid evidence. Only the numeric modes have a "nothing yet".
devnet_query_api_settling() {
  local api="$1" token="$2" sparql="$3" binding="$4" mode="$5" scope="${6:-}" response
  case "$mode" in rows|count) ;; *) echo "INCONCLUSIVE: settling poll needs rows or count mode" >&2; return 2 ;; esac
  response=$(devnet_query_api_frame "$api" "$token" "$sparql" "$scope") || return 2
  if printf '%s' "$response" | node -e '
    let frame = ""; process.stdin.on("data", (c) => { frame += c; }).on("end", () => {
      const [exit, http, ...rest] = frame.split("\n");
      let answer; try { answer = JSON.parse(rest.join("\n")); } catch { answer = null; }
      process.exitCode = exit === "0" && http === "503" && answer !== null && typeof answer === "object"
        && answer.code === "CONTEXT_GRAPH_READ_AUTHORITY_UNAVAILABLE" && answer.retryable === true ? 0 : 1;
    });
  '; then
    printf '0\n'
    return 0
  fi
  printf '%s' "$response" | devnet_observe "$mode" "$binding" api "${@:7}"
}

# Authorized raw-store observation: devnet directory, API port, SPARQL,
# binding, mode, optional assertion. The API port selects the configured store;
# no synthetic API request or query-shape inference is involved.
# Each read first proves the observer can see seeded triples. Embedded stores
# have no safe live HTTP endpoint and remain INCONCLUSIVE.
devnet_storage_query() {
  local directory="$1" port="$2" sparql="$3" binding="$4" mode="$5" helper_dir endpoint control response
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  endpoint=$(node "$helper_dir/lib/qa/devnet-storage-endpoint.mjs" "$directory" "http://127.0.0.1:$port") || return 2
  control=$(devnet_capture -H 'Accept: application/sparql-results+json' --data-urlencode 'query=SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1' "$endpoint") || return 2
  printf '%s' "$control" | devnet_observe rows s sparql ge 1 >/dev/null || return 2
  response=$(devnet_capture -H 'Accept: application/sparql-results+json' --data-urlencode "query=$sparql" "$endpoint") || return 2
  printf '%s' "$response" | devnet_observe "$mode" "$binding" sparql "${@:6}"
}
