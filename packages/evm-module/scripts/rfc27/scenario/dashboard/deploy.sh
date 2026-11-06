#!/usr/bin/env bash
# Installs the dashboard under ~/.rfc27-dashboard on a host with Node 22 and
# systemd --user, no root needed. It reads the host's Tailscale address and binds
# the server to it. It touches nothing outside that folder and its three units.
#
#   DEPLOY_HOST=user@host ./deploy.sh
#
# To stop it, on the host:
#   systemctl --user disable --now rfc27-dashboard-indexer.timer rfc27-dashboard-server.service
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST=user@host}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
remote() { ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; }
# A file, written in place only once it has arrived whole.
put() { remote "cat > '$2.new' && mv '$2.new' '$2'" < "$1"; }

node "$here/build.mjs"

remote 'mkdir -p .rfc27-dashboard/www .rfc27-dashboard/state .rfc27-dashboard/logs .rfc27-dashboard/run .config/systemd/user'
put "$here/dist/indexer.cjs" .rfc27-dashboard/indexer.cjs
put "$here/dist/server.mjs" .rfc27-dashboard/server.mjs
put "$here/dist/index.html" .rfc27-dashboard/www/index.html

bind="$(remote 'tailscale ip -4' | head -n 1)"
[[ "$bind" =~ ^[0-9.]+$ ]] || { echo "no Tailscale address on $DEPLOY_HOST: $bind" >&2; exit 1; }
sed "s/@BIND@/$bind/" "$here/systemd/rfc27-dashboard-server.service" | remote 'cat > .config/systemd/user/rfc27-dashboard-server.service'
put "$here/systemd/rfc27-dashboard-indexer.service" .config/systemd/user/rfc27-dashboard-indexer.service
put "$here/systemd/rfc27-dashboard-indexer.timer" .config/systemd/user/rfc27-dashboard-indexer.timer

remote 'systemctl --user daemon-reload \
  && systemctl --user enable --now rfc27-dashboard-indexer.timer rfc27-dashboard-server.service \
  && systemctl --user restart rfc27-dashboard-server.service \
  && systemctl --user start --no-block rfc27-dashboard-indexer.service'
echo "installed on $DEPLOY_HOST, serving http://$bind:8127/"
