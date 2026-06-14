# OT-RFC-49 rc18 Master Delivery Plan — Full Strip (cores hold zero private bytes)

**Status:** ACTIVE · **Date:** 2026-06-14 · **Branch base:** `feat/rfc49-public-projection`
**Supersedes:** the M1–M7 milestone spine in `OT-RFC-49-STRIP-IMPLEMENTATION-PLAN.md` (which assumed the anchor/escrow tier). This plan delivers the full strip in one rc18 with a member-side recovery layer instead of an anchor tier.

> Produced via six code-grounded multi-agent passes (delivery plan → full-strip design + stress → recovery spike → convergence redesign → minimal-anchor validation), each with an adversarial review. Every load-bearing claim is cited to `file:line`. The recovery model in §2 went through three corrections: encrypted-snapshot (dropped) → member-to-member plaintext + frontier (current) → with the foundational union-fix (Problem 0) and anchors folded in as an optional posture.

---

## 0. The decision and the one acceptance it requires

**Decision (user, final):** ship the **full strip** in rc18 — core nodes hold **zero private bytes**, host and **prove only the public `_catalog`**; private data lives **member-side**, with a real member-recovery layer built this cycle. Execution path: **spike recovery first** (done — GO-WITH-CONSTRAINTS) → **land the contract/catalog half in parallel** (additive, cores keep ciphertext until proven) → **strip last (WS-A), gated on a cross-rotation chaos soak.**

**The acceptance this plan requires:** a private CG's durability guarantee changes to **"recover to correct current state,"** *not* "recover full private event history across a membership rotation." For current-state knowledge graphs (latest-write-wins, which `_shared_memory` is) this loses nothing material. For append-only/event-log private CGs it means pre-rotation history is unrecoverable once no old-epoch keyholder remains. This must be accepted by the protocol and communicated to partners (DMaaST/HOLOS) before WS-A lands. See §8.

---

## 1. Executive summary

Today cores are the always-on custodian of private ciphertext: they subscribe `contextGraphWorkspaceTopic`, persist opaque envelopes (`host-mode-store.ts`), serve catch-up, and the on-chain curated commitment is a **ciphertext** commitment cores prove via random sampling. rc18 moves all private-data custody to the **member set** and re-bases the on-chain commitment + proof onto the **public catalog** cores legitimately hold.

**Per-CG shape after rc18:**
- **PUBLIC CG** — unchanged. Cores host + prove plaintext over `merkleRoot`/`merkleLeafCount`.
- **PRIVATE CG** — cores host + prove the **public catalog only** (a dedicated `catalogRoot`/`catalogLeafCount`). Private data is member-held, recoverable to **current state** via member-to-member plaintext sync + a frontier-beacon for convergence (§2); cores hold zero private bytes.

**Honest timeline:** **NOT a ~2-week rc.** Realistic **8-week floor, 11–13 weeks** once the private-snapshot phase, the authorization hardening, and the manual (broken-since-rc.8) redeploy are priced in. The member-recovery layer is the critical path. See §7.

**Scope line.** IN: the full strip; the member-recovery layer (**member-to-member plaintext `data` sync + a signed frontier-beacon for convergence detection** + SenderRekey-for-future-writes + a publish-time member durability gate + the ACL hard-deny gate); the clean contract (ciphertext commitment removed, catalog commitment added as **new** storage slots); catalog-only sampling with the proof-race + ACK-version fixes; **clean-break wipe** migration (rc18 is breaking — §0). OUT: any anchor/escrow/archival-tier durability product (deferred); the dropped encrypted-snapshot path (§2); per-root writer signatures (integrity = trust-any-ACL-member, §2 decision); full private *event-history* recovery across a rotation, and **availability when all member-holders incl. the writer are offline** (accepted residuals, §2/§8).

---

## 2. The recovery model — member-to-member plaintext + frontier convergence (REVISED 2026-06-14)

> **Supersedes the private-snapshot approach.** Recovery is **member-to-member, plaintext, over the existing `data` SyncPhase** — not encrypted-snapshot replay. The "old epoch can't decrypt" brick only bites if you recover by *replaying old encrypted envelopes*; the triples are **plaintext at rest** in every online member's `_shared_memory` (members decrypt-and-materialize on receipt), so a recovering member just **asks an authorized member for the plaintext state** over the Noise channel, ACL-gated. The sender-key epoch matters for **live broadcast**, not pairwise recovery.

**Why the snapshot path was dropped (built this session, now abandoned):** (1) it stores an **encrypted private blob on a core** — private bytes on a core, which *contradicts "cores hold zero"*; (2) it is **redundant** — the plaintext is already member-servable via `data`; (3) its producer **consumed a ratchet `messageIndex`**, perturbing the exact coordinate the convergence beacon depends on. Remove `workspace-private-snapshot.ts`, `workspace-private-snapshot-store.ts`, and `emitContextGraphPrivateSnapshot`/`getContextGraphPrivateSnapshotStore` (dkg-agent-crypto.ts). `privateSnapshot` was never added to `SyncPhase` on main, so dropping it is a no-op on the type.

**How a member knows it is behind (the core problem — no on-chain SWM commitment):** unlike VM (where `getLatestMerkleRoot(kaId)` is a trustless per-write oracle), SWM is purely off-chain until promotion, so there is no chain "what should be there." Today there is **no convergence detection at all** — the only signal is wall-clock age of the last sync; a node *cannot* tell it missed a write. The fix is a **signed frontier beacon**: members periodically advertise a compact summary of what they hold, peers compare, and the behind node pulls the gap. The frontier *is* the SWM analogue of the VM merkle root — an emergent consensus among members, not a chain fact.

