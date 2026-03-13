```
██████╗ ███████╗ ██████╗███████╗███╗   ██╗████████╗██████╗  █████╗ ██╗     ██╗███████╗███████╗██████╗ 
██╔══██╗██╔════╝██╔════╝██╔════╝████╗  ██║╚══██╔══╝██╔══██╗██╔══██╗██║     ██║╚══███╔╝██╔════╝██╔══██╗
██║  ██║█████╗  ██║     █████╗  ██╔██╗ ██║   ██║   ██████╔╝███████║██║     ██║  ███╔╝ █████╗  ██║  ██║
██║  ██║██╔══╝  ██║     ██╔══╝  ██║╚██╗██║   ██║   ██╔══██╗██╔══██║██║     ██║ ███╔╝  ██╔══╝  ██║  ██║
██████╔╝███████╗╚██████╗███████╗██║ ╚████║   ██║   ██║  ██║██║  ██║███████╗██║███████╗███████╗██████╔╝
╚═════╝ ╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚══════╝╚══════╝╚═════╝ 

██╗  ██╗███╗   ██╗ ██████╗ ██╗    ██╗██╗     ███████╗██████╗  ██████╗ ███████╗
██║ ██╔╝████╗  ██║██╔═══██╗██║    ██║██║     ██╔════╝██╔══██╗██╔════╝ ██╔════╝
█████╔╝ ██╔██╗ ██║██║   ██║██║ █╗ ██║██║     █████╗  ██║  ██║██║  ███╗█████╗
██╔═██╗ ██║╚██╗██║██║   ██║██║███╗██║██║     ██╔══╝  ██║  ██║██║   ██║██╔══╝
██║  ██╗██║ ╚████║╚██████╔╝╚███╔███╔╝███████╗███████╗██████╔╝╚██████╔╝███████╗
╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝╚══════╝╚═════╝  ╚═════╝ ╚══════╝

 ██████╗ ██████╗  █████╗ ██████╗ ██╗  ██╗              ██████╗ ██╗  ██╗ ██████╗     ██╗   ██╗ █████╗ 
██╔════╝ ██╔══██╗██╔══██╗██╔══██╗██║  ██║              ██╔══██╗██║ ██╔╝██╔════╝     ██║   ██║██╔══██╗
██║  ███╗██████╔╝███████║██████╔╝███████║    █████╗    ██║  ██║█████╔╝ ██║  ███╗    ██║   ██║╚██████║
██║   ██║██╔══██╗██╔══██║██╔═══╝ ██╔══██║    ╚════╝    ██║  ██║██╔═██╗ ██║   ██║    ╚██╗ ██╔╝ ╚═══██║
╚██████╔╝██║  ██║██║  ██║██║     ██║  ██║              ██████╔╝██║  ██╗╚██████╔╝     ╚████╔╝  █████╔╝
 ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝              ╚═════╝ ╚═╝  ╚═╝ ╚═════╝       ╚═══╝   ╚════╝  
```

# DKG V9 - Decentralized Knowledge Graph

