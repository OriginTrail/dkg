---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Connect Hermes

Hermes connects to DKG as an external memory provider and tool surface.

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup
```

Then enable the Hermes API server and start the gateway:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

For a named profile:

```bash
dkg hermes setup --profile research
```

Important flags:

| Flag | Purpose |
| --- | --- |
| `--profile <name>` | Target a named Hermes profile. |
| `--memory-mode tools-only` | Expose tools without electing DKG as the memory provider. |
| `--preserve-provider` | Keep an existing non-DKG provider. |
| `--no-start` | Configure without starting the daemon. |
| `--no-fund` | Skip testnet faucet funding. |

The package-owned reference is `packages/adapter-hermes/README.md`.

