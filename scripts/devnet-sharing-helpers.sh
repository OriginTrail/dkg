#!/usr/bin/env bash
# Bash 3.2. Observation errors retain the explicit legacy suite exit-1 adapter.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/devnet-observation-helpers.sh"

# Sharing operations. Caller supplies AUTH, DEVNET_DIR and check/fail functions.
# Loading this module does not initialize counters or change shell options.
sharing_api_observe() {
  local port="$1"; shift
  devnet_query_api "http://127.0.0.1:$port" "$AUTH" "$@"
}

# One poll of a wait loop: the observed number, or the word "settling" while
# the member's read authority is unavailable (devnet_query_api_settling).
# Invalid evidence returns 2, as for sharing_api_observe.
sharing_api_poll() {
  local port="$1" value status=0; shift
  value=$(devnet_query_api_settling "http://127.0.0.1:$port" "$AUTH" "$@") || status=$?
  case "$status" in
    0) printf '%s\n' "$value" ;;
    3) printf 'settling\n' ;;
    *) return 2 ;;
  esac
}

# After a wait loop that only warns when its data did not arrive: a wait that
# ended while the member was still settling never observed anything, and that
# is a failed step, not a slow sync.
sharing_fail_if_settling() {
  [ "$2" != settling ] || fail "$1: read authority was still unavailable when the wait ended"
}

sharing_storage_observe() {
  devnet_storage_query "$DEVNET_DIR" "$@"
}

# Legacy assertion adapter: invalid evidence aborts with suite exit 1.
# The same feature query must expose seeded owner data before peer absence.
sharing_storage_absence() {
  local description="$1" owner="$2" peer="$3" sparql="$4" binding="$5" owner_count peer_count
  owner_count=$(sharing_storage_observe "$owner" "$sparql" "$binding" rows) || devnet_observation_abort
  devnet_count_at_least "$owner_count" 1 || { fail "Owner storage control did not expose the seeded WM fact"; exit 1; }
  peer_count=$(sharing_storage_observe "$peer" "$sparql" "$binding" rows) || devnet_observation_abort
  check "$description" "$peer_count" "0"
}

sharing_wm_graphs_query() {
  printf '%s\n' "SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), \"$1\") && (CONTAINS(STR(?g), \"/assertion/\") || CONTAINS(STR(?g), \"/_working_memory/\"))) }"
}

sharing_owner_wm_control() {
  local port="$1" context="$2" query count
  query=$(sharing_wm_graphs_query "$context")
  count=$(sharing_storage_observe "$port" "$query" g rows) || devnet_observation_abort
  devnet_count_at_least "$count" 1 || { fail "Owner storage positive control is empty"; exit 1; }
}

sharing_excluded_swm() {
  local port="$1" context="$2" count
  count=$(sharing_api_observe "$port" 'SELECT ?s WHERE { ?s ?p ?o }' s rows "{\"contextGraphId\":\"$context\",\"view\":\"shared-working-memory\"}") || devnet_observation_abort
  check "Node 3 still has 0 SWM entities" "$count" "0"
}
