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

# Authorized raw-store reads for physical assertions. Each read first proves
# the observer can see seeded devnet triples, bypassing DKG API ACL filtering.
# Embedded stores have no safe live read endpoint and are INCONCLUSIVE.
devnet_storage_query() {
  local directory="$1" api="$2" body="$3" helper_dir endpoint sparql projection binding control response
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  endpoint=$(node "$helper_dir/lib/qa/devnet-storage-endpoint.mjs" "$directory" "$api") || return 2
  projection=$(printf '%s' "$body" | node -e 'let b="";process.stdin.on("data",c=>b+=c);process.stdin.on("end",()=>{try{const q=JSON.parse(b).sparql;const m=typeof q==="string" && /^SELECT\s+(?:DISTINCT\s+)?\?([A-Za-z_][A-Za-z0-9_]*)\b/i.exec(q);if(!m)throw Error();console.log(m[1]);console.log(q)}catch{process.exitCode=2}})') || return 2
  binding="${projection%%$'\n'*}"
  sparql="${projection#*$'\n'}"
  control=$(devnet_capture -H 'Accept: application/sparql-results+json' --data-urlencode 'query=SELECT ?s WHERE { GRAPH ?g { ?s ?p ?o } } LIMIT 1' "$endpoint") || return 2
  printf '%s' "$control" | devnet_observe rows s sparql ge 1 >/dev/null || return 2
  response=$(devnet_capture -H 'Accept: application/sparql-results+json' --data-urlencode "query=$sparql" "$endpoint") || return 2
  printf '%s' "$response" | devnet_observe json "$binding" sparql
}
