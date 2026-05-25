# Decoupled Hosting and Membership for Curated Context Graphs

**Status**: PROPOSED (v3 — addressing PR #113 review)
**Date**: 2026-05-23
**Scope**: Resolve the structural conflict between curated-CG privacy and verifiability / availability by separating *who hosts the bytes* from *who can read the bytes*. Enables edge-curators to publish curated CGs to VM, supports member-attested verification for granted outsiders, and gives edges a high-availability sync substrate. Adds a per-assertion-key monetization access model.
**Related**: [SPEC_CG_MEMORY_MODEL.md](./SPEC_CG_MEMORY_MODEL.md), [SPEC_V10_IDENTITY_AND_ACCESS.md](./SPEC_V10_IDENTITY_AND_ACCESS.md), [SPEC_SYNC_CHAIN_VERIFICATION.md](./SPEC_SYNC_CHAIN_VERIFICATION.md), [SPEC_MOBILE_NODE.md](./SPEC_MOBILE_NODE.md).

---

## 0. TL;DR

In today's design, **hosting the bytes** and **being able to read them** are the same concern. That collapses two surfaces that want to be independent:

- A curator wants strong privacy: "no random core sees my plaintext."
- The same curator wants strong availability: "anyone the network later admits — by membership grant or monetized access — must be able to fetch the bytes and reconstruct the CG against the on-chain commitment, even if my laptop is offline."

This RFC introduces a clean separation:

- **Hosting** (substrate role) — cores hold ciphertext for CGs the sharding table assigns them, regardless of allowlist. They attest "I'm storing the bytes" without ever seeing plaintext. **They do not attest to plaintext content.**
- **Membership** (semantic role) — members hold the per-CG / per-epoch chain keys. They verify plaintext content post-decrypt against the existing on-chain merkle root.

**Crypto invariant**: the on-chain merkle root stays exactly as today — over plaintext leaves computed by the publisher. The only thing this RFC changes about the on-chain commitment is the ACK shape (cores now ACK ciphertext-availability for the batch, not plaintext-presence). Ciphertext and plaintext do not need to be cryptographically bound in a single leaf; members verify the binding post-decrypt by re-deriving the plaintext root and comparing to chain.

This unlocks four things at once:

1. **Edge can publish curated CGs to VM** — cores ACK over ciphertext availability + the existing V10 batch-digest fields, no plaintext required.
2. **Member-attested verification for granted outsiders** — keys flow from curator to new member or paying buyer; ciphertext flows from any hosting core; members verify plaintext binding post-decrypt and can sign attestations for third parties.
3. **Edge sync from cores** — laptop reopens, asks any hosting core for missed encrypted SWM via a normative `SWMCatchupRequest`, decrypts locally.
4. **Curator privacy** — cores still cannot read curated content even though they store it.

**Plus a monetization protocol**: a per-assertion payload-key wrap protocol (model β) lets a buyer purchase access to a single assertion without gaining the epoch chain key — enabling Bloomberg-shaped data products natively.

This v3 dropped a dual-root commitment scheme that v2 proposed but that PR #113 review correctly identified as both over-engineered and broken-as-claimed (cores cannot prove plaintext↔ciphertext correspondence without the key). The verification story instead leans on the existing plaintext root + member post-decrypt checks + attestation tokens for outsiders.

---

## 1. The tension this RFC resolves

### 1.1 The empirical bug that surfaced it

End-to-end test of [SPEC_CG_MEMORY_MODEL.md](./SPEC_CG_MEMORY_MODEL.md): edge agent creates an invite-only CG, drafts content in SWM, tries to publish to VM. Result:

```
[ACKCollector] Decline from <core>: NO_DATA_IN_SWM — No data found in SWM graph for entities: <…>
[publishFromSWM] V10 ACK collection failed: storage_ack_insufficient (0/1 valid ACKs)
[publishFromSWM] Identity not set (0) — skipping on-chain publish
[publishFromSWM] Stored as tentative: UAL=…/tmp…
```

The cascade: the CG is invite-only, so SWM gossip is restricted to the allowlist; cores aren't allowlisted (correctly — agent membership shouldn't be conflated with infrastructure hosting), so they never receive the SWM data; the publish merkle root is computed over **plaintext triple hashes**, so cores have nothing to recompute it against; ACK collection fails; the publish stays local as a tentative record. The data is never actually on VM.

### 1.2 The architectural tension underneath

The bug is a surface symptom of a deeper conflation:

| Concern | Today's design |
|---|---|
| Who holds the bytes? | Whoever's in the allowlist. |
| Who can read the bytes? | Same set. |
| Who can ACK a VM publish? | Anyone who already has the plaintext locally (so they can recompute the merkle root). |

Three concerns collapsed into one set. That set is *agent membership* (the allowlist), so curated CGs become inaccessible to the *substrate* (cores, sharding table). Privacy gained; availability and verifiability lost.

### 1.3 What we want instead

A curator running on a laptop should be able to say *all four* of these at once:

1. "Cores I don't know about are storing my data so it survives my laptop closing."
2. "None of those cores can read my data — only the people I've granted access to."
3. "When I later grant someone access (free, paid, or by joining the allowlist), they can fetch the data from any of those cores, decrypt it, and verify it matches the on-chain commitment I made today."
4. "If a third party later sees a single fact of my data (leaked, quoted, monetized), a member can give them a small attestation that proves the fact's inclusion in the on-chain anchor."

Today (1) and (3) and (4) require defeating (2). This RFC makes all four compatible. (4) is achieved via member-attested verification — the chain alone cannot prove plaintext-vs-ciphertext correspondence because the chain has no key; a key-holder must vouch for the binding.

---

## 2. The conceptual move — hosting ≠ membership

### 2.1 Two surfaces, not one

| Surface | Decided by | Holds what | Can do what |
|---|---|---|---|
| **Hosting** (substrate) | Sharding table assignment | Encrypted chunks + commitments | Store, replicate, attest "I have this", serve to anyone who asks |
| **Membership** (semantic) | Curator (via key distribution) | Decryption key for the CG / epoch | Read plaintext, write SWM, prove inclusion to a verifier |

Cores live entirely in the hosting surface. Members live entirely in the membership surface. The two are orthogonal: a core can host without being a member (the normal case for curated CGs), a member can be a non-host (the normal case for edge agents).

### 2.2 What "curated" actually means

Today: "curated CG" implies "no one outside the allowlist can do anything." The RFC's framing: curated controls *who holds keys*, not *who holds bytes*. Restated:

- Curated = **only members can decrypt**.
- Curated = **anyone the network assigns can host the ciphertext**.

This matches how every modern E2E-encrypted system works (Signal, age-encrypted git remotes, encrypted IPFS pins). The hosting layer is dumb-bytes-and-availability; the access layer is keys-and-cryptography.

### 2.3 Mental analogy

A safe-deposit box in a bank. The bank guarantees the box exists, is preserved against fire and theft, and can be retrieved on demand. The bank doesn't know what's inside the box — only the key-holders do. Granting access = handing someone the key. Verifying provenance = the box has the bank's serial number on it; the contents have a tamper-evident seal cryptographically tied to the serial number.

Cores are the bank. Members are the key-holders. The on-chain commitment is the serial number plus the seal.

### 2.4 Target deployment shapes

This RFC is motivated by — and validated against — four concrete deployment patterns. All four share the same structural problem: **proprietary CG content + flaky member edges + need for reliable substrate availability**.

| # | Pattern | Edges | Cores | Why curated, not public |
|---|---|---|---|---|
| 1 | **Self-hosted code team**. Coders run multiple agents per laptop (Cursor, Claude Code, Codex); the team optionally runs its own cores. Analogue: self-hosted GitLab. | Laptops (closed lids, lost wifi) | Optional team-run cores OR rented network cores | Proprietary code, repo is private |
| 2 | **Cross-device planning**. Managers' agents help with roadmap planning across laptops + phones; company runs its own cores or rents. | Laptops + phones (mobile, intermittent) | Company-operated cores | Internal strategy / forecasts |
| 3 | **Consortium with external-tool bridges**. Multiple companies share a CG; on a cloud core, a co-located member-agent bridges CG content into Obsidian / Teams / Google Docs / Slack. | Member agents across orgs | Hosting cores with a co-located member-agent (host on the node + decrypt by the agent + push to external tool) | Cross-org confidential project |
| 4 | **Monetized data product** ("DKG Bloomberg"). Researchers curate market data via edges; cores host reliably and serve an x402-monetized API to paying outsiders. | Researcher laptops, collaborator nodes | Researcher-operated cores serving the paid API | Pre-purchase, data is private and monetizable |

**Two properties common to all four**:

1. **Edges are flaky by definition.** Laptops sleep, phones lose signal, users close apps. Cores are the always-on tier. RFC-38's substrate-subscription model means any member edge can come back online, sync from any hosting core, and never lose history — independent of whether other member edges are online.
2. **Bring-your-own-cores is the dominant deployment expectation.** Like self-hosted GitLab vs gitlab.com: most users use the network; some operate their own cores; the protocol is identical either way. RFC-38 makes both modes work for curated CGs.

**New pattern surfaced by scenario 3 — the bridge core.** Membership and hosting are properties of two different things: an **agent** (a wallet-identified persona) is a CG member if its wallet was granted access; a **node** (a daemon deployment registered in the sharding table) is a CG host if the sharding table assigned that CG to it. The two predicates are independent — a node has no "membership," an agent has no "hosting" — but they can be **co-located on the same operator's infrastructure**. The "bridge core" pattern is exactly that co-location: one operator runs (i) a node that the sharding table has assigned to host the CG's encrypted substrate, AND (ii) a member-agent process on the same machine whose wallet holds CG membership. The agent decrypts ciphertext the co-located node already stores locally — no network hop — and publishes the plaintext into an external tool (Obsidian, Slack, Google Docs, your-internal-CRM). No new protocol surface: the agent uses the chain key it was granted via the normal `KeyGrant` flow; the node uses its normal sharding-table assignment; co-location is just an operator's deployment choice that happens to compose efficiently.

**New pattern surfaced by scenario 4 — paid late-joining.** The monetization walkthrough in §3.2 + the late-joiner flow in §A.4 + the per-assertion `PaidAccessGrant` protocol (§5.7) compose into a Bloomberg-shaped product: outsider pays → curator issues a per-assertion `PaidAccessGrant` → outsider's node fetches ciphertext from any hosting core → decrypts the specific assertion → verifies plaintext binding via member attestation (§5.3.2) → checks merkle path to the on-chain anchor. No single party in the loop can fake — the verifier checks attribution against on-chain identities and content against on-chain anchors that the curator committed at publish time. The per-assertion granularity means buyers don't need to pay for (or even see) the rest of an epoch's content.

### 2.5 Trust model: encryption at rest on chosen operators

The trust model RFC-38 establishes is the model enterprises already accept from SaaS:

> "Data is encrypted at the edge. Bytes at rest sit on operators you chose — yours, your vendor's, or the public network. Operators cannot read the bytes without keys you control. Verifiability anchors on chain."

This is the SaaS posture (AWS holds your encrypted RDS volumes; Google holds your encrypted Drive content; vendor promises plus encryption-at-rest plus your-keys = the deal). It is also the self-hosting posture (your team's own cores hold your team's encrypted bytes — see scenarios 1 and 4). Whether you self-host or use network operators is a **deployment choice, not a protocol fork**.

The status quo's pitch — "data never touches third-party infrastructure" — is cleaner-sounding but operationally weaker. It requires every member edge to be online for availability, which the deployment patterns in §2.4 actively contradict. RFC-38 trades the marketing simplicity for an honest model that matches how enterprise software actually works and how end users (especially mobile / cross-device users) actually behave.

---

## 3. Roles under the decoupled model

### 3.1 Each actor

| Actor | Holds keys? | Hosts ciphertext? | Can read plaintext? | Can ACK VM publish? |
|---|---|---|---|---|
| **Curator** | Yes (issues KeyGrants) | If also a core, yes; otherwise no | Yes | Indirectly — proposes the publish, gathers ACKs from cores |
| **Member agent** | Yes (granted by curator) | Only if also a core | Yes | No (membership is semantic, ACKing is substrate) |
| **Hosting core** (sharding-table member) | No | Yes — encrypted chunks for assigned CGs | No | Yes — over ciphertext-availability + V10 batch digest fields (§5.4) |
| **Bridge core** (node in the sharding table; operator also runs a member-agent process on the same machine) | The co-located agent does; the node does not | Yes (as a sharding-table host) | Yes — the co-located agent decrypts | Yes — as a sharding-table host |
| **Non-hosting core** | No | No | No | No |
| **Outsider** (no membership, no hosting role) | No | No | No | No |
| **Outsider, post-grant** (KeyGrant or PaidAccessGrant) | Yes (scoped to grant) | No | Yes — after fetching ciphertext from a core via `SWMCatchupRequest` | No |

The single asymmetry that matters: only nodes with a key can read; only nodes with bytes can serve.

### 3.2 Per-scenario walkthroughs

**Edge curator publishes a private fact to VM**

