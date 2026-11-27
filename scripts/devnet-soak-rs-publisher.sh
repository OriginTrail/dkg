#!/usr/bin/env bash
# Compatibility launcher: exec preserves the PID used by the soak's drain/wait.
set -eu
exec node "$1/scripts/devnet-soak-rs-publisher.mjs" "$@"
