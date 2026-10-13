---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect Hermes

Prerequisites: a working Hermes installation and configured model access. The DKG adapter can bootstrap a node and configure the selected Hermes profile. The 10.0.23 baseline supports DKG memory tools, primary-memory integration, and Node UI chat through the local bridge or configured gateway.

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup --network testnet
dkg hermes status
dkg hermes verify
```

Setup replaces the memory provider by default. Use `--preserve-provider` if you intend to retain the existing provider; that is a different memory configuration. Use `--profile <name>` consistently for a non-default profile. Existing nodes retain their network.

Start Hermes using its installed runtime's instructions. For the API gateway path, ensure `API_SERVER_ENABLED=true` in the selected Hermes environment and run:

```bash
hermes gateway run --replace -v
```

## Verify

Confirm node health, adapter verification, and a chat reply from the connected profile. Then complete the [quickstart](../getting-started/quickstart.md) and repeat its query in a fresh conversation. Check both memory tool access and the actual memory provider; successful chat alone does not verify memory persistence.

If chat is unavailable, check the selected profile and bridge/gateway health with `dkg hermes doctor`. See the [adapter reference](https://github.com/OriginTrail/dkg/blob/testnet-canary/packages/adapter-hermes/README.md) for runtime prerequisites, profiles, transport modes, and configuration.

## Disconnect

```bash
dkg hermes disconnect
```

Use the same `--profile` selection as setup. Reconnect with `dkg hermes reconnect`; use `dkg hermes uninstall` when removing adapter wiring. Inspect the resulting status rather than deleting runtime configuration by hand.
