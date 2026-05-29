# Proposal: rebind the LU-11 chunked-AEAD nonce from `publishOperationId` to `batchId`

**Status:** Draft for review
**Area:** RFC-38 LU-11 (curated-CG chunked ciphertext gossip) + RFC-39 (random sampling)
**Origin:** Unresolved 🔴 review comment on PR #767 (`packages/publisher/src/dkg-publisher.ts`)
**Risk class:** Security-sensitive (AEAD nonce derivation) — do **not** land without crypto + RFC-38/39 owner review and devnet validation.

---

## 1. Summary

The curated-CG chunked publish path derives its per-chunk AES-256-GCM nonce
from the **`publishOperationId`** (`deriveChunkNonce(publishOperationId, chunkIndex)`),
while cores persist and random-sample the resulting ciphertext chunks under
the key **`(cgId, batchId, chunkIndex)`**, where `batchId` is the V10 KC
merkle root (a function of the *plaintext content*).

Because `publishOperationId` is fresh per publish attempt but `batchId` is
intrinsic to the content, **two publishes of identical content into the same
CG collide on the persistence/sampling key but produce divergent ciphertext
and therefore divergent `ciphertextChunksRoot` commitments.** The proposal is
to derive the nonce from `(batchId, chunkIndex)` instead, making the ciphertext
deterministic per `(CG-key, content, chunkIndex)` and consistent with the
storage/sampling model.

---

## 2. Current behaviour

### 2.1 Nonce derivation (`packages/core/src/crypto/v10-publish-payload.ts`)

```
deriveChunkNonce(publishOperationId, chunkIndex)
  = HKDF-SHA256(ikm = publishOperationId,
                info = "<prefix>" + publishOperationId + "|" + chunkIndex,
                len  = 12)            // AES-256-GCM nonce
```

The chunk is then AES-256-GCM-encrypted under a **per-CG** key
(`HKDF(chainKey, info = "<prefix>" + aeadCgId)`).

The documented invariant is: *"a single `publishOperationId` MUST NEVER be
reused against different plaintext at the same chunkIndex under the same
payload key"* and *"distinct publish attempts rotate the AEAD nonce domain
even if they share the same merkle root."*

### 2.2 Persistence / sampling key

The emitter (`DKGAgent._resolveEncryptInlineChunked`) gossips each chunk as a
`share-write-chunked` envelope with `payload = [batchId(32)][ct_i]`,
`swmMessageIndex = i`. Hosting cores persist the bytes **opaquely keyed by
`(cgId, batchId, swmMessageIndex)`**. The on-chain commitment is
`ciphertextChunksRoot = keccak-root( keccak256(ct_i) )` and RFC-39 random
sampling challenges `(cgId, batchId, chunkId)` against that root.

`batchId == V10 KC merkleRoot`, which is deterministic in the plaintext.

---

## 3. The bug

Consider two publishes of **identical content** into the **same curated CG**
(e.g. a genuine duplicate, or a re-publish after a first attempt that already
landed its on-chain commitment):

| | Publish A | Publish B |
|---|---|---|
| `publishOperationId` | `op-A` | `op-B` (fresh) |
| plaintext | `P` | `P` (identical) |
| `batchId` (= merkleRoot of `P`) | `R` | `R` (**identical**) |
| chunk nonce | `HKDF(op-A, i)` | `HKDF(op-B, i)` (**different**) |
| ciphertext `ct_i` | `C_A,i` | `C_B,i` (**different**) |
| `ciphertextChunksRoot` | `root(C_A)` | `root(C_B)` (**different**) |
| persistence key | `(cg, R, i)` | `(cg, R, i)` (**identical**) |

The two publishes write **different ciphertext** to the **same**
`(cg, R, i)` slot while committing **different** `ciphertextChunksRoot`s
on-chain. Depending on the host's write policy this surfaces as one of:

- **Last-write-wins:** B overwrites A's bytes. A node that committed A's root
  on-chain now stores B's bytes → RFC-39 sampling of A's `(cg, R, chunkId)`
  recomputes `keccak256(C_B,i) != A.root` → **A fails sampling / is declined.**
- **First-write-wins / dedupe:** B's bytes are dropped. A core that only ever
  saw B's on-chain commitment recomputes against A's stored bytes → **B fails
  sampling / its V2 publish ACK is declined.**

Either way the publish-operation nonce rotation — which the design comment
frames as a feature — is the direct cause: it breaks the content→ciphertext
determinism that the `(cgId, batchId, chunkIndex)` model assumes.

