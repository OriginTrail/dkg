---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Relays and Peers

Nodes use libp2p for peer connectivity. Edge nodes behind NAT can use relays so other nodes can reach them.

Inspect peers:

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

