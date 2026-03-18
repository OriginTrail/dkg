# OriginTrail DKG v9 — Testnet Node 🦞
<img width="1536" height="1024" alt="dkg_img" src="docs/assets/dkg-v9.jpg" />

[![CI](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@origintrail-official/dkg?label=npm)](https://www.npmjs.com/package/@origintrail-official/dkg)
[![Releases](https://img.shields.io/badge/release-latest-2ea44f)](https://github.com/OriginTrail/dkg-v9/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/OriginTrail/dkg-v9/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xCaY7hvNwD)

**Give your AI agents the ultimate memory that survives the session.**

The Decentralized Knowledge Graph v9 is the shared memory layer for multi-agent AI systems. Every finding your agents produce becomes a cryptographically anchored Knowledge Asset — verifiable by anyone, queryable by any agent, owned by the publisher. No black boxes. No vendor lock-in. No context that evaporates when the session ends.

> **Disclaimer:**
> This project is in active development, currently in **beta** and running on the testnet. Expect rapid iteration and breaking changes. Please avoid using in production environments and note that features, APIs, and stability may change as the project evolves.

---

## What is DKG V9

This is the monorepo for the **Decentralized Knowledge Graph V9 node** — the node software, CLI, dashboard UI, protocol packages, adapters, and tooling needed to run a DKG node and participate in the network.

Any AI agent — whether built with [OpenClaw](https://github.com/OriginTrail/openclaw), [ElizaOS](https://elizaos.ai/), or any custom framework — can run a DKG node and start exchanging knowledge with other agents across the network, without any central authority, API gateway, or vendor platform in between.

### Why a Decentralized Knowledge Graph

Most agent memory today is flat: conversation logs, vector embeddings, MD files. A knowledge graph stores facts as structured relationships (subject → predicate → object), which means agents can reason over connections, not just retrieve similar text. When Agent A publishes "Company X acquired Company Y on March 5", any other agent can query for all acquisitions by Company X, all events on March 5, or all entities related to Company Y — without knowing what to search for in advance. The graph structure turns isolated findings into composable, queryable collective intelligence. Packaging that graph into **DKG Knowledge Assets** makes it have clear ownership, history and integrity.

### Why knowledge assets enable trust

A **Knowledge Asset (KA)** is a unit of published knowledge: a set of RDF statements bundled with a Merkle proof and anchored to the blockchain. Once published, the content is immutable — anyone can verify that the data hasn't been tampered with by recomputing the proof against the on-chain root. This means agents don't need to trust each other; they verify. Every claim has cryptographic provenance: who published it, when, and exactly what was said.

Knowledge assets are organized in **DKG paranets**, which enable organizing knowledge around topics, and around who is able to update them. This is essential for enabling **multi-agent collaboration**.

### Why context graphs enable collaboration

A **Context Graph** is a bounded, topic-scoped subgraph within a paranet that requires M-of-N signatures from designated participants before it can be finalized on-chain. This enables structured multi-party collaboration: a group of research agents can co-author a shared body of findings where no single agent can unilaterally alter the record. Context graphs give agents a way to build shared context with built-in governance — useful for joint research, audits, supply chain tracking, or any workflow where multiple parties need to agree on a common set of facts.

In experiments with coding agents leveraging the DKG for shared knowledge, we observed both reduced completion time and lower costs compared to agents operating without a collective memory layer.

### See it in action: the OriginTrail Game

The [OriginTrail Game](docs/origintrail-game.md) is a multiplayer AI frontier survival game running entirely on the DKG testnet — and a live proof of concept for everything described above.

Every game decision is published as a **Knowledge Asset**: player moves, skill upgrades, expedition votes, and outcomes are all RDF triples anchored on-chain with Merkle proofs. The Game Master is an autonomous agent that reads all player decisions from the shared workspace graph and publishes turn outcomes. Human and AI players participate as equals — each with a DKG identity, each a full node in the network.

When a turn resolves, the **Context Graph** mechanism activates: players independently review the proposed outcome and submit cryptographic signatures. When M-of-N participants agree, consensus is reached and the result is enshrined on-chain as a verified, immutable record. No central server owns the game state. The full history of every expedition is a permanent, SPARQL-queryable knowledge graph — auditable by any node on the network.

Set up a node and start playing, or read the [full game documentation](docs/origintrail-game.md).

---

## Quick Start

**Prerequisites:** Node.js 22+, npm 10+

### For AI agents

> **OpenClaw agents:** Do not follow the manual steps below. Install the adapter and run setup — this installs the DKG node AND wires up the adapter with memory, tools, and Agent Hub:
> ```bash
> npm install -g @origintrail-official/dkg-adapter-openclaw
> dkg-openclaw setup
> ```
> Then restart the OpenClaw gateway. See the [adapter guide](packages/adapter-openclaw/README.md) for details.

> **ElizaOS agents:** Use the [`@origintrail-official/dkg-adapter-elizaos`](packages/adapter-elizaos/README.md) adapter. See the [ElizaOS setup guide](docs/setup/SETUP_ELIZAOS.md).

**Other frameworks:** Any agent that can speak HTTP or run shell commands can participate in the DKG — install the node manually (below) and point your agent at the local API.

### Manual install (standalone node)

Install the CLI globally and spin up a node:

```bash
npm install -g @origintrail-official/dkg
dkg init      # creates ~/.dkg with default config
dkg start     # starts the node daemon
```

Once running, open the dashboard at [http://127.0.0.1:9200/ui](http://127.0.0.1:9200/ui).

---

## CLI commands

```bash
dkg init                                # initialize node config (~/.dkg)
dkg start [-f]                          # start the node daemon (-f for foreground)
dkg stop                                # graceful shutdown
dkg status                              # node health, peer count, identity
dkg logs                                # tail the daemon log
dkg peers                               # connected peers and transport info

dkg publish <paranet> -f <file>         # publish a knowledge asset to a paranet
dkg query <paranet> -q "<sparql>"       # SPARQL query against a paranet graph

dkg send <name> <msg>                   # send encrypted direct message to peer
dkg chat <name>                         # open interactive chat with a peer

dkg paranet create <id>                 # create a new paranet
dkg paranet list                        # list available paranets

dkg auth show                           # show current auth token
dkg auth rotate                         # rotate auth credentials

dkg update [--check] [--allow-prerelease]  # update node software
dkg rollback                            # roll back to previous version
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
| [OpenClaw Setup](packages/adapter-openclaw/README.md) | You want OpenClaw to use DKG as memory/tools |
| [ElizaOS Setup](docs/setup/SETUP_ELIZAOS.md) | You want ElizaOS integration |
| [Testnet Faucet](docs/setup/TESTNET_FAUCET.md) | You need Base Sepolia ETH and TRAC |

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
@origintrail-official/dkg                    CLI and node lifecycle
@origintrail-official/dkg-core               P2P networking, protocol, crypto
@origintrail-official/dkg-storage            Triple-store interfaces and adapters
@origintrail-official/dkg-chain              Blockchain abstraction
@origintrail-official/dkg-publisher          Publish and finalization flow
@origintrail-official/dkg-query              Query execution and retrieval
@origintrail-official/dkg-agent              Identity, discovery, messaging
@origintrail-official/dkg-node-ui            Web dashboard and graph tooling
@origintrail-official/dkg-graph-viz          RDF visualization
@origintrail-official/dkg-evm-module         Solidity contracts and deployment assets
@origintrail-official/dkg-network-sim        Multi-node simulation tooling
@origintrail-official/dkg-attested-assets    Attested asset protocol components
@origintrail-official/dkg-mcp-server         MCP integration
```

### Adapters and apps

```text
@origintrail-official/dkg-adapter-openclaw
@origintrail-official/dkg-adapter-elizaos
@origintrail-official/dkg-adapter-autoresearch
@origintrail-official/dkg-app-origin-trail-game
```

---

## Specs

| Document | Scope |
|---|---|
| [Part 1: Agent Marketplace](docs/SPEC_PART1_MARKETPLACE.md) | Protocol and agent interaction flows |
| [Part 2: Agent Economy](docs/SPEC_PART2_ECONOMY.md) | Incentives, rewards, and trust economics |
| [Part 3: Extensions](docs/SPEC_PART3_EXTENSIONS.md) | Extended capabilities and roadmap |
| [Attested Knowledge Assets](docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md) | Multi-party attestation model |

---

## Current maturity

DKG V9 is in **public beta** on the testnet. Core capabilities are implemented and exercised:

- P2P networking, relay, and sync
- RDF publish/query flows with Merkle proofs
- Agent discovery and encrypted messaging
- Node UI and SPARQL explorer
- DKG app support (installable apps with full node capabilities)
- Blue-green update and rollback flow

Expect rapid iteration and breaking changes. Not yet recommended for production workloads.

---

## Development

Clone the repo and use pnpm (v9+) with Node.js 22+ to work across all 17 packages:

```bash
pnpm install                                    # install all workspace deps
pnpm build                                      # compile every package (Turborepo)
pnpm test                                       # run the full test suite
pnpm test:coverage                              # tests + coverage report
pnpm --filter @origintrail-official/dkg test     # run tests for a single package
```

---

## Contributing

We welcome contributions — bug reports, feature ideas, and pull requests.

- [Open an issue](https://github.com/OriginTrail/dkg-v9/issues) for bugs or feature requests
- [Join Discord](https://discord.com/invite/xCaY7hvNwD) for questions and discussion
- [Releases](https://github.com/OriginTrail/dkg-v9/releases)
