# Plan: Workspace Graph (No-Finality Build Area)

**Status**: Implemented  
**Date**: 2026-02  
**Goal**: Let agents build knowledge graphs collaboratively **without** blockchain cost or finality complexity, then **enshrine** (publish with finality) when ready. Reduces friction for pipelines (e.g. Guardian ETL) that need to query intermediate graphs while building.

> **Implementation note (2026-03):** All core workspace features are implemented: `writeToWorkspace`, `writeConditionalToWorkspace` (CAS), `enshrineFromWorkspace`, workspace graph/metadata graphs, GossipSub replication on the workspace topic, workspace sync on peer connect, query options (`graphSuffix: '_workspace'`, `includeWorkspace: true`), entity exclusivity (Rule 4) in workspace, and workspace TTL/eviction. Agents and integrations use workspace writes directly via the publisher API. See `packages/publisher/src/dkg-publisher.ts`, `packages/publisher/src/workspace-handler.ts`, and `packages/agent/src/dkg-agent.ts`.

---

## 1. Problem Statement

- **Current**: All publishing goes through the full path: prepare → store in data graph → **chain finality tx** → broadcast. Cost and UX add friction.
- **Need**: A way to write triples into a paranet **without** the finality transaction, so that:
  - Agents can build graphs incrementally and **query them** while the pipeline runs.
  - When the graph is “done,” the same content can be **enshrined** (one finality publish).
- **Constraint**: Keep the existing finality-based publish path unchanged; this is an **additional** write path and graph.

---

## 2. Naming: Better Than “Staging”

“Staging” suggests deployment pipelines and can be confused with “tentative” publish state. Below are alternatives that fit “build here, then commit to chain.”

| Name | Graph suffix | Pros | Cons |
|------|----------------|------|------|
| **Workspace** | `/_workspace` | Familiar (IDE workspace, git working tree). Implies “where I work before committing.” | Slightly long. |
| **Draft** | `/_draft` | Clear “not final.” | Can imply single draft; less “collaborative build” feel. |
| **Sandbox** | `/_sandbox` | Safe, experimental. | Can imply throwaway. |
| **Working** | `/_working` | Like “working directory.” | A bit generic. |
| **Scratch** | `/_scratch` | Scratch space, no commitment. | Implies disposable. |
| **Candidate** | `/_candidate` | “Candidate for enshrinement.” | More formal. |

**Recommendation**: **Workspace** (`/_workspace`) as the default name. It clearly means “where you build before committing”; aligns with “working graph” and “enshrine” (commit to the ledger). Alternative if you prefer brevity: **Draft** (`/_draft`).

**Term for “publish with finality”**: **Enshrine** is a good verb (content is “enshrined” on-chain). Alternatives: *finalize*, *commit*, *publish* (but that’s already used for the full flow).

---

## 3. Workspace vs enshrined KG: why pay TRAC & ETH?

A short comparison for agents and humans: when to use workspace (free) vs enshrined (costs TRAC + gas).

### 3.1 Workspace (no chain, no TRAC)

| Aspect | Workspace |
|--------|-----------|
| **Cost** | Free — no chain tx, no TRAC. |
| **Speed** | Immediate — write and broadcast; no finality wait. |
| **Replication** | Same as publish (GossipSub); all paranet subscribers get it. |
| **Authority** | Best-effort. No on-chain proof; a Byzantine node could store or broadcast invalid state. Honest nodes enforce rules locally. |
| **Persistence** | As long as subscribers hold it. No chain anchor; if everyone drops the paranet or clears workspace, it's gone. |
| **Query** | Same store, same SPARQL; you can query workspace (or data+workspace) locally and via cross-agent query. |
| **Identity** | No UAL. Workspace content is identified by operation id / publisher / timestamp, not by a permanent on-chain id. |

**Use workspace when:** You are building or collaborating on a graph (e.g. ETL, drafts, experiments). You need to query it while building. You don't need permanent, on-chain attestation yet. You want zero cost and minimal friction.

### 3.2 Enshrined (chain + TRAC)

