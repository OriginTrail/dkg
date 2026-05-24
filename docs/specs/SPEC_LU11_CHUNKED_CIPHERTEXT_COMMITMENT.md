# LU-11: Chunked Ciphertext Commitment for Curated VM Publish

**Status**: Draft — design delta for discussion.
**Author**: agent (claude-opus-4.7), drafting against feedback from the random-sampling agent on PR #595 / RFC-39.
**Depends on**: OT-RFC-38 LU-6 Phase B (PR [#610](https://github.com/OriginTrail/dkg/pull/610)) substrate.
**Unblocks**: OT-RFC-39 (curated random sampling), PR #114.

---

## 1. Problem statement

OT-RFC-38 §5.4.1 (in `docs/specs/SPEC_CG_HOSTING_MEMBERSHIP.md` on the LU-6 stack) specifies that the curated `ACKRequest` carries per-SWM-message ciphertext-chunk digests + a `ciphertextChunksRoot`, indexed under `(contextGraphId, batchId, swmMessageIndex)`. The spec further mandates a "persist-before-sign" invariant: cores MUST durably persist + index every chunk they intend to ACK before signing.

**The current Phase A implementation does none of this.** Instead, the curated VM-publish path:

1. Reads from SWM (which IS fed per-message via `swmHostModeStore.append` — confirmed by SCENARIO E of `devnet-test-rfc38-late-joiner.sh`).
2. Decrypts member-side, materialises the merged plaintext.
3. Re-encrypts the **entire merged plaintext** with a single chain-key AES-256-GCM blob via `v10-publish-payload.ts:encryptInlinePayload`.
4. Ships that one opaque blob inline as `PublishIntent.stagingQuads` (`storage-ack-handler.ts:197-260`).
5. Cores stage the blob under TTL, sign the existing V10 digest the publisher claimed, with **no per-message chunk linkage** to what they hold in `swmHostModeStore`.

So today there is **no cryptographic binding between the on-chain commitment and the per-SWM-message ciphertext cores actually host**. RFC-39 curated random sampling — which needs to pick a per-message chunk by index and verify against an on-chain root — therefore has nothing well-defined to sample.

**LU-11 (Chunked Ciphertext Commitment, short form CCC) closes this gap** by making the curated VM-publish path produce a `ciphertextChunksRoot` over the same per-message ciphertexts that SWM gossiped, and threading that root through to the ACK envelope (§5.4.1) and on-chain (RFC-39 §3.4).

## 2. Today's curated publish, in three call sites

| Step | File | Behavior |
|---|---|---|
| Member-side: per-message SWM gossip envelope | `dkg-agent.ts:publishWorkspaceGossip` → `swmHostModeStore.append` on receivers | Per-message ciphertext keyed by `seqno`, signed by `agentAddress`. Already correct shape for LU-11 — this is the substrate. |
| Member-side: aggregate + chain-key AEAD | `agent._resolveEncryptInlinePayload` → `core/v10-publish-payload.ts:encryptInlinePayload` | Concatenates all SWM-derived plaintext, encrypts in one AES-256-GCM call with a derived chain key. **This is where the chunking is lost.** |
| Core-side: ACK without chunk verification | `publisher/storage-ack-handler.ts:197-260` | Receives one `stagingQuads` blob, persists opaquely, signs V10 digest the publisher claimed. No `ciphertextChunks[]`, no `ciphertextChunksRoot`, no `swmMessageIndex` cross-reference. |

## 3. Target behavior

Per spec §5.4.1:

- Curator emits **N** per-SWM-message ciphertexts `ct_1 .. ct_N` keyed to `swmMessageIndex_1 .. swmMessageIndex_N` (the SWM seqnos cores already hold under `swmHostModeStore`).
- Curator computes `ciphertextChunksRoot = merkleRoot([H(ct_i) for i in 1..N])`.
- ACK envelope (`ackProtocolVersion: 2`) carries `ciphertextChunks[]` + `ciphertextChunksRoot`; bytes stay in `swmHostModeStore` (cores already have them via gossip — no second copy on the ACK wire).
- Core verifies it holds every `ct_i` at `(contextGraphId, batchId, swmMessageIndex_i)` before signing. Missing chunks → `ChunkPullRequest` fallback (§5.4.3) or `DECLINE`.
- On-chain: `KnowledgeAssetsV10.PublishParams` gains a `ciphertextChunksRoot bytes32` field (RFC-39's contract change). Curated random sampling weights against this root; public CGs pass `bytes32(0)` and use the existing leaf-root path.

## 4. Two convergence options for the publisher

The architectural question is **what ciphertexts the publisher should emit per-message**:

### Option A — Drop chain-key re-encryption, use SWM sender-key ciphertexts as authoritative

- Publisher reads SWM, materialises plaintext, **does not re-encrypt**. The SWM sender-key envelopes ARE the authoritative ciphertext.
- `ct_i = swmHostModeStore.iterate(cgId).map(entry => entry.envelopeBytes)`.
- `ciphertextChunksRoot = merkleRoot([keccak256(ct_i)])`, leaves indexed by SWM `seqno`.
- Cores already hold `ct_i` under `(cgId, seqno)` — `swmMessageIndex == seqno`, zero translation.

**Pros**: Simplest. Single ciphertext per message, no double-encryption overhead, perfect 1:1 mapping with the substrate. The "persist-before-sign" invariant becomes trivially satisfied because SWM ingest IS the persistence.

**Cons**: Couples VM persistence key to SWM sender keys. Sender keys rotate (LU-4), so the on-chain commitment effectively binds to a key generation the curator can revoke. **Member key rotation could orphan an on-chain commitment** — once the old sender key is forgotten, the ciphertext is undecryptable even by members. This is a real problem: today's chain-key re-encryption exists precisely to give the publish a separate, stable key independent of member-state churn.

### Option B — Keep chain-key AEAD, but chunk it 1:1 with SWM messages

- Publisher reads SWM, materialises plaintext, re-encrypts **per-SWM-message** with the chain key — one AEAD call per source message instead of one over the whole batch.
- `ct_i = AES-GCM(chainKey, nonce_i, plaintext_i)` where `plaintext_i` is the i-th decrypted SWM envelope's payload and `nonce_i = HKDF(batchId || swmMessageIndex_i)` (deterministic from public inputs).
- `ciphertextChunksRoot = merkleRoot([keccak256(ct_i)])`, leaves indexed by `swmMessageIndex_i`.
- Cores hold the chain-key ciphertext `ct_i` keyed by `(cgId, batchId, swmMessageIndex_i)` — a **new index alongside SWM seqno**, both populated by the same ingest.

**Pros**: Preserves the existing key-separation invariant (sender keys rotate freely without orphaning on-chain commitments). Drop-in for the existing `chain-key AEAD` security story.

**Cons**: Two ciphertext copies per message at core ingest (sender-key envelope for member catchup, chain-key chunk for ACK verification). ~2x storage on cores for curated CGs. More code: ingest path needs to materialise the chain-key chunk alongside the sender-key envelope.

### Recommendation: **Option B**

Option A's "member key rotation orphans the on-chain commitment" risk is unacceptable for a permanent attestation surface. Mainnet curators MUST be able to rotate sender keys (member revocation, post-compromise) without losing access to prior on-chain attestations.

The 2x storage cost is bounded by the existing `swmHostModeStore` retention policy and is small in absolute terms (curated CGs are a fraction of total traffic; ciphertext is already roughly plaintext-sized). The "two ciphertexts per message" framing is also slightly misleading — the sender-key envelope is short-lived (members consume + ack), while the chain-key chunk is the long-lived persisted artefact tied to the batch's `epochs`.

## 5. Implementation plan (this PR)

Phase-gated commits, each independently mergeable:

| # | Commit | Touches | Verifiable when |
|---|---|---|---|
| 1 | **Design delta** (this doc) | `docs/specs/SPEC_LU11_CHUNKED_CIPHERTEXT_COMMITMENT.md` | Other-team review-approved. |
| 2 | **Chunked AEAD helper** in `@origintrail-official/dkg-core` | `core/v10-publish-payload.ts:encryptInlinePayloadChunked`, deterministic nonce derivation `nonce_i = HKDF(batchId, swmMessageIndex_i)` | Unit test: round-trip N messages, verify deterministic ciphertext, verify Merkle root over `H(ct_i)` matches a known fixture. |
| 3 | **Ciphertext-chunk Merkle builder** | `core/src/v10-merkle-tree.ts:buildCiphertextChunksRoot` (pure function, no chain coupling) | Unit test: 0, 1, 2, 32, 1023 chunks; verify against an oracle implementation. |
| 4 | **ACKRequest v2 wire format** | `core/src/proto/publish-intent.ts` adds optional `ciphertextChunks[]`, `ciphertextChunksRoot`, `ackProtocolVersion` fields. Backwards-compatible: missing fields imply `v1`. | Wire roundtrip test + decode of legacy v1 still works. |
| 5 | **Publisher emit** | `publisher/v10-publish-runner.ts` or wherever `isEncryptedPayload=true` is set: replace `stagingQuads`-as-blob with per-message chunks. SWM seqno → `swmMessageIndex` mapping. | Publish a curated CG with 5 SWM-derived messages, assert ACK request carries 5 `ciphertextChunks[]` with matching SWM seqnos. |
| 6 | **Core verify** | `publisher/storage-ack-handler.ts:197+` branches on `ackProtocolVersion`. For v2: read `ciphertextChunks[]`, look up each in `swmHostModeStore.get(cgId, swmMessageIndex)`, recompute root, decline on `BYTESIZE_MISMATCH` or missing chunks. | Devnet test: 2 cores host CG, publish triggers ACK round, both cores verify per-chunk before signing. Replace SCENARIO E's existing assertions with chunk-aware variants. |
| 7 | **ChunkPullRequest fallback** (§5.4.3) | `agent/src/swm/chunk-pull.ts` + wire format. Triggered when ACK verification can't find a chunk locally. | Devnet test: artificially evict a chunk from one core before ACK round, verify it pulls from a peer before signing. |
| 8 | **`ciphertextChunksRoot` to chain** (separates LU-11 publisher emit from RFC-39 contract field) | `chain/evm-adapter.ts` threads the new on-chain field. | Coordinated with RFC-39 contract PR (other agent). Feature-flagged: `bytes32(0)` until both sides shipped. |

Commits 1-4 are pure-function / wire-format; can land in any order against any base.
Commits 5-6 require Phase B substrate (depends on PR #610 merging or rebasing onto its head).
Commit 7 is a separate sub-feature, could be its own PR.
Commit 8 is the handshake with the RFC-39 contract PR.

## 6. Open questions

1. **`swmMessageIndex` namespace**. SWM `seqno` is per-(cgId, host) — different cores may have different seqno counts for the same CG depending on when they started hosting. Spec §5.4.1 says "swmMessageIndex" — must be a curator-assigned monotonic counter (not core-local), threaded into the SWM envelope at publish time. **Add a new `swmMessageIndex` field to the SWM gossip envelope?** Or derive from `(timestamp, hash(payload))`?

2. **Nonce derivation determinism**. Option B's `nonce_i = HKDF(batchId, swmMessageIndex_i)` must produce a unique nonce per `(batchId, swmMessageIndex)` pair. If a curator re-publishes the same logical batch (e.g. quorum failure → retry), does `batchId` change? If yes, no nonce collision. If no, we re-use a nonce under the same key → catastrophic AES-GCM failure. **Recommendation**: bind `batchId` to `publishOperationId` (unique per attempt) and document the invariant.

3. **Chunk size policy**. §5.4.1 leaves chunk size to the publisher. Per-SWM-message is the obvious unit but means small chunks (~1KB typical) → high AEAD overhead (16-byte tag is ~1.5% of 1KB). Should the curator be allowed to coalesce N SWM messages into one chunk (trading sample granularity for storage efficiency)? **Recommendation**: ship 1:1 SWM message → chunk in v1; revisit coalescing as a separate proposal once we have curated-traffic data.

4. **Migration**. Existing curated CGs published under Phase A use the inline-blob path with no `ciphertextChunksRoot`. The chain treats `bytes32(0)` as "no curated random-sampling commitment" (RFC-39 feature flag), so they keep working. No migration needed for the substrate. Open question: do we want a curator-driven "re-attest" path to upgrade old publishes? **Recommendation**: no. Old publishes stay as-is; curators publishing fresh batches automatically get the new path once LU-11 + RFC-39 ship.

## 7. Non-goals for this PR

- RFC-39's contract change (`ciphertextChunksRoot` on `KnowledgeAssetsV10.PublishParams` + the `_pickWeightedChallenge` branch). That's the other agent's PR. This PR's commit 8 only threads the field through the chain adapter; the contract diff lives in their PR.
- Curated random-sampling proof submission (`RandomSampling.submitProof` curated branch). Also their PR.
- ChunkPullRequest implementation (§5.4.3 fallback) — broken out as commit 7, may split into a follow-up PR depending on review size.
- Coalescing policy / curator-tunable chunk size — deferred per open question §6.3.

## 8. Acceptance criteria

- [ ] Other agent (random sampling / RFC-39) signs off on §4 Option B + the on-chain commit 8 handshake shape.
- [ ] SCENARIO E of `devnet-test-rfc38-late-joiner.sh` passes with `ackProtocolVersion: 2` (chunks verified per-message before sign).
- [ ] New devnet scenario: publish a curated CG, then independently verify the on-chain `ciphertextChunksRoot` matches a recompute from `swmHostModeStore.iterate()`.
- [ ] Backwards compat: a Phase-A curated CG published before this PR's commit 5 lands continues to be valid (no on-chain root, sampling falls back to leaf-root path).
- [ ] Unit tests for the chunk Merkle builder against a known test-vector set.
