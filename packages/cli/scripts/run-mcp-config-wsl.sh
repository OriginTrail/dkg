#!/usr/bin/env bash
set -euo pipefail
fixture_bundle=$1
windows_temporary_root=$2
runtime_directory=$(mktemp -d)
trap 'rm -rf "$runtime_directory"' EXIT
cd "$runtime_directory"
curl --fail --silent --show-error --retry 3 https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz -o node.tar.xz
echo '9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578  node.tar.xz' | sha256sum --check --strict
tar -xJf node.tar.xz
./node-v22.23.1-linux-x64/bin/node "$fixture_bundle" "$windows_temporary_root"
