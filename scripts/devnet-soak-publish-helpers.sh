#!/usr/bin/env bash
# One publication of the RS soak's publisher loop (scripts/devnet-soak-rs.sh),
# through the CLI: `dkg ka create --share`, then `dkg ka publish`.
#
# A share can be refused because one of its prerequisites is temporarily
# unavailable, for example while the node's catalog receiver holds the legacy
# SWM fence of the graph. The daemon classifies that refusal as transient and
# the client contract is to send the same share again: the share route answers
# 503 with Retry-After: 1, and the one-shot create reports the refusal in its
# 207 body after it has sealed the draft. So only the share is sent again, a
# bounded number of times; sending the create again would write into a sealed
# draft. The CLI prints only the error text, so the refusal is recognised by
# the daemon's fixed message for it.

DEVNET_SOAK_RETRYABLE_SHARE_MESSAGE='A promote prerequisite is temporarily unavailable'

# Seconds to wait before each repeat of a refused share. The first is the share
# route's Retry-After. Doubling starts the last repeat at least 31 s after the
# refusal, later than the 30 s bound on how long a legacy SWM fence waits for
# its turn.
DEVNET_SOAK_SHARE_REPEAT_DELAYS='1 2 4 8 16'

devnet_soak_cli() {
  local node="$1"
  shift
  DKG_HOME="$DEVNET_DIR/node${node}" node "$CLI_JS" "$@"
}

devnet_soak_share_refused_retryably() {
  case "$1" in
    *"$DEVNET_SOAK_RETRYABLE_SHARE_MESSAGE"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Create, share and publish one fixture as a new named asset on one node. Sets
# DEVNET_SOAK_RC (exit status of the last step run), DEVNET_SOAK_OUT (the output
# of every step) and DEVNET_SOAK_SHARE_REPEATS (how often the share was sent
# again). The publication failed when DEVNET_SOAK_RC is not 0.
devnet_soak_publish_once() {
  local node="$1" cg="$2" name="$3" fixture="$4" step_out delay rc=0
  DEVNET_SOAK_SHARE_REPEATS=0
  step_out=$(devnet_soak_cli "$node" ka create "$name" --context-graph-id "$cg" --input-file "$fixture" --share 2>&1) || rc=$?
  DEVNET_SOAK_OUT="$step_out"
  for delay in $DEVNET_SOAK_SHARE_REPEAT_DELAYS; do
    if [ "$rc" -eq 0 ] || ! devnet_soak_share_refused_retryably "$step_out"; then
      break
    fi
    sleep "$delay"
    DEVNET_SOAK_SHARE_REPEATS=$((DEVNET_SOAK_SHARE_REPEATS + 1))
    rc=0
    step_out=$(devnet_soak_cli "$node" ka share "$name" --context-graph-id "$cg" 2>&1) || rc=$?
    DEVNET_SOAK_OUT="$DEVNET_SOAK_OUT"$'\n'"$step_out"
  done
  if [ "$rc" -eq 0 ]; then
    step_out=$(devnet_soak_cli "$node" ka publish "$name" --context-graph-id "$cg" 2>&1) || rc=$?
    DEVNET_SOAK_OUT="$DEVNET_SOAK_OUT"$'\n'"$step_out"
  fi
  DEVNET_SOAK_RC=$rc
}
