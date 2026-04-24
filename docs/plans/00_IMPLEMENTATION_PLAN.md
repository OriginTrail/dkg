# DKG V9 — Implementation Plan

Master list of all remaining work items, ordered by priority. Each item
links to its reference spec or design doc. Items marked **NEW** need a
spec created as part of this plan.

Last updated: 2026-03-01

---

## Status legend

| Symbol | Meaning |
|--------|---------|
| **DONE** | Implemented and tested |
| **IN PROGRESS** | Currently being worked on |
| **READY** | Spec exists, ready to implement |
| **NEEDS SPEC** | Idea identified, spec needed before implementation |

---

## AI Agent Coordination Assessment (2026-03-01)

The primary goal of DKG V9 is to enable efficient and trusted coordination
between AI agents. This section captures a high-level assessment of how
the current implementation serves that goal, and where the gaps are.

### What's Working Well

1. **"Agent is the Node" architecture.** Installing `@origintrail-official/dkg-agent` makes an
   AI agent a full network participant in ~5 lines of code. This is the
   single biggest win — a 10× DX improvement over V8's SDK-calls-engine model.

2. **End-to-end encrypted messaging with zero setup.** X25519 DH derived
   from the Ed25519 identity + XChaCha20-Poly1305 encryption + Ed25519
   signatures + replay protection. An agent can `sendChat()` or
   `invokeSkill()` with just a peer ID; no key management ceremony needed.

3. **Skill-based discovery via SPARQL.** Agents publish structured profiles
   (skills, pricing, framework) as RDF KAs in the Agent Registry paranet.
   Other agents discover them via semantic SPARQL queries with filters on
   price, success rate, and framework. Scales better than registry contracts.

4. **Framework adapters (OpenClaw, ElizaOS).** The adapter pattern exposes
   DKG capabilities as standard tools that any LLM-backed agent can call.
   Existing agent frameworks get DKG superpowers without rewriting their logic.

5. **Merkle-verified sync.** Sync-on-connect with paged transfer and merkle
   root verification. Agents joining the network get caught up with
   *verified* data, not just trusted data.

6. **Store isolation.** No node can execute SPARQL directly against another
   node's store (Spec §1.6). Cross-agent queries go through structured
   protocol with access policies and rate limiting.

7. **Test coverage.** 70 test files including meaningful E2E tests covering
   the full agent lifecycle: create, connect, publish profiles, discover,
   chat, invoke skills, relay traversal.

### Key Gaps for Agent Coordination

1. **Economic layer is mostly spec.** Agents can discover and talk to each
   other but can't *transact* with trust. `invokeSkill()` has a
   `paymentProof` field but it's never validated. No payment escrow, no
   reputation tracking, no slashing for bad actors.

2. **Persistence is improved but not bulletproof.** Oxigraph now uses async
   debounced flush and a worker thread to avoid blocking the event loop.
   External backends (Blazegraph) delegate persistence entirely. See §8.1.

3. **Discovery is local-only.** `DiscoveryClient` queries only the local
   triple store. No federated query or DHT-backed skill index. If an agent
   hasn't synced a profile, it can never discover that agent. See §1.7.

4. **No structured negotiation protocol.** No price negotiation, SLA
   agreement, or capability probing before skill invocation. See §8.5.

5. **No async/long-running task support.** `invokeSkill()` is synchronous
   request-response. Long-running ML tasks may timeout with no task ID,
   polling, progress, or cancellation support. See §8.6.

6. **No agent capability attestation.** Any agent can claim any skill type
   in its profile with no proof of capability, endorsement, or
   challenge-response. See §8.7.

7. **Private data has no redundancy.** Private triples exist only on the
   publisher node. No encrypted replication or backup strategy. See §8.8.

**Roadmap:** A phased plan for addressing these gaps (deliverables, spec
order, implementation order) is in [PLAN_AGENT_COORDINATION_GAPS.md](./PLAN_AGENT_COORDINATION_GAPS.md).

---

## 2026-03-03 Collaboration Experiment Learnings (New)

Tonight's benchmark series (Control, Exp-A, Exp-A2, Exp-B2, Exp-AB, Exp-C1, Exp-C2)
changed how we should execute DKG V9 delivery:

1. **Raw SPARQL remains the strongest cost primitive** for directed code retrieval.
   In sequential runs, SPARQL-first beat semantic wrappers on cost and turn count.

