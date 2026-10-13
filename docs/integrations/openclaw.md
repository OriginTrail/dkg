---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect OpenClaw

Prerequisites: an installed, working OpenClaw runtime and configured model access. The DKG adapter supplies memory tools, a memory provider, and a Node UI chat channel.

```bash
npm install -g @origintrail-official/dkg
dkg openclaw setup --network testnet
openclaw gateway restart
dkg status
```

Setup configures and starts the DKG node and registers the adapter. Restart the gateway when it does not automatically reload. Existing DKG nodes retain their network. Use `dkg openclaw setup --dry-run` to inspect the plan.

## Verify

In OpenClaw, call the discovered DKG status tool and list the authorized Context Graphs. In the Node UI, open the connected agent chat and send a message. Reload the UI and check conversation persistence. Then complete the [quickstart](../getting-started/quickstart.md), retrieving the graph fact in a new conversation.

If the adapter is missing, inspect the plugin registration and gateway logs. If another memory provider owns the slot, inspect that setting rather than assuming setup changed it as intended. Port overrides and channel configuration are covered in the [adapter reference](https://github.com/OriginTrail/dkg/blob/testnet-canary/packages/adapter-openclaw/README.md).

## Disconnect

Use the connected-agent panel's Disconnect action and verify the resulting integration state. The daemon's disconnect path restores adapter-owned settings. Reconnect through the panel or rerun setup with your original workspace and port options. Disconnecting an integration does not delete DKG knowledge.