1. Curator's edge encrypts each assertion in the publish payload using the current chain key's per-message payload key (existing SWM substrate; §5.2).
2. Ciphertext gossips to sharding-table cores as part of normal SWM substrate fanout (Phase A change: cores are subscribed to the substrate for curated CGs too).
3. Curator's edge sends an ACK request to the sharding-table cores for this CG. Payload includes the full V10 batch-digest fields PLUS `ciphertextChunks[]` digests and `ciphertextChunksRoot` (§5.4.1). It does NOT carry the bytes — cores already have them via gossip.
4. Each core verifies it holds the ciphertext chunks, signs the full `ackRequestDigest` (§5.4.2) over the combined V10 + availability fields.
5. Edge collects ACKs until `parametersStorage.minimumRequiredSignatures()` is met, anchors the existing single-root merkle commitment on chain via the existing publish flow.
6. Done. Cores never see plaintext. Members later verify post-decrypt by re-deriving the plaintext root from decrypted SWM (§5.3.1).

**Outsider receives a leaked assertion and wants to verify it**

1. Outsider has an assertion `A` plus a claim "this was in CG X, batch B, leaf i" — together with a member-attestation token (§5.3.2) issued by a member of CG X.
2. Outsider recomputes `H(A)`; checks it equals `attestation.plaintextLeafHash`.
3. Outsider fetches the corresponding ciphertext chunk from any hosting core via `SWMCatchupRequest` with the attestation token as authenticator; checks `H(received ciphertext) == attestation.ciphertextChunkDigest`.
4. Outsider verifies the merkle path from `plaintextLeafHash` to the on-chain root of batch B.
5. Outsider verifies `attestation.attesterSignature` and resolves the attester's wallet on chain — confirming they were a member of CG X at the attested epoch.
6. If all checks pass → trust the assertion. The trust chain: outsider → named on-chain-resolvable member → on-chain anchor.

**Edge laptop reopens after a day offline**

1. Edge identifies its missing message-index range per CG (last seen `(epochId, messageIndex)`).
2. Edge sends a `SWMCatchupRequest` (§5.6.1) to any hosting core — authenticated via its member wallet signature.
3. Core streams ordered ciphertext chunks for the requested range (paginated; broadcast-layer only, never setup packages).
4. Edge decrypts locally using the chain keys it already holds; re-derives plaintext root for each completed batch and compares to the on-chain anchor (§5.3.1).

**Curator monetizes access — per-assertion**

1. Buyer pays via x402 for a specific assertion in CG X (or a specific batch / set of assertions).
2. Curator emits a `PaidAccessGrant` (§5.7.2) to the buyer: envelope containing the assertion's `payloadKey`, `ciphertextChunkDigest`, and a member-attestation token (curator self-attests because they are a member).
3. Buyer fetches the ciphertext chunk from any hosting core (`SWMCatchupRequest`, token-bearer auth — §5.6.4).
4. Buyer decrypts the single assertion using the payload key; verifies the binding via the attestation.
5. Buyer learns ONE assertion. The epoch chain key is NEVER exposed — the buyer cannot decrypt any other assertion in the epoch (HKDF is one-way). To purchase additional assertions, the buyer pays for additional grants.

---

## 4. Scenarios this unlocks

