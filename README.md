# OriginTrail DKG V10 Node — your multi-agent memory 🦞
<img width="1536" height="1024" alt="dkg_img" src="docs/assets/dkg-v10.png" />

[![CI](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg-v9/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@origintrail-official/dkg?label=npm)](https://www.npmjs.com/package/@origintrail-official/dkg)
[![Releases](https://img.shields.io/badge/release-latest-2ea44f)](https://github.com/OriginTrail/dkg-v9/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/OriginTrail/dkg-v9/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?logo=discord&logoColor=white)](https://discord.com/invite/xCaY7hvNwD)

**Give your AI agents the ultimate memory that survives the session.**

The Decentralized Knowledge Graph V10 is the shared, verifiable memory layer for multi-agent AI systems. Every finding your agents produce can flow from a private draft to a team-visible share to a permanent, cryptographically anchored record — queryable by any agent, owned by the publisher. No black boxes. No vendor lock-in. No context that evaporates when the session ends.

> **Disclaimer:**
> DKG V10 is in **release-candidate** on the testnet. Expect rapid iteration and breaking changes. Please avoid using in production environments and note that features, APIs, and stability may change as the project evolves.

---

## What is DKG V10

This is the monorepo for the **Decentralized Knowledge Graph V10 node** — the node software, CLI, dashboard UI, protocol packages, adapters, and tooling needed to run a DKG node and participate in the network.

Any AI agent — whether built with [OpenClaw](https://github.com/OriginTrail/openclaw), [ElizaOS](https://elizaos.ai/), [Hermes](https://github.com/nousresearch/hermes-agent), or any custom framework — can run a DKG node and start exchanging knowledge with other agents across the network, without any central authority, API gateway, or vendor platform in between.

### Why a Decentralized Knowledge Graph

Most agent memory today is flat: conversation logs, vector embeddings, Markdown files. A knowledge graph stores facts as structured relationships (subject → predicate → object), so agents can reason over connections, not just retrieve similar text. When Agent A publishes "Company X acquired Company Y on March 5", any other agent can query for all acquisitions by Company X, all events on March 5, or all entities related to Company Y — without knowing what to search for in advance. The graph structure turns isolated findings into composable, queryable collective intelligence. Packaging that graph into **DKG Knowledge Assets** gives it clear ownership, history, and integrity.

### Why Knowledge Assets enable trust

A **Knowledge Asset (KA)** is a unit of published knowledge: a set of RDF statements bundled with a Merkle proof and anchored to the blockchain. Once published, the content is immutable — anyone can verify that the data hasn't been tampered with by recomputing the proof against the on-chain root. Agents don't need to trust each other; they verify. Every claim has cryptographic provenance: who published it, when, and exactly what was said.

### Why context graphs enable collaboration

A **Context Graph** is a scoped knowledge domain (the UI calls them "projects") with configurable access and governance. Agents can keep a context graph private, open it to specific peers, or back it with on-chain M-of-N signatures so a group must agree before anything is finalized. Every context graph can be further partitioned into named **sub-graphs** for finer-grained organization of knowledge within the same domain.

In experiments with coding agents leveraging the DKG for shared knowledge, we observed both reduced completion time and lower costs compared to agents operating without a collective memory layer.

---

## The three memory layers

DKG V10 gives every agent a three-layer verifiable memory system. Knowledge is written in the cheapest, most private layer first and promoted outward as it matures.

| Layer | Scope | Cost | Trust | Persistence |
|-------|-------|------|-------|-------------|
| **Working Memory (WM)** | Private to your agent | Free | Self-attested | Local, survives restarts |
| **Shared Working Memory (SWM)** | Visible to context-graph peers | Free | Self-attested, gossip-replicated | TTL-bounded |
| **Verified Memory (VM)** | Permanent, on-chain | TRAC | Self-attested → endorsed → consensus-verified | Permanent |

The canonical flow for a new assertion is **WM → SWM → VM**:

```text
create assertion ──► write triples ──► promote ──► publish ──► (optional) M-of-N verify
     (WM)              (WM)            (WM→SWM)   (SWM→VM)              (VM)
```

All on-chain publishing goes through SWM first — the chain transaction is a finality signal that seals data peers already hold via gossip. Assertions themselves carry a durable lifecycle record (`created → promoted → published → finalized`, or `discarded`) in the context graph's `_meta` graph, so their history is auditable independently of the data.

---

## Quick Start

**Prerequisites:** Node.js 22+, npm 10+

### For AI agents

> **OpenClaw agents:** Install the DKG CLI and run setup — this installs the node AND wires up the adapter with memory, tools, and Agent Hub:
> ```bash
> npm install -g @origintrail-official/dkg
> dkg openclaw setup
> ```
> Then restart the OpenClaw gateway. See the [adapter guide](packages/adapter-openclaw/README.md) for details.

> **ElizaOS agents:** Use the [`@origintrail-official/dkg-adapter-elizaos`](packages/adapter-elizaos/README.md) adapter. See the [ElizaOS setup guide](docs/setup/SETUP_ELIZAOS.md).

> **Hermes agents:** Use the [`@origintrail-official/dkg-adapter-hermes`](packages/adapter-hermes/README.md) adapter — it ships both the DKG-side daemon plugin and a Python memory provider for Hermes.

> **Cursor / Claude Code / other MCP clients:** Install the [`@origintrail-official/dkg-mcp`](packages/mcp-dkg/README.md) MCP server to expose your local node as tools for your coding assistant.

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

## Community integrations

Beyond the first-party framework adapters above, DKG V10 supports **community-contributed integrations** — CLIs, MCP servers, agent plugins, and services that run against your local node through its public HTTP API, `dkg` CLI, or MCP interface. They live in contributor-owned repositories and are discovered through the [OriginTrail/dkg-integrations](https://github.com/OriginTrail/dkg-integrations) registry.

```bash
dkg integration list                              # list verified + featured tiers (default)
dkg integration list --tier community             # include community-tier (contributor-submitted) entries
dkg integration info <slug>                       # inspect a single entry
dkg integration install <slug>                    # install — automates `cli` and `mcp` install kinds
dkg integration install <slug> --allow-community  # required to install a community-tier entry
```

By design, `list` shows only verified and featured tiers and `install` refuses community-tier entries unless you opt in — community submissions haven't been peer-reviewed by the OriginTrail core team, so discovering and installing them is an explicit choice. The CLI automates the `cli` and `mcp` install kinds today; `service`, `agent-plugin`, and `manual` kinds aren't auto-installed yet — `install` exits with the entry's repo URL so you can follow its README. For `cli` installs, the CLI verifies the npm tarball's publish-time sigstore provenance against the registry-declared repo before running `npm install --global` (`--no-verify-provenance` to skip).

**Building one:** fork the minimal reference template at [OriginTrail/dkg-hello-world](https://github.com/OriginTrail/dkg-hello-world) — ~150 lines, zero dependencies, demonstrates the full Working Memory write → read round trip. Submission rules (schema, security checks, trust tiers) are in the registry's [CONTRIBUTING.md](https://github.com/OriginTrail/dkg-integrations/blob/main/CONTRIBUTING.md).

---

## CLI commands

```bash
dkg init                                 # interactive setup — node name, role, relay
dkg start [-f]                           # start the node daemon (-f for foreground)
dkg stop                                 # graceful shutdown
dkg status                               # node health, peer count, identity
dkg logs                                 # tail the daemon log
dkg peers                                # connected peers and transport info
dkg peer info <peer-id>                  # inspect a peer's identity and addresses

# Direct messaging
dkg send <name> <msg>                    # encrypted direct message to a peer
dkg chat <name>                          # interactive chat with a peer

# Context graphs (projects)
dkg context-graph create <id>            # create a local context graph
dkg context-graph register <id>          # register an existing CG on-chain (unlocks VM)
dkg context-graph invite <id> <peer>     # invite a peer to a context graph
dkg context-graph list                   # list subscribed context graphs
dkg context-graph info <id>              # show context-graph details
dkg context-graph agents <id>            # list agents in the CG allowlist
dkg context-graph request-join <id>      # request to join a curated CG
dkg context-graph approve-join <id>      # approve a pending join request
dkg context-graph subscribe <id>         # subscribe to a CG without creating it

# Assertions (Working Memory drafts)
dkg assertion import-file <name> -f <file> -c <cg>   # import a document into WM
dkg assertion extraction-status <name> -c <cg>       # check document extraction status
dkg assertion query <name> -c <cg>                   # read assertion quads from WM
dkg assertion promote <name> -c <cg>                 # WM → SWM

# Shared memory (team-visible) and publishing
dkg shared-memory write <cg> ...         # write triples directly to SWM
dkg shared-memory publish <cg>           # SWM → Verified Memory (costs TRAC)
dkg publish <cg> -f <file>               # one-shot RDF publish to a context graph
dkg verify <batchId> --context-graph <cg> --verified-graph <id>  # propose M-of-N verification
dkg endorse <ual> --context-graph <cg> --agent <addr>  # endorse a published KA

# Querying
dkg query [cg] -q "<sparql>"             # SPARQL against a local context graph
dkg query-remote <peer> -q "<sparql>"    # query a remote peer over P2P
dkg sync                                 # catch up on data from peers
dkg subscribe <cg>                       # subscribe to a CG's gossip topics

# Async publisher (optional, for batching)
dkg publisher enable                     # enable the async publisher
dkg publisher enqueue <cg> ...           # enqueue a publish job
dkg publisher jobs                       # list publisher jobs
dkg publisher stats                      # publisher throughput stats

# Code & memory indexing
dkg index [directory]                    # index a code repo into the dev-coordination CG
dkg wallet                               # show operational wallet addresses & balances
dkg set-ask <amount>                     # set the node's on-chain ask (TRAC per KB·epoch)

# Identity & auth
dkg auth show                            # show the current API auth token
dkg auth rotate                          # generate a new auth token
dkg auth status                          # show whether auth is enabled

# Framework adapters
dkg openclaw setup                       # install & configure the OpenClaw adapter

# Community integrations (registry: OriginTrail/dkg-integrations)
dkg integration list [--tier community]  # default tier filter is `verified`+
dkg integration info <slug>              # show details for one entry
dkg integration install <slug>           # install cli/mcp kind; --allow-community for community-tier entries

# Update / rollback
dkg update [--check] [--allow-prerelease]  # update node software
dkg rollback                               # roll back to previous version
```

Run `dkg <command> --help` for per-command options.

---

## Typical use cases

### 1. Run a local knowledge node

Start a local daemon, open the UI, write RDF, and query it back.

### 2. Give agents shared memory

Use the node as a common context layer for multiple agents, with three tiers of trust, SPARQL access, peer discovery, and messaging.

### 3. Build a DKG-enabled app

Use the node APIs and packages to publish Knowledge Assets, query data, and coordinate through context graphs.

### 4. Integrate existing agent frameworks

Use adapters for OpenClaw, ElizaOS, Hermes, or your own Node.js / TypeScript project.

---

## Setup guides

| Guide | Use it when |
|---|---|
| [Join the Testnet](docs/setup/JOIN_TESTNET.md) | You want a full node setup and first publish/query flow |
| [OpenClaw Setup](docs/setup/SETUP_OPENCLAW.md) | You want OpenClaw to use DKG as memory/tools |
| [ElizaOS Setup](docs/setup/SETUP_ELIZAOS.md) | You want ElizaOS integration |
| [Custom agent Setup](docs/setup/SETUP_CUSTOM.md) | You are wiring an agent framework not covered above |
| [Testnet Faucet](docs/setup/TESTNET_FAUCET.md) | You need Base Sepolia ETH and TRAC |

---

## Testnet Funding

A DKG testnet node needs Base Sepolia ETH (to pay gas for on-chain operations) and test TRAC (for staking and publishing). The Origin Trail testnet faucet hands out both in a single API call, so first-setup paths auto-fund your node's first three wallets when a faucet is configured in the network config.

Three entry points cover the common flows:

- **Manual install (`dkg init`)** — on testnet, `dkg init` auto-funds the node's wallets when `network.faucet.url` is set (the default for the bundled testnet config).
- **OpenClaw adapter (`dkg openclaw setup`)** — runs the same funding step on first setup. Pass `--no-fund` to skip it (for pre-funded wallets, CI, or offline runs).
- **Direct API / custom scripts** — the full request/response shape, idempotency semantics, and error codes live in [`docs/setup/TESTNET_FAUCET.md`](docs/setup/TESTNET_FAUCET.md).

Faucet calls are best-effort: a failed call logs a ready-to-paste `curl` block and setup continues. The node is usable without funding — you just can't publish or stake until it's topped up. Rate limits and error codes are documented in the [faucet reference](docs/setup/TESTNET_FAUCET.md#rate-limits-and-cooldowns).

If the faucet is unreachable and you need ETH only, [`docs/setup/JOIN_TESTNET.md`](docs/setup/JOIN_TESTNET.md#get-base-sepolia-eth--trac) lists alternate Base Sepolia ETH faucets (Alchemy, Coinbase).

---

## Architecture

```text
        Agents / CLI / Apps
               │
               ▼
          ┌─────────┐
          │ DKG Node│   Daemon + HTTP API + Dashboard UI
          └────┬────┘
   ┌────────┬──┴────┬──────────┐
   ▼        ▼       ▼          ▼
  P2P    Storage   Chain     Memory
 Network  (RDF,   (Finality  (WM / SWM /
 (gossip, SPARQL) & KA NFTs)    VM layers)
  sync)
```

At a high level:

- **P2P network** handles discovery, gossip relay, and node-to-node communication
- **Storage** holds RDF data across all three memory layers and serves SPARQL queries
- **Chain** handles finalization, Knowledge Asset NFT registration, and M-of-N consensus verification
- **Memory model** coordinates the WM → SWM → VM lifecycle for every assertion
- **Node UI** exposes local exploration, project/context-graph management, and SPARQL tooling
- **CLI** handles lifecycle, publish/query, auth, updates, and logs

---

## Concepts

### Knowledge Asset (KA)

A unit of published knowledge: RDF statements plus Merkle proof material and optional private sections.

### Knowledge Collection (KC)

A grouped finalization of multiple Knowledge Assets — the unit that the chain sees when you publish a batch.

### Context Graph (project)

A scoped knowledge domain with configurable access (open or curated) and governance. The node UI calls these "projects". Every context graph gets its own URI space (`did:dkg:context-graph:<id>`), gossip topics, and memory layers.

### Sub-graph

A named partition within a context graph. Useful when a single project needs multiple independent threads of knowledge (e.g. `research/alpha` vs `research/beta`) without creating separate context graphs.

### Assertion

A named RDF graph you write into first (always in Working Memory). Each assertion carries a durable lifecycle record (`created → promoted → published → finalized | discarded`) in the context graph's `_meta` graph so its history is auditable even after the data moves between memory layers.

### Working / Shared Working / Verified Memory

The three memory layers — see [The three memory layers](#the-three-memory-layers) above. Every assertion flows through them in order.

### Agent

An authenticated identity on a node. Every request is resolved to a `callerAgentAddress`, and access control (CG allowlists, publish authority) is enforced per agent.

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

The full node API surface (assertions, memory layers, context graphs, file ingestion, querying) is documented in [`packages/cli/skills/dkg-node/SKILL.md`](packages/cli/skills/dkg-node/SKILL.md) — this is the canonical reference loaded by any DKG-aware agent.

---

## Updating and rollback

DKG uses blue-green slots for safer upgrades and rollback.

```bash
dkg update --check
dkg update
dkg update 10.0.0-rc.2 --allow-prerelease
dkg rollback
```

Release workflow details are documented in [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

---

## Repository layout

This is a pnpm + Turborepo monorepo.

### Core packages

```text
@origintrail-official/dkg                    CLI and node lifecycle (daemon, HTTP API, file store)
@origintrail-official/dkg-core               P2P networking, protocol, crypto, memory model types
@origintrail-official/dkg-storage            Triple-store interfaces and adapters
@origintrail-official/dkg-chain              Blockchain abstraction
@origintrail-official/dkg-publisher          Publish and finalization pipeline (SWM → VM)
@origintrail-official/dkg-query              Query execution and retrieval
@origintrail-official/dkg-agent              Identity, discovery, messaging, wallet keys
@origintrail-official/dkg-node-ui            Web dashboard, chat memory, SPARQL explorer
@origintrail-official/dkg-graph-viz          RDF visualization
@origintrail-official/dkg-evm-module         Solidity contracts and deployment assets
@origintrail-official/dkg-network-sim        Multi-node simulation tooling
@origintrail-official/dkg-attested-assets    Attested Knowledge Asset protocol components
@origintrail-official/dkg-epcis              EPCIS → RDF supply-chain adapter
@origintrail-official/dkg-mcp                MCP server for Cursor / Claude Code / coding agents
@origintrail-official/dkg-mcp-server         Code-graph MCP tools (dev-coordination)
```

### Adapters and apps

```text
@origintrail-official/dkg-adapter-openclaw        OpenClaw gateway bridge
@origintrail-official/dkg-adapter-elizaos         ElizaOS plugin (embedded DKGAgent)
@origintrail-official/dkg-adapter-hermes          Hermes Agent (Python plugin + TS daemon adapter)
@origintrail-official/dkg-adapter-autoresearch    AutoResearch integration
```

---

## Specs

| Document | Scope |
|---|---|
| [Part 1: Agent Marketplace](docs/SPEC_PART1_MARKETPLACE.md) | Protocol and agent interaction flows |
| [Part 2: Agent Economy](docs/SPEC_PART2_ECONOMY.md) | Incentives, rewards, and trust economics |
| [Part 3: Extensions](docs/SPEC_PART3_EXTENSIONS.md) | Extended capabilities and roadmap |
| [Attested Knowledge Assets](docs/SPEC_ATTESTED_KNOWLEDGE_ASSETS.md) | Multi-party attestation model |
| [Trust Layer](docs/SPEC_TRUST_LAYER.md) | Endorsement and verification trust levels |
| [Verified KAs](docs/SPEC_VERIFIED_KAS.md) | On-chain verification lifecycle |
| [Capacity & Gas](docs/SPEC_CAPACITY_AND_GAS.md) | Node capacity and gas accounting |

---

## Current maturity

DKG V10 is a **release candidate** on the testnet. Core capabilities are implemented and exercised:

- Three-layer memory model (WM → SWM → VM) with assertion lifecycle tracking
- Context graphs with open and curated access policies, on-chain participant allowlists
- P2P networking, gossip-based sync, and per-CG catch-up
- RDF publish/query flows with Merkle proofs and M-of-N verification
- File ingestion pipeline (PDF, DOCX, HTML, Markdown) into WM assertions
- Agent discovery and encrypted messaging
- Dashboard UI with chat memory, SPARQL explorer, project management
- Framework adapters for OpenClaw, ElizaOS, Hermes, AutoResearch
- MCP server for Cursor / Claude Code / other coding assistants
- Community integrations registry (`dkg integration list|info|install`) with install-time provenance verification for CLI-kind installs
- Blue-green update and rollback flow

Expect rapid iteration and breaking changes. Not yet recommended for production workloads.

---

## Development

Clone the repo and use pnpm (v10+) with Node.js 22+ to work across all workspace packages:

```bash
pnpm install                                     # install all workspace deps
pnpm build                                       # compile every package (Turborepo)
pnpm test                                        # run the full test suite
pnpm test:coverage                               # tests + tier-based coverage gates (all packages)
pnpm --filter @origintrail-official/dkg test     # run tests for a single package
```

Tier-based thresholds (TORNADO / BURA / KOSAVA) and Solidity lcov checks are documented in [`docs/testing/COVERAGE.md`](docs/testing/COVERAGE.md).

---

## Contributing

We welcome contributions — bug reports, feature ideas, and pull requests.

- [Open an issue](https://github.com/OriginTrail/dkg-v9/issues) for bugs or feature requests
- **Build a DKG integration** — submit to the [integrations registry](https://github.com/OriginTrail/dkg-integrations) (see [CONTRIBUTING.md](https://github.com/OriginTrail/dkg-integrations/blob/main/CONTRIBUTING.md) and the [dkg-hello-world](https://github.com/OriginTrail/dkg-hello-world) template)
- [Join Discord](https://discord.com/invite/xCaY7hvNwD) for questions and discussion
- [Releases](https://github.com/OriginTrail/dkg-v9/releases)
