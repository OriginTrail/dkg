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

# Explicit API observation: base URL, token, SPARQL, binding, mode, scope JSON.
# Metrics are validated once; bindings mode emits an array for cell inspection.
devnet_query_api() {
  local api="$1" token="$2" sparql="$3" binding="$4" mode="$5" scope="${6:-}" body response
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
  response=$(devnet_capture -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data "$body" "${api%/}/api/query") || return 2
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
