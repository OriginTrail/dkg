# DKG V9
<img width="1536" height="1024" alt="dkg_img" src="https://github.com/user-attachments/assets/7be9c4a1-0ade-4bad-8f16-27d457d39e19" />

[![CI](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml)
[![Releases](https://img.shields.io/badge/release-latest-2ea44f)](https://github.com/OriginTrail/dkg-v9/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/OriginTrail/dkg-v9/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xCaY7hvNwD)

DKG V9 is a node for publishing, querying, and exchanging verifiable knowledge.

It gives users and agents a shared RDF-based memory layer with:

- verifiable knowledge publishing
- SPARQL querying
- peer discovery
- encrypted agent messaging
- topic-scoped collaboration through paranets
- a local UI for graph exploration and node operations

**Start here:** [Join the Testnet](docs/setup/JOIN_TESTNET.md) · [Releases](https://github.com/OriginTrail/dkg-v9/releases) · [Discord](https://discord.com/invite/xCaY7hvNwD)

---

## What this repository is for

Use DKG V9 when you want one or more of these:

- a local or remote node that stores and serves RDF knowledge
- a shared memory layer for AI agents
- a publish/query protocol with cryptographic proofs
- encrypted peer-to-peer communication between agents or apps
- isolated domains of coordination through paranets
- a base for agent frameworks such as OpenClaw or ElizaOS

This repository contains the node, CLI, UI, core protocol packages, adapters, and supporting tooling.

---

## Quick start

Install the CLI and start a local node:

```bash
npm install -g @dkg/cli
dkg init
dkg start
```

Open the UI:

```text
http://127.0.0.1:9200/ui
```

Useful checks:

```bash
dkg status
dkg logs
```

---

## First 5 minutes

After the node starts:

1. Open **Explorer → SPARQL** to query graph data.
2. Open **Paranets** to inspect or create domains.
3. Open **Agent Hub** to inspect local agents, state, and messaging.

Basic CLI flow:

```bash
dkg peers
dkg paranet list
dkg publish <paranet> -f <file>
dkg query <paranet> -q "<sparql>"
```

---

## Common commands

```bash
dkg init
dkg start [-f]
dkg stop
dkg status
dkg logs

dkg peers
dkg send <name> <msg>
dkg chat <name>

dkg paranet create <id>
dkg paranet list

dkg publish <paranet> -f <file>
dkg query [paranet] -q <sparql>

dkg auth show
dkg auth rotate

dkg update [versionOrRef] [--check] [--allow-prerelease]
dkg rollback
```

---

## Typical use cases

### 1. Run a local knowledge node

Start a local daemon, open the UI, publish RDF, and query it back.

### 2. Give agents shared memory

Use the node as a common context layer for multiple agents, with SPARQL access, peer discovery, and messaging.

### 3. Build a DKG-enabled app

Use the node APIs and packages to publish knowledge assets, query data, and coordinate through paranets.

### 4. Integrate existing agent frameworks

Use adapters for OpenClaw, ElizaOS, or your own Node.js / TypeScript project.

---

## Setup guides

| Guide | Use it when |
|---|---|
| [Join the Testnet](docs/setup/JOIN_TESTNET.md) | You want a full node setup and first publish/query flow |
| [OpenClaw Setup](docs/setup/SETUP_OPENCLAW.md) | You want OpenClaw to use DKG as memory/tools |
| [ElizaOS Setup](docs/setup/SETUP_ELIZAOS.md) | You want ElizaOS integration |
| [Custom Project Setup](docs/setup/SETUP_CUSTOM.md) | You want to build your own project on top of DKG |
| [SPARQL HTTP Storage](docs/setup/STORAGE_SPARQL_HTTP.md) | You want to use an external triple store |
| [Testnet Faucet](docs/setup/TESTNET_FAUCET.md) | You need Base Sepolia ETH and TRAC |

---

## OpenClaw quick path

Use this path when you want OpenClaw to use a local DKG node for memory and tools.

### 1. Clone and build

```bash
git clone https://github.com/OriginTrail/dkg-v9.git
cd dkg-v9
pnpm install
pnpm build
```

### 2. Start the node

```bash
pnpm dkg start
```

### 3. Confirm the UI is up

Open:

```text
http://127.0.0.1:9200/ui
```

### 4. Configure OpenClaw

Enable `adapter-openclaw` in `~/.openclaw/openclaw.json`.

### 5. Add DKG node config

In your workspace `config.json`, add:

```json
{
  "dkg-node": {
    "daemonUrl": "http://127.0.0.1:9200",
    "memory": { "enabled": true },
    "channel": { "enabled": true }
  }
}
```

### 6. Add the skill file

Copy:

```text
skills/dkg-node/SKILL.md
```

into your OpenClaw workspace, then restart the OpenClaw gateway.

More detail:

- [OpenClaw setup doc](docs/setup/SETUP_OPENCLAW.md)
- [Adapter runbook](packages/adapter-openclaw/README.md)

---

## Architecture

```text
Agents / CLI / Apps
        |
        v
     DKG Node
  (Daemon + API + UI)
    /       |       \
   v        v        v
 P2P     Storage    Chain
Network  RDF/SPARQL Finalization
```

At a high level:

- **P2P network** handles discovery, relay, and node-to-node communication
- **Storage** handles RDF data and SPARQL querying
- **Chain** handles finalization and on-chain registration flows where required
- **Node UI** exposes local exploration and operational tooling
- **CLI** handles lifecycle, publish/query, auth, updates, and logs

---

## Concepts

### Knowledge Asset (KA)

A unit of published knowledge: RDF statements plus proof material and optional private sections.

### Knowledge Collection (KC)

A grouped finalization of multiple knowledge assets.

### Paranet

A scoped domain where agents and apps exchange and organize knowledge.

### Context graph

A named graph used to scope data to a particular context such as a turn, workflow, app state, or task.

### Workspace graph

A collaborative staging area for in-progress writes before durable finalization.

### DKG app

An installable app that runs with DKG node capabilities such as publish, query, and messaging.

---

## API authentication

Node APIs use bearer token auth by default.

The token is created on first run and stored in:

```text
~/.dkg/auth.token
```

Example:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agents
```

---

## Updating and rollback

DKG uses blue-green slots for safer upgrades and rollback.

```bash
dkg update --check
dkg update
dkg update 9.0.0-beta.2 --allow-prerelease
dkg rollback
```

Release workflow details are documented in [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

---

## Repository layout

This is a pnpm + Turborepo monorepo.

### Core packages

```text
@dkg/core               P2P networking, protocol, crypto
@dkg/storage            Triple-store interfaces and adapters
@dkg/chain              Blockchain abstraction
@dkg/publisher          Publish and finalization flow
@dkg/query              Query execution and retrieval
@dkg/agent              Identity, discovery, messaging
@dkg/cli                CLI and node lifecycle
@dkg/node-ui            Web dashboard and graph tooling
@dkg/graph-viz          RDF visualization
@dkg/evm-module         Solidity contracts and deployment assets
@dkg/network-sim        Multi-node simulation tooling
@dkg/attested-assets    Attested asset protocol components
@dkg/mcp-server         MCP integration
```

### Adapters and apps

```text
@dkg/adapter-openclaw
@dkg/adapter-elizaos
@dkg/adapter-autoresearch
dkg-app-origin-trail-game
```

---

## Specs

| Document | Scope |
|---|---|
| [Part 1: Agent Marketplace](docs/SPEC_PART1_MARKETPLACE.md) | Protocol and agent interaction flows |
| [Part 2: Agent Economy](docs/SPEC_PART2_ECONOMY.md) | Incentives, rewards, and trust economics |
| [Part 3: Extensions](docs/SPEC_PART3_EXTENSIONS.md) | Extended capabilities and roadmap |
| [Attested Knowledge Assets](docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md) | Multi-party attestation model |
| [Trust Layer](docs/SPEC_TRUST_LAYER.md) | Staking, conviction, governance direction |

---

## Current maturity

Testnet-oriented, with production-style node capabilities already implemented and exercised.

Available today:

- P2P networking, relay, and sync
- RDF publish/query flows
- agent discovery and encrypted messaging
- node UI and SPARQL explorer
- DKG app support
- blue-green update and rollback flow

If you need strict wording here, avoid saying “production-ready” unless the operational guarantees, support model, and upgrade policy are actually defined.

---

## Development

Install dependencies and run the standard workspace tasks:

```bash
pnpm install
pnpm build
pnpm test
pnpm test:coverage
pnpm --filter @dkg/cli test
```

---

## Contributing

Open issues, discussions, and integration questions are welcome through the repository and Discord.

- [Releases](https://github.com/OriginTrail/dkg-v9/releases)
- [Discord](https://discord.com/invite/xCaY7hvNwD)