**Scope / severity.** This requires *identical content in the same CG*, which
is uncommon but reachable (duplicate KAs; retry-after-partial-failure where
the first attempt's commitment already landed). It does **not** affect
distinct-content publishes. It is not a fresh-testnet blocker, but it is a
correctness hole in the LU-11 ↔ RFC-39 contract.

---

## 4. Proposed fix (Option A — recommended)

Derive the chunk nonce from the **`batchId`** (the content-bound merkle root)
instead of the `publishOperationId`:

```
deriveChunkNonce(batchId /* 32-byte KC merkleRoot */, chunkIndex)
  = HKDF-SHA256(ikm = batchId, info = "<prefix>" + batchIdHex + "|" + chunkIndex, len = 12)
```

Properties:

- **Deterministic per content.** Identical plaintext in the same CG ⇒ identical
  `batchId` ⇒ identical nonce ⇒ identical ciphertext ⇒ identical
  `ciphertextChunksRoot`. The `(cgId, batchId, chunkIndex)` slot now holds a
  single canonical value, and both publishes' on-chain roots agree. The
  collision in §3 disappears.
- **Retry-idempotent for free.** Retries no longer need to reuse the same
  `publishOperationId`; idempotency follows from the content itself.
- **Cryptographically safe.** AES-256-GCM's catastrophic failure mode is
  *nonce reuse with the same key on different plaintext*. Here nonce uniqueness
  is tied to content uniqueness via a collision-resistant hash:
  - same key (same CG) + different content ⇒ different `batchId` ⇒ different
    nonce. The only way to reuse a nonce on different plaintext is a keccak256
    merkle-root collision — computationally infeasible.
  - same key + same content ⇒ same nonce + same plaintext ⇒ identical
    ciphertext, which is the desired deterministic-encryption behaviour and
    leaks nothing beyond the already-public fact that two KCs share a merkle
    root.
  - cross-CG: the payload key is per-CG (`HKDF(chainKey, aeadCgId)`), so even
    an (infeasible) cross-CG `batchId` collision uses a different key.

### 4.1 No privacy regression

Two KCs with identical plaintext already reveal that fact on-chain via their
identical merkle root / `batchId`. Producing identical ciphertext does not
leak anything additional.

### 4.2 Why the current rationale doesn't hold

The design comment justifies `publishOperationId` as "rotating the nonce domain
across distinct publish attempts even if they share the same merkle root." The
*only* situation that produces "distinct attempts, same merkle root" is
identical-content republish — which is exactly the case this rotation breaks.
GCM nonce-uniqueness does not require per-attempt rotation; it requires
per-(key, plaintext) uniqueness, which `batchId` satisfies.

---

## 5. Alternatives considered

- **Option B — namespace storage by `kcId`.** Persist/sample under
  `(cgId, kcId, batchId, chunkIndex)`. Avoids the collision without touching
  the nonce, but changes the RFC-39 sampling tuple and the host-mode chunk
  store schema (more invasive; touches the on-chain sampling binding). Keeps
  the redundancy of storing identical bytes twice.
- **Option C — reject duplicate-content republishes.** Have the publisher
  detect an existing `(cgId, batchId)` in the same CG and refuse / short-circuit
  to an update. Defensive only; does not fix the underlying determinism gap and
  adds a pre-publish read.

Option A is the smallest change that makes the cryptographic layer consistent
with the storage/sampling model.

---

## 6. Affected code

- `packages/core/src/crypto/v10-publish-payload.ts` — `deriveChunkNonce`
  signature + `encryptChunked` input (`publishOperationId` → `batchId`).
- `packages/agent/src/dkg-agent.ts` — `_resolveEncryptInlineChunked`: pass
  `batchId` into `encryptChunked` instead of `publishOperationId` (the emitter
  already has `batchId`).
- `packages/publisher/src/dkg-publisher.ts` — the chunked-inline call site
  (drops the `publishOperationId` nonce-domain argument).
- Tests: `packages/core/test/*v10-publish-payload*`, plus any LU-11 chunked
  emit/ingest tests asserting nonce/ciphertext determinism.

## 7. Rollout / compatibility

- **Wire-format compatible**: envelope shape (`[batchId][ct]`, `swmMessageIndex`)
  and the on-chain `ciphertextChunksRoot` field are unchanged — only the bytes
  inside `ct` and the resulting root change for a given content.
- **Mixed-version meshes during rollout**: an old publisher (op-id nonce) and a
  new publisher (batchId nonce) that publish the *same* content would still
  diverge — i.e. the fix is not retroactive for in-flight duplicates across the
  upgrade boundary. Because the failure requires identical-content collisions,
  the recommended sequence is: upgrade publishers + hosting cores together for
  a given curated CG, and (optionally) ship Option C's duplicate guard as a
  transitional safety net.
- **No migration** for existing single-publish KCs (their stored bytes + root
  remain internally consistent; only *future* duplicate publishes change).

## 8. Open questions for reviewers

1. Confirm the host-mode write policy for an existing `(cgId, batchId, chunkIndex)`
   slot (last-write-wins vs first-write-wins vs reject) so §3's surfaced
   symptom is stated precisely and the duplicate guard (Option C) is scoped if
   needed.
2. Is identical-content-in-same-CG a flow we want to *support* (dedup to one
   canonical commitment) or *forbid* (Option C)? Option A supports it cleanly;
   if we'd rather forbid it, Option C is still worth adding.
3. Any consumer relying on per-attempt ciphertext variability (none found in
   this repo) that would regress under deterministic ciphertext?