2. **Parallelism is the dominant speed lever**, but only if collaboration state
   is shared in a disciplined way. Multi-agent runs cut wall-clock time nearly in half.

3. **Collaboration substrate affects outcomes**:
   - Workspace shared memory (C1): lower cost variance, simpler operations.
   - Full DKG publish/query (C2): better completion reliability and auditable trail.

4. **Conclusion for production execution**:
   DKG V9 implementation should be coordinated over a **live shared paranet** as the
   source of truth for plans, decisions, handoffs, and evidence — not markdown files
   or ad-hoc chat history.

### Production coordination directive

- Use a dedicated coordination paranet for DKGV9 production work.
- Treat each task, dependency, decision, risk, and experiment as a graph entity.
- Human + agent teams publish updates in real time; no single human coordinator
  should be required to manually synchronize execution state.

**Plan artifact (non-MD, graph-native):**
- [01_PRODUCTION_PLAN_DKG.json](./01_PRODUCTION_PLAN_DKG.json)

---

## 1. Networking & Sync

### 1.1 Persistent triple store — **DONE**
Triple store backends are pluggable via `createTripleStore(config)`. Three
built-in backends: `oxigraph` (in-process WASM), `oxigraph-worker`
(dedicated worker thread with file persistence, the default), and
`blazegraph` (remote SPARQL endpoint over HTTP). Custom backends can be
added by implementing the `TripleStore` interface and calling
`registerTripleStoreAdapter()`.

The Oxigraph worker backend uses async debounced flush to `store.nq`,
avoiding the previous issue of synchronous writes on every mutation.
External stores like Blazegraph handle persistence natively.

- **Spec**: [sync-flow.md](../diagrams/sync-flow.md) (Persistence lifecycle section)

### 1.2 Paranet sync on connect — **DONE**
New `/dkg/sync/1.0.0` protocol. On `peer:connect`, nodes request the
agents paranet from peers to catch up on profiles they missed via GossipSub.
Paginated (500 triples/page) with merkle root verification.

- **Spec**: [sync-flow.md](../diagrams/sync-flow.md)

### 1.3 On-chain sync verification (Tier 2) — **NEEDS SPEC**
After syncing and verifying merkle roots locally (Tier 1), cross-check
against the blockchain: query on-chain KC records to confirm the merkle
roots are actually anchored. This catches a peer that forges both data
and metadata.

Also detects **omitted KCs** — the blockchain has the authoritative list
of all KCs published to a paranet; a peer that withholds entire KCs can
be detected by comparing on-chain KC count vs received KC count.

- **Spec**: [SPEC_SYNC_CHAIN_VERIFICATION.md](../specs/SPEC_SYNC_CHAIN_VERIFICATION.md) — **TO CREATE**

### 1.4 Profile exchange on connect — **NEEDS SPEC**
Pairwise profile exchange: when two peers connect, they directly swap
their own agent profiles (not the whole paranet). Lightweight complement
to full paranet sync — useful when the connecting peer only needs to know
about the immediate neighbor.

- **Spec**: [SPEC_PROFILE_EXCHANGE.md](../specs/SPEC_PROFILE_EXCHANGE.md) — **TO CREATE**

### 1.5 Cross-agent query protocol — **DONE**
Agents query each other's knowledge stores remotely via `/dkg/query/2.0.0`.
Structured lookups (ENTITY_BY_UAL, ENTITIES_BY_TYPE, ENTITY_TRIPLES, SPARQL_QUERY)
with access policies, rate limiting, and optional LLM. CLI `query-remote`, daemon API.

- **Spec**: [SPEC_CROSS_AGENT_QUERY.md](../specs/SPEC_CROSS_AGENT_QUERY.md)

### 1.6 Relay auto-discovery — **NEEDS SPEC**
Nodes currently need the relay multiaddr in config. Relay addresses should
be discoverable from the blockchain or a well-known on-chain registry so
new nodes can bootstrap without manual config.

- **Spec**: [SPEC_RELAY_DISCOVERY.md](../specs/SPEC_RELAY_DISCOVERY.md) — **TO CREATE**

### 1.7 Federated / network-wide discovery — **NEEDS SPEC** (NEW)
Currently `DiscoveryClient` only queries the local Agent Registry paranet.
If Agent A hasn't synced from a node that has Agent C's profile, Agent A
can never discover Agent C. In a large network with churn, discovery
completeness depends entirely on GossipSub propagation timing.