| Aspect | Enshrined (data graph) |
|--------|-------------------------|
| **Cost** | TRAC (storage payment) + ETH (gas for finality tx). |
| **Speed** | After chain confirmations; finality delay. |
| **Replication** | Same GossipSub; plus **on-chain record** (merkle root, UAL, publisher, epochs). |
| **Authority** | **On-chain**. Anyone can verify that this knowledge was published by this publisher, at this time, with this content (merkle root). Byzantine nodes cannot forge enshrined state; the chain is the source of truth. |
| **Persistence** | **Anchored**. The chain record persists regardless of who replicates the graph. Storage payment (TRAC) commits nodes to hold it for the paid epochs. |
| **Query** | Same query engine; enshrined content has a **UAL** and appears in the data graph and meta graph. Resolvable globally by UAL. |
| **Identity** | **UAL** — permanent, verifiable, on-chain. Enshrined knowledge is citable, attestable, and usable in contracts and other systems. |

**Use enshrinement when:** The knowledge is "done" and should be **permanent**, **verifiable**, and **citable**. You need a UAL, on-chain proof, storage guarantees, or use in contracts/attestations. You're willing to pay TRAC + gas for that.

### 3.3 Why pay TRAC & ETH? (one sentence each)

- **Permanence**: Workspace can disappear if no one holds it; enshrined knowledge is anchored on-chain and paid for over time.
- **Verifiability**: Workspace is "someone said so"; enshrined is "the chain attests this merkle root and publisher."
- **Identity (UAL)**: Workspace has no stable, global id; enshrined has a UAL that others can resolve and trust.
- **Incentives**: TRAC pays for storage and replication; nodes have a reason to hold and serve enshrined content.
- **Trust**: For high-stakes use (credentials, supply chain, compliance, payments), enshrinement is the only way to get a shared, tamper-evident record.

### 3.4 For agents (decision rule)

- **Building / drafting / collaborating** → write to **workspace**. Query workspace (or data+workspace) while building. No cost.
- **Ready for permanent, verifiable, citable knowledge** → **enshrine** (read from workspace or publish directly to data graph). Pay TRAC + gas. Content gets a UAL and on-chain proof.
- **"Should I enshrine?"** → Enshrine when the content is final, needs to be cited or verified by others, or must survive regardless of who stays in the paranet.

### 3.5 For humans (short)

- **Workspace** = free, fast, collaborative draft area. Great for building and iterating; not permanent or provable.
- **Enshrined** = you pay TRAC + ETH to put knowledge on-chain. You get a permanent id (UAL), proof it exists and who published it, and storage commitments. Use it when the knowledge is "ready for the world" and worth the cost.

---

## 4. Architecture Overview

### 4.1 One Extra Named Graph per Paranet

- **Existing**: `did:dkg:paranet:{id}` (data), `did:dkg:paranet:{id}/_meta`, `did:dkg:paranet:{id}/_private`.
- **New**: `did:dkg:paranet:{id}/_workspace` (or chosen suffix).

Same paranet scope; workspace is another named graph. No new “paranet type” or protocol.

### 4.2 What Stays the Same (Roughly)

- **Data model**: Quads with subjects in the paranet’s data/workspace graph; same skolemization and partitioning (rootEntity, manifest) if we want to **promote** the same structure later.
- **Validation**: Optional: apply the same validation rules (e.g. manifest, Rules 1–3, 5) so that workspace content is **promotable** without re-shaping. Rule 4 (entity exclusivity) — see §6.
- **Query**: Same store, same SPARQL; query engine must be able to target the workspace graph (and optionally union with data).

### 4.3 What’s Different

| Aspect | Data graph (current publish) | Workspace graph |
|--------|------------------------------|------------------|
| **Write** | Prepare → store in data graph → **chain** → broadcast. | Prepare → store in workspace graph + workspace meta → **broadcast** (no chain). |
| **Replication** | GossipSub on `dkg/paranet/{id}/publish`; subscribers receive and store. | **Same**: GossipSub on a workspace topic (see §7); subscribers receive and store in workspace + workspace meta. |
| **Metadata** | Meta graph `/_meta` (UAL, rootEntity, partOf, tentative/confirmed). | **Dedicated workspace metadata graph** `/_workspace_meta` (see §4.4): same *idea* as `_meta` (provenance, rootEntity, operation id), but no UAL until enshrined. |
| **Entity exclusivity** | Rule 4: one rootEntity per paranet (across all publishers). | Policy choice: relax for workspace (see §6) or keep per-workspace-owner. |
| **Cost** | Chain gas + (future) storage incentives. | **Free** (no chain). |

