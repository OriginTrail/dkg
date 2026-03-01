# DKG V9 — Implementation Plan

Master list of all remaining work items, ordered by priority. Each item
links to its reference spec or design doc. Items marked **NEW** need a
spec created as part of this plan.

Last updated: 2026-02-22

---

## Status legend

| Symbol | Meaning |
|--------|---------|
| **DONE** | Implemented and tested |
| **IN PROGRESS** | Currently being worked on |
| **READY** | Spec exists, ready to implement |
| **NEEDS SPEC** | Idea identified, spec needed before implementation |

---

## 1. Networking & Sync

### 1.1 Persistent triple store — **DONE**
Oxigraph store persists to `~/.dkg/store.nq` via N-Quads dump/load.
Data survives node restarts.

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

- **Spec**: [SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md §2.1](../SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md)

### 2.3 Paranet on-chain lifecycle — **DONE**
On-chain paranet creation and discovery via `ParanetV9Registry.sol`. EVM adapter
implements `createParanet(name, description, accessPolicy)` and
`listParanetsFromChain(fromBlock?)` when the registry is registered in the Hub.
`submitToParanet` remains a stub (Milestone 5). Deploy script `042_deploy_paranet_v9_registry.ts`;
chain types extended with `CreateParanetParams` (name/description/accessPolicy),
`ParanetOnChain`, and optional `TxResult.paranetId`.

- **Spec**: [SPEC_PARANET_LIFECYCLE.md](../specs/SPEC_PARANET_LIFECYCLE.md)

### 2.4 Workspace graph (no-finality build area) — **IN PROGRESS**
Per-paranet workspace graph (`/_workspace` + `/_workspace_meta`) so agents can build and replicate knowledge without chain cost, then **enshrine** (publish with finality) when ready. Replication same as publish (GossipSub on workspace topic). Challenges (message ordering, Rule 4 consistency, sync semantics, enshrine coordination, growth, private quads, **Byzantine node / entity exclusivity**) are documented with mitigations in the plan.

- **Plan**: [PLAN_WORKSPACE_GRAPH.md](./PLAN_WORKSPACE_GRAPH.md)
- **Implemented**: Constants + GraphManager (workspace/workspace_meta URIs and topic); proto `WorkspacePublishRequest`; `Publisher.writeToWorkspace` + `enshrineFromWorkspace`; `WorkspaceHandler` for workspace topic; agent subscribes to both publish and workspace topics, exposes `writeToWorkspace`/`enshrineFromWorkspace`; query options `graphSuffix: '_workspace'` and `includeWorkspace: true`. **Tests**: unit tests in `@dkg/publisher` (workspace.test.ts: writeToWorkspace, enshrineFromWorkspace, WorkspaceHandler), `@dkg/query` (query-engine.test.ts: graphSuffix and includeWorkspace), proto round-trip in `@dkg/core`; e2e in `@dkg/agent` (e2e-workspace.test.ts: 2-node write → GossipSub replicate → query workspace → includeWorkspace → enshrine → query data). Sync extension (workspace on connect) still to do; **test in a real use case** next.

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
- **Gap doc**: [SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md §1.4](../SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md)

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
See [SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md §4](../SPEC_IMPLEMENTATION_GAPS_AND_ISSUES.md)
for the full list of inline TODOs across the codebase.

### 7.3 EVM test hardhat_contracts.json instability
The file regenerates with different addresses on each test run. Should
be gitignored or test setup made deterministic.

---

## Priority order (suggested)

| Priority | Item | Rationale |
|----------|------|-----------|
| **P0** | ~~2.2 Fix UAL/chainId~~ | ✅ DONE |
| **P0** | ~~7.1 Relay test~~ | ✅ DONE |
| **P1** | 2.1 Private KA access | Completes the core publish/access loop |
| **P1** | 2.3 Paranet on-chain | **DONE** — create + list from chain |
| **P1** | ~~1.5 Cross-agent query~~ | ✅ DONE |
| **P1** | ~~5.0 DKG Node UI~~ | ✅ DONE |
| **P2** | 3.1 Publishing conviction | First trust layer economic feature |
| **P2** | 3.2 Staking conviction | Node operator incentives |
| **P2** | 3.3 Paranet sharding | Per-paranet economics |
| **P2** | 3.6 Fee split/treasury | Correct economic distribution |
| **P3** | 1.3 On-chain sync verify | Trustless sync (Tier 2) |
| **P3** | 3.4 FairSwap | Trustless private knowledge exchange |
| **P3** | 3.5 Permanent publishing | "Publish forever" model |
| **P3** | 1.4 Profile exchange | Lightweight alternative to full sync |
| **P3** | 1.6 Relay auto-discovery | Better node bootstrapping UX |
| **P4** | 4.1 Payment channels | Agent economy |
| **P2** | 2.4 Workspace graph | No-finality build area; test in use case, address challenges as they arise |
| **P4** | 2.5 Capacity metering | Resource-aware pricing |
| **P4** | 6.1–6.3 Extensions | Neural queries, pipelines, viz |
| **P5** | 3.8 Solana adapter | Second chain support |

---

## What to implement next (recommendation)

**Current state (2026-02-22):**  
Networking & sync (persistence, sync on connect, cross-agent query) and Node UI are done. UAL/chainId in broadcast is fixed. Relay E2E test (7.1) and Paranet on-chain lifecycle (2.3) are done. CLI and node-ui builds fixed (TS action opts, Command import; Vite heap for relay). Release workflow, CHANGELOG, and release docs added. Remaining P1: Private KA access (2.1).

**Recommended order:**

1. **2.3 Paranet on-chain lifecycle** (P1) — **DONE**  
   ParanetV9Registry contract (createParanetV9, ParanetCreated event), EVM adapter createParanet/listParanetsFromChain, extended CreateParanetParams and optional listParanetsFromChain on ChainAdapter. Join/leave and node startup recovery from chain can follow.

2. **2.1 Private KA access** (P1)  
   Complete the access protocol (payment proof, full e2e). Needed for paid private knowledge and completes the publish → access loop.

3. **Then** either Trust Layer milestones (3.1–3.6) for economics, or 1.3 on-chain sync verification / 1.6 relay auto-discovery for robustness and bootstrapping.