**Options to evaluate:**
- DHT-backed skill index (publish skill type → peer ID mappings to Kademlia)
- Gossip-based query protocol (broadcast "who offers skill X?" to mesh)
- Federated SPARQL (fan-out query to N connected peers, deduplicate)

Each has different latency, bandwidth, and privacy trade-offs. Needs
a spec comparing approaches.

- **Spec**: SPEC_FEDERATED_DISCOVERY.md — **TO CREATE**

---

## 2. Publishing & Knowledge

### 2.1 Private KA access protocol — **READY**
`/dkg/access/1.0.0`: Agent B sees a private KA in the meta graph, sends
an AccessRequest with payment proof, receives the private triples, and
verifies the private merkle root. Already partially implemented
(`AccessHandler`, `AccessClient`); needs payment proof integration and
full e2e flow.

- **Spec**: [SPEC_PART1_MARKETPLACE.md §7](../SPEC_PART1_MARKETPLACE.md) (Private Knowledge section)
- **Diagram**: [access-flow.md](../diagrams/access-flow.md)

### 2.2 Fix agent UAL/chainId in broadcast — **DONE**
`broadcastPublish` now uses `this.chain.chainId` and builds UAL from
`result.onChainResult` (publisherAddress, startKAId). Uses `result.publicQuads`
so private triples are not re-sent over gossip.

- **Spec**: [SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md §2.1](../archive/SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md)

