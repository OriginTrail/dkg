---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect Prime Agent

The DKG adapter connects a **Prime Intellect Prime Agent** session to Node UI chat. At the 10.0.23 baseline it provides setup, discovery, authenticated transport, and UI chat. It does **not** advertise primary-memory integration or provide a model-facing DKG Python skill. Do not treat a successful chat connection as proof of DKG memory recall or persistence.

Prerequisites: Prime Agent installed and usable, an initialized and running DKG node, and its local auth token. Prime Agent setup does not offer the same node/bootstrap flags as Hermes or OpenClaw.

```bash
# Only for a fresh DKG node:
dkg init --role edge --network testnet
dkg start

# Connect the installed Prime Agent runtime:
dkg prime-agent setup
dkg prime-agent verify
dkg prime-agent status
```

Start or reload a Prime Agent session so the installed extension runs. Open the DKG Node UI's connected-agents panel and connect Prime Agent. An installed adapter with no live session is an idle state, not a successful conversation connection.

## Verify the session

Send a message from the Node UI and confirm that it reaches the Prime Agent session you are using and streams a reply. With multiple live sessions, unaddressed messages route to the most recently active session. An explicit session ID overrides that routing; the current panel has no session picker.

Use `dkg prime-agent doctor` for diagnostics. The bridge binds loopback and requires a bridge token. A busy session can return `429`; let the existing turn finish before resending. Setup/reload problems and upstream runtime assumptions are documented in the [adapter reference](https://github.com/OriginTrail/dkg/blob/testnet-canary/packages/adapter-prime-agent/README.md).

For the [memory quickstart](../getting-started/quickstart.md), use a separate supported MCP/framework memory connection or your own explicit node client. This bridge alone supplies chat transport.

## Disconnect or remove

```bash
dkg prime-agent disconnect
dkg prime-agent status
# If removing the integration entirely:
dkg prime-agent uninstall
```

Use `--agent-dir` and `--profile` consistently when you configured a non-default runtime directory/profile. Reconnect with `dkg prime-agent reconnect`. Setup preserves the original settings and uninstall removes the adapter's extension entry; graph data remains on the DKG node.
