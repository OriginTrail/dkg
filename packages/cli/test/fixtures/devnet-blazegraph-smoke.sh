#!/usr/bin/env bash
set -euo pipefail

metadata_root="$1"
capture_path="$2"
fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$fixture_dir/../../../.." && pwd)"

export DEVNET_SOURCE_ONLY=1
source "$repo_root/scripts/devnet.sh"

REPO_ROOT="$metadata_root"
BLAZEGRAPH_PORT=19099
BLAZEGRAPH_CONTAINER=devnet-blazegraph-smoke
blazegraph_started=0

docker_responsive() { return 0; }
docker() {
  case "$1" in
    inspect) return 1 ;;
    run)
      printf '%s\n' "$@" > "$capture_path"
      blazegraph_started=1
      return 0
      ;;
    *) return 1 ;;
  esac
}
curl() {
  [ "$blazegraph_started" = "1" ] || return 1
  local arg
  for arg in "$@"; do
    if [ "$arg" = "-w" ]; then
      printf '%s' "${DEVNET_BLAZEGRAPH_SMOKE_NAMESPACE_STATUS:-201}"
      break
    fi
  done
}

if start_blazegraph; then
  exit 0
fi
exit 42
