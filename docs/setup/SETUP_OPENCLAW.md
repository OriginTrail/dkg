# Setting Up DKG V9 with OpenClaw

The full setup guide lives in the `@dkg/adapter-openclaw` package itself, so it ships with the npm install and is always in sync with the code.

**After installing:**

```
node_modules/@dkg/adapter-openclaw/README.md
```

**In this repo:**

```
packages/adapter-openclaw/README.md
```

## Quick Overview

1. `cd WORKSPACE_DIR && npm install @dkg/adapter-openclaw` — install in your workspace
2. Enable in `~/.openclaw/openclaw.json` — add `~/` prefixed `load.paths` and `plugins.entries["adapter-openclaw"].enabled: true`
3. Configure in `WORKSPACE_DIR/config.json` — under the `"dkg-node"` key
4. Set `DKG_EVM_PRIVATE_KEY` in `~/.openclaw/.env` for on-chain publishing (optional)
5. Copy `skills/dkg-node/SKILL.md` to your workspace, restart gateway

See the [full guide](../../packages/adapter-openclaw/README.md) for configuration reference, troubleshooting, and programmatic API.

For the complete testnet walkthrough (including CLI and ElizaOS), see [JOIN_TESTNET.md](./JOIN_TESTNET.md).
