---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Install a Node

## Prerequisites

- Node.js 22+
- npm 10+
- A machine that can keep a local daemon running
- Testnet ETH and TRAC only when publishing to Verified Memory

## Packaged install

```bash
npm install -g @origintrail-official/dkg
dkg init
dkg start
```

`dkg init` creates node config under `~/.dkg`, including auth and wallet material. On testnet, setup paths try to fund generated wallets when a faucet is configured. Funding failures are non-fatal for local Working Memory, Shared Working Memory, queries, and P2P operations.

Open the Node UI:

```text
http://127.0.0.1:9200/ui
```

Check the daemon:

```bash
dkg status
dkg wallet
```

## Monorepo development install

```bash
pnpm install
pnpm --filter @origintrail-official/dkg build
node packages/cli/dist/cli.js init
node packages/cli/dist/cli.js start
```

Use monorepo mode for local development only. Installed agents should use the packaged CLI unless they need in-progress repo changes.