### 4.4 Workspace Metadata Graph

- **Do we need a new metadata graph for workspace?** **Yes.** Keep `_meta` for enshrined (data-graph) KAs only; workspace entries never have a UAL, so they shouldn’t live in `_meta`.
- **New graph**: `did:dkg:paranet:{id}/_workspace_meta`.
- **Contents** (same *shape* as data-graph metadata where it makes sense):
  - **Workspace operation id** (e.g. UUID or `{publisherPeerId}:{timestamp}`): unique id for this workspace write (no UAL).
  - **rootEntity** (per entity in the write), **partOf** → this operation id (so we can “list entities in this workspace batch”).
  - **Publisher**: peer id (and optionally chain address if present).
  - **Timestamp**, optional **merkle root** for integrity checks.
  - No tentative/confirmed; workspace is always “current” until overwritten or enshrined.

So: **two metadata graphs** — `_meta` for data (enshrined) KAs, `_workspace_meta` for workspace units. Same replication and provenance idea; workspace meta just doesn’t reference UALs.

---

## 5. Flows

### 5.1 Write to Workspace (No Finality)

- **Input**: Paranet id, quads (and optionally private quads, manifest).
- **Steps**:
  1. `ensureParanet(paranetId)` so data + meta + **workspace** + **workspace_meta** graphs exist.
  2. Validate (manifest, Rules 1–3, 5; Rule 4 per §6).
  3. Normalize quads to **workspace graph** URI; generate **workspace metadata** (operation id, rootEntity(s), publisher, timestamp, optional merkle).
  4. **Local**: `store.insert(quads)` into workspace graph; insert metadata quads into **workspace_meta** graph (and private store if needed).
  5. **Replicate**: Encode a **workspace publish message** and broadcast on the **workspace topic** (see §7). Other nodes that subscribe to this paranet’s workspace receive the message and store the same quads + metadata into their local workspace and workspace_meta graphs.
  6. **No** chain call.
- **Output**: Success; quads and metadata are in workspace (and workspace_meta) locally and replicated to all subscribers.

### 5.2 Query Workspace (and Optionally Data)

- **Option A**: Query **only** workspace: e.g. `query(sparql, { paranetId, graphSuffix: '_workspace' })` so the engine uses `did:dkg:paranet:{id}/_workspace`.
- **Option B**: Query **union** of data + workspace: e.g. `query(sparql, { paranetId, includeWorkspace: true })` so the default “paranet graph” is both data and workspace (e.g. `FROM NAMED` both graphs and query over both). Useful for “show me everything we have so far.”
- **Option C**: No default change; caller passes explicit `GRAPH <.../_workspace>` in SPARQL.

Recommendation: support **Option A** (explicit workspace) and **Option B** (union) via query options; keep default behaviour “data only.”

### 5.3 Enshrine (Workspace → Data + Finality)

- **Input**: Paranet id, and a **selection** of what to enshrine: e.g. “all workspace triples,” or “these rootEntities,” or “this manifest.”
- **Steps**:
  1. Read triples from **workspace** graph (for the selected rootEntities or full workspace).
  2. Run **existing** publish flow with those triples: same prepare (merkle, manifest), store into **data** graph, chain finality, broadcast.
  3. Optionally: **delete** or **clear** the enshrined subset from workspace (so workspace is “what’s not yet enshrined”). Or leave as-is for audit.
- **Output**: Same as current publish (UAL, status confirmed, etc.).

So workspace is the **source** of triples for one or more “final” publishes; the rest of the stack is unchanged.

---

## 6. Entity Exclusivity (Rule 4) in Workspace

- **Data graph**: Rule 4 is required so that one publisher “owns” each rootEntity and merkle/update/delete are well-defined.
- **Workspace**: Two policies:
  - **Strict**: Same Rule 4 in workspace (one “owner” per rootEntity in workspace). Simpler promotion (no conflict with data graph ownership). Tighter for multi-agent collaboration on the **same** entity in workspace.
  - **Relaxed**: Allow multiple writers to add triples for the same rootEntity in workspace (e.g. different “layers” or timestamps). Promotion would then require **resolving** which triples to enshrine (e.g. merge, or “promote this agent’s view”). More flexible for collaboration, more complex to implement and reason about.