- **Coordinate:** the per-`(sender, epoch)` ratchet `messageIndex` — the *only* cross-node-meaningful value (it's bound into the signed AEAD AAD, identical on every honest node). A node's `nextMessageIndex` per writer is its high-water mark. **Not** the host-store seqno (storage-local).
- **Beacon:** ed25519-signed `{cgId, subGraph, entries:[{sender, epoch, membershipHash, nextMessageIndex, skippedIndexes}]}`, ~45s ±40% jitter, fan-out 3, per-`(cg,peer)` backoff.
- **Detect + pull:** if a peer's high-water for some `(S,E)` dominates yours, pull the gap from any authorized member that holds it (single-writer → recover wholly from the publisher; multi-writer → union of per-writer streams).

**Five load-bearing problems (verified by adversarial review — these are why this is NOT "net-smaller"):**

1. **Cross-epoch blindness (the hardest, and the exact case we target).** A fresh epoch resets `messageIndex` to 0 and you can't compare/pull an epoch you lack the key for — so the frontier finds "different epoch," **not** "I'm behind," at every rotation. The late-joiner / >64-behind / cross-rotation case the redesign targets is **not solved by the frontier alone**; it needs an explicit cross-epoch trigger (detect "peer is on epoch E′ that I've never seen" via the agent-roster + epoch-set compare → SenderRekey to E′ → full-state pull). **Must be designed, not assumed.**
2. **Serve mismatch — "any member can serve the range" is false.** A re-serving member holds *materialized plaintext rows*, with no `messageIndex → rows` index. So a ranged `[i,j)` delta is only servable by the *original writer* (who keeps the ratchet); from any other member, the pull **degenerates to a full-graph current-state re-pull** (which latest-write-wins makes correct, just not minimal). The `swm-member-catchup` wire is therefore "ranged from the writer, full-state from anyone else" — not a uniform ranged delta.
3. **Integrity = trust any ACL-authorized member (DECISION, 2026-06-14).** Serving plaintext-at-rest bypasses per-message sender-key auth (materialized rows aren't individually signed; the writer signature is verified once at apply then discarded, and `privateMerkleRoot` is a bare unsigned meta quad). We **accept** that any agent-gate-authorized member is trusted to serve faithful plaintext. **Accepted risk:** a compromised member can serve tampered working-memory state, fail-silent, until promotion-to-VM catches it (where the chain root *is* verified — see WS-0.4). We chose NOT to build per-root writer signatures.
4. **Beacon metadata leak.** The beacon exposes the writer roster (on-chain EOAs), roster size, write cadence, and rotation timing — confidential for a private CG. **Beacon emission must be ACL-gated** with the same hard-deny as the serve path (the first pass gated only the pull).
5. **ACL fail-open is now genuinely dangerous.** `authorizePrivateSyncRequest` falls through to a weaker participant/peer branch on a null resolve ([request-authorize.ts:163-169](../../packages/agent/src/sync/auth/request-authorize.ts#L163-L169)); with plaintext serve, a transient chain hiccup turns a private CG public. **Hard-deny on null, against a fresh authenticated agent-gate read** (not the poisonable subscription cache).

**Problem 0 — the FOUNDATIONAL one (affects EVERY plaintext-recovery model, incl. the anchor variant; the prerequisite for all of WS-0).** Recovery applies as a **blind triple-UNION, not last-write-wins.** The `data` SyncPhase requester applies pulled rows via a blind `storeInsert` ([shared-memory-sync.ts:142,168-169](../../packages/agent/src/sync/requester/shared-memory-sync.ts#L142)) — a *set-union* of triples, with no per-root replacement and no tiebreak (the **gossip** apply path does per-root delete-then-insert; the **sync** path does not). The existing `data` sync was built for **cold-start full transfer** (empty target → union is correct), **not** incremental merge. So recovering into a *non-empty* store corrupts any updated/contended single-valued root into a permanent multi-value superset (`status=v1` ∪ `status=v2`). **No plaintext-sync recovery is correct until this is fixed (WS-0.0).** The fix: recovery applies as **per-root replace / LWW** — and, for a *single authoritative source*, the clean form is **wipe-and-replace** (drop the CG's local SWM, take the source's full current state — no merge, no tiebreak). Multi-source reconciliation (mesh peers, or anchor↔anchor) additionally needs a deterministic per-root tiebreak (`dkg:publishedAt` then writer EOA) added to the **sync** apply path — `operationTimestamp` is computed at [workspace-handler.ts:1066](../../packages/publisher/src/workspace-handler.ts#L1066) but currently stored only as metadata, and Rule-4 ownership ([validation.ts:75-87](../../packages/publisher/src/validation.ts#L75-L87)) hard-rejects a non-creator's overwrite of a contended root — so "union of all writers" is also false and multi-writer-same-root semantics must be defined.

**Revised recovery matrix:**

| Scenario | Mechanism | Status |
|---|---|---|
| Intra-epoch gap ≤ 64, intact receive-state | ratchet skip ≤ 64 | works today |
| Behind within a known epoch | frontier detects → member-to-member plaintext pull | **MUST BE BUILT (WS-0)** |
| **Late joiner / >64 behind / across a rotation** | cross-epoch trigger → SenderRekey to current epoch → full-state plaintext pull from a member | **MUST BE BUILT — hardest part (problem 1)** |
| Public facet, any member | `snapshot` SyncPhase (plaintext public quads) | works today |
| Pre-rotation *history* below current epoch, no keyholder online | none — **intentionally non-recoverable** (current-state contract, §8) | accepted boundary |

**Capability tradeoffs vs the dropped core backstop (accepted, but stated honestly):** pure member-to-member gives up (a) **availability when *all* holders incl. the writer are offline** — the publisher invariant holds only while the publisher (or a replica) is online; a 2-member CG with the durability gate clamped to N=1 has a publish-then-writer-offline loss window; and (b) **fail-closed integrity** (undecryptable garbage) → fail-silent tampering risk (per decision 3). The "cores hold zero" invariant becomes structural; the cost is reallocated to availability + member-trust, not eliminated.

**Optional posture — designated anchors (always-on member source-of-truth).** A private CG MAY designate ≥1 always-on **member** node (not a core) as an anchor. This was evaluated as a full replacement for the frontier and **rejected as the primary model** (the convergence half doesn't simplify — see below), but two of its parts are genuine wins we **fold in as an optional durability posture, not a hard requirement:**
- **Anchor-acked durability** — when a CG has a designated anchor, "durable" can mean *an anchor reliably-acked* (a single awaited `sendReliable` ACK that already attests *persisted + materialized*, [workspace-handler.ts:1140-1158](../../packages/publisher/src/workspace-handler.ts#L1140-L1158)) instead of the probabilistic 0.9-of-N member quorum. Simpler and stronger *when* an anchor exists.
- **Free discovery** — `resolveWorkspaceAgentRecipients` already returns each authorized agent's `peerId`, so "find the anchor / find members" needs no new transport.
- **Clean member recovery** — a single authoritative source makes member recovery a **wipe-and-replace** (§Problem 0), sidestepping the merge corruption entirely.

**Why anchors are NOT the primary model (validation verdict):** (1) a lone anchor is a self-recovery dead-end (writers delete the outbox entry on ACK, so nobody retains the bytes) → durability needs **≥2** anchors → **anchor↔anchor reconciliation re-imports the same convergence/merge problem**, only bounded to a few nodes — *not eliminated*; (2) requiring an anchor adds a **liveness dependency** the mesh lacks (no anchor reachable → can't publish durably; publish-blocks in a partition); (3) the anchor is the **durability authority**, yet its designation + `peerId` are **unsigned bare literals** — spoofable; (4) it concentrates custody on a higher-value always-on target. So: anchors are an **opt-in durability upgrade** for CGs that can run always-on nodes (enterprises/DMaaST-HOLOS), layered on the member-to-member + frontier base — not a required tier, and the full bond/escrow economy (RFC §5.5) stays deferred.

---

## 3. Workstreams

> Sizes: **S** ≤2 dev-days · **M** 3–5 · **L** 1–2 weeks. Test gates split unit / devnet (multi-node) / testnet (post-redeploy).

### WS-0 — Member-recovery layer  *(L — critical path; NOT net-smaller than the snapshot approach — work moved, not removed)*
Goal: a stripped private CG is usable + survivable **to current state**, member-side, with **no core dependency** and zero private bytes (plaintext or ciphertext) on any core. Purely additive during Phase 1 (cores still hold ciphertext as backstop until WS-A; keep `useGossip:true` — WS-0.9).

- **WS-0.0 — Recovery apply = replace, NOT blind union** *(FOUNDATIONAL — prerequisite for all of WS-0; M, and subtler than it looks — design notes below).* The `data` SyncPhase requester applies via a blind additive `storeInsert` ([shared-memory-sync.ts:168-172](../../packages/agent/src/sync/requester/shared-memory-sync.ts#L168)) that corrupts updated/contended roots on incremental recovery (§Problem 0). Implementation realities found while scoping:
  - **Two modes, not one.** `runSharedMemorySync` is the **shared** path for cold-start, public, and incremental sync, with a **single real call site** ([dkg-agent-lifecycle.ts:2888](../../packages/agent/src/dkg-agent-lifecycle.ts#L2888)) and DI'd deps (`storeInsert`, `processSharedMemoryBatch`). **Recovery** (full current state from one authoritative source — member/anchor) wants **wipe-and-replace**; **incremental top-up** wants **per-root LWW**. Don't bluntly change the shared apply — prefer a **dedicated recovery entry point** that does wipe-and-replace for one CG from one peer, leaving the incremental path's union intact for cold-start (where union is correct, empty target).
  - **Paging is across *invocations*** (checkpoint/resume via `setCheckpoint`/`nextOffset`), not just within one call. So a naive "delete root on first encounter → insert" **re-deletes a root's already-inserted rows on a later page/invocation** = new corruption. Per-root clearing must key off a **fresh-sync start** (`resumedFromOffset===0`) or durable per-root tracking; the safe form is a **graph-level wipe-and-replace gated to a fresh recovery pull**, with **atomicity** care (stage-and-swap, or accept a wipe→repopulate window — a mid-sync failure must not leave permanently-partial state).
  - **The roots are available:** `processSharedMemoryBatch` returns `entityCreators: {dataGraph, entity, creator}[]` — the roots+graphs to delete by (mirror the gossip delete: `deleteByPattern{graph,subject:entity}` + `deleteBySubjectPrefix(graph, entity+'/.well-known/genid/')`, [workspace-handler.ts:1056-1057](../../packages/publisher/src/workspace-handler.ts#L1056)).
  - **Deterministic tiebreak (multi-source divergence) is a refinement** needing a data-root→meta join: `dkg:publishedAt` is in the **meta** per share-op ([workspace-resolution.ts:155](../../packages/publisher/src/workspace-resolution.ts#L155)), not on data triples. Single-source recovery (wipe-and-replace) needs no tiebreak; multi-source anchor↔anchor does.
  - Define multi-writer-same-root semantics given Rule-4 ownership ([validation.ts:75-87](../../packages/publisher/src/validation.ts#L75-L87)) — a non-creator overwrite is hard-rejected, so "union of all writers" is false.
  - **Nothing else in WS-0 is correct until this lands. Implement carefully (shared path; "all SWM sync" blast radius) — not a quick patch.**
- **WS-0.1 — Member-to-member plaintext recovery transport** *(reuse — S/M).* Drive recovery off the **existing `data` SyncPhase** (serves decrypted `_shared_memory` rows, no re-encryption, no core dependency — `readSwmDataPage`, [graph-plan.ts:149-193](../../packages/agent/src/sync/responder/graph-plan.ts#L149-L193)). Add `/dkg/10.0.x/swm-member-catchup`: **ranged `[i,j)` per `(sender,epoch)` only from the original writer; full-state current pull from any other member** (re-serving members have no `messageIndex→rows` index — problem 2). Drive `runCatchupOverPeers`/`runSharedMemorySync` (already peer-parametric) off the **CG member roster**, not core tiering; `orderCatchupPeers(privateOnly)` is a no-op today ([peer-selection.ts:26](../../packages/agent/src/p2p/peer-selection.ts#L26)) — make it a real member-roster filter.
- **WS-0.2 — Anti-entropy frontier beacon** *(net-new — M; the answer to "how does a member know it's behind").* Coordinate = per-`(sender,epoch)` `nextMessageIndex` + `skippedIndexes`, derived from the SWM **receive-states** (not `seenShareOps`/send-states). Signed `FrontierBeacon` wire; ~45s ±40% jitter, fan-out 3, per-`(cg,peer)` backoff. **Beacon EMISSION must be ACL-gated** (problem 4 — it leaks the writer roster/cadence/rotation timing). **Cross-epoch trigger (problem 1, the hard part):** detect "peer is on an epoch I've never held" via the agent-roster + epoch-set compare → SenderRekey to that epoch → full-state pull. New `swm/frontier.ts` + `swm/frontier-beacon-wire.ts`; timer in `dkg-agent-lifecycle.ts`.
- **WS-0.3 — ACL hard-deny gate** *(security — #1 item, S).* Now that serve is **plaintext**, the ACL is the only barrier to cleartext. Authorize the member path against **only** `getContextGraphAgentGateAddresses` and **HARD-DENY on null** — today `authorizePrivateSyncRequest` **widens** on null to participant/peer ([request-authorize.ts:163-169](../../packages/agent/src/sync/auth/request-authorize.ts#L163-L169)); remove that for the member path. Bind to a **fresh authenticated** agent-gate read, not the poisonable subscription cache ([:444](../../packages/agent/src/dkg-agent-crypto.ts#L444)). Use a **distinct authorizer** so the node-operator branch ([dkg-agent-swm-host.ts:1697-1714](../../packages/agent/src/dkg-agent-swm-host.ts#L1697-L1714)) and delegation union can't be reused by default.
- **WS-0.4 — Recovered-state verification** *(reduced by the integrity decision — S/M).* **Promoted (VM):** verify against the **on-chain merkle root** — re-read `getLatestMerkleRoot(kaId)` and compare to the recomputed flat root (today durable sync checks self-consistency only). **Pre-promotion SWM: trust any ACL-authorized member** (DECISION 2026-06-14) — no per-root writer signatures; accept fail-silent member tampering until promotion. (This is the scope we removed by choosing the trust model.)
- **WS-0.5 — SenderRekey, FUTURE-writes only** *(reuse-ish — S).* No longer recovers past state (that's WS-0.1). Only hands a returning/new node the **current** epoch key for **future live writes**. Soften the throw at `:2129-2131` to a retriable error; re-bootstrap the live epoch. Net-new: `createSignedSwmSenderKeyPackage` hardcodes `initialMessageIndex:0` ([:1805](../../packages/agent/src/dkg-agent-crypto.ts#L1805)); a same-epoch re-issue must not discard `skippedChainKeys`.
- **WS-0.6 — Agent-roster discovery** *(prerequisite — S/M).* Agent-gated private CGs return `source:'none'` ([enumerate-cg-members.ts:312-315](../../packages/agent/src/swm/enumerate-cg-members.ts#L312-L315)); derive an enumerable agent-roster (signed `agentEOA→peerId` on `_meta`). **Hard prerequisite for both the cross-epoch trigger and detecting a wholly-missed sender** (a sender absent from all your receive-states is invisible without the roster).
- **WS-0.7 — Publish-time durability gate** *(M).* Replaces the removed core ACK quorum with **two opt-in backends:** (i) **Member Durability Round (MDR)** — a member ACK attests persistence AND decryptability (member-computed witness, **never carried in the Intent**); N default 2, and the `min(2, rosterSize−1)` clamp must **not** silently drop a 2-member CG to N=1 zero-external-redundancy — surface a typed downgrade. (ii) **Anchor-acked** *(optional, §2 anchor posture)* — when the CG designates anchor(s), `durable` = **≥2 distinct anchor ACKs** (typed downgrade if only 1 reachable), each a single awaited `sendReliable` ACK that already attests persisted+materialized — simpler than the 0.9-of-N quorum (reuses `sendReliable` + SQLite outbox + the applied-attesting empty-response convention verbatim). Both bound the availability boundary (≥1 *other* holder before publish acks). **Liveness note:** the anchor backend adds a dependency the mesh lacks — no anchor reachable ⇒ writes queue in the outbox as a **typed "not-yet-durable"**, never silent loss; the outbox 24h TTL ([protocol-outbox.ts:78](../../packages/agent/src/protocol-outbox.ts#L78)) expiry of an undelivered write must surface as typed loss too.
- **WS-0.8 — Member-side state** *(reuse — S).* No new opaque store: every member already materializes all authorized senders' writes into `_shared_memory` (latest-write-wins). That plaintext graph **is** the re-servable state. (Drops the old "member-local host-mode-store analogue.")
- **WS-0.9 — Gossip-off coupling** *(structural).* Keep `useGossip:true` on the member-roster arm **until WS-A**; the gossip-off flip and the roster fix are inseparable.

Risk: **High** (net-new security-sensitive protocol; plaintext serve makes the ACL gate + beacon-gating load-bearing). Gate: cross-rotation chaos soak (§5) — must show a node detecting a silent miss via beacon and recovering member-to-member **across a rotation**, the hard-deny gate rejecting a null/non-member resolve, and the beacon refusing emission to a non-member.

### WS-A — Strip ciphertext from cores  *(M — LAST move)*
Cores stop subscribing private workspace topics, stop persisting/serving private ciphertext, retire the operator chunk-fetch ([dkg-agent-swm-host.ts:1573](../../packages/agent/src/dkg-agent-swm-host.ts#L1573), `:1697-1714`). Depends on WS-0 baked + WS-B/C/D/E green. Risk: **High** (irreversible) — mitigated by sequencing last after soak.

### WS-B — Contract: catalog commitment  *(L — storage-touching)*
- **Remove** the ciphertext commitment; **add** `catalogRoots`/`catalogLeafCounts` as **NEW** storage slots appended to `DKGKnowledgeAssets.sol` (avoids the legacy-ciphertext-root-masquerades-as-catalogRoot footgun; legacy KCs read 0 → grandfather).
- Invert the curated publish gate ([KnowledgeAssetsLifecycle.sol:701-713](../../packages/evm-module/contracts/KnowledgeAssetsLifecycle.sol#L701-L713)): catalog mandatory for curated, forbidden for public; re-derive the update-path gate ([:1554-1567](../../packages/evm-module/contracts/KnowledgeAssetsLifecycle.sol#L1554-L1567)).
- **Trap 1 (proof-race):** `submitProof` reads `(root,count)` **live** at [RandomSampling.sol:304-310](../../packages/evm-module/contracts/RandomSampling.sol#L304-L310) — and the in-source comment at [:295-300](../../packages/evm-module/contracts/RandomSampling.sol#L295-L300) **falsely claims it doesn't**. Add `challengeRoot`/`challengeLeafCount` to `RandomSamplingLib.Challenge`, snapshot at issuance, verify against the pinned pair, delete the live reads.
- **Trap 3 (ACK cross-attest):** prepend `uint256(ACK_DIGEST_VERSION=2)` to the **raw `abi.encodePacked` ACK preimage** at [KnowledgeAssetsLifecycle.sol:652](../../packages/evm-module/contracts/KnowledgeAssetsLifecycle.sol#L652). **NOT** the `_EIP712_VERSION_HASH` bump — the ACK digest is `toEthSignedMessageHash`, not EIP-712. (Bump both, but the raw prefix is the one that closes the hole.)

Risk: **High** (storage layout + reward path). Watch the contract deployed-flag gotcha on reinit.

### WS-C — Catalog sampling + prover/extractor  *(M)*
- **Trap 2 (interleave):** `V10MerkleTree` sorts+dedupes ([v10-merkle.ts:39-48](../../packages/core/src/crypto/v10-merkle.ts#L39-L48)) → catalog and private sub-root leaves interleave with no addressable range. Build a **separate Merkle tree over catalog leaves only**; curated draw `chunkId = seed % catalogLeafCount`; skip curated KCs with `catalogLeafCount==0`. Private sub-roots stay in `kcMerkleRoot` (proof-of-existence) **but are never drawn**.
- **Traps 1+2 MUST deploy atomically** with WS-B — a split deploy has an intermediate state that fails honest cores (catalog-index draw vs live ciphertext root).
- Off-chain: prover curated branch reads the pinned challenge + catalog getters; `ka-extractor.ts:174` sources leaves from the `_catalog` graph (today it reads `_data` only).

Risk: **High** (reward path).

### WS-D — Catalog-to-cores transport / persist / ACK  *(M)*
Publisher computes `catalogRoot`/`catalogLeafCount` over `catalogQuads` only (`partitionCatalogQuads`), ships **plaintext catalog** (not ciphertext) to cores; invert the storage-ack "must be encrypted" gate to "must carry catalog commitment" while still verifying the catalog root; cores persist + serve `_catalog` (the existing `catalog` SyncPhase / `readCatalogPage` / `fetchPublicCatalog`, already green). **Trap 4:** `partitionCatalogQuads` is subject-keyed → publish-time `WARN publish.catalog.public-projection` listing exactly which triples become public, surfaced before the irreversible commit. Risk: **Medium**.

### WS-E — Migration  *(M)*
**Grandfather, not wipe.** Legacy curated KCs read `catalogRoots[id]==0` → skipped by the curated draw, re-enter on first post-rc18 update writing a catalog commitment. In-flight challenges spanning the redeploy: **clear outstanding challenges** at an epoch boundary (a net-new admin/migration function — must be written + tested, not a flag). **DMaaST/HOLOS partner check is a hard gate before WS-A:** confirm devnet/testnet curated CGs are non-disposable; partners must **re-publish** to re-enter the catalog draw (backfill is unprovable — cores hold no legacy catalog tree). Risk: **Medium**.

---

## 4. Dependency + sequencing

```
Phase 1 — additive, cores STILL hold ciphertext (backstop intact):
  WS-0  member-recovery layer (WS-0.0 union-fix FIRST → plaintext data sync + frontier beacon +
        SenderRekey-future-only + durability gate + ACL hard-deny)
        ↳ INVARIANT: keep useGossip:true on the member-roster arm here; do NOT flip gossip-off yet,
          or cores stop receiving private SWM before WS-A and the backstop is gone prematurely.

Phase 2 — contract + proof + transport (cores still hold ciphertext):
  WS-B  contract catalog-commitment ─┐  traps 1+2 deploy ATOMICALLY
  WS-C  catalog sampling + prover   ─┤
  WS-D  catalog-to-cores transport  ─┘
  WS-E  migration (grandfather + clear-in-flight; partner check)

Phase 3 — the strip, LAST, only after the cross-rotation chaos soak passes:
  WS-A  strip ciphertext from cores + flip gossip-off
```

Trap fixes fold into: traps 1+2 → WS-B/WS-C (atomic deploy); trap 3 → WS-B raw-preimage prefix + WS-D off-chain mirror; trap 4 → WS-D warning.

---

## 5. Contract & testnet-bake plan

**Redeploy (manual).** Two storage-layout changes (`DKGKnowledgeAssets` new `catalog*` maps; `RandomSamplingLib.Challenge` + storage grow by 2 fields). `release.yml` broken since rc.8 → manual cut; watch the deployed-flag gotcha on reinit. Sequence the `RandomSamplingStorage` redeploy at an **epoch boundary** and clear outstanding challenges as part of the cut. ABI/typechain/dkg.js regen (`getNodeChallenge` tuple grows; getter/event names change — check indexers reading by name).

**Multi-epoch soak (≥3 epochs)** with curated KCs earning via catalog proofs; assert no honest-core failure across an epoch boundary or a mid-period curated update (proof-race regression); grandfather path; a partner-shaped 2–3-member CG through the MDR.

**Member-recovery chaos test (mandatory gate for WS-A):**
1. Publish to a multi-member private CG; confirm the durability gate (MDR or anchor-acked) + replication to ≥1 other holder.
2. **Union-fix regression (WS-0.0):** a member holding `status=v1` recovers from a source holding `status=v2` and ends with **only `v2`** (per-root replace / wipe-and-replace) — the negative control (blind union) shows the corrupt `{v1,v2}` superset, proving WS-0.0 closes it.
3. Take a member offline; **rotate membership (join + leave)** so a new epoch is minted; send >64 further writes under the new epoch.
4. Bring a **true cross-rotation recoverer** (freshly-admitted member) online: the **frontier beacon detects the new epoch** (cross-epoch trigger) → SenderRekey for forward writes → **plaintext pull of current state** from a member. Assert it reaches **correct current state**, decrypts a new forward write, **no prior-epoch envelope is ever replayed**, and **the core holds zero plaintext** throughout.
5. **ACL hard-deny:** a null/failed agent-gate resolve **rejects** (does not widen to participant/peer); the **beacon refuses emission** to a non-member.
6. Kill **all** holders past TTL with no writer online → assert the residual unrecoverable boundary surfaces as an explicit typed failure, not silent loss.

Only after this soak passes does **WS-A** land.

---

## 6. Risk register / must-fix before build

1. **Authorization fail-open (the #1 gating fix).** The private-snapshot/catch-up/frontier/MDR responders must hard-deny on a null ACL resolve and must NOT widen on probe failure. Audit the subscription-cache input to `getContextGraphAgentGateAddresses` ([:444](../../packages/agent/src/dkg-agent-crypto.ts#L444)) for non-member poisoning. Fail-open here defeats the strip's entire purpose.
2. **Traps 1+2 atomic deploy** + correct the lying comment at `RandomSampling.sol:295-300`. **Trap 3** needs the raw-preimage prefix, not the EIP-712 bump.
3. **MDR decrypt-witness must be member-computed, never carried in the Intent.** N=2 must not silently clamp a 2-member CG to zero redundancy.
4. **Phase-1 invariant:** keep `useGossip:true` on the member-roster arm until WS-A (cores stay backstop). Resolve how a Phase-1 private publish satisfies the contract gate (it still carries a ciphertext commitment until WS-B lands).
5. **SenderRekey is net-new crypto** (the `initialMessageIndex:0` hardcode; same-epoch re-issue must not nuke `skippedChainKeys`).
6. **Migration:** write + audit the clear-outstanding-challenges function; confirm partner non-disposability + re-publish before WS-A.

---

## 7. Timeline (honest)

| Phase | Workstreams | Est. (focused weeks) |
|---|---|---|
| P1 — recovery layer | WS-0 (union-fix + plaintext data sync + frontier beacon + cross-epoch trigger + SenderRekey + durability gate + ACL hardening) | **4–5 wk** |
| P2 — contract + proof + transport | WS-B (L) ∥ WS-C (M) ∥ WS-D (M); WS-E (M) — partly overlaps P1 tail | **2–3 wk** |
| P3 — strip + bake | WS-A (M) + multi-epoch soak + cross-rotation chaos test | **1–2 wk** |

**Critical path:** WS-0 → WS-A (the strip cannot land until recovery is baked across a membership rotation). **8-week floor, 11–13 realistic** once the private-snapshot phase, authorization review, and manual redeploy are priced in. Do not commit a 2- or 4-week rc18 externally.

---

## 8. Residual unrecoverable boundary (the honest contract)

With cores holding zero private bytes, a private CG recovers to **correct current state**, not full private event history. Permanently unrecoverable, by design:
- **Append-only / event-log private CGs across a rotation** when no old-epoch keyholder remains — every delta is load-bearing; "current state" is undefined/lossy for this shape.
- **A true late joiner's pre-snapshot private history** — reaches current state, cannot decrypt `[a, snapshot)` (no member→member chain-key handoff, and there shouldn't be — handing an epoch chain key at index `i` discloses every message key from `i` forward).
- **Individual skipped messages past the 64-gap** when the messages themselves (not just current state) are needed.

**The CG contract to publish and communicate to partners:** *"recover to correct current state"* — explicitly **not** *"recover full private event history across a membership rotation."* For current-state knowledge graphs (`_shared_memory` is latest-write-wins) this loses nothing material; for event-log CGs it is a real trade that must be accepted before WS-A.

---

## 10. The intended SWM model — CURATOR-AS-LEADER (single-leader replication) (2026-06-14, adversarially corrected)

> **Supersedes the §2 frontier/beacon model AND the §9 digest-manifest** — both were scaffolding to *invent* an oracle the chain doesn't give SWM. Curator-as-leader **names** the oracle (the curator) instead. This section is the **adversarially-corrected** version: it keeps only what verified true and labels the net-new/unsolved parts honestly (the first-pass respec oversold three load-bearing claims — see "Open problems" below).

**The model.** The **curator** (a member node, never a core — so "cores hold zero" holds by construction) is the authoritative SWM replica. It maintains a **contiguous per-CG sequence number** over the SWM writes it observes — a per-CG off-chain oracle. *(This is the SWM counterpart of VM's freshness oracle, which is the **per-KA on-chain merkle root** `getLatestMerkleRoot(kaId)` — NOT a "batchId" ordinal; `batchId`/`KnowledgeBatch` is dead KC-legacy, the off-chain `dkg:batchId` is literally the kaId, and V10 is strictly 1 merkle root per KA. The curator-seqno is per-CG by deliberate choice; VM's roots are per-KA.)* The unit is the **KA-graph `(author, number)`** (a named graph of many entities), **not** `rootEntity` (legacy KC decomposition). Members **delta-sync** "give me changed KA-graphs since curator-seqno N", reusing the `sinceBatchId`-shaped delta **wire** (note: that wire's `dkg:batchId` is the kaId and the durable delta path is currently dormant — we reuse its transport, not a live VM batch-delta), then `applySwmRecovery` REPLACEs just those KA-graphs. "Am I current?" = `myLastSeqno == curatorHead`.

| | SWM (curator-as-leader) | VM |
|---|---|---|
| Authority | curator-seqno (per-CG leader oracle, **off-chain**) | **per-KA** chain merkle root `getLatestMerkleRoot(kaId)` (global, **chain-anchored**; no batchId ordinal) |
| Unit | KA-graph `(author, number)` | KA / batch |
| Convergence | delta since curator-seqno → REPLACE changed KA-graphs | `sinceBatchId` delta-sync |
| Conflicts | none — single ordering authority | none — chain order |

**What's genuinely real (the win, verified).** The read-side delta reuses the entire `sinceBatchId` transport/parse/checkpoint/auth/page-loop machinery (mirrored as `sinceCuratorSeqno`); `applySwmRecovery` REPLACE (now keyed on the KA-graph) is reused; `resolveCuratorPeerId`/preferred-sync wiring exists. The **frontier's hardest problems vanish**: no cross-epoch `messageIndex` trigger, no oscillation (a single monotonic source can't regress), no manifest-of-millions (delta = `seqno > N`), no beacon roster-leak. The dropped modules (`frontier.ts`, `frontier-beacon.ts`, `recovery-plan.ts`, the §9 digest-manifest) are **cleanly removable** (referenced only in driver comments/ui helpers).

**Net-new (small, real):** (a) the curator stamps a contiguous per-CG seqno at the single lock-guarded write seam (`_shareImpl → store.insert`), persisted as a `dkg:curatorSeqno` meta triple in the same insert batch; allocate only on `applied:true`. (b) a `sinceCuratorSeqno` delta responder + dropping the `!includeSharedMemory` exclusion. (c) KA-graph **tombstones** for deletions (a `seqno > N` delta surfaces adds/updates but not a KA the curator *deleted* — REPLACE never removes an omitted graph).

**OPEN PROBLEMS — net-new and NOT solved by reuse (the first-pass respec mislabeled these as "kept"):**
1. **Per-write provenance does NOT exist on the recovery path.** `processSharedMemoryBatch` is **structural-only** (`sync-verify-worker-impl.ts:242-360`); "creator" is a self-asserted `dkg:publisherPeerId` literal; signatures are verified ONLY on the gossip-receive path (`workspace-handler.ts:823`). So a leader serving plaintext is **unverifiable** — a compromised/forked curator can omit/reorder/misattribute writes and stamp a monotonic seqno over the lies. Real verification is **net-new**, not "KEPT."
2. **Deterministic leader pick is unsolved.** `getContextGraphCurator` is node-relative (self-elects); the `owners[0]` fallback is over an **unordered** query (`context-graph-meta-projection.ts:282`) → two members can elect different leaders. A globally-deterministic pick must be **built**.
3. **Foreign/peer-discovered CGs have NO resolvable leader** — `resolveCuratorPeerId` returns `undefined` (`dkg-agent-cg-resolve.ts:1325-1327`) for a CG you didn't create and whose `_meta` curator triple you never got. State this as a first-class boundary, not "a leader is always defined."
4. **No failure detector** — slow-vs-down curator is indistinguishable; only a dial-failure triggers fallback, and that fallback pulls from **untrusted arbitrary peers** (defeating the oracle). V10.0 is **manual-failover-only** unless a detector is built.
5. **Split-brain heal is incomplete** — "curator log authoritative" only re-REPLACEs the KA-graphs the curator's delta touches; **forked writes a follower gossiped to other members survive** (seqno-gateless gossip apply), and a **follower-acked "durable" write can be silently lost on heal**.
6. **No chain anchor (fundamental, unchanged by either model)** — the curator-seqno is a bare integer; the VM analogy is **wire-shape only, not trust-shape**.

**Honest verdict.** Leader-based is the right *direction* and the read-delta is a real simplification, but it **relocates** the difficulty (multi-master convergence → leader-election + failover + fencing + trust-without-anchor) rather than removing it. **It fits OT-RFC-49's primary target — a trusted, always-on enterprise curator (DMaaST/HOLOS)** — where "trust the curator + it's the SPOF" is the deployment model, not a bug; problems 1–6 are largely *answered by that deployment* and are *real work* for the decentralized/adversarial case. **Honest re-estimate:** the read-delta MVP is ~2–3 wk (mostly reuse); failover + provenance + tombstones + deterministic-leader are the net-new cost (the respec under-counted them by labeling them reuse). Net vs the frontier: **lower convergence risk, but the residual concentrates on leader-election/failover/trust** — better-understood problems, not free ones.

---

## 9. (superseded) Constrained SWM + versioned digest reconciliation

> This is the **preferred convergence design**, simpler and more reliable than the frontier/beacon (§2 WS-0.2), and it directly answers two real concerns: (a) full-state transfer doesn't scale for large SWM; (b) SWM has no chain oracle, so "am I current?" is otherwise unanswerable. It supersedes the frontier as the *intended* mechanism; the frontier modules remain as dormant logic and are not required.

**Why SWM convergence is hard without the chain.** VM is easy because the chain is a global, trustless oracle: a node reads each KA's `getLatestMerkleRoot(kaId)` (per-KA; there is no batchId ordinal — that's dead KC-legacy), compares, and re-pulls stale KAs. SWM has **no oracle** — it's a mutable multi-master off-chain replica, so "current" is only definable *relative to peers*, who can disagree. The fix is not to invent a global oracle but to **constrain SWM so a LOCAL per-root oracle is sufficient.**

**The three constraints (two already enforced):**
1. **Single-writer-per-root** — already enforced by Rule-4 ([validation.ts:75-87](../../packages/publisher/src/validation.ts#L75-L87)): only a root's creator may overwrite it. *Make it a feature, not a limitation* → there are no cross-writer conflicts to merge (the one genuinely unsolved case disappears).
2. **Per-root writer-version** *(the missing piece — the SWM analog of VM's per-KA on-chain merkle root)* — each root carries its owning writer's monotonic version (a counter, or reuse `dkg:publishedAt`, [workspace-resolution.ts:155](../../packages/publisher/src/workspace-resolution.ts#L155)). The **writer is the per-root authority — a local oracle per root.** VM gets a per-KA `getLatestMerkleRoot(kaId)` from the chain (per-unit, trustless); constrained-SWM uses the per-root writer-version as a *local* per-unit one. *(There is no chain `batchId` ordinal — dead KC-legacy; per-root writer-version is actually the close analog of VM's real per-KA model.)* Single-writer-per-root is exactly what makes a local oracle sufficient (no root has competing writers → no global coordination). This also **kills the stale-source oscillation** (§2 problem): version-aware replace never overwrites newer with older.
3. **Bounded size + TTL** — SWM is the *small ephemeral working set*; large/durable data **belongs in VM** (promote it — VM has the chain oracle + `sinceBatchId` delta-sync). This makes full reconcile always cheap and **dissolves the large-SWM scaling concern** (large data is not SWM's job).

**The recovery mechanism = per-root versioned digest reconciliation.** Manifest = `{ root → (writerEOA, writerVersion, contentDigest) }` (reuse `workspacePublicQuadsDigest`). A behind member fetches a peer's manifest, and for each root **takes the max writer-version**, pulling only the newer/differing roots, then `applySwmRecovery` REPLACEs just those. Deterministic (max-version-wins), scalable (pull only the diff), reliable (no conflicts), no chain needed — *same shape as VM sync, with a per-root local oracle instead of a global on-chain one.*

| | SWM (constrained) | VM |
|---|---|---|
| Authority | per-root writer version (local oracle) | **per-KA** chain merkle root `getLatestMerkleRoot(kaId)` (global oracle; no batchId) |
| Writers | single-writer-per-root (Rule-4) | curated / conviction |
| Size | bounded working set + TTL | unbounded durable record |
| Convergence | max-version digest reconciliation | sync toward chain |

**Trust caveat.** Under the "trust any ACL member" decision (§2), a malicious member could forge a high version. For Byzantine-resistance the writer **signs** `(root, version, digest)` — the per-root signature deferred in §2. Composes with the chosen trust level; among honest members the versioning alone converges cleanly.

**Build delta vs what's already built.** `applySwmRecovery` (per-root REPLACE) and `recoverContextGraphSwmFromPeer` are reused verbatim — the recovery list becomes the *differing/newer* roots instead of all roots. Net-new: (a) per-root writer-version stamped on write (small — reuse `publishedAt` or add a counter), (b) the `manifest` SyncPhase serving `{root → (writer, version, digest)}`, (c) the diff-and-pull driver. This is *smaller* than the frontier/beacon and removes the cross-epoch/messageIndex machinery entirely.
