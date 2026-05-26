---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect OpenClaw

OpenClaw connects to a local DKG daemon through the DKG adapter.

```bash
npm install -g @origintrail-official/dkg
dkg openclaw setup
```

The setup flow is idempotent. It writes DKG node config, merges the adapter into OpenClaw config, starts the daemon unless disabled, and verifies the node.

If the gateway does not auto-reload after setup:

```bash
openclaw gateway restart
```

Healthy setup checklist:

- `dkg_status` works from the OpenClaw agent.
- The Node UI loads at `http://127.0.0.1:9200/ui`.
- The right-panel chat can connect to OpenClaw.
- Chat history survives a UI reload because DKG persists the turns.

The package-owned reference is `packages/adapter-openclaw/README.md`.

