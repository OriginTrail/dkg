# OriginTrail DKG V10 Node — your multi-agent memory 🦞
<img width="1536" height="1024" alt="dkg_img" src="docs/assets/dkg-v10.png" />

[![CI](https://github.com/OriginTrail/dkg/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OriginTrail/dkg/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@origintrail-official/dkg?label=npm)](https://www.npmjs.com/package/@origintrail-official/dkg)
[![Releases](https://img.shields.io/badge/release-latest-2ea44f)](https://github.com/OriginTrail/dkg/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/OriginTrail/dkg/blob/main/LICENSE)
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
| **Verifiable Memory (VM)** | Permanent, on-chain | TRAC | Self-attested → endorsed → consensus-verified | Permanent |

The canonical flow for a new assertion is **WM → SWM → VM**:

```text
create assertion ──► write triples ──► promote ──► publish ──► (optional) M-of-N verify
     (WM)              (WM)            (WM→SWM)   (SWM→VM)              (VM)
```

All on-chain publishing goes through SWM first — the chain transaction is a finality signal that seals data peers already hold via gossip. Assertions themselves carry a durable lifecycle record (`created → promoted → published → finalized`, or `discarded`) in the context graph's `_meta` graph, so their history is auditable independently of the data.

SWM gossip is signed when the node has a local agent private key. Context graphs
that declare `DKG_ALLOWED_AGENT` or `DKG_PARTICIPANT_AGENT` require a signed
`GossipEnvelope` from one of those agent addresses; unsigned legacy SWM payloads
are accepted only for context graphs without agent gates. Signatures authenticate
the writer, but do not encrypt GossipSub payload bytes.

---

## Quick Start

**Prerequisites:** Node.js 22+, npm 10+. macOS, Linux, and Windows (PowerShell 5.1+ or WSL2) all supported.

### Hermes adapter

Two commands:

```bash
npm install -g @origintrail-official/dkg
dkg hermes setup
```

`dkg hermes setup` bootstraps the DKG node config (no separate `dkg init` needed), starts the daemon, optionally funds wallets, and wires the Hermes profile with replace-by-default provider election (use `--preserve-provider` to opt out, `--no-start` / `--no-fund` for advanced flows). See the [adapter guide](packages/adapter-hermes/README.md) for details.

**Network:** setup defaults to **mainnet-gnosis**; pass `--network <mainnet-gnosis | mainnet-base | testnet>` to choose another. Mainnet nodes have no faucet; testnet nodes auto-fund their wallets when the faucet is reachable.

### OpenClaw adapter

Two commands:

```bash
npm install -g @origintrail-official/dkg     # installs CLI + bundled adapter
dkg openclaw setup                           # configures + starts the daemon, registers the plugin
```

`dkg openclaw setup` is non-interactive and idempotent. It writes `~/.dkg/config.json`, merges the adapter into `~/.openclaw/openclaw.json` (under `plugins.entries.adapter-openclaw.config` — `daemonUrl`, `memory.enabled`, `channel.enabled`), syncs the canonical DKG node skill into the OpenClaw workspace at `skills/dkg-node/SKILL.md`, and verifies the install. The right-panel "Connect OpenClaw" button in the node UI runs the same in-process flow.

Restart the OpenClaw gateway if it does not auto-reload:

```bash
openclaw gateway restart
```

**First-run verification.** A healthy setup satisfies all four:

- `dkg_status` works from the OpenClaw agent
- The DKG node UI loads at `http://127.0.0.1:9200/ui`
- The right-side chat surface connects to OpenClaw and a sent message round-trips
- The conversation survives a UI reload (proves DKG-backed chat persistence)

**Network:** setup defaults to **mainnet-gnosis**; pass `--network <mainnet-gnosis | mainnet-base | testnet>` to choose another. Mainnet nodes have no faucet; testnet nodes auto-fund their wallets when the faucet is reachable.

**Flags.** `--network <name>` (choose network), `--no-fund` (skip faucet), `--no-start` (configure only), `--no-verify` (skip verification), `--dry-run` (preview without writing). Faucet funding is best-effort: a failed call logs a ready-to-paste `curl` block and setup continues. See the [Funding](#funding) section below for the full request/response shape.

The full adapter reference — daemon URL config, channel-port overrides, disconnect/reconnect semantics — lives in [`packages/adapter-openclaw/README.md`](packages/adapter-openclaw/README.md).

#### Troubleshooting (OpenClaw)

- **Adapter not visible to gateway** → check `~/.openclaw/openclaw.json` has `plugins.entries.adapter-openclaw` populated; re-run `dkg openclaw setup`.
- **Faucet failure** → setup logs a `curl` block for manual funding; the node still works for non-on-chain flows (P2P, queries, WM/SWM writes).
- **Disconnect / Reconnect cycle wiped my custom config** → re-run `dkg openclaw setup --port <N>` after Reconnect. Default-port users see no visible difference across the cycle.
- **Channel port `9201` already in use** → set `channel.port` manually under `plugins.entries.adapter-openclaw.config` in `~/.openclaw/openclaw.json`.

### Model Context Protocol (MCP)

Two commands wire DKG V10 into MCP-aware clients (Cursor, Claude Code, Claude Desktop, Windsurf, VSCode + GitHub Copilot Chat, Cline, Codex CLI):

```bash
npm install -g @origintrail-official/dkg
dkg mcp setup
```

`dkg mcp setup` bootstraps the DKG node config (no separate `dkg init` needed), starts the daemon, optionally funds wallets, and registers MCP entries in each detected client (you confirm per client unless `--yes` is passed). See the [MCP integration guide](packages/mcp-dkg/README.md) for client-by-client paths, mode overrides (`--installed` / `--monorepo`), the manual JSON shape, the contributor monorepo dev workflow, and troubleshooting (including the WSL2 caveat for Windows-side MCP clients).

**Network:** setup defaults to **mainnet-gnosis**; pass `--network <mainnet-gnosis | mainnet-base | testnet>` to choose another. Mainnet nodes have no faucet; testnet nodes auto-fund their wallets when the faucet is reachable.

### Standalone node

Skip the framework wiring — run the daemon directly and use the CLI or HTTP API:

```bash
npm install -g @origintrail-official/dkg
dkg init      # interactive: prompts for network (default: mainnet-gnosis), node name, role, store, port
dkg start     # starts the node daemon on http://127.0.0.1:9200
```

`dkg init` asks which network to join — **mainnet-gnosis** (default), **mainnet-base**, or **testnet**. Mainnet nodes have no faucet; testnet nodes auto-fund their wallets when the faucet is reachable. Pass `--network <name>` to skip the prompt.

For a Core Node, choose the `core` role during setup or pass it explicitly:

```bash
dkg init --role core --network mainnet-gnosis
dkg start
```

Core Nodes need an on-chain node profile (`identityId`). On startup the daemon checks the primary operational wallet; if it has no profile and `nodeRole` is `core`, it attempts to create the profile, approve TRAC to `StakingV10`, and mint the initial staking conviction. If the node is already running after you fund or repair wallets, trigger the same identity-creation path manually:

```bash
TOKEN=$(dkg auth show)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9200/api/identity/ensure
```

Verify with `GET /api/identity` or `/api/status`: Core registration is complete when `identityId` is non-zero and `hasIdentity` is `true`. The two node roles are `edge` and `core`. See [Daemon Lifecycle](docs/use-dkg/run-node.md#core-node-profile-registration) for the full Core profile checklist.

Once running, open the dashboard at [http://127.0.0.1:9200/ui](http://127.0.0.1:9200/ui), or query directly:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agents
```

### Updating your node

To update DKG, run one command:

```bash
dkg update                  # pull the latest release from npm and restart
dkg update --check          # check what's available without applying
dkg update --allow-prerelease   # follow the `next` dist-tag for pre-release builds
dkg rollback                # revert to the previous version
```

Do **not** `git pull` or clone the repository to update — `dkg update` is the canonical verb. If anything looks off (multiple repositories on disk, served UI doesn't match version, version skew between daemon and CLI), run `dkg doctor` for a structured diagnostic of the install state. See [`OT-RFC-41`](https://github.com/OriginTrail/dkgv10-spec/blob/main/rfcs/OT-RFC-41-edge-node-npm-only-install-and-update.md) for the design rationale.

### Contributors / monorepo development

Hacking on DKG itself? Don't go through `npm install -g`. Clone, install, and run from the workspace:

```bash
git clone https://github.com/OriginTrail/dkg.git
cd dkg
pnpm install
pnpm dkg start             # or `pnpm dkg <any subcommand>`
```

Contributor state lives under `~/.dkg-dev/` (separated from `~/.dkg/` so a contributor's dev work doesn't stomp on their own Edge install). `dkg update` is intentionally disabled in monorepo-checkout mode — use `git pull && pnpm install && pnpm build` instead.

The legacy `install.sh` git-checkout installer was removed in rc.12 (OT-RFC-41 §5 PR 6). If you have an existing `install.sh`-style install, run `npm install -g @origintrail-official/dkg` to take over the install; the daemon will detect the legacy `~/.dkg/releases/` tree on first start, record the active slot version into `~/.dkg/previous-version` (rollback target), and resume from the npm-global install. `dkg doctor` flags any leftover cleanable state. See [`docs/archive/MIGRATE_TO_NPM.md`](docs/archive/MIGRATE_TO_NPM.md) for historical context on the pre-rc.12 procedure.

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
dkg init                                 # interactive setup — network, node name, role, store (--network to skip the prompt)
dkg start [-f]                           # start the node daemon (-f for foreground)
dkg stop                                 # graceful shutdown
dkg status                               # node health, peer count, store status
dkg logs                                 # tail the daemon log
dkg peers                                # connected peers and transport info
dkg peer info <peer-id>                  # inspect a peer's identity and addresses

# Direct messaging
dkg send <name> <msg>                    # encrypted direct message to a peer
dkg chat <name>                          # interactive chat with a peer

# Context graphs (projects)
dkg context-graph create <id>            # create a local context graph
dkg context-graph register <id>          # register an existing CG on-chain (unlocks VM)
dkg context-graph add-agent <id> --agent <addr>   # add an agent to a curated CG allowlist
dkg context-graph list                   # list subscribed context graphs
dkg context-graph info <id>              # show context-graph details
dkg context-graph agents <id>            # list agents in the CG allowlist
dkg context-graph request-join <id> <curatorPeerId>   # request to join a curated CG (peer id from V10 invite)
dkg context-graph sign-join <id>         # sign a join-request delegation locally without forwarding
dkg context-graph approve-join <id>      # approve a pending join request
dkg context-graph subscribe <id>         # subscribe to a CG without creating it

# Knowledge Assets: create -> write -> finalize -> share -> publish
dkg ka create <name> -c <cg> --input-file <rdf-file> --share  # one-shot create/write/finalize/share; no VM publish
dkg ka import-file <name> -c <cg> --input-file <file>         # import a document into WM through extraction
dkg ka write <name> -c <cg> --input-file <rdf-file>           # append RDF payload quads to WM
dkg ka finalize <name> -c <cg>                                # seal the WM draft
dkg ka share <name> -c <cg>                                   # share finalized WM to SWM
dkg ka publish <name> -c <cg>                                 # sync publish from SWM to VM
dkg ka publish-async <name> -c <cg>                           # enqueue VM publish from SWM to VM
dkg ka query <name> -c <cg>                                   # read KA WM quads
dkg ka history <name> -c <cg>                                 # show lifecycle state/history
dkg ka pull-from <name> -c <cg> --layer swm                   # seed WM from SWM or VM
dkg ka discard <name> -c <cg>                                 # discard a WM draft

# Compatibility aliases
dkg assertion import-file <name> -f <file> -c <cg>  # compatibility alias for document import
dkg assertion promote <name> -c <cg>                # compatibility alias for KA share

# Verification and endorsement
dkg verify <batchId> --context-graph <cg> --verified-graph <id>  # propose M-of-N verification
dkg endorse <ual> --context-graph <cg> --agent <addr>  # endorse a published KA

# Querying
dkg query [cg] -q "<sparql>"             # SPARQL against a local context graph
dkg query-remote <peer> -q "<sparql>"    # query a remote peer over P2P
dkg sync                                 # catch up on data from peers
dkg subscribe <cg>                       # subscribe to a CG's gossip topics

# Async publisher (optional, for batching)
dkg publisher enable                     # enable the async publisher
dkg publisher publish-async <cg> <name>  # operational alias for dkg ka publish-async
dkg publisher jobs                       # list publisher jobs
dkg publisher stats                      # publisher throughput stats
# publisher wallets must already have on-chain identities/profiles before they can claim VM publish jobs

# Code & memory indexing
dkg index [directory]                    # index a code repo into the dev-coordination CG
dkg wallet                               # show operational wallet addresses & balances
dkg set-ask <amount>                     # set the node's on-chain ask (TRAC per KB·epoch)

# Identity & auth
dkg auth show                            # show the current API auth token
dkg auth rotate                          # generate a new auth token
dkg auth status                          # show whether auth is enabled

# Framework adapters & MCP wiring
dkg openclaw setup                       # install & configure the OpenClaw adapter
dkg hermes setup                         # install & configure the Hermes adapter
dkg mcp setup                            # register the MCP server with Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline / Codex CLI
dkg mcp serve                            # run the MCP server on stdio (invoked by the client; not run manually)

# Community integrations (registry: OriginTrail/dkg-integrations)
dkg integration list [--tier community]  # default tier filter is `verified`+
dkg integration info <slug>              # show details for one entry
dkg integration install <slug>           # install cli/mcp kind; --allow-community for community-tier entries

# Update / rollback / diagnose
dkg update [--check] [--allow-prerelease]  # update node software via npm registry
dkg rollback                               # roll back to previous version
dkg doctor [--json]                        # diagnostic report: install layout, version skew, orphan clones, UI mismatch, plugin root, config sanity
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

## Benchmarking

Benchmarking docs live in [`BENCHMARKING.md`](BENCHMARKING.md). The current
suite covers DKG publish/get and memory-layer flows:

- get/read retrieval
- synchronous publish with finalization
- asynchronous publish enqueue and finalization
- upload payload to local working memory
- lift local working memory to shared working memory

Run the main local benchmark workflow:

```bash
pnpm bench
pnpm bench:html
pnpm bench:analysis
pnpm bench:profile
```

The benchmark matrix uses generated payload sizes of `10kb`, `100kb`, `2mb`,
and `200mb`. Use `DKG_ESBENCH_PAYLOAD_SIZES=10kb` or
`DKG_ESBENCH_PAYLOAD_SIZES=200mb` to run a focused subset.

Generated reports are written under `bench/results/`. The combined ESBench HTML
report is `bench/results/latest.html`; per-flow HTML pages are under
`bench/results/publish-async-get/`. CPU profiles, flame graphs, and per-method
analysis reports are under `bench/results/profiles/`, including
`method-analysis.latest.html` for the invoked-method timing breakdown.

---

## Setup guides

| Guide | Use it when |
|---|---|
| [MCP Setup](packages/mcp-dkg/README.md) | You want Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline / Codex CLI to use DKG as memory |
| [Join the Testnet](docs/archive/internal/setup/JOIN_TESTNET.md) | You want a full node setup and first publish/query flow |
| [OpenClaw Setup](packages/adapter-openclaw/README.md) | You want OpenClaw to use DKG as memory/tools |
| [Hermes Setup](packages/adapter-hermes/README.md) | You want Hermes Agent to use DKG as memory/tools |
| [ElizaOS Setup](packages/adapter-elizaos/README.md) | You want ElizaOS integration |
| [Custom agent Setup](docs/archive/internal/setup/SETUP_CUSTOM.md) | You are wiring an agent framework not covered above |
| [Testnet Faucet](docs/archive/internal/setup/TESTNET_FAUCET.md) | You need Base Sepolia ETH and TRAC |

---

## Triple Store Backends

A DKG node keeps every assertion in an [RDF](https://www.w3.org/RDF/) triple store. Out of the box the node runs an embedded [Oxigraph](https://github.com/oxigraph/oxigraph) instance, which is everything you need on a workstation — no extra process, no extra port, no extra config. Heavier deployments can swap in [Blazegraph](https://blazegraph.com/) (the mainnet store) or any SPARQL 1.1 server.

| Backend | When to pick it |
|---|---|
| `oxigraph-worker` (default) | Single-operator nodes, dev, CI. No setup. File-backed, capped at process RAM. |
| `blazegraph` | High-throughput nodes, mainnet parity, very large graphs (10M+ quads). Run as a separate daemon (Docker or `java -jar`). Shares cleanly with V6 / V8 instances — DKG scopes its writes to the `did:dkg:context-graph:` named-graph prefix. |
| `sparql-http` | Any SPARQL 1.1 Protocol server (Fuseki, GraphDB, Stardog, Neptune…). Bring your own URL + (optional) auth header. |

### Configure via `dkg init`

Two paths:

**1. Point at an existing Blazegraph instance:**

```
$ dkg init
…
Triple store backend (oxigraph / blazegraph) (oxigraph): blazegraph
Blazegraph SPARQL endpoint URL: http://127.0.0.1:9999/bigdata/namespace/mynode/sparql
  Store endpoint reachable: blazegraph http://127.0.0.1:9999/bigdata/namespace/mynode/sparql
```

**2. Let `dkg init` provision a Blazegraph container via Docker:**

```
$ dkg init
…
Triple store backend (oxigraph / blazegraph) (oxigraph): blazegraph
Blazegraph SPARQL endpoint URL:                                    ← leave blank
No URL provided. Provision a Blazegraph container via Docker? (y/n) (y): y
  Starting Blazegraph in Docker (namespace: mynode)…
  Docker available: Docker version 24.0.6, build ed223bc
  Created container "dkg-blazegraph-mynode" on port 9999.
  Created Blazegraph namespace "mynode".
```

The Docker provisioner pins `lyrasis/blazegraph:2.1.5` (same image and tag as mainnet and the devnet test fixture), uses `--restart unless-stopped`, auto-bumps the host port if 9999 is taken, and is idempotent — re-running `dkg init` against an already-provisioned namespace reuses the running container.

The wizard validates non-Docker URLs via an `ASK { ?s ?p ?o }` probe before saving — typos or unreachable namespaces are caught at setup time, not at first boot. A 404 surfaces a specific "namespace likely doesn't exist" message rather than the generic network-failure hint.

### Configure via flags (scripted setup)

Every setup entry point honours `--store` / `--store-url`:

```bash
# Init only
dkg init --store blazegraph --store-url http://127.0.0.1:9999/bigdata/namespace/mynode/sparql

# Adapter setups (validated + persisted after the adapter step completes)
dkg hermes setup    --store blazegraph --store-url http://blaze.example/sparql
dkg openclaw setup  --store blazegraph --store-url http://blaze.example/sparql
dkg mcp setup       --store blazegraph --store-url http://blaze.example/sparql
```

`--store oxigraph` on a previously-Blazegraph node clears the persisted block (force-fall-back to the local default).

### Configure via `~/.dkg/config.json`

```json
{
  "store": {
    "backend": "blazegraph",
    "options": {
      "url": "http://127.0.0.1:9999/bigdata/namespace/mynode/sparql",
      "managedByDkg": false
    }
  }
}
```

For `sparql-http`:

```json
{
  "store": {
    "backend": "sparql-http",
    "options": {
      "queryEndpoint": "http://server.example/query",
      "updateEndpoint": "http://server.example/update",
      "auth": "Bearer YOUR_TOKEN"
    }
  }
}
```

### What changes when you pick an external backend

- **Boot-time health check**: the daemon refuses to start until the endpoint answers `ASK`. Unreachable URLs print an actionable message naming the URL — no half-broken daemon.
- **Namespace identity tag**: on first boot the daemon writes a triple into a reserved `<urn:dkg:store-meta>` graph recording its node name. Subsequent boots verify the tag before doing any writes — two DKG nodes pointed at the same Blazegraph namespace can't silently corrupt each other any more. Mismatches print the cleanup recipe (`DELETE WHERE { ... }`).
- **Backend-aware reset**: chain-reset (and rebooting against a different backend) scopes its `DELETE` to the `did:dkg:context-graph:` prefix, leaving any V6/V8 data on the same Blazegraph instance untouched. Docker-provisioned namespaces (`managedByDkg: true`) use the faster `DROP ALL` path.
- **Backend-switch guard**: switching backends between boots is treated like a destructive operation. The daemon prints a multi-line warning and refuses to start unless you set `DKG_ACCEPT_STORE_RESET=1`. Reverting `store.backend` in your config recovers the previous backend's data.
- **Metrics**: `/api/status` exposes `storeUrl` and `storeQuads` (cached for 30 s) instead of the `storeBytes` file size — quad count is what's meaningful when the store isn't a local file.
- **Required config**: when you enable `largeLiteralStorage` or `sharedMemoryPublicSnapshotStorage` with an external backend, you must set their `directory` explicitly (no local store path to infer from). The daemon fails fast at config-load if either is missing.

### Limitations

- **Auth / TLS**: only the generic `sparql-http` backend accepts an `Authorization` header. For Blazegraph behind auth or HTTPS-with-custom-CA, run a reverse proxy in front of it for now.
- **Migration tool**: there is no `dkg migrate-store` between backends. Plan a chain-reset window if you need to switch on a node that holds important non-VM state.

---

## Funding

Every setup flow persists your chosen network into `config.networkConfig`; the default for a fresh node is **mainnet-gnosis**.

**Mainnet (gnosis / base) — no faucet.** Fund the node's operational wallets yourself with the chain's native gas token (xDAI on Gnosis, ETH on Base) and TRAC before publishing to Verified Memory. An edge node needs no funds just to run and sync; funds are only required to publish on-chain.

**Testnet — auto-funded.** A testnet node needs Base Sepolia ETH (gas) and test TRAC (staking / publishing). The OriginTrail testnet faucet hands out both in one call, so when you select `testnet` the first-setup paths auto-fund the generated admin wallet plus the three operational wallets. This step fires **only on testnet** — the mainnet network configs ship no faucet, so it is skipped automatically.

The faucet step applies to all entry points when testnet is selected:

- **Manual install (`dkg init`)** — auto-funds when the selected network defines a faucet (testnet only).
- **OpenClaw, Hermes, and MCP setup (`dkg openclaw setup`, `dkg hermes setup`, `dkg mcp setup`)** — run the same funding step on first setup. Pass `--no-fund` to skip it (pre-funded wallets, CI, offline runs); pass `--network <name>` to choose the network.

Faucet calls are best-effort: a failed call logs a ready-to-paste `curl` block and setup continues. The node is usable without funding — you just can't publish or stake until it's topped up.

On testnet, if the faucet is unreachable and you need ETH only, [`docs/archive/internal/setup/JOIN_TESTNET.md`](docs/archive/internal/setup/JOIN_TESTNET.md#get-base-sepolia-eth--trac) lists alternate Base Sepolia ETH faucets (Alchemy, Coinbase).

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

### Knowledge Asset on-chain registration

Publishing mints a single Knowledge Asset as an ERC-721 NFT (`tokenId == kaId`) — the unit the chain sees. Each publish creates one Knowledge Asset; there is no multi-KA batching.

### Context Graph (project)

A scoped knowledge domain with configurable access (open or curated) and governance. The node UI calls these "projects". Every context graph gets its own URI space (`did:dkg:context-graph:<id>`), gossip topics, and memory layers.

### Sub-graph

A named partition within a context graph. Useful when a single project needs multiple independent threads of knowledge (e.g. `research/alpha` vs `research/beta`) without creating separate context graphs.

### Assertion

A named RDF graph you write into first (always in Working Memory). Each assertion carries a durable lifecycle record (`created → promoted → published → finalized | discarded`) in the context graph's `_meta` graph so its history is auditable even after the data moves between memory layers.

### Working / Shared Working / Verifiable Memory

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
@origintrail-official/dkg-epcis              EPCIS → RDF supply-chain adapter
@origintrail-official/dkg-mcp                MCP server for Cursor / Claude Code / coding agents
```

### Adapters and apps

```text
@origintrail-official/dkg-adapter-openclaw        OpenClaw gateway bridge
@origintrail-official/dkg-adapter-elizaos         ElizaOS plugin (embedded DKGAgent)
@origintrail-official/dkg-adapter-hermes          Hermes Agent (Python memory provider + TypeScript setup/client helpers)
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
- Framework adapters for OpenClaw, ElizaOS, Hermes
- MCP server for Cursor / Claude Code / other coding assistants
- Community integrations registry (`dkg integration list|info|install`) with install-time provenance verification for CLI-kind installs
- Blue-green update and rollback flow

Expect rapid iteration and breaking changes. Not yet recommended for production workloads.

---

## Development

Clone the repo and use pnpm (v10+) with Node.js 22+ to work across all workspace packages:

```bash
pnpm install                                     # install all workspace deps
pnpm build                                       # compile packages and the Node UI bundle
pnpm test                                        # run the full test suite
pnpm test:coverage                               # tests + tier-based coverage gates (all packages)
pnpm --filter @origintrail-official/dkg test     # run tests for a single package
```

Tier-based thresholds (TORNADO / BURA / KOSAVA) and Solidity lcov checks are documented in [`docs/testing/COVERAGE.md`](docs/testing/COVERAGE.md).

---

## Contributing

We welcome contributions — bug reports, feature ideas, and pull requests.

- [Open an issue](https://github.com/OriginTrail/dkg/issues) for bugs or feature requests
- **Build a DKG integration** — submit to the [integrations registry](https://github.com/OriginTrail/dkg-integrations) (see [CONTRIBUTING.md](https://github.com/OriginTrail/dkg-integrations/blob/main/CONTRIBUTING.md) and the [dkg-hello-world](https://github.com/OriginTrail/dkg-hello-world) template)
- [Join Discord](https://discord.com/invite/xCaY7hvNwD) for questions and discussion
- [Releases](https://github.com/OriginTrail/dkg/releases)
