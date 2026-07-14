#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
cd "$repo_root"

runtime="$(node packages/cli/blazegraph-image-metadata.cjs blazegraph-image.json)"
IFS=$'\t' read -r image container_port <<< "$runtime"
if [[ -z "$image" || -z "$container_port" ]]; then
  echo "::error::Could not read image contract from blazegraph-image.json"
  exit 1
fi

case "$(uname -m)" in
  x86_64) platform="linux/amd64" ;;
  aarch64 | arm64) platform="linux/arm64" ;;
  *)
    echo "::error::Unsupported CI runner architecture: $(uname -m)"
    exit 1
    ;;
esac

manifest="$(docker buildx imagetools inspect "$image" --format '{{json .Manifest}}')"
printf '%s\n' "$manifest" | jq -e '
  ([.manifests[] | select(.platform.os == "linux") | .platform.architecture] | index("amd64") != null)
  and
  ([.manifests[] | select(.platform.os == "linux") | .platform.architecture] | index("arm64") != null)
'

container="dkg-ci-blazegraph-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${platform##*/}"
# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d \
  --platform "$platform" \
  --name "$container" \
  -p "127.0.0.1::${container_port}" \
  "$image" >/dev/null
binding="$(docker port "$container" "${container_port}/tcp")"
host_port="${binding##*:}"

for _ in $(seq 1 120); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${host_port}/bigdata/status" >/dev/null; then
    echo "Verified Blazegraph ${platform} runtime on declared container port ${container_port}."
    exit 0
  fi
  sleep 1
done

docker logs "$container" || true
echo "::error::Pinned Blazegraph image did not serve /bigdata/status for ${platform} on declared container port ${container_port}"
exit 1