**Recommendation (v1)**: **Strict** in workspace: apply Rule 4 to workspace as well (per rootEntity, first writer wins in that workspace). So workspace is “draft space” but still one logical owner per entity; collaboration is “each agent has its own rootEntities that link to others.” If we later need shared editing of the same rootEntity before enshrinement, we can add a “workspace policy: relaxed” option (or a separate “shared draft” graph with different rules).

---

## 7. Replication of Workspace (Same as Existing Publish)

Workspace replication is **the same model** as for the data graph: GossipSub, all subscribers of the paranet receive workspace updates and store them.

- **Topic**: Dedicated topic so protocol and handlers stay clear: `dkg/paranet/{id}/workspace` (mirrors `dkg/paranet/{id}/publish`). When a node subscribes to a paranet, it subscribes to **both** the publish topic (for finality-based publishes) and the workspace topic (for workspace writes).
- **Message format**: A **workspace publish message** that mirrors `PublishRequest` where it makes sense: paranetId, nquads (public quads), manifest (rootEntity, optional privateMerkleRoot, privateTripleCount), publisher identity/peer id, **workspace operation id**, timestamp. No UAL, no chainId, no receiver signatures. New protobuf (e.g. `WorkspacePublishRequest`) or extend existing with a `targetGraph: 'data' | 'workspace'` and optional fields.
- **Receiver**: A **workspace handler** (like PublishHandler): on message, validate, store quads into **workspace graph**, generate and store metadata into **workspace_meta** graph. No chain, no tentative/confirmed lifecycle; just store and optionally ack for reliability.
- **Result**: Many agents (nodes) working on the same paranet all see the same workspace graph and workspace_meta once they’re subscribed; collaboration is natural. When ready, any node can **enshrine** from the workspace content it has.

### 7.1 Future: Workspace Private to Registered Nodes Only

**Current behaviour**: The system does **not** support restricting workspace visibility to a subset of nodes. Anyone who subscribes to the paranet receives the workspace topic and can read all workspace data.

**Desired (future)**: Workspace data visible only to nodes that are **registered** or **members** of the workspace (e.g. an explicit allow-list, or on-chain paranet membership, or token-gated). Nodes that are subscribed to the paranet but not workspace members would see the **data** graph (enshrined content) but not the **workspace** graph.

**Options to add later** (design only; implement later):
- **Workspace membership**: Paranet (or workspace) config or on-chain registry lists peer IDs or keys that are allowed to subscribe to the workspace topic / receive workspace sync. Non-members do not subscribe to the workspace topic (or subscribe but receive encrypted payloads they cannot decrypt).
- **Dedicated workspace topic per "room"**: e.g. `dkg/paranet/{id}/workspace/{workspaceGroupId}`; membership in `workspaceGroupId` is managed separately (invite-only, or derived from paranet membership + extra registration).
- **Encrypted workspace**: Workspace messages encrypted under a key shared only with registered nodes; topic remains public but payload is opaque to non-members.

**Plan**: Document this as a **future** feature. V1 ships with "all paranet subscribers see workspace"; add workspace access control in a later phase when we have a clear membership model (e.g. paranet join/leave on-chain, or explicit workspace registration API).

---

## 8. Codebase Touchpoints

