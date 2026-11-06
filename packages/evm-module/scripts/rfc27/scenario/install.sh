#!/usr/bin/env bash
# Installs the scenario's tick on one beacon, from the machine that ran the setup:
# the bundled driver, the public file and the seed, then a systemd user timer.
# It touches nothing outside ~/.rfc27-scenario and its two unit files. No sudo.
#
#   scripts/rfc27/scenario/install.sh <ssh target> <beacon name>     (from packages/evm-module)
#
# Run scripts/rfc27/scenario/build.mjs first. README.md says how to stop and uninstall.

set -euo pipefail

target="${1:?usage: install.sh <ssh target> <beacon name>}"
beacon="${2:?usage: install.sh <ssh target> <beacon name>}"
[[ "$beacon" =~ ^beacon-0[1-4]$ ]] || { echo "unknown beacon: $beacon" >&2; exit 1; }
minute=$((10#${beacon##*-} - 1))

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
module="$(cd "$here/../../.." && pwd)"
driver="$module/cache/rfc27-scenario/driver.cjs"
public="$here/public.testnet.json"
seed="$HOME/.rfc27-scenario/seed"
for f in "$driver" "$public" "$seed"; do [[ -s "$f" ]] || { echo "missing: $f" >&2; exit 1; }; done
python3 -c 'import json, sys; sys.exit(any(b["pays"] == "account" and b["accountId"] is None for b in json.load(open(sys.argv[1]))["buyers"]))' "$public" \
  || { echo "the public file has an account without its id: run the setup first" >&2; exit 1; }

remote() { ssh -o BatchMode=yes "$target" "$@"; }

remote 'umask 077; mkdir -p ~/.rfc27-scenario/logs ~/.config/systemd/user; chmod 700 ~/.rfc27-scenario'
remote 'umask 077; cat > ~/.rfc27-scenario/seed.tmp && mv ~/.rfc27-scenario/seed.tmp ~/.rfc27-scenario/seed && chmod 600 ~/.rfc27-scenario/seed' < "$seed"
remote 'umask 077; cat > ~/.rfc27-scenario/public.json.tmp && mv ~/.rfc27-scenario/public.json.tmp ~/.rfc27-scenario/public.json' < "$public"
remote 'umask 077; cat > ~/.rfc27-scenario/driver.cjs.tmp && mv ~/.rfc27-scenario/driver.cjs.tmp ~/.rfc27-scenario/driver.cjs' < "$driver"

remote 'cat > ~/.config/systemd/user/rfc27-scenario-tick.service' <<EOF
[Unit]
Description=OT-RFC-27 marketplace scenario: one tick of $beacon
ConditionPathExists=!%h/.rfc27-scenario/stop

[Service]
Type=oneshot
ExecStart=/usr/bin/flock -n -E 0 %h/.rfc27-scenario/tick.lock /usr/local/bin/node --max-old-space-size=200 %h/.rfc27-scenario/driver.cjs tick --beacon $beacon
MemoryMax=256M
CPUQuota=25%
Nice=10
TimeoutStartSec=285
StandardOutput=null
StandardError=journal
EOF

remote 'cat > ~/.config/systemd/user/rfc27-scenario-tick.timer' <<EOF
[Unit]
Description=OT-RFC-27 marketplace scenario: a tick of $beacon every five minutes

[Timer]
OnCalendar=*:0$minute/5:15
AccuracySec=1s
Persistent=false
Unit=rfc27-scenario-tick.service

[Install]
WantedBy=timers.target
EOF

remote 'systemctl --user daemon-reload && systemctl --user enable --now rfc27-scenario-tick.timer && systemctl --user list-timers rfc27-scenario-tick.timer --no-pager | head -3'
echo "the node's service: $(remote 'systemctl is-active dkg-v9-node.service' || true)"