| Scenario | Possible today? | Possible under this RFC? |
|---|---|---|
| Edge curator → public CG → VM publish | Yes | Yes (no change) |
| Edge curator → invite-only CG → VM publish | **No** (cores can't ACK without plaintext) | **Yes** (cores ACK ciphertext) |
| Edge member resyncs SWM from cores after going offline | Partial (only for public CGs) | Yes for any CG it has the key to |
| Outsider verifies a leaked triple against on-chain anchor | Possible only if they have full ciphertext + key | Yes from a single triple + on-chain leaf + ciphertext chunk |
| Curator monetizes access to historical VM data | No clean path (cores don't host curated data) | Yes — cores host, curator gates keys |
| Curator rotates keys (revoke former member) | Awkward (no formal protocol) | Yes — new epoch, old members keep their old-epoch keys, new members get new-epoch onwards |

---

## 5. Under the hood — what changes

### 5.1 Sharding-table-based hosting subscription

Today, cores subscribe to a CG's SWM substrate only if they are explicitly in the allowlist (`enumerate-cg-members.ts` returns `source: 'allowlist'` for curated, and cores are not typically allowlisted).

Under this RFC, cores subscribe to **any CG the sharding table assigns them**, regardless of allowlist, **and regardless of whether the CG is on-chain-registered yet**. The substrate carries ciphertext; subscription is a hosting commitment, not a read grant. Concretely:

- `ShardingTableStorage` already maps CGs to responsible cores at publish time (see [SPEC_CG_MEMORY_MODEL.md §4.6](./SPEC_CG_MEMORY_MODEL.md#46-hosting)). Extend this to also drive *SWM-tier* subscription, not only VM-tier.
- For curated CGs, the SWM gossip topic admits sharding-table cores in addition to allowlisted peers. Cores hold ciphertext, never get keys.
- The `enumerate-cg-members.ts` enumerator stays the same for *membership* (who can decrypt) but a new enumerator — `enumerate-cg-hosts.ts` — surfaces hosting peers for substrate fanout (`allowlist ∪ shardingTableForCG`).

#### 5.1.1 Pre-registration staging

A core accepts SWM ciphertext for **any** CG ID — registered on chain or not — if and only if the deterministic sharding-table function says it is in the assignment for that CG ID at the current sharding-table epoch.

**Current network shape**: there is no per-CG sub-assignment today. Per [SPEC_CG_MEMORY_MODEL.md §4.6](./SPEC_CG_MEMORY_MODEL.md#46-hosting), the assignment for any CG is "every member of the sharding table." So the check resolves to `amIInTheShardingTable()` for every CG ID — every core stages every CG. The check is left as a deterministic-function abstraction so that future per-CG sub-sharding can refine it without a protocol change.

**Why pre-registration staging matters**:

- **Zero cold-start at first VM publish**. By the time a curator registers on chain, cores already hold the SWM history; the first publish goes through the steady-state ACK path (§5.4.2) rather than the `ChunkPullRequest` fallback (§5.4.3).
- **Availability for drafts and ephemeral CGs**. Members joining mid-draft on flaky connections can resync from cores even before registration; groups that use a CG for a sprint without ever anchoring it to VM still get the substrate's availability guarantees during the staging window.
- **No "registration vs first publish" footgun**. Registration is a non-event for the substrate — cores are already staging the CG's SWM and continue to do so. Promotion to long-term hosting happens at first VM publish (the publish's `tokenAmount × epochs` is what pays for retention), not at registration.

**What gates staging from becoming a free file host** is a small set of policies on the core, all enforced locally without any chain dependency. All byte-denominated limits are in **ciphertext bytes** (the actual bytes the core stores; for curated CGs there is no plaintext available to measure against — see §5.4.1):

| Gate | Default |
|---|---|
| Per-chunk TTL, sliding from receipt — expires unless the chunk is committed to a VM batch (which pays retention via tokenAmount × epochs) | 6 hours |
| Per-sender-wallet rate limit on unregistered CGs (ciphertext bytes/min, ciphertext bytes/hour) | 1 MB/min, 50 MB/hour |
| Per-CG-ID ciphertext-byte cap on unregistered staging | 100 MB |
| Per-core aggregate budget (ciphertext bytes) for unregistered staging | Few GB, operator-configurable |
| Sender signature required on every staged message (already true today) | unchanged |

If a wallet trips its rate limit, the core declines further staging from that wallet for a cooldown window. If a CG-ID hits the byte cap, no more chunks are accepted for that CG until either (a) some staged chunks are committed to a VM batch via publish (those bytes move from the staging budget to the batch's retention-paid budget — see Promotion below), or (b) TTL expiry resets the staged total to zero. **Registration on chain alone does NOT lift the cap** — registration creates the on-chain CG record but pays cores nothing; only a VM publish pays for retention. If the per-core aggregate budget is saturated, the core declines new staging until budget is freed by TTL expiry or by publish-driven promotion.

**Promotion happens at VM publish time, not at registration time.** The lifecycle has three distinct moments:

- **Registration on chain** creates the CG record and pins `publishAuthority` (and any PCA delegates). It enables VM publishing for this CG ID. It does NOT extend SWM TTL, does NOT pay cores anything, and does NOT lift the staging quotas. The CG is now publishable, but its SWM-staged ciphertext is still subject to the same TTL and caps as before.
- **VM publish** pays `tokenAmount` for `epochs` of retention via the existing `KnowledgeAssetsV10` flow. The specific ciphertext chunks named in the batch (via `ciphertextChunks[]` in the ACK request, §5.4.1) are promoted from "staged under TTL" to "retained for the batch's `epochs`." They keep the same bytes in the core's local store; they get re-indexed under the batch ID; they exit the staging budget and enter per-batch retention bookkeeping.
- **SWM activity outside any published batch** — past chunks that weren't included in a batch, or new chunks gossiped after the publish — continue under the same staging TTL until they too are committed to a future batch or expire.

If the sharding-table membership changes (epoch rollover, stake change) and a core is no longer eligible for the CG's assignment, it drops staged-but-not-yet-published data immediately and follows the existing sharding-table-reshuffle policy for already-retained batches.

Note for operators: a core MAY choose to offer registered CGs a more generous TTL than the unregistered default (e.g. 30 days vs 6h) as a local policy choice, on the reasoning that on-chain registration is a commitment signal that the CG is "real." The protocol allows this; it does not require it. This is one of the calibration questions in §8.

**Defaults are configurable per operator** — the values above are starting points that the network may want to tune as adoption scales. See §8 for the open question on calibration.

### 5.2 SWM payload encryption is already a two-layer Sender Keys construction

The existing SWM encryption substrate is more sophisticated than "broadcast encryption" suggests — it's a Signal-style Sender Keys protocol with two distinct layers ([`packages/core/src/crypto/swm-sender-key.ts`](../../packages/core/src/crypto/swm-sender-key.ts)):

- **Setup layer** — when an epoch starts (or a new member joins mid-epoch), the curator sends each recipient a small X25519-wrapped **setup package** containing the 32-byte symmetric **chain key** for that epoch, bound to the membership snapshot. One package per recipient, ~few hundred bytes each. Point-to-point, NOT broadcast.
- **Broadcast layer** — all SWM messages in the epoch are AES-256-GCM ciphertexts under a per-message **payload key** derived from the chain key via HKDF, with the chain key ratcheting via HMAC-SHA-256 each message. **One ciphertext per message**, gossiped to all subscribers; every member decrypts the same bytes.

This RFC changes the **gating** at the substrate layer; it introduces no new crypto primitive:

- Sharding-table cores subscribe to the **broadcast layer** for any CG they're assigned to. They receive ciphertext only, never the chain key, never the setup packages.
- Allowlisted members continue to receive both layers via the existing flow.
- Non-hosting non-member peers receive nothing (same as today).

The cost shape this gives the RFC:

| Cost component | Per | Held by |
|---|---|---|
| Broadcast ciphertext | message | members + sharding-table cores |
| Setup package | recipient per epoch | members only (point-to-point from curator) |
| Chain-key rekey on revocation | epoch boundary | members only (new setup packages, broadcast stream switches) |

**Cores hold exactly one ciphertext per message regardless of CG size**, which is what makes the "host curated CGs without reading them" pattern affordable. The per-recipient setup cost stays off-core; cores never become a key-distribution channel. The §6 trust model is unchanged.

**Phase A only changes the substrate subscription gate; the encryption substrate itself is unchanged.** No new crypto primitives, no proto-version bump, no new AAD fields. The existing two-layer Sender Keys construction continues to work exactly as it does today — Phase A just admits sharding-table cores into the broadcast-layer gossip topic for curated CGs.

Phase B (later, optional) adds a per-assertion **payload-key wrap protocol** for monetization (see §5.7) and, if implemented, bumps `SWM_SENDER_KEY_PACKAGE_VERSION` from `'1'` to `'2'`. Phase A defers that work.

### 5.3 Verification model: member post-decrypt + outsider attestation

**The on-chain merkle root stays exactly as today.** The publisher computes leaves over plaintext (per-KA / per-assertion granularity, matching the existing V10 format), the merkle root is anchored on chain via the existing `ContextGraphStorage` batch entry, and the on-chain commitment carries no new fields.

Verification splits cleanly across actors based on what they hold:

#### 5.3.1 Member verification (post-decrypt)

A member with the chain key:

1. Fetches encrypted SWM messages — from either substrate gossip (live) or a hosting core via `SWMCatchupRequest` (catch-up; see §5.6).
2. Decrypts each ciphertext chunk using the per-message payload key derived from the chain key.
3. Computes the plaintext leaf hash from the decrypted assertion using **the same leaf format the publisher used** to commit on chain.
4. For each batch they reconstruct, re-derives the merkle root and compares to the on-chain anchor.
5. **If a mismatch occurs** (a malicious or buggy publisher committed a root that does not match the ciphertext stream): the member rejects the batch, alerts via SWM gossip to other members, optionally fetches the same ciphertext from a different hosting core to rule out core-level tampering, and the curator can slash / revoke the malicious publisher's `publishAuthority` per the existing V10 authority model.

This is the same verification model members already have for SWM-to-VM consistency today. The only new wrinkle is that the *ciphertext source* is now a core (or other peer), not exclusively a member peer.

#### 5.3.2 Outsider verification (member attestation tokens)

An outsider holding a leaked / quoted / monetized assertion `A` plus a claim "this is in batch `B` of CG `X`, leaf index `i`" can verify against the on-chain anchor **with a member-attestation token**. The token is a small, member-signed envelope:

```
attestation = {
  contextGraphId, batchId, leafIndex,
  plaintextLeafHash,                  // H(A) computed by the attesting member after decrypt
  ciphertextChunkDigest,              // H(ct_i) the member observed on substrate
  attesterAgentAddress,               // member's wallet address
  attesterMembershipEpoch,            // which epoch the attester held a chain key for
  attesterSignature                   // secp256k1 / EIP-191 over the above fields
}
```

Outsider's verification flow:

1. Recompute `H(A)` from the leaked assertion; check it equals `attestation.plaintextLeafHash`.
2. Fetch ciphertext chunk `ct_i` from any hosting core; check `H(ct_i)` equals `attestation.ciphertextChunkDigest`. (This step confirms the attester is talking about a ciphertext that actually exists on the substrate.)
3. Verify merkle path from `plaintextLeafHash` to the on-chain root of batch `B`.
4. Verify `attestation.attesterSignature` against `attestation.attesterAgentAddress`.
5. Resolve `attesterAgentAddress` on chain via [SPEC_V10_IDENTITY_AND_ACCESS.md](./SPEC_V10_IDENTITY_AND_ACCESS.md) — was this address a member of CG `X` at `attesterMembershipEpoch`? Was that epoch active when batch `B` landed?
6. If all checks pass → trust the attestation. Trust path: outsider → named on-chain-resolvable member → on-chain anchor.

**Why this is the honest model.** The chain has no chain key, so it cannot verify that `decrypt(ct_i)` equals `A`. Some key-holder must vouch. The attestation is that vouch, with cryptographic attribution: a malicious attester is publicly identifiable (their wallet is on chain) and slashable per the existing V10 reputation / authority machinery. For scenarios 1-3 in §2.4 the attester is naturally part of the trust loop (member, bridge, paid subscriber). For scenario 4 (Bloomberg-style monetized data) the curator IS the seller IS the attester — the API response bundles the assertion, payload key, ciphertext, and attestation token in one payload.

**What about "trustless" outsider verification?** A truly chain-only verification of plaintext↔ciphertext correspondence requires either (a) a member co-signature gathered at publish time and anchored on chain, or (b) a zero-knowledge proof that the publisher knows a key under which `decrypt(ct_i) = pt_i`. Both are heavyweight. Neither is needed for the four motivating scenarios in §2.4. See §12 for what was considered and why deferred.

#### 5.3.3 Why this RFC dropped the dual-root approach considered in v2

An earlier draft (v2) proposed a dual-root leaf format `leaf_i = H( H(salt ‖ pt_i) ‖ H(ct_i) )` with a per-epoch salt and an extra on-chain `saltCommitment` field. PR #113 review correctly identified two fatal issues:

1. **No correspondence enforcement.** The publisher chooses both halves of the leaf independently; nothing in the construction binds the inner-left plaintext-hash to the actual plaintext recoverable from the inner-right ciphertext-hash. A malicious publisher can commit `(H(salt ‖ pt_A), H(ct_B))` and the merkle math validates. Outsiders are fooled; members catch it only post-decrypt — same detection point we have without the dual root.
2. **Epoch-salt disclosure broadens to whole-epoch privacy regression.** Revealing `salt_epoch` to one verifier (for one leaked triple) exposes the blinding for every plaintext-hash in that epoch. A per-leaf nonce would help but requires complex distribution.

Both issues collapse if we accept that **plaintext↔ciphertext correspondence is fundamentally a key-holder check**. There is no leaf format the chain can verify on its own that fixes (1) without a key. So we drop the dual-root entirely; the on-chain commitment stays single-root over plaintext; members do their existing post-decrypt verification; outsiders use member attestations. This removes ~5 of Jurij's review items and significantly reduces Phase A scope.

### 5.4 ACK protocol — ciphertext-availability + existing batch digest fields

The new ACK shape preserves every existing V10 ACK invariant (replay protection, payment binding, retention binding) and adds **only** a ciphertext-availability attestation. Critically, the ACK digest binds the full batch metadata — not just a root.

#### 5.4.1 ACK request

```
ACKRequest = {
  // Existing V10 digest fields (do NOT change semantics or signing) —
  // bind ACK to a specific batch under specific payment/retention terms.
  contextGraphId,                    // identifies the CG
  publishOperationId,                // unique per publish attempt (replay protection)
  merkleRoot,                        // plaintext root, as today
  knowledgeAssetCount,               // KAs in this batch
  byteSize,                          // total batch size in bytes
  epoch,                             // chain epoch of the publish
  publishingChainId,                 // EVM chain id
  tokenAmount,                       // payment amount bound to this ACK
  retentionPeriod,                   // retention obligation
  publishAuthority,                  // authorised publisher identity

  // NEW (Phase A): per-ciphertext-chunk availability commitments.
  ciphertextChunks: [
    { chunkDigest: H(ct_i), byteSize: |ct_i|, swmMessageIndex: idx_i },
    ...
  ],
  ciphertextChunksRoot,              // merkle root over chunkDigests, for compact ACK signing

  // NEW (Phase A): protocol version of the ACK envelope itself, for forward extensibility.
  ackProtocolVersion: 2,
}
```

The responder verifies, in order:

1. `publishOperationId` has not been seen before (replay protection).
2. The `publishAuthority` is currently authorised on chain for `contextGraphId` (per existing V10 publishAuthority lookup).
3. For each entry in `ciphertextChunks`: the core holds bytes matching `chunkDigest` and has indexed them under `(contextGraphId, batchId)`. If a chunk is missing, the core MAY request it inline (see §5.4.3); if it cannot acquire it within a normative timeout, it MUST decline the ACK.
4. `ciphertextChunksRoot` matches the recomputed merkle root over the supplied chunk digests.
5. **`byteSize` matches what the core actually holds.** The semantic is "size of what cores persist for this batch": for public CGs that is plaintext leaf bytes (today's behaviour, unchanged); for curated CGs that is the sum of `ciphertextChunks[i].byteSize`. The core recomputes from its local store and MUST decline the ACK with `BYTESIZE_MISMATCH` if the publisher's claim doesn't match. This is what keeps the pricing formula `tokenAmount ≥ stakeWeightedAsk × byteSize × epochs / 1024` (`KnowledgeAssetsV10._validateTokenAmount`) honest — the chain trusts a `byteSize` only because quorum-of-cores cosign an ACK digest binding it.

**Implication for curated-CG pricing**. Because curated CGs declare ciphertext `byteSize`, they pay (slightly) more per plaintext bit than equivalent public CGs do, equal to the AEAD overhead per chunk (16-byte tag + 12-byte nonce). For typical chunk sizes the overhead is small (~0.7% at 4 KB chunks, ~2.7% at 1 KB chunks, ~11% at 256-byte chunks). Curators sensitive to cost may amortise by packing more assertions per broadcast message. No contract change is required: the contract treats `byteSize` as opaque input; the semantic ("plaintext for public, ciphertext for curated") is the publisher/core convention enforced via the cosigned ACK digest.

The responder signs an `ACKResponse`:

```
ACKResponse = {
  ackRequestDigest,                  // H of all fields in the corresponding ACKRequest
  ackerIdentityId,                   // chain-resolvable core identity
  ackerSignature                     // secp256k1 over ackRequestDigest, EIP-191
}
```

#### 5.4.2 What signing the ACK binds

Phase A constraint: the **cosigned digest is the existing V10 `computePublishACKDigest`** — `(chainId, kavAddress, contextGraphId, merkleRoot, knowledgeAssetsAmount, byteSize, epochs, tokenAmount, merkleLeafCount)`. Cores sign this verbatim because `KnowledgeAssetsV10._validateSignatures` verifies that exact shape on-chain; introducing new bound fields would require a contract change, which Phase A explicitly avoids (§7).

The additional ACKRequest fields (`publishOperationId`, `ciphertextChunks[]`, `ciphertextChunksRoot`, `ackProtocolVersion`, `publishAuthority`) are **off-chain inputs to the core's accept-or-decline decision**, not new digest material. They give the core enough information to:

- verify it holds the right ciphertext chunks (or to fetch them via `ChunkPullRequest` per §5.4.3),
- bind the ACK to a specific publish attempt (the proposer dedups via `publishOperationId` locally), and
- reject mismatched / replayed requests at the protocol layer before any signing happens.

Because the V10 digest already contains `merkleRoot` + `byteSize`, an attacker swapping ciphertext under a valid digest fails immediately: the core's persisted bytes won't match `byteSize`, and at member verification (§5.3.1) the decrypted plaintext root won't match `merkleRoot`. Phase A's privacy gain comes from cores holding ciphertext bytes (not plaintext), not from extending the on-chain attestation surface.

This addresses PR #113 review comment on `line:271`.

#### 5.4.3 Ciphertext transport — normative behaviour

This addresses PR #113 review comment on `line:273` (loose "inline or gossip" language).

**Default path (the operational steady state)**: cores receive ciphertext chunks via substrate gossip well before any ACK request arrives — including for the first publish, because of pre-registration staging (§5.1.1). By the time the proposer sends the ACK request, the chunks are already locally indexed under `(contextGraphId, swmMessageIndex)`. The ACK request carries only digests, not bytes.

**Fallback path (edge case)**: a core receiving an ACK request finds it lacks one or more referenced chunks. With pre-registration staging in place, this should be uncommon — it happens when:

- A sharding-table reshuffle moved this core into the CG's assignment *after* the unrouted chunks were already gossiped (so the core was not subscribed when they flew by).
- The curator skipped the SWM gossip path entirely (e.g. a script-driven batch publish that constructs ciphertext locally and goes straight to ACK collection).
- Staging quota (§5.1.1) expelled some chunks before publish (e.g. TTL expired, or per-CG cap was hit then reset, or aggregate budget evicted older chunks).

Resolution sequence:

1. Core MAY request missing chunks inline from the proposer via a `ChunkPullRequest` over the same connection. Bounded retry: up to `MAX_CHUNK_PULL_ATTEMPTS = 3`.
2. If the proposer cannot supply within `CHUNK_PULL_TIMEOUT_MS = 5000`, the core MUST decline the ACK with reason `CHUNK_UNAVAILABLE`.
3. If the proposer supplies but chunks fail digest verification, the core MUST decline with reason `CHUNK_DIGEST_MISMATCH`.

**Persist-before-sign requirement (normative)**: a core MUST durably persist any ciphertext chunk it intends to ACK *before* signing the ACK response. Storage MUST include indexing under `(contextGraphId, batchId, swmMessageIndex)` such that later `SWMCatchupRequest` queries (§5.6) can serve the chunk. Signing on transient receipt without persistence violates the availability commitment the ACK attests to. Hosting accountability (Phase C storage proofs) presumes this invariant.

#### 5.4.4 ACK quorum

Unchanged from V10: `parametersStorage.minimumRequiredSignatures()`. Cores in the sharding-table assignment for the CG are the eligible signer set. The existing `requiredSignatures` decision in `verify-collector.ts` continues to apply.

### 5.5 Key distribution and epoch rotation

A per-CG, per-epoch **chain key** is the access gate. The SWM substrate already implements the two-layer Sender Keys protocol (§5.2); this RFC formalises the lifecycle (today implicit in setup-on-first-share) and pins authentication, scope, and failure semantics.

#### 5.5.1 KeyGrant — issuance and authentication

A `KeyGrant` is the curator's explicit, signed envelope for delivering a chain key to a new or returning member. It supersedes the implicit "send a setup package on first interaction" pattern.

```
KeyGrant = {
  contextGraphId,                    // target CG
  epochId,                           // which epoch this grant scopes
  membershipHash,                    // snapshot of allowed-members set at grant time
  recipientAgentAddress,             // grantee wallet
  recipientKeyId,                    // recipient X25519 setup-key id (existing field)
  setupPackageDigest,                // H of the SwmSenderKeyPackageMsg envelope
  backfillScope,                     // see §5.5.4
  startMessageIndex,                 // see §5.5.3
  grantedAtMs,
  curatorSignature                   // secp256k1 / EIP-191 over the above fields
}
```

**Signature scheme is secp256k1 / EIP-191**, NOT Ed25519. This addresses PR #113 review comment on `line:279`. The curator's wallet identity is the V10 `publishAuthority` (or its delegate) — which is an Ethereum address — so the binding is to the same identity that grants on-chain authority for the CG. Ed25519 is reserved for node-level and message-level identities elsewhere in V10; mixing schemes for wallet-bound permissions is incorrect.

The verifier (recipient or any third party validating the grant) checks:

1. Recover signer address from `curatorSignature`.
2. Resolve current `publishAuthority` for `contextGraphId` on chain.
3. Confirm signer is either the `publishAuthority` directly or holds an active PCA delegation from it (per [SPEC_V10_IDENTITY_AND_ACCESS.md](./SPEC_V10_IDENTITY_AND_ACCESS.md)).
4. Confirm `membershipHash` matches the recipient's view of the membership snapshot (or accept the curator's snapshot if first contact).
5. Decrypt the setup package per the existing X25519+AES-GCM flow; confirm its digest equals `setupPackageDigest`.

#### 5.5.2 KeyRotate — rotation on revocation

A `KeyRotate` is the curator's signed envelope to remaining members announcing a new epoch:

```
KeyRotate = {
  contextGraphId,
  previousEpochId,
  newEpochId,
  newMembershipHash,
  rotationReason,                    // "member_revocation" | "scheduled" | "compromise"
  newSetupPackageDigest,             // each remaining member receives their own setup package; this is the digest of the recipient-specific package
  rotationDeadlineMs,                // see §5.5.5 below
  curatorSignature                   // secp256k1 / EIP-191
}
```

The verifier checks the same chain of curator authority as for `KeyGrant`, plus: the `previousEpochId` matches the recipient's current epoch.

#### 5.5.3 Mid-epoch joining — forward-only key delivery

A new member joining mid-epoch does NOT require a new epoch. The curator sends them a `KeyGrant` with `startMessageIndex` set to the CURRENT message index, plus ratchet state for that index — NOT the initial chain key.

This addresses PR #113 review comment on `line:280`. Concretely: instead of sending the initial chain key `CK_0` (which would let the joiner decrypt every prior message in the epoch by ratcheting forward), the curator derives the ratchet state at index `n` via `CK_n = HMAC_ratchet^n(CK_0)` and includes only `CK_n` in the setup package. The joiner can decrypt messages from index `n` onward but cannot reverse the HMAC ratchet to recover `CK_0..n-1`.

If the curator explicitly wants to grant historical access (e.g. paid backfill), they set `startMessageIndex = 0` and ship `CK_0`. The `startMessageIndex` field is bound in the curator's signature, so the grant's scope is unambiguous and chain-verifiable.

#### 5.5.4 KeyGrant backfill-scope artifact

The `backfillScope` field in `KeyGrant` is an explicit declaration of what historical content the grantee is entitled to. This addresses PR #113 review comment on `line:595` (and resolves the previous "prior keys at curator discretion" vagueness).

```
BackfillScope = {
  grantedEpochs: [                   // explicit list of epochs included in the grant
    {
      epochId,
      chainKeyMaterial,              // CK_n for the startMessageIndex of this epoch (encrypted in setup package)
      startMessageIndex,             // forward boundary within this epoch
      grantedBatchIds: [...] | "all" // optional restriction to specific publish batches
    },
    ...
  ],
  futureGrantsScope:                 // policy for future epochs
    "auto_grant" |                   // curator commits to forwarding future epochs (subscription model)
    "manual"                         // grantee must request each future epoch (per-asset model)
}
```

A recipient UI can now cleanly distinguish:
- Future-only access (`grantedEpochs = [current_epoch_only_with_forward_boundary]`)
- Full historical (`grantedEpochs` includes all prior, `startMessageIndex = 0` for each)
- Targeted batch access (`grantedBatchIds` constrained — used for the per-assertion monetization model β, §5.7)
- Failed / incomplete grants (recipient was promised epochs that aren't in the actual delivered `backfillScope`)

#### 5.5.5 KeyRotate failure states

This addresses PR #113 review comment on `line:281`. Rekey is a multi-recipient operation; some recipients will be offline at rotation time. Operators need explicit visibility.

**States**:

- `pending` — `KeyRotate` issued, awaiting recipient acknowledgements. New SWM writes under the new epoch are NOT yet emitted by the curator.
- `partial` — `rotationDeadlineMs` passed; some but not all remaining members ACK'd receipt. Curator decides per-CG policy: either (a) proceed (cut over to new epoch; offline members will get the new setup package on their next reconnect from the curator's queue) or (b) hold (defer cutover; SWM continues on previous epoch).
- `complete` — all remaining members ACK'd; cutover proceeds.
- `failed` — `rotationDeadlineMs` passed with insufficient ACKs AND curator policy is (b) hold; curator MUST surface this to UI and retry. SWM continues on previous epoch.

**Retry**: `KeyRotate` may be re-issued indefinitely with a new `rotationDeadlineMs`; recipients that have already ACK'd a prior issuance for the same `(previousEpochId → newEpochId)` MAY ACK again idempotently.

**SWM-write semantics during pending/partial**: if curator policy is (b) hold, SWM writes from members continue under the previous epoch and the curator MUST emit `KeyRotate` retries until rotation completes. If policy is (a) proceed past deadline, new SWM writes use the new epoch; offline members will see a gap when they reconnect (their stored chain key for the old epoch covers messages up to the cutover; they need the new setup package to read messages after).

**Curator-side queue**: a curator that has issued a `KeyRotate` MUST persist a queue of pending recipient setup packages and offer them on first contact when those recipients reconnect.

#### 5.5.6 Time-based and post-compromise rotation

Optional curator-initiated rotation for stronger post-compromise security follows the same `KeyRotate` flow as revocation. Not required by protocol; not blocking for Phase A.

#### 5.5.7 What stays out of scope

- **Re-encryption of historical ciphertext** for forward secrecy on revocation. Curated CG operators who need it MUST do explicit re-encrypt + re-publish under a new epoch with new keys. A future RFC could spec proxy re-encryption; not in this one.
- **Threshold curator** (no single wallet holds the only signing key). Can layer on top without changing this design — the verifier would check a threshold signature against a known curator multi-sig instead of a single secp256k1 sig.

### 5.6 SWMCatchupRequest — wire protocol for fetching encrypted SWM from cores

This addresses PR #113 review comment on `line:293` (correcting the v2 "no new protocol" claim — there IS new wire surface and it needs spec).

A member edge that's been offline (or a late joiner) asks any hosting core to stream encrypted SWM messages it missed. Cores serve **only the broadcast-layer ciphertext**; never the setup-layer packages (those flow point-to-point from curator; see §5.5).

#### 5.6.1 Request shape

```
SWMCatchupRequest = {
  contextGraphId,
  subGraphName,                       // optional, defaults to default subgraph
  sinceEpochId,                       // epoch to start from
  sinceMessageIndex,                  // message index within sinceEpochId; inclusive lower bound
  untilEpochId,                       // optional upper bound; omitted = serve to current
  untilMessageIndex,                  // optional upper bound within untilEpochId
  maxMessages,                        // pagination: max messages per response page
  pageCursor,                         // opaque cursor for continuation; empty on first request

  // Authentication & rate-limit context
  requesterIdentityId,                // chain-resolvable wallet of the requester
  requesterSignature,                 // secp256k1 / EIP-191 over the above fields + timestamp
  requestedAtMs                       // timestamp; signature replay protection
}
```

#### 5.6.2 Response shape

```
SWMCatchupResponse = {
  pageMessages: [                     // ordered by (epochId, messageIndex)
    {
      epochId,
      messageIndex,
      ciphertextChunk,                // opaque AEAD-encrypted bytes (broadcast layer)
      swmMessageDigest                // H(ciphertextChunk), for the requester to detect corruption
    },
    ...
  ],
  nextPageCursor,                     // empty if this was the last page in the requested range
  serverIdentityId,                   // the hosting core's chain-resolvable wallet
  serverSignature                     // secp256k1 over (pageMessages digests + pageCursor); allows requester to attribute corruption to a specific core
}
```

#### 5.6.3 Ordering and completeness

- Messages MUST be served in `(epochId, messageIndex)` order. Cores SHOULD NOT serve out-of-order or skip indices; if a chunk is missing locally, the response includes a `missingIndices` array so the requester can fetch from another core.
- **Completeness verification**: requesters reconstruct the SWM message-index sequence and check for gaps. For each batch that was anchored on chain during the requested range, the requester compares the assembled batch hash against the on-chain merkle root (post-decrypt). Mismatch → flag this core and refetch the disputed chunks from a different hosting core.

#### 5.6.4 Authentication, rate limits, abuse model

Cores by default MUST authenticate requesters to enable rate-limiting and abuse defence. Three authentication modes:

- **Anonymous (denied by default)**: cores MAY reject unsigned requests. CGs that have explicitly opted in to public-discoverability can be served anonymously, but curated CGs MUST require authenticated requests.
- **Member-attested**: `requesterSignature` is from a wallet that the core can resolve as a current or historical member of `contextGraphId` (chain lookup). This is the normal path for member edge resync.
- **Token-bearer (for paid grants)**: requester presents a short-lived bearer token issued by the curator (a signed envelope binding `requesterIdentityId`, `contextGraphId`, `validUntilMs`, and `grantedBatchIds` if scoped). The core verifies the token's curator signature against the on-chain `publishAuthority` and serves only chunks within the granted scope.

**Rate limits**: cores MUST enforce per-`requesterIdentityId` rate limits, configurable, with defaults documented in [SPEC_CG_MEMORY_MODEL.md §4.6](./SPEC_CG_MEMORY_MODEL.md#46-hosting). Exceeding limits → `429 Too Many Requests` with `Retry-After` hint.

**Abuse signals**: a requester that repeatedly fetches but never ACKs as a member, fetches batches beyond their granted scope, or triggers rate-limit responses 5+ times in a window — the core MAY add to a local block-list and SHOULD report via [SPEC_CG_MEMORY_MODEL.md] reputation surface.

#### 5.6.5 What cores still do NOT serve

- **Setup-layer packages** (per-recipient X25519 wraps containing chain keys / payload keys). These flow point-to-point from the curator at grant time and are never on cores. A returning member already has their setup package locally; a new member gets one from the curator directly. This invariant is what keeps cores out of the key-distribution path (§5.2).
- **Plaintext.** Cores have no key. Even if compelled to disclose, they can only disclose ciphertext.

### 5.7 Monetization access model β — per-assertion payload key

This RFC specifies a fine-grained access model for monetization: a buyer pays for ONE assertion and receives a key that decrypts only that assertion — not the epoch chain key (which would unlock everything in the epoch).

This is "model β" in the §12 alternative-considered comparison. Model α (sell the epoch chain key for broad subscription access) falls out as a degenerate case where the curator sells β keys for every assertion in the epoch, but is not the primary monetization protocol. β is the Bloomberg-shaped product.

#### 5.7.1 Cryptographic foundation (already in code)

The existing Sender Keys construction in [`packages/core/src/crypto/swm-sender-key.ts`](../../packages/core/src/crypto/swm-sender-key.ts) derives the per-message payload key as:

```
payloadKey_n = HKDF(CK_n, info = SWM_SENDER_KEY_PAYLOAD_KEY_PURPOSE, length = 32)
```

where `CK_n` is the chain key after `n` ratchets. HKDF is one-way: knowledge of `payloadKey_n` does NOT recover `CK_n`. So the curator can deliver a single `payloadKey_n` to a buyer without exposing the chain key or any other message's payload key.

#### 5.7.2 PaidAccessGrant — wire protocol

```
PaidAccessGrant = {
  contextGraphId,
  buyerAgentAddress,                  // buyer wallet (the X402 payer)
  buyerRecipientKeyId,                // buyer's X25519 setup-key id for envelope wrap
  grantedAssertions: [                // array of one or more assertion accesses
    {
      epochId,
      swmMessageIndex,                // identifies the assertion
      batchId,                         // the VM batch this assertion was anchored in
      leafIndex,                       // position within the batch's merkle tree
      payloadKey,                     // 32 bytes — derived from CK_n by curator, opaque to buyer's understanding of the ratchet
      ciphertextChunkDigest,          // H(ct_n), for buyer to verify they got the right ciphertext from cores
      attestation                     // member-attestation token per §5.3.2 (curator can self-attest if they're a member, which is the typical case)
    },
    ...
  ],
  validUntilMs,                       // optional: time-bounded access (curator may revoke by not renewing)
  curatorSignature                    // secp256k1 / EIP-191 over the above
}
```

The grant envelope itself is encrypted to `buyerRecipientKeyId` via the same X25519 + AES-GCM machinery as the existing setup package. Only the buyer can decrypt.

#### 5.7.3 Buyer's verification and decryption flow

1. Buyer pays via x402 (or other payment rail) → curator emits `PaidAccessGrant`.
2. Buyer decrypts the envelope → gets `(payloadKey, ciphertextChunkDigest, attestation)` per granted assertion.
3. Buyer fetches the ciphertext chunk from any hosting core via `SWMCatchupRequest` (token-bearer mode, presenting a bearer token derived from `PaidAccessGrant.curatorSignature` — see §5.6.4).
4. Buyer verifies `H(received ciphertext) == ciphertextChunkDigest`.
5. Buyer decrypts: `assertion = AEAD_decrypt(payloadKey, ciphertextChunk, AAD = standard SWM AAD per §5.2)`.
6. Buyer verifies plaintext binding via the attestation per §5.3.2 → trust path established to on-chain anchor.

#### 5.7.4 What the buyer learns

- The single assertion they paid for, fully decrypted.
- The on-chain anchor confirms it was committed by the curator at publish time.
- The attestation confirms the plaintext matches what a member decrypted.

#### 5.7.5 What the buyer does NOT learn

- **Other assertions in the same epoch**: HKDF is one-way; `payloadKey_n` reveals nothing about `payloadKey_m` for `m ≠ n` or about `CK_n`.
- **Other assertions in the same batch**: even if the buyer holds the merkle root for the batch, they cannot decrypt other leaves without their `payloadKey_m`.
- **Future assertions**: unless `PaidAccessGrant` includes them, the buyer has no key.

#### 5.7.6 What the curator learns (and the privacy implication)

The curator knows which assertions the buyer purchased — both from the payment correlation and from issuing the grant. This is a curator-side metadata trail. For most commercial use cases this is acceptable (the seller knows what the buyer bought). For privacy-preserving purchase patterns (private purchase that the curator cannot correlate to specific assertions), a future RFC could introduce private-payment / blind-grant primitives.

#### 5.7.7 Phase A vs Phase B

The HKDF derivation is already in code. What is missing for full β monetization:

- The `PaidAccessGrant` envelope format and wire protocol (~200 LOC).
- Curator-side UI to issue grants (~UI changes).
- Buyer-side library to consume grants (~100 LOC + verification flow per §5.7.3).
- The token-bearer authentication mode in `SWMCatchupRequest` (§5.6.4).

**This RFC places β monetization in Phase B**, not Phase A. Phase A delivers the substrate change that makes monetization possible (cores host ciphertext that paid outsiders can fetch); the explicit `PaidAccessGrant` protocol can be developed and shipped independently when a concrete monetization product is ready to consume it. Members in the meantime can manually share `(payloadKey, ciphertextChunkDigest, attestation)` tuples — same content, just without a normative envelope format.

---

## 6. Threat model

### 6.1 What this preserves

- **Plaintext privacy from cores** — cores never receive chain keys; ciphertext is AEAD-encrypted under per-message payload keys derived via HKDF; cores see opaque bytes only.
- **Plaintext privacy from non-members** — non-members get nothing (same as today).
- **Member verifiability** — members verify each batch post-decrypt against the existing on-chain plaintext root (§5.3.1). Detection point identical to today.
- **Verifiability for grant-recipients** — once they hold the chain key (KeyGrant) or per-assertion payload key (PaidAccessGrant), recipients verify their content the same way members do.
- **Outsider verifiability via attestation** — outsiders without keys verify content via member-attestation tokens (§5.3.2), with cryptographic attribution to a named on-chain-resolvable member.

### 6.2 What this preserves only against honest cores

- **Hosting commitment** — a malicious core can claim to host bytes it doesn't actually hold, ACK a publish, then refuse to serve. Mitigations: existing sharding-table accountability (replication factor > 1, slashing on proven non-availability), periodic proof-of-storage challenges (Phase C). The `persist-before-sign` invariant (§5.4.3) makes any later denial-of-service evidence directly attributable.
- **Selective ciphertext withholding** — a malicious core can serve some queries and not others. Mitigation: same as above — replication, multiple-core querying, eventual slashing-on-proof.

### 6.3 What this does not protect against

- **Member exfiltration** — a member with the chain key can always copy the plaintext and share it out of band. Same as any access-controlled system. The on-chain anchor lets the curator at least *prove provenance* of leaked data via a member attestation, which is a useful audit primitive even when prevention is not possible.
- **Curator key loss** — if the curator loses the chain key entirely, no one can read the CG anymore (except via existing member copies). Operational hygiene; out of protocol scope. Threshold-curator (§5.5.7) is the layered fix.
- **Malicious attester** — a member who attests to a false plaintext-binding can deceive an outsider in the short term. Mitigation: attestation includes `attesterAgentAddress` which is on-chain-resolvable; once detected (e.g. by another member or by the outsider comparing attestations), the curator can revoke the malicious member's `publishAuthority` and the existing V10 reputation/slashing model applies. See open question §8.5 about freshness.

### 6.4 Forward-secrecy posture, per actor

Compared to the status quo (curated content lives only on member nodes), RFC-38 changes the read-at-time-T capability for two specific actor states. The table makes the delta explicit:

| Actor at time T+1 | Prior state at time T | Status quo: can read T's plaintext? | RFC-38: can read T's plaintext? |
|---|---|---|---|
| Current member | Holds chain key for T, was online at T | Yes (cached locally) | Yes (cached locally + cores) |
| Returning member | Holds chain key for T, was offline at T | Only if a peer is online to serve | Yes — cores serve ciphertext |
| Revoked member, cached plaintext at T | Was member at T, decrypted at T | Yes (locally cached) — unchanged | Yes (locally cached) — unchanged |
| Revoked member, did NOT decrypt at T | Was member at T but offline, retained chain key | Probably no (peers may have rotated, refused to serve) | **Yes** — if they fetch ciphertext from a core |
| Outsider with chain key, no membership | Got key out of band (leak, theft, paid grant) | Needs to compromise a member node to get bytes | Needs to authenticate to a core via `SWMCatchupRequest` (§5.6.4) — possible if they have a valid bearer token or member-attestation chain |
| Outsider without chain key | None | Cannot read | Cannot read |
| Compromised core | Holds ciphertext only | N/A (cores don't host curated today) | Cannot read (no key) |
| Compromised core + revoked member colluding | Ciphertext + old chain key | N/A | Yes — full historical read for granted epochs |

**Net assessment.** The marginal new exposure is one row (revoked member who didn't decrypt at T but retained their old key, AND obtains ciphertext from a core). This is narrower than it first appears because:

- Most revoked members **decrypted continuously while active** — the lazy-decrypt scenario where they retained the key but never used it is uncommon.
- The chain key required to decrypt is itself a hard-to-obtain artifact. Compromising the key is the primary attack regardless of where ciphertext lives.
- The compromised-core scenario presumes the attacker can violate a staked operator's storage — which under §6.2 is subject to (Phase C) slashing once provable.

The new model is **defense in depth** for plaintext, not regression: cores hold encrypted, members hold keys, neither alone suffices. The threat surface widens slightly (cores join the set of places ciphertext lives) in exchange for the availability and verifiability benefits that motivated the RFC. For curators who explicitly need stronger forward secrecy on revocation, the §9 escape valve (re-encrypt + republish) remains available.

### 6.5 Metadata leakage and abuse model

This addresses PR #113 review comment on `line:291`. Cores now hosting curated ciphertext changes the metadata surface even though plaintext stays protected. The threat model and the protocol-level mitigations:

#### 6.5.1 Metadata visible to a hosting core (curated CG)

| Metadata | Visible to core? | Mitigation |
|---|---|---|
| CG existence | Yes (core knows it's assigned to host this CG via sharding-table) | Inherent to hosting; CG existence is on-chain anyway |
| Batch IDs | Yes | Same as above; batches are on-chain |
| Per-batch chunk count and byte size | Yes | Sharding-table assignment requires this for storage planning |
| Update cadence (message frequency) | Yes (cores see the gossip rate) | No protocol mitigation — operational reality |
| Hosting assignments (which cores host which CGs) | Yes (on-chain in sharding-table) | Public info; same as today for public CGs |
| Member wallet addresses interacting | Partial — cores see message senders via the broadcast layer's `senderAgentAddress` AAD field, but only for members; cores don't see who's a non-publishing reader | This is the same exposure as today for public CGs; the AAD is required for sender authentication |
| Plaintext content | NO | Encryption; this RFC's core invariant |
| Setup-package distribution (who got keys when) | NO | Setup packages flow point-to-point from curator, never on cores (§5.2) |

#### 6.5.2 Metadata visible to an unauthenticated outsider

Without `SWMCatchupRequest` authentication (§5.6.4), outsiders could enumerate:

- That a CG exists (on-chain, no new exposure)
- Batch IDs and merkle roots (on-chain, no new exposure)
- Ciphertext chunk byte sizes and digests (via core queries)
- Update cadence (by polling)
- Bulk-download all ciphertext (opaque, but reveals total volume)

**Mitigations enforced by this RFC**:

- **Curated CGs require authenticated `SWMCatchupRequest`** (§5.6.4). Cores MUST reject anonymous requests for curated CGs. The three accepted auth modes (member, paid-token-bearer, curator-issued bearer) all bind the requester to a chain-resolvable identity.
- **Rate limits** per-requester (§5.6.4). Default policy: aggressive limits for unrecognised requesters; higher limits for verified members and active paid subscribers.
- **Quota-based access** (optional, per-CG curator policy): cores may enforce per-grant byte-quota limits derived from `PaidAccessGrant.grantedAssertions`.
- **Anti-enumeration**: a core SHOULD respond with consistent timing whether the requested chunk exists or not, to prevent presence-oracle attacks (within reason — full constant-time is not required).

#### 6.5.3 Compelled disclosure

A core compelled (subpoena, court order, coercion) to disclose its CG storage can disclose:

- The list of CGs it hosts (already on-chain)
- All ciphertext chunks for those CGs
- Sender wallet addresses observed in AAD fields

It **cannot** disclose:

- Plaintext (no key)
- Member-to-CG mappings beyond what's on chain
- Setup packages (it never had them)

For threat models where compelled disclosure of ciphertext-at-rest is unacceptable, the only mitigation is **don't use a third-party core for that CG** — self-host (per §2.5's GitLab analogy). The protocol supports this; deployment is the user's choice.

#### 6.5.4 Abuse — protocol-level circuit breakers

Cores hosting may face abuse vectors:

- **Storage exhaustion via registered CGs** (publisher floods cores with high-cardinality CGs): mitigated by the sharding-table replication factor (cores host a bounded subset of CGs once per-CG sub-sharding lands; until then, every core hosts every registered CG, bounded by retention-policy expiration) and Phase C storage-proof challenges.
- **Storage exhaustion via unregistered-CG staging** (attacker gossips ciphertext under a never-registered CG ID to use cores as a free file host): mitigated by the per-chunk TTL, per-wallet rate limit, per-CG-ID byte cap, and per-core aggregate budget specified in §5.1.1. None of these gates require chain state; all are enforced locally on the receiving core based on the sender's wallet signature (already on every SWM message). An attacker can burn the wallet's reputation and chew through the per-wallet rate budget, but cannot exceed the per-core aggregate ceiling and cannot retain anything past TTL without registering on chain (which adds an explicit, attributable, on-chain footprint).
- **Bandwidth exhaustion** (outsider repeatedly fetches the same ciphertext): mitigated by rate limits and per-requester quotas (§5.6.4).
- **Reputational poisoning** (malicious publisher commits batches that members later reject, blaming cores): the core can prove via `ackRequestDigest` (§5.4) that it ACK'd only what was attested; correlation back to the publisher's authority is on chain.

---

## 7. Implementation impact

**Phase A is the small, focused ship that unblocks scenarios 1-3 in §2.4.** It changes only the substrate subscription gate, the ACK protocol shape, and (de-implements) the assumption that cores serve only public CGs. No new on-chain fields. No new merkle leaf format. No proto-version bump. **Phase B** adds the explicit key lifecycle protocol and the monetization model β (scenario 4). **Phase C** adds storage-proof challenges (future hardening).

### 7.1 Phase A — Substrate subscription + new ACK protocol (single ship)

**Scope**: admit sharding-table cores into curated SWM substrate as encrypted-bytes hosts; rewire the ACK protocol to bind ciphertext-availability into the existing V10 batch digest. No on-chain field changes. No leaf format changes. Verification continues to use the existing single-root over plaintext (§5.3).

**Changes**:

*Substrate subscription:*
- `packages/agent/src/swm/enumerate-cg-members.ts` → split into `enumerate-cg-members` (decryption-eligible; unchanged semantics) and `enumerate-cg-hosts` (substrate-eligible; new).
- `packages/agent/src/dkg-agent.ts` SWM subscription gate uses `enumerate-cg-hosts` for hosting decisions and `enumerate-cg-members` for key-distribution decisions.
- `packages/chain` adds (if not already present) a `getShardingTableMembersForCG(cgId)` helper. Reuses the existing sharding-table contract.

*ACK protocol (§5.4):*
- `packages/publisher/src/ack-collector.ts` (and the responder in `packages/agent/`) → adopt the new `ACKRequest` shape (§5.4.1) that binds the full V10 batch-digest fields PLUS the new `ciphertextChunks[]` + `ciphertextChunksRoot` + `ackProtocolVersion`. Sign with secp256k1/EIP-191 over `ackRequestDigest`.
- Responder enforces the `persist-before-sign` invariant (§5.4.3): durably persist + index every chunk it intends to ACK before emitting `ACKResponse`.
- Implement the `ChunkPullRequest` fallback for cores that haven't yet seen a chunk via gossip (§5.4.3). Bounded retry; explicit decline on timeout.

*Catch-up protocol (§5.6):*
- `packages/agent/src/swm/catchup.ts` (new) → implement `SWMCatchupRequest`/`Response` per §5.6.1-§5.6.2. Default to member-attested auth; reject anonymous requests for curated CGs.
- Rate-limit and abuse defence per §5.6.4 / §6.5. Default rate limits documented in [SPEC_CG_MEMORY_MODEL.md §4.6](./SPEC_CG_MEMORY_MODEL.md#46-hosting).

*Member verification post-decrypt (§5.3.1):*
- `packages/agent/src/swm/verify-batch.ts` (new) → after reconstructing a batch from substrate (live or catch-up), recompute plaintext merkle root and compare to on-chain anchor. On mismatch: reject batch, alert via SWM, retry from a different hosting core.

*Outsider attestation tokens (§5.3.2):*
- `packages/publisher/src/member-attestation.ts` (new) → small library for members to mint, and outsiders to verify, attestation envelopes. Used by scenario 3 bridge agents and scenario 4 monetization paths.

**Out of Phase A scope**: explicit `KeyGrant` / `KeyRotate` messages (Phase B), monetization β protocol (Phase B), dual-root commitment (dropped entirely; see §5.3.3), epoch salt (dropped entirely), `saltCommitment` on-chain field (dropped entirely), `commitmentVersion` field (not needed; the existing single-root commitment is unchanged).

**Unlocks**: scenarios 1, 2, and 3 in §2.4. Edge curator → curated CG → VM publish works. Edge resync from cores works. Bridge cores (scenario 3) work via existing implicit setup-on-first-share grant flow. Scenario 4 (monetization) requires Phase B's `PaidAccessGrant` to be fully native, but a manual "send the buyer `(payloadKey, ciphertext, attestation)` over email" already works under Phase A using existing primitives.

**Test gates** (devnet):

1. Invite-only CG, edge proposer + 3 sharding-table-core ACKers; publish lands on chain. Repeat with edge proposer offline immediately after sending ACK requests (publish should still land because cores hold the ciphertext and the new ACK shape binds availability).
2. Fresh "late joiner" node receives a setup package out-of-band from the curator, then uses `SWMCatchupRequest` against any hosting core to backfill the entire CG history. Verify every batch reconstruction against the on-chain merkle root.
3. Member detects a malicious-publisher batch: publisher commits a root that doesn't match the SWM ciphertext members can decrypt. Member rejects the batch, alerts via SWM gossip, and the rejection propagates.
4. Outsider with `(assertion, attestation)` from a member runs the attestation-verification flow against a target batch; verification succeeds for a real attestation, fails for a tampered one or one signed by a wallet that wasn't a CG member at the attested epoch.

#### 7.1.1 Phase A — implementation status (as-shipped)

The Phase A milestones above are mostly landed. Devnet validation lives in `scripts/devnet-test-rfc38-*.sh`; run `scripts/devnet-test-rfc38-all.sh` against a fresh 6-node devnet (4 cores + 2 edges) to exercise the full suite end-to-end. Current scope on this branch:

| Sub-task | Source surface | Devnet test | Status |
|---|---|---|---|
| LU-5: edge curator → curated CG → VM publish (the §1.1 unblocker — `isEncryptedPayload` PublishIntent, AEAD wrap, no-attribution V10 publish) | `packages/core/src/crypto/v10-publish-payload.ts`, `packages/publisher/src/{storage-ack-handler,dkg-publisher}.ts`, `packages/agent/src/dkg-agent.ts` (`_resolveEncryptInlinePayload`) | `devnet-test-rfc38-lu5.sh` + `lu5-public.sh` | ✅ landed |
| LU-7: `SWMCatchupRequest` catchup endpoint (anon for public CGs, member-attested for curated; outsider denial) | `packages/cli/src/daemon/routes/memory.ts` (`POST /api/shared-memory/catchup`) + the existing `PROTOCOL_SYNC` substrate | `devnet-test-rfc38-lu7.sh` | ✅ landed |
| LU-8: member post-decrypt root recompute + `BatchRejected` SWM gossip | `packages/agent/src/swm/verify-batch.ts` + `POST /api/shared-memory/{verify-batch,report-batch-rejection}` | `devnet-test-rfc38-lu8.sh` | ✅ landed |
| LU-9: member-attestation token mint + outsider verification (with optional `membershipResolver` chain hook) | `packages/agent/src/swm/member-attestation.ts` + `POST /api/attestation/{mint,verify}` | `devnet-test-rfc38-lu9.sh` | ✅ landed |
| LU-10: public-CG regression sweep (publish + anonymous catchup + verify-batch + attestation, all on a public CG) | reuses LU-5/7/8/9 surfaces with `accessPolicy: 0` | `devnet-test-rfc38-lu10.sh` | ✅ landed |
| Cross-CG isolation, multi-member (3-way), scale (50 triples / 25 KAs), late-joiner (member-from-member with curator offline) | scenario coverage on top of the landed surfaces | `devnet-test-rfc38-{cross-cg,multi-member,scale,late-joiner}.sh` | ✅ landed |
| LU-6: sharding-table-driven SWM substrate subscription on cores + pre-registration staging (TTL, byte caps, ciphertext fanout to cores) so cores can serve catchup when the curator AND all live members are offline | (deferred) | `devnet-test-rfc38-late-joiner.sh` SCENARIO C documents the gap with a passing fail-soft assertion (cores-only catchup returns 0 triples cleanly, no crash) | ⚠️ deferred (see below) |

**What "deferred LU-6" means in practice on this branch:**

- A new member joining when the curator OR any other current member is online → catches up the full SWM history via `POST /api/shared-memory/catchup` against that peer. ✅ works.
- A new member joining when the curator AND all current members are offline → catchup against cores returns 0 triples. The endpoint shape is correct (`peersAttempted > 0`, `totalInsertedTriples == 0`, no crash); the data simply isn't there because today's cores don't subscribe to curated CG SWM gossip topics outside the member allowlist. ⚠️ gap.

This gap is acceptable for the Phase A user-visible surface (the §1.1 bug was about *publishing*, not about a specific late-joiner pattern), but is the next thing to land for the full "scenarios 1–4 of §2.4" promise to be honest. The substrate-subscription work itself is non-trivial: it touches the `SharedMemoryHandler` apply path (currently signature-checks the publisher and applies plaintext quads; needs a parallel "store opaque ciphertext under sharding-table assignment" path) and the SWM gossip wire format (Phase B in §7.2 will move it to AEAD per §5.2; Phase A could ship a transitional "cores subscribe but only persist for members" mode if needed sooner).

### 7.2 Phase B — Explicit key lifecycle + monetization model β

**Scope**: formalise the curator's key-distribution lifecycle as explicit `KeyGrant` / `KeyRotate` messages (§5.5) and add the `PaidAccessGrant` protocol for per-assertion monetization (§5.7).

**Changes**:

*Explicit lifecycle messages:*
- `packages/agent/src/swm/key-grant.ts` (new) → implement `KeyGrant` and `KeyRotate` per §5.5.1, §5.5.2. Curator-side issuance, recipient-side verification, secp256k1/EIP-191 signing.
- `packages/agent/src/swm/key-grant-state.ts` (new) → KeyRotate state machine (pending/partial/complete/failed) per §5.5.5. Curator-side queue for pending recipients.
- `packages/agent/src/swm/backfill-scope.ts` (new) → `BackfillScope` artifact per §5.5.4. Recipient-side UI signals for future-only vs full-historical vs targeted-batch access.
- `packages/core/src/proto/swm-sender-key.ts` → bump `SWM_SENDER_KEY_PACKAGE_VERSION` from `'1'` to `'2'`. Add `KeyGrantMsg` and `KeyRotateMsg` schemas. Wire-negotiation: version `'1'` continues to work for nodes that haven't upgraded; version `'2'` adds explicit lifecycle.

*Monetization β protocol:*
- `packages/agent/src/swm/paid-access.ts` (new) → `PaidAccessGrant` per §5.7.2. Per-assertion payload-key wrap using existing X25519+AES-GCM machinery; member attestation per §5.3.2.
- `packages/agent/src/swm/catchup.ts` → add token-bearer auth mode for `SWMCatchupRequest` (§5.6.4) — paid buyers fetch ciphertext using a `PaidAccessGrant`-derived bearer token.
- `packages/node-ui/` → curator UI flow for "grant access" (KeyGrant) and "issue paid access" (PaidAccessGrant). x402 integration is a separate spec.

*Mid-epoch join semantics:*
- Forward-only `startMessageIndex` enforcement per §5.5.3. Curator-side: derive ratchet state at index `n` instead of shipping `CK_0`. Recipient-side: refuse setup packages with ambiguous scope.

**Defer until**: a concrete monetization product or compliance/audit story justifies the additional protocol surface. Phase A members can use implicit setup-on-first-share until then.

### 7.3 Phase C — Storage-proof challenges (future hardening)

**Scope**: periodic proof-of-storage challenges to keep cores honest about what they claim to host. Slashing wiring against `parametersStorage`-defined penalties.

**Defer until**: real-world hosting-fault evidence makes protocol-level enforcement worth the complexity. Until then, the §6.2 honest-cores assumption (with sharding-table replication factor > 1 as the layer-0 mitigation) is acceptable.

### 7.4 What this enables later without forking the protocol

The substrate convergence in §2 has compound benefits. Each of the following becomes a **single-implementation** feature instead of "build twice (public + curated) or skip for curated":

| Future feature | Status quo cost | Under RFC-38 |
|---|---|---|
| Replication-factor SLAs for stored data | Implement separately for curated (member-replication is undefined today) | Reuse sharding-table replication mechanism uniformly |
| Slashing for hosting non-availability | Cannot apply to curated (no shared substrate to slash on) | Works uniformly; cores are slashable for any CG they're assigned to |
| Per-CG access monetization via x402 | Requires bespoke gateway per CG | Standard pattern: pay-curator-for-key, fetch-ciphertext-from-cores (scenario 4, formalized as §5.7) |
| Third-party tool integration via bridge cores | Impossible (cores don't have curated bytes to bridge) | Native: hosting cores hold ciphertext, a co-located member-agent on the same machine decrypts and pushes (scenario 3) |
| Cross-CG queries that include curated content | Requires querier to be member of every queried CG | Querier with appropriate keys reads from one substrate (cores), discovers what they have keys for |
| Audit logs for compliance | Members manually verify post-decrypt; outsiders need member co-operation | Same trust model + attestation tokens carry the verification cryptographically |

The substrate fork in the status quo means each of these has to be implemented twice or skipped for curated; the cost compounds with each new feature. RFC-38's one-time investment in convergence pays back over the product roadmap.

---

## 8. Open questions

1. **Replication factor for hosting**. The sharding table currently picks an N-of-M set per CG; what's the right N for the substrate tier (encrypted SWM) for curated vs public CGs? Same value or different? Recommendation: start with both at the same default (e.g. 3); revisit once hosting-cost analysis lands.
2. **PCA (publisher chain authority) interaction**. PCA-authorised agents publishing on a curator's behalf need access to the same chain key as the curator. PCA-grant ≡ KeyGrant in this model (Phase B); the PCA signs ACK requests under its own identity and its own publishAuthority delegation. Verify the PCA flow composes cleanly; expect yes but write a regression test.
3. **Rename of "curated" in UI copy**. The terminology in SPEC_CG_MEMORY_MODEL.md uses "invite-only" for the sharing dial and "curators-only" for the contribution dial. Neither covers the new connotation "data is encrypted at the substrate layer, keys gate access." Consider a future copy pass. Out of scope for this RFC.
4. **Setup-package availability for offline curators.** Today setup packages flow strictly point-to-point from curator to recipient at grant time. If a member rolls a new device while the curator is offline, the new device cannot bootstrap (it has the wallet but not the chain key). Options: (a) curator pre-provisions long-lived recipient X25519 keys that are device-portable so any device with the same agent wallet can decrypt setup packages it previously received; (b) cores opt in to relay setup packages on the curator's behalf — these are still end-to-end encrypted, cores cannot decrypt, but they break the strict no-key-material-on-cores invariant of §5.2. Recommendation: (a) for v1, defer (b) until a concrete use case demands it.
5. **Trustless outsider verification (deferred-Phase-D candidate).** Member-attestation tokens (§5.3.2) give outsiders a cryptographically-attributable verification path, but require trusting a named member at attestation time. For use cases where no member is reachable at verification time (regulated audit years after publish; journalism with all original members hostile), a member-co-signature collected at publish time and anchored on chain would provide fully self-contained chain verification. Sketch: each publish ACK round includes ≥1 member co-signature attesting "I decrypted every leaf and the plaintext binding holds." Cost: changes the publish flow to require a member online and willing to co-sign. Not on the roadmap; documented here so the protocol does not paint into a corner.
6. **Member-attestation token freshness / revocation.** Attestation tokens (§5.3.2) are signed at attestation time, not publish time. If a member later realises they attested to a bad batch (the publisher's plaintext didn't match what the member decrypted, but they only noticed later), how do they revoke? Options: (a) attestations include `attesterCommitsAtMs` and consumers check it's before any on-chain `BatchRejected` event; (b) attesters maintain a revocation registry. Recommendation: (a) for Phase B, defer (b).
6. **Backfill scope verification.** A buyer who pays for `grantedBatchIds = [B_42]` (§5.5.4) and receives a `PaidAccessGrant` for that batch can verify they received what they paid for. But what if the curator's UI says "you bought batch 42" while the issued grant says "you bought batch 43"? Recommendation: the buyer's payment receipt (off-chain or on-chain) MUST bind to the same `grantedBatchIds` set the grant carries. Out of scope for this RFC; in scope for whoever wires the x402 / payment layer.
7. **Catch-up bandwidth amplification attacks.** Cores serve ciphertext to authenticated requesters per §5.6.4. A malicious member could repeatedly trigger full-history catch-ups across many cores to amplify bandwidth costs. Rate limits (§5.6.4) and per-CG quotas mitigate. May need explicit catch-up budgets per-member per-day in Phase B if real-world abuse emerges.
8. **ACK protocol version migration.** Phase A introduces `ackProtocolVersion: 2`. Cores running pre-Phase-A code will continue to receive `ackProtocolVersion: 1` requests (the existing V10 shape); their behaviour is unchanged. New publishers MUST send version 2 to gain ciphertext-availability binding. Until all cores have upgraded, publishers SHOULD fall back to version 1 if a target core declines version 2 with `UNSUPPORTED_ACK_VERSION` — but this means losing the ciphertext-availability binding for that ACK. Acceptable degradation during rollout.
9. **Pre-registration staging defaults.** §5.1.1 proposes 6h per-chunk TTL, 1 MB/min and 50 MB/h per-wallet rate limits, 100 MB per-CG-ID cap, and a per-core aggregate budget of "a few GB." These are starting points, not measured optima. Two things to settle as the network scales: (a) whether the per-CG and per-wallet caps need to grow proportionally to network capacity, or whether the per-core aggregate budget is the only really load-bearing limit; (b) whether the TTL should be uniform or risk-tiered (e.g. shorter TTL for new wallets with no on-chain history). Recommendation: ship the defaults above for v1, instrument staging-budget utilisation per core, and tune the next time we touch this surface.
10. **Per-CG sub-sharding (future direction).** Today the sharding-table assignment for any CG is "every core in the table" (§5.1.1, [SPEC_CG_MEMORY_MODEL.md §4.6](./SPEC_CG_MEMORY_MODEL.md#46-hosting)); cores host every CG. As the network grows this won't scale and a per-CG sub-assignment will be needed. The RFC is forward-compatible — the `amIInTheAssignmentFor(cgId)` check is written as a deterministic-function abstraction so a future sub-sharding scheme can refine it without changing this protocol. Not in scope here.
11. **Curated-vs-public pricing differential (tokenomics calibration).** Per §5.4.1, curated CGs declare ciphertext `byteSize` for hosting cost, which means they pay AEAD-overhead more per plaintext bit than equivalent public CGs (small in practice — see overhead table). This is honest and self-correcting (curators can amortise via larger chunks) and requires no contract change. Open question for the tokenomics layer: do we want an explicit `stakeWeightedAverageAsk` modifier that compensates / discounts curated hosting differently from public, or do we leave the ciphertext-byteSize convention as the only differential and let the market sort it out? Recommendation: leave it alone for v1; revisit when there is real adoption data on the curated/public mix and operator economics.

---

## 9. Out of scope

This RFC does not address:

- **Re-encryption on membership revocation** (forward secrecy). Curated CG operators who need it must do explicit re-encrypt + republish. A future RFC could spec proxy re-encryption or per-leaf access policies.
- **Marketplace pricing / payment rails** for monetized access grants. This RFC enables the protocol-level grant; the commercial layer (NFT mints, subscriptions, micropayments) is a separate spec.
- **TEE-based hosting** (cores hold plaintext inside enclaves with policy enforcement). Alternative privacy model with a different trust profile; not pursued here.
- **Threshold cryptography for keys** (no single curator wallet holds the only copy). Useful for high-assurance CGs; can layer on top without contradicting this design.
- **Per-fact access policies** beyond per-CG / per-epoch. Each member sees the whole CG today, will continue to under this RFC. Per-fact ACLs are a much bigger spec.

---

## 10. Economic context (deferred to tokenomics spec)

This RFC's hosting-and-membership decoupling is a *mechanism* change. It enables — but does not specify — a richer economic surface than the network has today. The actual numbers (prices, reward shares, quota calibration) belong in [SPEC_PART2_ECONOMY.md](../SPEC_PART2_ECONOMY.md) or a successor tokenomics spec. This section names the dynamic the mechanism enables and identifies what a tokenomics spec needs to bind to.

### 10.1 Two compatible dynamics

The RFC enables two effects that are simultaneously true and in tension only at the calibration layer:

- **Network-growth dynamic** (the freemium tier widens the funnel). Pre-registration staging (§5.1.1) lets users prove a CG works for their use case before committing TRAC to chain registration. Lower entry friction → more CGs tried → more conversions → more cores worth running → more network adoption. The cost to the network is bounded (TTL + per-core aggregate budget) and is borne by cores as a known operating expense — funnel maintenance, not unmanaged liability.
- **Token-sink dynamic** (the paid tier locks TRAC). Once a CG converts from staged to registered, TRAC is locked across the four staged stages (table below). The more value a CG delivers, the more it advances along the conversion gradient and the more TRAC the curator commits. Core operators capture this value via the existing reward distribution; the network captures it via reduced circulating supply.

Both true. The calibration problem is choosing quota / pricing values such that the funnel converts at a rate that's net-positive for cores' economics — neither too generous (cores eat unbounded cost), nor too restrictive (users abandon for free alternatives, and the funnel never produces conversions).

### 10.2 The four-stage conversion gradient

| Stage | What the curator does | TRAC flow |
|---|---|---|
| 0 | Drafts CG via WM only | None |
| 1 | Shares CG via SWM; cores stage ciphertext under §5.1.1 | None — cores eat the staging cost as funnel maintenance |
| 2 | Registers CG on chain | Registration fees + retention bonds; **TRAC locked** |
| 3 | Publishes to VM (per-batch) | Per-batch publish fees flow to cores via existing reward mechanism; **TRAC locked + redistributed** |
| 4 | Issues `PaidAccessGrant`s (§5.7) for monetization | Buyer → curator x402 settlement; **TRAC velocity through monetization rails** |

Stages 0-1 are the freemium tier. Stages 2-4 are the paid tier with increasing TRAC commitment and increasing core-operator revenue.

### 10.3 Operator-level market dynamics

The §5.1.1 quotas are *protocol limits* (the most permissive defaults the protocol allows), not *protocol floors* (what cores must offer). Each operator chooses their freemium-vs-paid stance locally:

- A core that wants to maximise its position in the conversion funnel runs generous quotas (high TTL, large per-CG caps, large per-core aggregate budget). It accepts higher unpaid cost in exchange for higher exposure to conversion-driven revenue.
- A core that wants to minimise unpaid hosting runs tight quotas. It accepts lower funnel exposure in exchange for lower freemium cost.

Each individual core operator's choice is asymmetric: when a CG it staged converts to registered, that core captures revenue from hosting it going forward. When a CG it staged never converts, the cost is sunk. So cores have a direct individual interest in serving CG-types that convert well, and the operator market will discover the right shape (perhaps using usage analytics, perhaps using simple heuristics, perhaps just by aggregate budget tuning) without protocol intervention.

The protocol's role is to provide the levers and reasonable defaults — not to mandate any operator's economic strategy.

### 10.4 What this RFC settles vs. what tokenomics must settle

| Concern | Where it's settled |
|---|---|
| Pre-registration staging mechanism (TTL, quota gates, promotion) | This RFC §5.1.1 |
| ACK protocol and `byteSize` semantics (ciphertext for curated, plaintext for public) | This RFC §5.4.1 |
| Per-assertion payload-key wrap for monetization | This RFC §5.7 |
| Quota *default values* (6h TTL, 100 MB cap, etc.) | This RFC §5.1.1 — first-cut defaults |
| Quota *calibration over time* | Tokenomics spec — measurement-driven |
| Pricing per ciphertext byte / per epoch | Tokenomics spec — current `stakeWeightedAverageAsk` formula in `KnowledgeAssetsV10._validateTokenAmount` |
| Whether staging itself can be priced (e.g. TRAC bond to raise per-CG quotas above default) | Tokenomics spec — not addressed here |
| Whether cores can advertise per-CG-class staging policies in sharding-table metadata | Tokenomics spec — not addressed here |
| Conversion-incentive mechanisms (e.g. discounts for first registration, churn rewards for cores with high conversion ratios) | Tokenomics spec — not addressed here |
| Reward formulas for cores hosting unregistered staged CGs | Tokenomics spec — current default is "zero, funnel-maintenance only" |

### 10.5 Open economic questions surfaced by this RFC

These are not blocking for shipping Phase A; they are inputs to whoever next touches tokenomics:

1. **Staging-quota calibration**. What conversion ratio do the §5.1.1 defaults produce in practice? At what conversion ratio do cores' economics break even on freemium? Recommendation: ship the defaults; instrument staging-budget utilisation and conversion-rate per core; tune the next time tokenomics is touched.
2. **Curated-vs-public pricing differential**. Per §8.11 — let the ciphertext-byteSize convention be the only differential, or add an explicit modifier? Recommendation: leave alone for v1.
3. **Tiered staging policy**. Should cores be able to offer differentiated staging tiers (e.g. a wallet with on-chain reputation history gets a 24h TTL; a fresh wallet gets 6h)? Recommendation: defer; current uniform TTL is a workable starting point.
4. **Monetization fee shape**. `PaidAccessGrant` is an off-chain envelope today (§5.7); the x402 payment lives outside this RFC's protocol surface. Tokenomics spec needs to decide whether some fraction of paid-access revenue flows to the cores hosting the underlying ciphertext, or whether cores are only compensated via the registered-CG reward stream.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| **Hosting** | The substrate role: storing encrypted bytes for a CG without holding the keys to read them. A property of a node, governed by the sharding table. |
| **Membership** | The semantic role: holding the per-CG chain key and being able to decrypt CG content. A property of an agent, governed by the curator. |
| **Sharding table** | The on-chain registry that assigns cores to CGs for hosting and ACK duties. See [SPEC_CG_MEMORY_MODEL.md §4.6](./SPEC_CG_MEMORY_MODEL.md#46-hosting). |
| **Chain key** | The 32-byte symmetric key shared by all members of a given CG-epoch, used to derive per-message payload keys via HKDF-SHA-256. Ratchets via HMAC-SHA-256 per broadcast message, giving per-message forward secrecy within an epoch. Cores never see it. |
| **Payload key** | A per-message key derived as `HKDF(chainKey_n, info=SWM_SENDER_KEY_PAYLOAD_KEY_PURPOSE, length=32)`. Decrypts exactly one broadcast message. One-way derivable from `chainKey_n + index`; HKDF is irreversible. |
| **Setup package** | The per-recipient X25519-wrapped envelope (AES-256-GCM) that delivers a new chain key to one member at epoch initialization or membership join. One package per recipient per epoch. Point-to-point, never held by cores. |
| **Broadcast message** | The single shared ciphertext fanned out via gossip per SWM write — AES-256-GCM under a payload key derived from the current chain key. Every member decrypts the same bytes; cores store the same bytes. Per-assertion granularity (1 ciphertext = 1 assertion = N triples). |
| **Ciphertext chunk** | A single AEAD-encrypted broadcast message — the unit of substrate-tier replication and the unit of `SWMCatchupRequest` pagination. |
| **Epoch** | A version of the chain key. Rotated on membership revocation or curator's discretion; not rotated when a new member joins mid-epoch (§5.5.3). |
| **KeyGrant** | A curator-signed envelope (secp256k1/EIP-191) delivering a chain key to a new or returning member, with explicit `startMessageIndex` and `BackfillScope` (§5.5.1). |
| **KeyRotate** | A curator-signed envelope announcing a new epoch to remaining members after a revocation or scheduled rotation (§5.5.2). Has explicit pending/partial/complete/failed states (§5.5.5). |
| **BackfillScope** | An explicit artifact in `KeyGrant` declaring which historical epochs and batches the grantee is entitled to access (§5.5.4). |
| **PaidAccessGrant** | A curator-signed envelope delivering one or more per-assertion payload keys to a paying buyer, enabling fine-grained monetization without exposing the epoch chain key (§5.7). |
| **Member attestation token** | A member-signed envelope vouching for a specific `(assertion, ciphertextChunkDigest)` binding at a specific batch leaf. Used by outsiders to verify against on-chain anchors when they don't hold the chain key themselves (§5.3.2). |
| **Hosting core** | A core node that the sharding table has assigned to a given CG. Holds broadcast-layer ciphertext, ACKs publishes, serves `SWMCatchupRequest`. |
| **Member edge** | An edge node whose agent is on the CG's allowlist and holds the current chain key. |
| **Bridge core** | A deployment pattern: one operator runs a node that the sharding table has assigned to host a CG AND, on the same machine, a member-agent process whose wallet holds CG membership. The node hosts encrypted bytes; the co-located agent holds the chain key and decrypts. Used in scenario 3 for integrating CG content into external tools like Obsidian/Teams/Google Docs without a network hop between the storage and the decrypter. |
| **Outsider** | Any node / agent not currently a member. May become one via KeyGrant or PaidAccessGrant, retroactively gaining access to historical ciphertext via hosting cores. |

---

## 12. Alternatives considered

Two distinct alternatives were considered during this RFC's development. Both rejected.

### 11.1 Inline-ciphertext ACK (only solves the publish symptom)

A simpler alternative would close the original VM-publish symptom without any substrate-subscription change:

**Shape**. At publish time, the edge proposer attaches the full ciphertext batch to the ACK request sent to a small set of cores. Cores verify ciphertext-side, sign the commitment, discard the ciphertext after publish confirmation. No SWM subscription gating change; no chain-field addition.

**Why rejected — fails deployment shapes in §2.4**:

| Property | Inline-ciphertext ACK | RFC-38 (substrate subscription) |
|---|---|---|
| Publish-time bandwidth from edge | O(batch size) — synchronous push to N cores | O(commitments) — ciphertext pre-positioned via gossip |
| Behavior on flaky edge connections | Publishes fail or stall mid-push; retry forces re-push of the same payload | Ciphertext already on cores via gossip; ACK request is tiny |
| Edge resync after offline window | Requires another member peer to be online | Cores always-on; resync works regardless of peer state |
| Bridge core integration (scenario 3) | Impossible — cores hold no curated ciphertext | Native — cores hold ciphertext, bridge agent decrypts on same node |
| Monetized late-joiner (scenario 4) | Impossible — cores have nothing to serve historically | Native — cores serve ciphertext, curator grants payload key (§5.7) |
| Implementation footprint | ~100 LOC (ACK collector + responder) | ~800 LOC across substrate, publisher, agent (Phase A only) |

**The trade is the substrate**. Inline-ciphertext is cheap to build but only solves one symptom and bakes "all member nodes must be online for availability" into the operational model. RFC-38 is more work but matches the deployment patterns in §2.4.

**Hybrid note**. Phase A's ACK protocol allows an optional `ChunkPullRequest` fallback (§5.4.3) for the rare case where a core hasn't yet received the ciphertext via gossip (e.g. just became a sharding-table member for this CG). This makes inline-ciphertext-push a degenerate special case of RFC-38, not an excluded alternative — so the cheap path is available when it's appropriate.

### 11.2 Dual-root commitment (considered in v2, dropped in v3)

An earlier draft of this RFC (v2, in PR #113) proposed a dual-root leaf format `leaf_i = H( H(salt ‖ pt_i) ‖ H(ct_i) )` plus an on-chain `saltCommitment` field, framed as enabling outsiders to verify a leaked triple against the on-chain root WITHOUT trusting any member.

**Why considered**. The intuition is appealing: the chain holds both the plaintext-binding and the ciphertext-binding for each leaf, so cores can ACK ciphertext availability and outsiders can later check plaintext-binding using just the salt + on-chain root.

**Why rejected (PR #113 review surfaced two structural issues)**:

1. **The construction does not bind plaintext to ciphertext.** The publisher chooses BOTH halves of the leaf independently — there is no key the chain has access to that could check `decrypt(ct_i) == pt_i`. A malicious publisher can commit `(H(salt ‖ pt_A), H(ct_B))` and the merkle math validates. An outsider "verifying" the dual-root learns: "the publisher committed this pair." They do not learn: "this plaintext is the actual decryption of this ciphertext." Members catch the mismatch only post-decrypt — same detection point we have WITHOUT the dual root. So the dual-root delivers no verifier capability that wasn't already available via member post-decrypt verification.
2. **Epoch-salt disclosure broadens privacy regression.** Revealing `salt_epoch` to one verifier (to let them check one leaked triple) exposes the salt's blinding for EVERY plaintext-hash in that epoch. Low-entropy plaintexts in the entire epoch become brute-forceable to that verifier. Per-leaf nonces would help but require complex distribution and revocation.

**Why we did not patch (1)**. The only way to bind plaintext↔ciphertext on chain is either (a) a member co-signature gathered at publish time and anchored on chain, or (b) a zero-knowledge proof. Both are heavyweight. Neither was needed for the four motivating scenarios — in all of them the verification consumer is in a trust relationship with a member (current member, bridge operator, paid subscriber, journalist with attribution). The honest construction is "member attests; outsider verifies the attestation" (§5.3.2), not "chain attests to a binding it cannot verify."

**What this RFC kept from the dual-root exploration**: the substrate subscription split (§5.1), the ciphertext-availability ACK shape (§5.4), the catch-up protocol (§5.6). Those were always the operational core. The dual-root construction was a verification overreach that v3 cleanly removes.

**Future revisit (open question §8.5)**: if a use case emerges that genuinely requires trustless outsider verification at chain-resolution time (no reachable member), a Phase D could add member co-signatures at publish time and anchor them on chain. That gives the desired property without the dual-root's correspondence flaw. Not on the roadmap; documented so the design does not preclude it.

---

## Appendix A — Sequence diagrams

### A.1 Edge curator publishes facts to VM — detailed

Single end-to-end flow from a curator writing a fact, through SWM staging, plaintext-root computation (unchanged from today), ACK collection with the new ciphertext-availability binding, and on-chain anchoring. Shows every actor and every message in detail.

```mermaid
sequenceDiagram
    autonumber
    participant U as Curator agent (member)
    participant E as Edge node (daemon)
    participant G as SWM gossip substrate
    participant CN as Hosting cores<br/>(sharding-table)
    participant CH as Chain (ContextGraphs.sol)

    Note over U,E: Pre-conditions:<br/>• Chain key CK_e for current epoch is provisioned to all members via setup packages.<br/>• Cores hold no keys, only ciphertext.<br/>• Sharding-table cores are subscribed to the CG's substrate topic — this happens<br/>  whether or not the CG is on-chain-registered (§5.1.1 pre-registration staging).<br/>• Staged chunks live under TTL regardless of registration. Only this VM publish<br/>  step pays for retention; the chunks it names get promoted from staged-under-TTL<br/>  to retained-for-epochs.
    Note over CN: At t = 0 (CG creation), cores already accept SWM for this CG ID<br/>(deterministic sharding function says they're in the assignment).<br/>Registration on chain enables this publish step but does NOT by itself<br/>promote staged chunks — only the publish below does.

    Note over U,CN: 1) Drafting and SWM staging
    U->>E: write assertion A (plaintext)
    E->>E: payloadKey_n = HKDF(CK_e, info, len=32)<br/>ct_A = AEAD_encrypt(A, payloadKey_n, AAD)
    E->>G: gossip(SWM, ct_A) on CG topic
    G->>CN: deliver ct_A to hosting cores<br/>(Phase A change: now includes curated CGs)
    Note over CN: Cores index ct_A under (cg, batchId, msgIndex).<br/>No key, no plaintext — opaque bytes.

    Note over U,E: 2) Building a VM batch (unchanged from today)
    U->>E: publish [A_1, …, A_N] to VM
    E->>E: leaf_i = H(A_i) per existing V10 leaf format<br/>merkleRoot = merkleRoot(leaves)
    E->>E: ciphertextChunksRoot = merkleRoot([H(ct_i) for each leaf])

    Note over E,CN: 3) Collecting ACKs over availability + V10 fields
    E->>CN: ACKRequest{cg, opId, merkleRoot,<br/>kaCount, byteSize, epoch, chainId,<br/>tokenAmount, retentionPeriod, publishAuthority,<br/>ciphertextChunks[], ciphertextChunksRoot,<br/>ackProtocolVersion: 2}
    alt Core has all chunks (steady-state path)
        Note over CN: Verify each H(ct_i) is locally indexed.<br/>Recompute ciphertextChunksRoot.<br/>Persist-before-sign: chunks already persisted via gossip.<br/>Sign ackRequestDigest with secp256k1.
    else Core is missing a chunk
        CN->>E: ChunkPullRequest(missingIndices[])
        E->>CN: ciphertext bytes
        CN->>CN: Verify H(ct) matches digest; durably persist.
    end
    CN-->>E: ACKResponse{ackRequestDigest, ackerIdentityId, ackerSignature}
    Note over E: Collect until quorum reached<br/>(= parametersStorage.minimumRequiredSignatures())

    Note over E,CH: 4) Anchoring on chain (existing V10 flow)
    E->>CH: createKnowledgeAssetsV10(<br/>cg, merkleRoot, batchMetadata, ackSignatures[])
    Note over CH: Verify each ACK signer ∈ sharding table.<br/>Verify publisher per publishPolicy.<br/>Verify quorum.<br/>NOTE: no new chain fields vs today.
    CH-->>E: KnowledgeCollectionCreated event

    par durable hosting (already persisted from step 3)
        CN->>CN: Serve ct_i to authenticated requesters<br/>via SWMCatchupRequest (§5.6).
    and member notification
        G->>U: New batch announced on CG topic
    end
```

What each phase guarantees:

| Phase | Privacy invariant | Availability invariant |
|---|---|---|
| 1 — Stage | Cores see ciphertext only; gossip carries no keys | Cores have indexed ciphertext under (cg, batchId, msgIndex) before any ACK is requested |
| 2 — Build | Plaintext stays on curator's node | Merkle root computed over plaintext leaves (unchanged from today's V10) |
| 3 — ACK | Cores never need plaintext to sign | `ackRequestDigest` binds plaintext root AND ciphertext-availability — replay-protected and authority-pinned. Persist-before-sign enforces durable hosting. |
| 4 — Anchor | Chain stores plaintext root + V10 metadata only — no ciphertext, no keys | Members later verify post-decrypt; outsiders verify via member attestations (§5.3.2) |

### A.2 Outsider verifies an assertion via member attestation

```mermaid
sequenceDiagram
    autonumber
    participant O as Outsider (no chain key)
    participant CH as Chain
    participant CN as Any hosting core
    participant M as Member of CG<br/>(curator or any granted member)

    Note over O,M: Pre-condition: O somehow obtained assertion A<br/>(leak, public quote, paid purchase per §5.7).<br/>O needs a verifiable trust path to the on-chain anchor.

    O->>M: Request attestation for (assertion A, claimed cg, batchId, leafIndex i)
    Note over M: M decrypts ct_i locally (using their chain key).<br/>Computes plaintextLeafHash = H(decrypted assertion).<br/>If matches H(A), proceeds; else rejects.
    M-->>O: attestationToken{<br/>plaintextLeafHash = H(A),<br/>ciphertextChunkDigest = H(ct_i),<br/>attesterAgentAddress,<br/>attesterMembershipEpoch,<br/>attesterSignature (secp256k1) }

    O->>O: Compute H(A); verify equals attestationToken.plaintextLeafHash
    O->>CN: SWMCatchupRequest{cg, sinceEpochId, sinceMessageIndex} — fetch ct_i
    CN-->>O: ciphertext_chunk_i
    O->>O: Verify H(received) equals attestationToken.ciphertextChunkDigest

    O->>CH: Read batch entry for (cg, batchId): get merkleRoot
    CH-->>O: merkleRoot, batch metadata
    O->>O: Verify merkle path from H(A) to merkleRoot

    O->>CH: Resolve attesterAgentAddress: was it a member of cg at attesterMembershipEpoch?<br/>(via SPEC_V10_IDENTITY_AND_ACCESS — existing chain lookups)
    CH-->>O: Membership history confirms attester was authorised
    O->>O: Verify attestationToken.attesterSignature

    Note over O: All checks pass →<br/>Trust chain: O → on-chain-resolvable member → on-chain anchor.<br/>O learned the assertion is genuinely in the CG.<br/>O did NOT need the chain key.<br/>Malicious attester is publicly attributable and slashable<br/>per existing V10 reputation/authority model.
```

### A.3 Member edge resyncs SWM from cores after going offline

```mermaid
sequenceDiagram
    autonumber
    participant E as Member edge<br/>(reconnecting)
    participant CN as Any hosting core
    participant P as Other member peer<br/>(possibly offline)

    Note over E: Has chain key for current epoch + last seen (epochId, msgIndex).

    E->>CN: SWMCatchupRequest(cg, sinceEpochId, sinceMessageIndex,<br/>requesterIdentityId, requesterSignature)
    Note over CN: Verify requester is a member<br/>(chain lookup, §5.6.4 auth).<br/>Apply rate limit.
    CN-->>E: SWMCatchupResponse(pageMessages[],<br/>nextPageCursor, serverSignature)

    loop until nextPageCursor is empty
        E->>CN: SWMCatchupRequest(... pageCursor)
        CN-->>E: next page
    end

    E->>E: Decrypt each ciphertext with payload key<br/>derived from chain key + index.<br/>Re-derive plaintext root for each completed batch;<br/>compare to on-chain anchor (§5.3.1).
    Note over E: Catch-up complete.<br/>No member peer needed to be online —<br/>cores are the always-on availability substrate.
```

### A.4 Late joiner gets the CG data — full backfill

A late joiner is an outsider just granted membership (by invite, payment via `PaidAccessGrant`, or ad-hoc share). Unlike A.3 (where a known member returns with keys already in hand), the late joiner starts from zero — they need both the keys and the historical data. They use the same hosting cores as the rest of the network: cores serve encrypted bytes to authenticated requesters; the chain key handles decryption authorization.

```mermaid
sequenceDiagram
    autonumber
    participant LJ as Late joiner agent
    participant LJN as Late joiner's node
    participant C as Curator
    participant CN as Hosting core (any)
    participant CH as Chain
    participant G as SWM gossip substrate

    Note over LJ,C: 1) Grant — invite, payment, or ad-hoc share
    LJ->>C: Request access (off-chain or via x402 payment)
    C->>C: Add LJ wallet to allowlist (_meta)
    C->>LJN: KeyGrant{cg, epochId, recipientAgentAddress,<br/>setupPackage{chainKey, startMessageIndex},<br/>BackfillScope{grantedEpochs[], futureGrantsScope},<br/>curatorSignature (secp256k1)}
    Note over LJN: Verify curator signature against on-chain publishAuthority.<br/>BackfillScope tells LJ exactly which epochs/batches they can read.<br/>For "future-only": startMessageIndex = current, no historical keys.<br/>For "full historical": startMessageIndex = 0 for prior epochs included.

    Note over LJ,CH: 2) Backfill VM history (only for batches in BackfillScope.grantedEpochs)
    LJN->>CH: List batches for cg → [(batchId, merkleRoot, epoch)…]
    loop for each batch the joiner has keys for
        LJN->>CN: SWMCatchupRequest(cg, sinceEpochId, sinceMessageIndex,<br/>requesterSignature OR bearerToken)
        CN-->>LJN: SWMCatchupResponse(pageMessages[], serverSignature)
        LJN->>LJN: Decrypt each ciphertext with payload key derived from chain key.<br/>Recompute plaintext merkle root for the batch.<br/>Compare to on-chain merkleRoot.
        Note over LJN: Verify pass → import assertions into local store.<br/>Verify fail → reject batch; flag serving core via §6.5 abuse signals.<br/>Joiner can retry from a different hosting core.
    end

    Note over LJ,G: 3) Catch up live SWM since the latest VM batch
    LJN->>CN: SWMCatchupRequest(cg, sinceEpochId = currentEpoch, sinceMessageIndex)
    CN-->>LJN: stream of encrypted SWM messages
    LJN->>LJN: Decrypt with currentEpoch chain key<br/>Replay into local SWM store
    LJN->>G: Subscribe to CG gossip topic (live updates begin)

    Note over LJN: Late joiner now has the full picture<br/>(within BackfillScope) + live updates.<br/>Forward-only grants give a clean "joined-from-here" semantics.
```

Two properties worth highlighting in this flow:

1. **Cores are the single uniform data source.** Whether the joiner is new, returning, or a long-standing member, the bytes come from the same hosting cores. The cores authenticate requesters (§5.6.4) and rate-limit, but the authorization-to-decrypt is handled entirely off-substrate via the chain key.
2. **BackfillScope is the curator's explicit lever.** By choosing which prior-epoch chain keys to include in the `KeyGrant` (and at what `startMessageIndex`), the curator declaratively scopes what the new member can read. This gives a natural "trial member" / "full member" / "subscriber" tiering as a key-distribution policy, not a protocol change.