| Component | Change |
|-----------|--------|
| **core/constants** | Add `paranetWorkspaceGraphUri(paranetId)` → `did:dkg:paranet:{id}/_workspace`. Add `paranetWorkspaceMetaGraphUri(paranetId)` → `did:dkg:paranet:{id}/_workspace_meta`. Add `paranetWorkspaceTopic(paranetId)` → `dkg/paranet/{id}/workspace`. |
| **storage/graph-manager** | `ensureParanet` creates workspace and workspace_meta graphs; add `workspaceGraphUri(paranetId)` and `workspaceMetaGraphUri(paranetId)`. `listParanets` / `hasParanet` unchanged. |
| **core/proto** | Define **workspace publish** message (e.g. `WorkspacePublishRequest`: paranetId, nquads, manifest, publisherPeerId, workspaceOperationId, timestamp; no UAL/chain fields). Encoder/decoder. |
| **publisher** | New method `writeToWorkspace(paranetId, quads, options?)`: validate, insert into workspace + workspace_meta, **broadcast** on workspace topic. Track workspace-owned entities if Rule 4 applies. |
| **publish-handler (workspace)** | New handler for workspace topic: on message, validate, store to workspace graph + workspace_meta (same shape as writeToWorkspace). No chain. Optionally ack. |
| **publisher (enshrine)** | New method `enshrineFromWorkspace(paranetId, selection)`: read from workspace graph, call existing `publish()` with that content (data graph + chain + publish topic). Selection = “all” or “rootEntities: [...]”. |
| **agent / node** | On subscribe to paranet: subscribe to **both** publish topic and **workspace topic**. Register workspace handler. Expose `writeToWorkspace`, `enshrineFromWorkspace`, and query options. |
| **query** | `QueryOptions`: add `graphSuffix?: '_workspace'` and/or `includeWorkspace?: boolean`. Support querying workspace_meta if needed (e.g. “list workspace operations”). |
| **validation** | Reuse `validatePublishRequest` for workspace writes; add optional parameter for workspace-owned set (Rule 4 in workspace). |
| **meta graph** | No change: `_meta` remains for enshrined (data) KAs only. Workspace metadata lives in **`_workspace_meta`** only. |

---

## 9. Open Questions

1. **Private quads in workspace**: Support private quads in workspace and carry them over on enshrine? (Same private store keyed by paranetId + rootEntity; workspace is just “data graph” equivalent for public part.)
2. **Multiple workspace “layers”**: Do we ever want more than one workspace graph per paranet (e.g. per-agent or per-session)? For v1, one `/_workspace` per paranet is enough; we can add `/_workspace/{agentId}` later if needed.
3. **TTL / eviction**: Should workspace have a TTL or max size so it doesn’t grow unbounded? Out of scope for v1; document as future.
4. **Guardian ETL**: Confirm with actual pipeline: “query by paranet + workspace” and “enshrine this set of rootEntities” is sufficient.
5. **Sync on connect**: Should the existing paranet sync protocol (e.g. `/dkg/sync/1.0.0`) also sync **workspace** and **workspace_meta** graphs so that a node joining the paranet gets the current workspace state from peers, not only the data graph? Recommendation: yes — extend sync to include workspace (and optionally workspace_meta) so new collaborators see the same workspace.

---

## 10. Challenges and Mitigations

