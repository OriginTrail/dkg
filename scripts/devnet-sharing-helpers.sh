#!/usr/bin/env bash
# Bash 3.2. Observation errors retain the explicit legacy suite exit-1 adapter.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/devnet-observation-helpers.sh"

# Sharing operations. Caller supplies AUTH, DEVNET_DIR and check/fail functions.
# Loading this module does not initialize counters or change shell options.
# One read through the API, made the way a client that follows the route's
# contract makes it: the documented retryable 503 (read authority unavailable)
# is asked again after its Retry-After, at most SHARING_READ_ATTEMPTS times in
# all (default 5). Each repeat appends a line to $SHARING_RETRY_LOG when that
# is set, so a suite can report how often its reads needed one. A read that is
# still unavailable after the last attempt is invalid evidence (2), and so is
# every other invalid answer, at once and without a repeat.
sharing_api_observe() {
  local port="$1" attempt=1 value status
  shift
  while :; do
    status=0
    value=$(devnet_query_api_settling "http://127.0.0.1:$port" "$AUTH" "$@") || status=$?
    [ "$status" -eq 3 ] || break
    if [ "$attempt" -ge "${SHARING_READ_ATTEMPTS:-5}" ]; then
      echo '{"outcome":"INCONCLUSIVE","reason":"READ_AUTHORITY_STILL_SETTLING"}' >&2
      return 2
    fi
    [ -z "${SHARING_RETRY_LOG:-}" ] || printf '%s\n' "$port" >> "$SHARING_RETRY_LOG"
    attempt=$((attempt + 1))
    sleep "${SHARING_RETRY_AFTER:-3}"
  done
  [ "$status" -eq 0 ] || return "$status"
  printf '%s\n' "$value"
}

# Bounded wait for a member to read at least <min>: port, attempts, min, then
# the sharing_api_observe arguments. It runs in the caller's shell and leaves
#   SHARING_WAIT_VALUE  the last valid number, empty when no read was valid
#   SHARING_WAIT_POLLS  the polls made
# Status 0: the threshold was reached. 1: the deadline passed on valid reads
# below it. 3: the deadline passed while read authority was still unavailable,
# which means no read was valid at all, or the last SHARING_SETTLING_TAIL polls
# (default 3, the route's Retry-After at one poll a second) all answered
# SETTLING. A single such answer in between is a retry, not an outcome. The
# caller keeps its message and its choice between a warning and a failure for
# status 1; status 3 never observed the member's state and is a failed step.
# Invalid evidence stops the suite, as for a single observation.
sharing_wait_for_count() {
  local port="$1" attempts="$2" min="$3" value status settling=0 i
  shift 3
  SHARING_WAIT_VALUE=""; SHARING_WAIT_POLLS=0
  for i in $(seq 1 "$attempts"); do
    SHARING_WAIT_POLLS=$i; status=0
    value=$(devnet_query_api_settling "http://127.0.0.1:$port" "$AUTH" "$@") || status=$?
    case "$status" in
      0) settling=0; SHARING_WAIT_VALUE="$value"
         if devnet_count_at_least "$value" "$min"; then return 0; fi ;;
      3) settling=$((settling + 1)) ;;
      *) devnet_observation_abort ;;
    esac
    sleep "${SHARING_WAIT_INTERVAL:-1}"
  done
  if [ -z "$SHARING_WAIT_VALUE" ] || [ "$settling" -ge "${SHARING_SETTLING_TAIL:-3}" ]; then return 3; fi
  return 1
}

# Run one bounded wait and report it: <warn|fail> for late data, what was read,
# the message when the threshold was reached, the message when the data was
# late, then the sharing_wait_for_count arguments. In both messages {value} and
# {polls} stand for the last valid number and the polls made. A wait that ended
# while read authority was still unavailable is a failed step for every caller,
# whatever it does about late data. Returns 0 only when the threshold was
# reached, so a caller can keep a flag: sharing_expect_count ... && SEEN=true.
sharing_expect_count() {
  local late_action="$1" what="$2" reached="$3" late="$4" status message
  shift 4
  case "$late_action" in warn|fail) ;; *) echo "INCONCLUSIVE: late action must be warn or fail" >&2; devnet_observation_abort ;; esac
  sharing_wait_for_count "$@"; status=$?
  case "$status" in
    0) message=$reached ;;
    3) fail "$what: read authority was still unavailable when the wait ended"; return 1 ;;
    *) message=$late ;;
  esac
  message=${message//\{value\}/$SHARING_WAIT_VALUE}
  message=${message//\{polls\}/$SHARING_WAIT_POLLS}
  if [ "$status" -eq 0 ]; then ok "$message"; return 0; fi
  "$late_action" "$message"
  return 1
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
