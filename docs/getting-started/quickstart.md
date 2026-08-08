---
status: current
version: v10
audience: human+agent
doc_type: how-to
description: >-
  Give your AI agent a persistent and structured memory on the DKG in under 10
  minutes
icon: robot
---

# Quickstart

By connecting your AI agent to the DKG Node, you give it three layers of persistent and structured memory on the DKG:

* **Working Memory** — _Private, local, free._ Your agent's scratchpad. Write drafts, ingest documents, stage knowledge before sharing it. Nothing leaves your node. No cost, no coordination overhead. This is where all knowledge starts.
* **Shared Working Memory** — _Collaborative, gossip-replicated, no charge._ Selectively share knowledge with specific peers (other agents) without publishing to a blockchain. Multiple agents can read from and write to the same Context Graph. This is where collective intelligence happens before anything needs to be verified.
* **Verifiable Memory** — _Blockchain-anchored, cryptographically provable._ Promote knowledge that needs a durable, independently verifiable record. Each published version is bound to an on-chain commitment; later updates create an auditable new committed state instead of silently rewriting history. Query access follows the Context Graph's policy. Trust level is explicit: self-attested, endorsed, partially verified, or consensus verified.

To better understand how DKG works, explore [here](../how-dkg-works/key-concepts.md).

## Prerequisites&#x20;

Node.js 22+, npm 10+. macOS, Linux, and Windows (PowerShell 5.1+ or WSL2) all supported.

## Hermes&#x20;

Install the DKG CLI and set up the default Hermes profile:

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup
```

Enable Hermes' API server and start the gateway:

```bash
echo 'API_SERVER_ENABLED=true' >> ~/.hermes/.env
hermes gateway run --replace -v
```

`dkg hermes setup` bootstraps the DKG node config (no separate `dkg init` needed), starts the daemon, optionally funds wallets, and wires the Hermes profile with replace-by-default provider election (use `--preserve-provider` to opt out, `--no-start` / `--no-fund` for advanced flows).&#x20;

By default this sets up the node on **Gnosis mainnet** (`mainnet-gnosis`). On a fresh node, pass `--network mainnet-base` or `--network testnet` to choose a different network (an already-configured node keeps its current network — switch it with `dkg init --network`). Wallet funding via the faucet only happens on `testnet`; on mainnet you fund the node's wallets yourself.

See the [adapter guide](https://github.com/OriginTrail/dkg/blob/main/packages/adapter-hermes/README.md) for details.

## OpenClaw&#x20;

```bash
npm install -g @origintrail-official/dkg     # installs CLI + bundled adapter
dkg openclaw setup                           # configures + starts the daemon, registers the plugin
```

Restart the OpenClaw gateway if it does not auto-reload:

```
openclaw gateway restart
```

`dkg openclaw setup` is non-interactive and idempotent. It writes `~/.dkg/config.json`, merges the adapter into `~/.openclaw/openclaw.json` (under `plugins.entries.adapter-openclaw.config` — `daemonUrl`, `memory.enabled`, `channel.enabled`), syncs the canonical DKG node skill into the OpenClaw workspace at `skills/dkg-node/SKILL.md`, and verifies the install. The right-panel "Connect OpenClaw" button in the node UI runs the same in-process flow.

Use `--no-start`, `--no-fund`, and `--no-verify` only when the user or environment requires it.

By default this sets up the node on **Gnosis mainnet** (`mainnet-gnosis`). On a fresh node, pass `--network mainnet-base` or `--network testnet` to choose a different network (an already-configured node keeps its current network — switch it with `dkg init --network`). Wallet funding via the faucet only happens on `testnet`; on mainnet you fund the node's wallets yourself.

## MCP

Two commands wire DKG V10 into MCP-aware clients (Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + GitHub Copilot Chat, Cline, Codex CLI):

```bash
npm install -g @origintrail-official/dkg
dkg mcp setup
```

Restart the client and inspect DKG tools.

`dkg mcp setup` bootstraps the DKG node config (no separate `dkg init` needed), starts the daemon, optionally funds wallets, and registers MCP entries in each detected client (you confirm per client unless `--yes` is passed).&#x20;

By default this sets up the node on **Gnosis mainnet** (`mainnet-gnosis`). On a fresh node, pass `--network mainnet-base` or `--network testnet` to choose a different network (an already-configured node keeps its current network — switch it with `dkg init --network`). Wallet funding via the faucet only happens on `testnet`; on mainnet you fund the node's wallets yourself.

See the [MCP integration guide](https://github.com/OriginTrail/dkg/blob/main/packages/mcp-dkg/README.md) for client-by-client paths, mode overrides (`--installed` / `--monorepo`), the manual JSON shape, the contributor monorepo dev workflow, and troubleshooting (including the WSL2 caveat for Windows-side MCP clients).

## Standalone node

Skip the framework wiring — run the daemon directly and use the CLI or HTTP API:

```bash
npm install -g @origintrail-official/dkg
dkg init      # interactive: prompts for network, node name, role, triple-store backend (default: oxigraph-server), relay, API port
dkg start     # starts the node daemon on http://127.0.0.1:9200
```

`dkg init` asks which network to join — **Gnosis mainnet** (`mainnet-gnosis`, the default), `mainnet-base`, or `testnet` — at the prompt, or pass `--network <name>` to skip it. Wallet funding via the faucet only happens on `testnet`; on mainnet you fund the node's wallets yourself.

For Core Node operation, initialize with the Core role:

```bash
dkg init --role core --network mainnet-gnosis
dkg start
```

Core Nodes are registered on-chain with a node profile (`identityId`). The daemon attempts this automatically on Core startup, but the primary operational wallet needs gas plus TRAC and the admin wallet must be present for profile/key-management transactions. If you fund or fix wallets after the daemon is already running, call `POST /api/identity/ensure` as described in [Daemon Lifecycle](../use-dkg/run-node.md#core-node-profile-registration).

Once running, open the dashboard at [http://127.0.0.1:9200/ui](http://127.0.0.1:9200/ui), or query directly:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agents
```
