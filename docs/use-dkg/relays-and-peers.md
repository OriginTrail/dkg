---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Relays and Peers

Nodes use libp2p for peer connectivity. Edge nodes behind NAT reserve relay slots so other nodes can reach them. The default network relay set is loaded from the active network config.

## Inspect Peers

```bash
dkg peers
dkg peer info <peer-id>
```

If peer discovery looks empty:

- confirm the daemon is running
- wait for discovery to settle
- check configured relays in node config
- inspect daemon logs
- verify that both nodes subscribe to the same Context Graph when expecting shared memory

Direct messages and query-remote are best-effort P2P operations. Treat timeouts as connectivity facts, not as proof that the remote data does not exist.

## Prefer Operator Relays

Use `--relay-preferred` when you run relays you control and want this node to try those relays before the network defaults:

```bash
dkg start \
  --relay-preferred /ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayOne... \
  --relay-preferred /dns4/relay.example.com/tcp/4001/p2p/12D3KooWMyRelayTwo...
```

The flag is repeatable. Entries are prepended in CLI order for that daemon run. To persist the preference, set `preferredRelays` in `~/.dkg/config.json`:

```json
{
  "preferredRelays": [
    "/ip4/203.0.113.10/tcp/4001/p2p/12D3KooWMyRelayOne...",
    "/dns4/relay.example.com/tcp/4001/p2p/12D3KooWMyRelayTwo..."
  ]
}
```

CLI entries and config entries are deduplicated before they are prepended to the network relay list. Public relays stay as fallback.

## Messenger Health

Short peer-to-peer protocols that use Universal Messenger expose delivery latency and queued counts through the daemon API:

```bash
curl -H "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  http://127.0.0.1:9200/api/slo
```

Use this when peer commands show a reachable peer but messages still queue or feel slow. `/api/slo` is an in-memory snapshot; daemon restart resets its samples, while the underlying retry outbox survives restart.
