#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
cd "$repo_root"

runtime="$(node packages/cli/blazegraph-image-metadata.cjs blazegraph-image.json)"
IFS=$'\t' read -r image container_port data_path <<< "$runtime"
if [[ -z "$image" || -z "$container_port" || -z "$data_path" ]]; then
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

resource_suffix="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-${platform##*/}"
container="dkg-ci-blazegraph-${resource_suffix}"
volume="dkg-ci-blazegraph-data-${resource_suffix}"
namespace="dkg-ci-persistence-contract"
host_port=""
# Invoked indirectly by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_contract_container() {
  docker run -d \
    --platform "$platform" \
    --name "$container" \
    --mount "type=volume,source=${volume},target=${data_path}" \
    -p "127.0.0.1::${container_port}" \
    "$image" >/dev/null
  local binding
  binding="$(docker port "$container" "${container_port}/tcp")"
  host_port="${binding##*:}"

  for _ in $(seq 1 120); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${host_port}/bigdata/status" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" || true
  return 1
}

if ! start_contract_container; then
  echo "::error::Pinned Blazegraph image did not serve /bigdata/status for ${platform} on declared container port ${container_port}"
  exit 1
fi

curl -fsS --max-time 10 -X POST \
  "http://127.0.0.1:${host_port}/bigdata/namespace" \
  -H 'Content-Type: application/xml' \
  --data-binary @- >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
  <entry key="com.bigdata.rdf.sail.namespace">${namespace}</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.quads">true</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.statementIdentifiers">false</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.textIndex">false</entry>
  <entry key="com.bigdata.rdf.sail.truthMaintenance">false</entry>
  <entry key="com.bigdata.rdf.store.AbstractTripleStore.axiomsClass">com.bigdata.rdf.axioms.NoAxioms</entry>
</properties>
EOF

curl -fsS --max-time 10 \
  "http://127.0.0.1:${host_port}/bigdata/namespace/${namespace}/sparql/properties" \
  >/dev/null

# Recreate only the container, preserving the named volume. The namespace must
# still exist; this proves dataPath is the image's real durable journal path.
docker rm -f "$container" >/dev/null
if ! start_contract_container; then
  echo "::error::Pinned Blazegraph image did not restart with its declared dataPath volume"
  exit 1
fi

if ! curl -fsS --max-time 10 \
  "http://127.0.0.1:${host_port}/bigdata/namespace/${namespace}/sparql/properties" \
  >/dev/null; then
  docker logs "$container" || true
  echo "::error::Declared Blazegraph dataPath ${data_path} did not preserve namespace ${namespace} across container recreation"
  exit 1
fi

echo "Verified Blazegraph ${platform} runtime on port ${container_port} and durable journal path ${data_path}."