### 2.3 Context graph on-chain name registry — **DONE**
On-chain context graph name claims and discovery via `ContextGraphNameRegistry.sol`
(renamed from the legacy `ParanetV9Registry` — see PR #240). The EVM adapter
implements `createContextGraph({ name, accessPolicy })` and
`listContextGraphsFromChain(fromBlock?)` when the registry is registered in the Hub.
`submitToParanet` remains a stub (Milestone 5). Deploy script `042_deploy_paranet_v9_registry.ts`;
chain types extended with `CreateParanetParams` (name/description/accessPolicy),
`ParanetOnChain`, and optional `TxResult.paranetId`.

- **Spec**: [SPEC_PARANET_LIFECYCLE.md](../specs/SPEC_PARANET_LIFECYCLE.md)

### 2.4 Workspace graph (no-finality build area) — **IN PROGRESS**
Per-paranet workspace graph (`/_workspace` + `/_workspace_meta`) so agents can build and replicate knowledge without chain cost, then **enshrine** (publish with finality) when ready. Replication same as publish (GossipSub on workspace topic). Challenges (message ordering, Rule 4 consistency, sync semantics, enshrine coordination, growth, private quads, **Byzantine node / entity exclusivity**) are documented with mitigations in the plan.

- **Plan**: [PLAN_WORKSPACE_GRAPH.md](./PLAN_WORKSPACE_GRAPH.md)
- **Implemented**: Constants + GraphManager (workspace/workspace_meta URIs and topic); proto `WorkspacePublishRequest`; `Publisher.writeToWorkspace` + `enshrineFromWorkspace`; `WorkspaceHandler` for workspace topic; agent subscribes to both publish and workspace topics, exposes `writeToWorkspace`/`enshrineFromWorkspace`; query options `graphSuffix: '_workspace'` and `includeWorkspace: true`. **Tests**: unit tests in `@origintrail-official/dkg-publisher` (workspace.test.ts: writeToWorkspace, enshrineFromWorkspace, WorkspaceHandler), `@origintrail-official/dkg-query` (query-engine.test.ts: graphSuffix and includeWorkspace), proto round-trip in `@origintrail-official/dkg-core`; e2e in `@origintrail-official/dkg-agent` (e2e-workspace.test.ts: 2-node write → GossipSub replicate → query workspace → includeWorkspace → enshrine → query data). Sync extension (workspace on connect) still to do; **test in a real use case** next.

### 2.5 Capacity metering & dynamic pricing — **NEEDS SPEC** (exists as draft)
Gas-like metering for DKG resources (storage, CPU, bandwidth) with
dynamic pricing. Foundation for pay-per-query and resource-aware
node scoring.

- **Spec**: [SPEC_CAPACITY_AND_GAS.md](../SPEC_CAPACITY_AND_GAS.md) (draft)

---

## 3. Trust Layer (Smart Contracts)

All items below follow the milestone plan in
[PLAN_TRUST_LAYER.md](./PLAN_TRUST_LAYER.md).

### 3.1 Publishing Conviction Account (Milestone 3) — **READY**
Publishers who lock TRAC long-term get discounted publishing fees.
`PublishingConvictionAccount.sol` with flat discount based on initial lock.

- **Spec**: [SPEC_TRUST_LAYER.md §6](../SPEC_TRUST_LAYER.md)
- **Plan**: [PLAN_TRUST_LAYER.md §Milestone 3](./PLAN_TRUST_LAYER.md)

### 3.2 Staking conviction (Milestone 4) — **READY**
Stakers who lock longer earn up to 3× rewards.
`StakingConviction.sol` with lock multiplier: 1 epoch = 1×, 12 epochs = 3×.

- **Spec**: [SPEC_TRUST_LAYER.md §7](../SPEC_TRUST_LAYER.md)
- **Plan**: [PLAN_TRUST_LAYER.md §Milestone 4](./PLAN_TRUST_LAYER.md)

### 3.3 Paranet sharding (Milestone 5) — **READY**
Nodes allocate stake to specific paranets. Rewards, pricing, scoring,
and challenges are all per-paranet.

- **Spec**: [SPEC_TRUST_LAYER.md §8](../SPEC_TRUST_LAYER.md)
- **Plan**: [PLAN_TRUST_LAYER.md §Milestone 5](./PLAN_TRUST_LAYER.md)

### 3.4 FairSwap judge (Milestone 5b) — **READY**
Trustless exchange of private knowledge via FairSwap protocol.
`FairSwapJudge.sol` with escrow, key reveal, and dispute resolution.

- **Spec**: [SPEC_TRUST_LAYER.md §5](../SPEC_TRUST_LAYER.md)
- **Plan**: [PLAN_TRUST_LAYER.md §Milestone 5b](./PLAN_TRUST_LAYER.md)

### 3.5 Permanent publishing (Milestone 5c) — **READY**
"Publish forever" with one-time fee distributed across 100 epochs.
Arweave-style endowment model with declining distribution.

- **Spec**: [SPEC_TRUST_LAYER.md §4](../SPEC_TRUST_LAYER.md)
- **Plan**: [PLAN_TRUST_LAYER.md §Milestone 5c](./PLAN_TRUST_LAYER.md)

### 3.6 Fee split & protocol treasury (Milestone 5) — **READY**
85% paranet pool / 10% global pool / 5% protocol treasury.
`ProtocolTreasury` multisig-controlled address.

- **Spec**: [SPEC_TRUST_LAYER.md §9–10](../SPEC_TRUST_LAYER.md)
- **Gap doc**: [SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md §1.4](../archive/SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md)

### 3.7 V9 integration & Base Sepolia deployment (Milestone 6) — **IN PROGRESS**
Wire all Trust Layer contracts into the V9 TypeScript layer. Deploy to
Base Sepolia testnet.

- **Plan**: [PLAN_TRUST_LAYER.md §Milestone 6](./PLAN_TRUST_LAYER.md)
- **Deploy guide**: [DEPLOY_TESTNET.md](./DEPLOY_TESTNET.md)

### 3.8 Solana adapter (Milestone 7, future) — **NEEDS SPEC**
Anchor programs mirroring EVM contract logic. `SolanaChainAdapter`
implementing the same `ChainAdapter` interface. Zero changes to
publisher/agent/CLI.

- **Spec**: [SPEC_SOLANA_ADAPTER.md](../specs/SPEC_SOLANA_ADAPTER.md) — **TO CREATE** (when prioritized)

---

## 4. Agent Economy

All items below are specified in the Part 2 economy spec.

### 4.1 Payment channels — **READY**
TRAC payment for skill invocations, query gas, and private KA access.
Peer-to-peer payment proofs verified on-chain.

- **Spec**: [SPEC_PART2_ECONOMY.md](../SPEC_PART2_ECONOMY.md)

### 4.2 Delegation & rewards — **READY**
Node operators earn rewards from staked TRAC. Delegators earn
proportional rewards. Node scoring based on uptime, storage, and
availability.

- **Spec**: [SPEC_PART2_ECONOMY.md](../SPEC_PART2_ECONOMY.md)
- **Spec**: [SPEC_TRUST_LAYER.md §9](../SPEC_TRUST_LAYER.md)

### 4.3 Multi-chain support — **NEEDS SPEC**
Agents operate across multiple chains simultaneously. Cross-chain
UAL resolution and payment settlement.

- **Spec**: part of [SPEC_PART2_ECONOMY.md](../SPEC_PART2_ECONOMY.md); chain-specific adapter spec **TO CREATE** when a second chain is targeted

### 4.4 FairSwap off-chain flow for skill invocations — **NEEDS SPEC** (NEW)
The FairSwap smart contract (§3.4) handles on-chain escrow and disputes,
but the off-chain negotiation and invocation flow is not implemented.
Currently `invokeSkill()` has a `paymentProof` field that is never
validated. Need: (a) buyer locks TRAC in FairSwap escrow before invocation,
(b) seller delivers result, (c) buyer reveals key or disputes, (d)
`MessageHandler` validates payment proof before executing skill handler.

This is the critical path from "agents that can talk" to "agents that can
transact with trust."

- **Spec**: SPEC_SKILL_PAYMENT_FLOW.md — **TO CREATE**

### 4.5 Agent reputation tracking — **NEEDS SPEC** (NEW)
`DiscoveredOffering` has a `successRate` field but there is no mechanism
to compute or update it. Need on-chain or off-chain tracking of
success/failure per skill offering, possibly anchored to FairSwap
outcomes. Slashing for persistent bad actors.

- **Spec**: SPEC_AGENT_REPUTATION.md — **TO CREATE**

---

## 5. Node UI & Observability

### 5.0 DKG Node UI — **DONE**
Unified web interface for operating a DKG node — monitoring, querying,
exploring, and managing. Phases 1–5 implemented: instrumentation + storage +
API, dashboard home + observability UI, Knowledge Explorer (SPARQL editor +
result views, paranet browser, publish, history, saved queries), Wallet &
Economics (balances, RPC health), Integrations (adapters list, skills,
paranet subscribe). Phase 6: AI assistant (rule-based chatbot) done; OTel
export interface stubbed; neural NL→SPARQL planned.

- **Spec**: [SPEC_NODE_DASHBOARD.md](../specs/SPEC_NODE_DASHBOARD.md)

---

## 6. Extensions

### 6.1 Neural queries — **READY**
LLM-powered SPARQL generation and natural language query interface.
Transforms "What does Alice know about climate?" into SPARQL.

- **Spec**: [SPEC_PART3_EXTENSIONS.md §1](../SPEC_PART3_EXTENSIONS.md)

### 6.2 Knowledge pipelines — **READY**
DAG-based processing pipelines: ingest → transform → derive → publish.
Declarative pipeline definitions with provenance tracking.

- **Spec**: [SPEC_PART3_EXTENSIONS.md §2](../SPEC_PART3_EXTENSIONS.md)

### 6.3 Graph visualization — **READY**
Interactive RDF graph visualization component for web UIs.

- **Spec**: [SPEC_PART3_EXTENSIONS.md §3](../SPEC_PART3_EXTENSIONS.md)

---

## 7. Bugs & Technical Debt

### 7.1 Relay circuit test flaky — **DONE**
Stabilized with longer post-connect wait (3s) and `sendChatWithRetry` (3
attempts, 1.5s backoff) so chat delivery succeeds after relay→direct upgrade.
Test timeout increased to 45s.

### 7.2 Codebase TODOs — **READY**
See [SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md §4](../archive/SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md)
for the full list of inline TODOs across the codebase.

### 7.3 EVM test hardhat_contracts.json instability
The file regenerates with different addresses on each test run. Should
be gitignored or test setup made deterministic.

---

## 8. Storage & Resilience (NEW — 2026-03-01)

Items identified during the AI agent coordination assessment. These are
critical for agents running autonomously where crashes are inevitable and
data integrity is paramount.

### 8.1 Pluggable triple store backends & persistence hardening — **DONE**

All phases complete:

**Phase A — Harden existing Oxigraph persistence — DONE:**
- `OxigraphStore` now uses async debounced flush (`scheduleFlush` /
  `flushNow`) instead of synchronous write-on-every-mutation.
- `OxigraphWorkerStore` runs Oxigraph in a dedicated worker thread,
  keeping the main event loop free for networking and API requests.

**Phase B — Wire up the adapter factory — DONE:**
- `DKGAgent.create()` now uses `createTripleStore(config.storeConfig)`
  instead of hardcoding `new OxigraphStore()`.
- `storeConfig` field added to `DKGAgentConfig`.
- Default: `oxigraph-worker` with file persistence in `<dataDir>/store.nq`.
- CLI reads `config.store` from the node config and passes it through.

**Phase C — Blazegraph adapter — DONE:**
- `BlazegraphStore` implements `TripleStore` via Blazegraph's HTTP SPARQL
  endpoint. Registered as `'blazegraph'` adapter.
- Configuration: `{ backend: 'blazegraph', options: { url: '<sparql-endpoint>' } }`
- Handles: N-Quads bulk insert, SPARQL Update for mutations, SPARQL JSON
  results for SELECT/ASK, N-Quads for CONSTRUCT.
- Devnet script (`scripts/devnet.sh`) auto-starts a Dockerized Blazegraph
  container, creates per-node namespaces, and configures nodes 4-6 to use
  Blazegraph. Graceful fallback to Oxigraph if Docker is not available.
- Network Simulator UI displays each node's active backend in the Stats
  dashboard.

**Phase D — Generic HTTP SPARQL adapter — DONE:**
- `SparqlHttpStore` implements `TripleStore` via standard SPARQL 1.1 Protocol
  (query + update endpoints). Registered as `'sparql-http'`.
- Works with Oxigraph server (RocksDB persistence), Jena Fuseki, GraphDB,
  Neptune, Stardog, and any SPARQL 1.1–compliant server.
- Config: `{ backend: 'sparql-http', options: { queryEndpoint, updateEndpoint?, timeout?, auth? } }`.
- See [STORAGE_SPARQL_HTTP.md](../setup/STORAGE_SPARQL_HTTP.md) for Oxigraph server and other stores.

**Testing:** A shared conformance test suite validates all `TripleStore`
interface methods against every registered backend. Run Blazegraph tests
with: `BLAZEGRAPH_URL=<endpoint> pnpm --filter @origintrail-official/dkg-storage test`.

**Benchmark results** (10K ops, 100 concurrency, 100 KAs/publish):
`oxigraph` (in-process) is 4–12x faster per-operation (publish 125ms vs
554ms, query 33ms vs 399ms) because it avoids worker thread serialization.
However, `oxigraph-worker` has 2x fewer chat timeouts (15% vs 30%) because
it keeps the event loop free for networking. See README.md for full data.

### 8.1b API authentication — **DONE**

Unified bearer-token authentication for all node interfaces (HTTP API, future MCP, WebSocket):

- **Auth module** (`packages/cli/src/auth.ts`): Token generation, file-based storage,
  `verifyToken()` for any interface, `httpAuthGuard()` middleware for HTTP.
- **Enabled by default**: Token auto-generated on first start in `<DKG_HOME>/auth.token`.
- **Config**: `{ auth: { enabled: true, tokens: [] } }` in `config.json`.
- **Public endpoints**: `/api/status`, `/api/chain/rpc-health`, `/ui/*`, `OPTIONS`.
- **CLI integration**: `dkg auth show|status|rotate`, `ApiClient` auto-loads token.
- **Node UI**: Token injected into served HTML via `window.__DKG_TOKEN__`.
- **Network sim**: Reads tokens from devnet node dirs; Vite proxy injects auth headers.
- **Devnet**: Shared token generated by `devnet.sh`, copied to all node dirs.
- **Tests**: 23 unit + integration tests covering token extraction, verification,
  HTTP guard (public/protected/disabled), and file-based token loading.

### 8.2 Log rotation — **READY** (NEW)
`daemon.log` grows unbounded. Add size-based or time-based rotation.
Simple implementation: rotate on startup if file > threshold, keep N
rotated files.

### 8.3 Crash recovery for in-flight operations — **NEEDS SPEC** (NEW)
No WAL or transactional persistence for the triple store means in-flight
publishes can leave partial state. Need at minimum: (a) tentative KCs
are cleaned up on startup if they were never confirmed, (b) partial
workspace writes are detectable and recoverable.

- **Spec**: SPEC_CRASH_RECOVERY.md — **TO CREATE**

### 8.4 Private data redundancy — **NEEDS SPEC** (NEW)
Private triples exist only on the publisher node. If the node goes
offline, the data is inaccessible. Options: encrypted replication to N
selected peers, encrypted backup to IPFS/Arweave, or threshold secret
sharing so no single peer can read the data but K-of-N can reconstruct.

- **Spec**: SPEC_PRIVATE_DATA_REDUNDANCY.md — **TO CREATE**

### 8.5 Structured negotiation protocol — **NEEDS SPEC** (NEW)
Agents currently invoke skills with no negotiation step. For sophisticated
agent coordination (multi-step workflows, auctions, delegation chains),
need a structured protocol: capability probing ("can you handle 4K
images?"), price negotiation (offer/counter-offer), SLA agreement
(timeout, retry policy, quality guarantees), batch pricing.

The `callback` field in `SkillRequest` supports
`'inline' | 'publish_ka' | 'stream'` but only `inline` is implemented.

- **Spec**: SPEC_NEGOTIATION_PROTOCOL.md — **TO CREATE**

### 8.6 Async / long-running skill invocations — **NEEDS SPEC** (NEW)
`invokeSkill()` is synchronous request-response over a single libp2p
stream. If a skill takes 30+ seconds (ML inference, data processing),
the stream may timeout. Need:
- Task ID returned immediately on invocation
- Polling endpoint or GossipSub notification on completion
- Progress updates (optional)
- Cancellation support
- Result retrieval by task ID (with TTL)

Could reuse the workspace graph for intermediate results.

- **Spec**: SPEC_ASYNC_SKILLS.md — **TO CREATE**

### 8.7 Agent capability attestation — **NEEDS SPEC** (NEW)
Any agent can claim any skill type in its profile with no verification.
In a marketplace, this creates a trust bootstrapping problem. Options:
- Challenge-response: requester sends a test input, evaluates output
  before committing to paid invocation
- Endorsement graph: agents vouch for each other's capabilities (signed
  RDF triples in the Agent Registry)
- Verifiable credentials: W3C VC standard for skill certification
- Stake-backed claims: agent stakes TRAC behind a skill claim, slashed
  if disputes exceed threshold (ties into §4.5 reputation)

- **Spec**: SPEC_CAPABILITY_ATTESTATION.md — **TO CREATE**

### 8.8 Key storage hardening — **NEEDS SPEC** (NEW)
`agent-key.bin` and `wallets.json` are plain files with `0o600`
permissions. No HSM, enclave, or OS keychain integration. For production
autonomous agents managing real TRAC, need at minimum: OS keychain
integration (macOS Keychain, Linux Secret Service), optional KMS support
(AWS KMS, GCP KMS, HashiCorp Vault).

- **Spec**: SPEC_KEY_MANAGEMENT.md — **TO CREATE**

---

## 9. DKG-native Production Coordination (NEW — 2026-03-03)

### 9.1 Production plan as graph (non-MD source of truth) — **READY**

The production implementation plan is now defined as a graph-native JSON
artifact designed for publishing into a shared coordination paranet.

- **Plan graph**: [01_PRODUCTION_PLAN_DKG.json](./01_PRODUCTION_PLAN_DKG.json)
- **Publish utility**: [01_PRODUCTION_PLAN_DKG.publish.mjs](./01_PRODUCTION_PLAN_DKG.publish.mjs)
- **Query pack**: [01_PRODUCTION_PLAN_DKG.query-pack.json](./01_PRODUCTION_PLAN_DKG.query-pack.json)

This enables real-time human+agent collaboration where teams query the latest
task graph, dependencies, decisions, and handoffs directly from DKG state.

### 9.2 ROI experiment backlog for production execution — **READY**

Defined in the production plan graph:
- Smaller-model + DKG collaboration ROI experiment.
- Swarm same-task experiment: shared Markdown vs DKG nodes.
- Trust-first experiment: provenance/auditability under conflict.

---

## Priority order (suggested)

| Priority | Item | Rationale |
|----------|------|-----------|
| **P0** | ~~2.2 Fix UAL/chainId~~ | ✅ DONE |
| **P0** | ~~7.1 Relay test~~ | ✅ DONE |
| **P0** | 9.1 Production plan as graph + shared paranet execution | Remove manual coordination bottleneck; enable autonomous human+agent collaboration |
| **P0** | 8.1 Phase A (atomic writes + batched flush) | Crash safety for autonomous agents; no spec needed |
| **P0** | 8.1 Phase B (wire adapter factory) | Unblock pluggable backends; small refactor |
| **P1** | 2.1 Private KA access | Completes the core publish/access loop |
| **P1** | 2.3 Paranet on-chain | **DONE** — create + list from chain |
| **P1** | ~~1.5 Cross-agent query~~ | ✅ DONE |
| **P1** | ~~5.0 DKG Node UI~~ | ✅ DONE |
| **P1** | 4.4 FairSwap off-chain flow | Critical path to trusted agent transactions |
| **P1** | 8.1 Phase C (HTTP SPARQL adapter) | Enables Blazegraph/GraphDB/etc. |
| **P1** | 8.6 Async skill invocations | Required for real AI workloads |
| **P2** | 1.7 Federated discovery | Network-wide skill search |
| **P2** | 4.5 Agent reputation | Trust signal for marketplace |
| **P2** | 3.1 Publishing conviction | First trust layer economic feature |
| **P2** | 3.2 Staking conviction | Node operator incentives |
| **P2** | 3.3 Paranet sharding | Per-paranet economics |
| **P2** | 3.6 Fee split/treasury | Correct economic distribution |
| **P2** | 2.4 Workspace graph | No-finality build area; test in use case, address challenges as they arise |
| **P3** | 1.3 On-chain sync verify | Trustless sync (Tier 2) |
| **P3** | 3.4 FairSwap | Trustless private knowledge exchange |
| **P3** | 3.5 Permanent publishing | "Publish forever" model |
| **P3** | 1.4 Profile exchange | Lightweight alternative to full sync |
| **P3** | 1.6 Relay auto-discovery | Better node bootstrapping UX |
| **P3** | 8.5 Negotiation protocol | Sophisticated multi-agent coordination |
| **P3** | 8.3 Crash recovery | Resilience for long-running nodes |
| **P3** | 8.2 Log rotation | Operational hygiene |
| **P4** | 4.1 Payment channels | Agent economy |
| **P4** | 2.5 Capacity metering | Resource-aware pricing |
| **P4** | 8.7 Capability attestation | Trust bootstrapping |
| **P4** | 8.4 Private data redundancy | Fault tolerance for private knowledge |
| **P4** | 6.1–6.3 Extensions | Neural queries, pipelines, viz |
| **P5** | 3.8 Solana adapter | Second chain support |
| **P5** | 8.8 Key storage hardening | Production key management |

---

## What to implement next (recommendation)

**Current state (2026-03-01):**  
Phase 1 (off-chain marketplace) is substantially complete. Networking &
sync (persistence, sync on connect, cross-agent query), Node UI,
UAL/chainId broadcast, Relay E2E, Paranet on-chain lifecycle, CLI, and
framework adapters (OpenClaw, ElizaOS) are all done. Workspace graph is
in progress. 70 test files including E2E coverage. The "agent is the node"
architecture is working and the identity + discovery + encrypted messaging
stack is the project's biggest competitive advantage.

The gap is the economic/trust layer: agents can discover and communicate
but cannot yet transact with on-chain guarantees.

**Previous state (2026-02-22):**  
Networking & sync (persistence, sync on connect, cross-agent query) and Node UI are done. UAL/chainId in broadcast is fixed. Relay E2E test (7.1) and Paranet on-chain lifecycle (2.3) are done. CLI and node-ui builds fixed (TS action opts, Command import; Vite heap for relay). Release workflow, CHANGELOG, and release docs added. API authentication (8.1b) done. Remaining P1: Private KA access (2.1).

**Recommended order:**

1. ~~**8.1 Phase A+B+C — Storage hardening + pluggable backends** (P0) — **DONE**~~
   Oxigraph worker thread, async flush, Blazegraph adapter, and
   `createTripleStore()` wired into `DKGAgent.create()`.
   ~~**8.1b API authentication** (P0) — **DONE**~~
   Bearer token auth on all non-public endpoints. Auto-generated tokens,
   CLI management (`dkg auth`), Node UI injection, devnet shared tokens.

2. **2.1 Private KA access** (P1)  
   Complete the access protocol (payment proof, full e2e). Needed for paid
   private knowledge and completes the publish → access loop.

3. **4.4 FairSwap off-chain flow** (P1)  
   Implement the off-chain negotiation + payment escrow flow for skill
   invocations. This is the critical path from "agents that can talk" to
   "agents that can transact with trust."

4. **8.6 Async skill invocations** (P1)  
   Task ID + polling for long-running AI workloads. Required for
   production agent coordination beyond simple request-response.

5. **Then** Trust Layer milestones (3.1–3.6) for on-chain economics,
   1.7 federated discovery for network-wide skill search, or 4.5 agent
   reputation for marketplace trust signals.
