#!/usr/bin/env bash
# Sourceable status assertions for the daemon-owned store outage scenario.
# Shared auth/HTTP/JSON primitives remain in devnet-lib.sh.
# bash 3.2 compatible; caller supplies status_body(), say(), and fail().
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/devnet-lib.sh" || return 1

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
