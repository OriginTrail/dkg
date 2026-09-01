# Capture one selector phase in the current shell. The caller owns diagnostics
# and exit policy; this boundary only guarantees that a successful result is a
# non-empty, fully materialized schedule.
capture_sweep_phase_schedule() { # $1=baseline|stability $2=round
  local phase="$1" round="$2"
  SWEEP_PHASE_SCHEDULE=""
  if ! SWEEP_PHASE_SCHEDULE=$(node \
    "$SWEEP_SELECTOR" \
    "$SUITES_JSON" \
    "$phase" \
    "$round" \
    "$STABILITY_OVERRIDE"); then
    SWEEP_PHASE_SCHEDULE=""
    return 1
  fi
  [ -n "$SWEEP_PHASE_SCHEDULE" ]
}