| Challenge | Description | Mitigation |
|-----------|-------------|------------|
| **Message ordering** | GossipSub does not guarantee total order. Two nodes can receive workspace messages in different order (e.g. A then B vs B then A). With strict Rule 4, "first writer wins" is ambiguous. | Accept eventual consistency for v1. Optionally include a **monotonic timestamp or sequence** in the workspace message so receivers can reject or reorder out-of-order writes for the same rootEntity. Or document that workspace is "best effort" and enshrinement is the source of truth. |
| **Rule 4 consistency across nodes** | Each node tracks "workspace-owned" entities to enforce Rule 4. Because message order can differ, node 1 might accept a write for rootEntity X and node 2 might accept a different write for X first. Workspace state can diverge. | Mitigation: (a) include a logical timestamp or operation id in the message and have receivers apply a deterministic rule (e.g. "higher timestamp wins" for the same rootEntity), or (b) accept that workspace may diverge slightly and rely on enshrinement (only one enshrine of a given rootEntity can succeed in the data graph). For v1, (b) may be enough; add (a) if we see conflicts in practice. |
| **Sync semantics for workspace** | When a new node joins, it needs workspace state. Syncing the full workspace graph can be large and churny. | Options: (a) sync full workspace (and workspace_meta) on first connect, like data graph; (b) do not sync workspace, only receive new messages from join time (node has empty workspace until new writes arrive); (c) incremental sync (e.g. by workspace operation id). Recommendation: (a) for v1 so new collaborators see current state; optimize later with (c) if size is a problem. |
| **Enshrine coordination** | Two agents might try to enshrine the same rootEntity from workspace. Only one can succeed in the data graph (Rule 4). | Document that enshrinement is "first successful tx wins." Agents can agree out-of-band who enshrines what, or one "lead" agent does the enshrine. No in-protocol locking in v1. |
| **Workspace growth** | No TTL or eviction in v1; workspace can grow unbounded. | Document as known limitation; add TTL or max-size eviction in a later release. Paranet operators can advise "clear workspace after enshrine" or periodic cleanup. |
| **Private quads in workspace** | If we support private quads in workspace, they do not replicate (private content is never sent over gossip). Only the publisher has the private part. | On enshrine, only a node that has the private quads (typically the publisher) can run the full publish with private content. Others can enshrine only the public subset. Document this clearly. |
| **Byzantine node breaks entity exclusivity** | A node that does not follow the protocol could (a) broadcast a workspace write that violates Rule 4 (same rootEntity already claimed), or (b) accept and store such a write instead of rejecting it. So one node's workspace could hold two publishers' triples for the same rootEntity. | **Honest nodes**: Enforce Rule 4 in the workspace handler and reject messages that would break exclusivity; their local workspace stays consistent. **Byzantine node**: Can only corrupt its own local state; if we sync workspace from peers, it could propagate bad state to nodes that trust it. **Data graph and enshrinement**: Remain protected — Rule 4 and chain finality still apply to the data graph; only one enshrine of a given rootEntity can succeed. So the source of truth (enshrined data) stays consistent. **Mitigation**: When syncing workspace from peers, validate that synced state does not introduce duplicate rootEntity ownership (e.g. reject or merge by deterministic rule). Prefer syncing from multiple peers and cross-checking, or only trust workspace state that you yourself validated from ordered messages. Document that workspace is best-effort; enshrinement is authoritative. |

---

## 11. Naming Summary

- **Data graph**: `did:dkg:paranet:{id}` (unchanged).
- **Workspace graph**: `did:dkg:paranet:{id}/_workspace`.
- **Workspace metadata graph**: `did:dkg:paranet:{id}/_workspace_meta` (separate from `_meta`; no UAL until enshrined).
- **Workspace topic**: `dkg/paranet/{id}/workspace`.
- **Write**: `writeToWorkspace(paranetId, quads, options?)` — local store + broadcast on workspace topic.
- **Promote**: `enshrineFromWorkspace(paranetId, selection)`.
- **Query**: `query(sparql, { paranetId, graphSuffix: '_workspace' })` or `includeWorkspace: true`.

---

## 12. Implementation Checklist

1. ✅ **Constants + GraphManager**: `paranetWorkspaceGraphUri`, `paranetWorkspaceMetaGraphUri`, `paranetWorkspaceTopic` in `packages/core/src/constants.ts`. `ensureParanet` creates workspace and workspace_meta graphs.
2. ✅ **Proto**: `WorkspacePublishRequest` message in `packages/core/src/proto/workspace.ts`.
3. ✅ **Publisher.writeToWorkspace**: Validate, insert into workspace + workspace_meta, broadcast on workspace topic. See `packages/publisher/src/dkg-publisher.ts`.
4. ✅ **Workspace handler**: `WorkspaceHandler` in `packages/publisher/src/workspace-handler.ts`. Includes CAS condition enforcement and per-entity write locks.
5. ✅ **Agent / node**: `DKGAgent` subscribes to both publish and workspace topics; exposes `writeToWorkspace`, `writeConditionalToWorkspace`, `enshrineFromWorkspace`.
6. ✅ **Query**: `graphSuffix: '_workspace'` and `includeWorkspace: true` options in `DKGQueryEngine`.
7. ✅ **Publisher.enshrineFromWorkspace**: Read from workspace graph, call existing publish flow.
8. ✅ **Sync**: Workspace and workspace_meta included in paranet sync on peer connect.
9. ✅ **Tests**: Coverage in `packages/publisher/test/workspace.test.ts`, `packages/agent/test/e2e-workspace.test.ts`, `packages/agent/test/e2e-workspace-sync.test.ts`, and `packages/agent/test/workspace-consistency.test.ts`.

No change to existing publish flow or to chain adapter.
