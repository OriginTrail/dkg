#!/bin/sh
# Entrypoint of the DKG node container image (see the Dockerfile).
#
# Runs the dkg CLI with the container's arguments. The image's default command,
# `start --foreground`, runs the daemon in the foreground.
#
# Before the first start, when DKG_HOME holds no config, it writes a config for
# the network named by DKG_NETWORK. It has the store backend that `dkg init`
# gives a new node, and the settings a container needs: the API listens on all
# interfaces and the peer-to-peer port is fixed, so both can be published, and
# the node does not update itself, because a new version is a new image. A
# config that exists is used as it is.
set -eu

if [ "${1:-}" = start ]; then
  if [ ! -e "$DKG_HOME/config.json" ] && [ ! -e "$DKG_HOME/config.yaml" ]; then
    network="${DKG_NETWORK:-}"
    case "$network" in
      '' | *[!a-z0-9-]*)
        echo "No config in $DKG_HOME. Set DKG_NETWORK to the network to join (for example testnet) for the first start, or mount a config.json." >&2
        exit 64
        ;;
    esac
    if [ ! -f "/app/network/$network.json" ]; then
      echo "Unknown DKG_NETWORK \"$network\". Networks in this image: $(cd /app/network && for file in *.json; do printf '%s ' "${file%.json}"; done)" >&2
      exit 64
    fi
    (
      umask 077
      mkdir -p "$DKG_HOME"
      cat > "$DKG_HOME/config.json" <<EOF
{
  "networkConfig": "$network",
  "apiHost": "0.0.0.0",
  "apiPort": 9200,
  "listenPort": 9090,
  "store": { "backend": "oxigraph-server" },
  "autoUpdate": { "enabled": false }
}
EOF
    )
    echo "Wrote $DKG_HOME/config.json for network $network." >&2
  fi
  # A daemon that detached would leave the container with nothing to run.
  case " $* " in
    *" -f "* | *" --foreground "*) ;;
    *) set -- "$@" --foreground ;;
  esac
fi

exec dkg "$@"