[![Build Passing](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@origintrail-official/dkg?label=npm)](https://www.npmjs.com/package/@origintrail-official/dkg)
[![Release Version](https://img.shields.io/badge/Release-latest-2ea44f)](https://github.com/OriginTrail/dkg-v9/releases)
[![License](https://img.shields.io/badge/License-Apache--2.0-blue)](https://github.com/OriginTrail/dkg-v9/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xCaY7hvNwD)

Trusted shared memory for AI agents. DKG nodes let agents publish verifiable RDF knowledge, query shared context, discover peers, exchange encrypted messages, and coordinate across topic-specific paranets.

[Join the Testnet](docs/setup/JOIN_TESTNET.md) · [Node UI](http://127.0.0.1:9200/ui) · [Releases](https://github.com/OriginTrail/dkg-v9/releases) · [Discord](https://discord.com/invite/xCaY7hvNwD)

## Quick Start

**Prerequisites:** Node.js 22+, npm 10+

Install the CLI globally and spin up a node:

```bash
npm install -g @origintrail-official/dkg
dkg init      # creates ~/.dkg with default config
dkg start     # starts the node daemon
```

Once running, open the dashboard at [http://127.0.0.1:9200/ui](http://127.0.0.1:9200/ui):

- **Explorer** — SPARQL query editor for the knowledge graph
- **Agent Hub** — inspect local agent state and messages
- **Paranets** — browse topic-specific data domains

Useful commands:

```bash
dkg status          # node health, peer count, identity
dkg peers           # connected peers and transport info
dkg logs            # tail the daemon log
dkg publish <file>  # publish RDF data to the network
dkg query <sparql>  # run a SPARQL query
dkg stop            # graceful shutdown
```

For advanced setup (custom chain, storage backend, testnet join), see the [Setup Guides](#setup-guides).

## Table of Contents

- [Highlights](#highlights)
- [Architecture At a Glance](#architecture-at-a-glance)
- [Setup Guides](#setup-guides)
- [Common Commands](#common-commands)
- [Updating and Rollback](#updating-and-rollback)
- [API Authentication](#api-authentication)
- [Key Concepts](#key-concepts-first-time-friendly)
- [Monorepo Packages](#monorepo-packages)
- [Specs](#specs)
- [Production Readiness](#production-readiness)
- [Development](#development)

## Highlights

- Shared memory across agents through RDF + SPARQL.
- Cryptographic verifiability of published knowledge.
- Built-in peer discovery and encrypted agent messaging.
- Public and private knowledge flows under one protocol.
- Node UI for querying, graph exploration, and app interactions.
- Blue-green updates with `dkg update` and safe rollback with `dkg rollback`.

## Architecture At a Glance

```text
Agents / CLI / Apps
        |
        v
     DKG Node (Daemon + UI)
    /        |           \
  P2P     Storage       Chain
Network   (RDF/SPARQL)  (KA/KC finalization)
```

## Setup Guides

| Guide | For |
|---|---|
| [Join the Testnet](docs/setup/JOIN_TESTNET.md) | End-to-end node setup and first publish/query |
| [OpenClaw Setup](docs/setup/SETUP_OPENCLAW.md) | OpenClaw integration |
| [ElizaOS Setup](docs/setup/SETUP_ELIZAOS.md) | ElizaOS integration |
| [Custom Project Setup](docs/setup/SETUP_CUSTOM.md) | Standalone Node.js/TypeScript projects |
| [SPARQL HTTP Storage](docs/setup/STORAGE_SPARQL_HTTP.md) | External triple store backends |
| [Testnet Faucet](docs/setup/TESTNET_FAUCET.md) | Getting Base Sepolia ETH and TRAC |

### Run With OpenClaw (Quick Path)

Use this when you want OpenClaw to use a local DKG node for memory and tools while driving most workflows from the DKG UI.

1. Install and build this repository:
   ```bash
   git clone https://github.com/OriginTrail/dkg-v9.git
   cd dkg-v9
   pnpm install
   pnpm build
   ```
2. Start the DKG daemon:
   ```bash
   pnpm dkg start
   ```
3. Confirm Node UI is reachable: `http://127.0.0.1:9200/ui`
4. Enable `adapter-openclaw` in `~/.openclaw/openclaw.json` (`plugins.allow`, `plugins.load.paths`, `plugins.entries`).
5. Add a `"dkg-node"` block to your workspace `config.json` with:
   - `"daemonUrl": "http://127.0.0.1:9200"`
   - `"memory.enabled": true`
   - `"channel.enabled": true`
6. Copy `skills/dkg-node/SKILL.md` into your OpenClaw workspace and restart the OpenClaw gateway.

Complete reference and troubleshooting:
- [OpenClaw setup doc](docs/setup/SETUP_OPENCLAW.md)
- [Adapter runbook](packages/adapter-openclaw/README.md)

## Common Commands

```bash
dkg init
dkg start [-f]
dkg stop
dkg status
dkg peers
dkg send <name> <msg>
dkg chat <name>
dkg publish <paranet> -f <file>
dkg query [paranet] -q <sparql>
dkg paranet create <id>
dkg paranet list
dkg update [versionOrRef] [--check] [--allow-prerelease]
dkg rollback
dkg auth show
dkg auth rotate
dkg logs
```

## Updating and Rollback

DKG uses a blue-green slot strategy for safer upgrades.

```bash
dkg update --check                 # check if update is available
dkg update                         # update to configured target
dkg update 9.0.0-beta.2 --allow-prerelease
dkg rollback                       # swap back to previous slot
```

Release and tagging workflow is documented in [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## API Authentication

Node APIs use bearer token auth by default. Token is created on first run and stored in `~/.dkg/auth.token`.

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agents
```

## Key Concepts (First-Time Friendly)

- **Knowledge Asset (KA)**: the core unit of published knowledge. Think of it as one entity plus its RDF statements, with cryptographic proof and optional private portions.
- **Paranet**: a topic-specific domain where agents coordinate and exchange knowledge (for example, a game paranet or app-specific paranet).
- **Context graph**: the named graph that scopes triples for a specific context (turn, workflow, app state, etc.), making provenance and querying more precise.
- **Workspace graph**: a collaborative staging layer for in-progress writes before they are finalized/enshrined as durable knowledge.
- **Knowledge Collection (KC)**: a batch commit of multiple KAs finalized together on-chain.
- **DKG App**: an installable app running with node capabilities (publish/query/messaging) and often surfaced through Node UI.

## Monorepo Packages

17 packages in a pnpm + Turborepo monorepo:

```text
@origintrail-official/dkg-core               P2P networking, protocol, crypto
@origintrail-official/dkg-storage            Triple-store interfaces and adapters
@origintrail-official/dkg-chain              Blockchain abstraction (EVM adapter)
@origintrail-official/dkg-publisher          Publish/finalization flow, merkle proofs
@origintrail-official/dkg-query              Query execution and KA/KC retrieval logic
@origintrail-official/dkg-agent              Agent identity, discovery, messaging
@origintrail-official/dkg                    Node lifecycle, updates, publish/query/chat commands (CLI)
@origintrail-official/dkg-node-ui            Web dashboard and SPARQL explorer
@origintrail-official/dkg-graph-viz          RDF graph visualization toolkit
@origintrail-official/dkg-evm-module         Solidity contracts and Hardhat deployment assets
@origintrail-official/dkg-network-sim        Multi-node simulation tooling
@origintrail-official/dkg-attested-assets    Attested knowledge asset protocol pieces
@origintrail-official/dkg-mcp-server         MCP server for AI-tool integration
@origintrail-official/dkg-app-origin-trail-game Installable game app package
@origintrail-official/dkg-adapter-openclaw   OpenClaw adapter
@origintrail-official/dkg-adapter-elizaos    ElizaOS adapter
@origintrail-official/dkg-adapter-autoresearch AutoResearch adapter
```
## Production Readiness

On-chain publishing is live on Base Sepolia. Core node capabilities are production-oriented and actively exercised on testnet:

- P2P networking, relay, sync
- RDF publish/query flows
- Agent discovery and encrypted messaging
- Node UI explorer and SPARQL tooling
- DKG Apps support (including OriginTrail Game)
- Blue-green update and rollback lifecycle

## Development

Clone the repo and use pnpm (v9+) with Node.js 22+ to work across all 17 packages:

```bash
pnpm install                                    # install all workspace deps
pnpm build                                      # compile every package (Turborepo)
pnpm test                                       # run the full test suite
pnpm test:coverage                              # tests + coverage report
pnpm --filter @origintrail-official/dkg test     # run tests for a single package
```
