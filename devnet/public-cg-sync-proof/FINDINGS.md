# Public Context Graph sync — what works, what doesn't

**Date:** 2026-07-20
**Branch under test:** `integration/rfc64-v2-staging`
= `origin/integration/rfc64-devnet` (`0470e6b7d`) + PRs #1835, #1821, #1822 merged
**Method:** live 6-node devnet, driven through the daemon HTTP API a real agent uses.
No fixtures, no library shortcuts, no mocks.
**Reproduce:** `NUM_NODES=6 node devnet/public-cg-sync-proof/proof.mjs`

---

## The product question

> Can any agent subscribing to a **public** Context Graph reliably converge to
> **both** the shared working memory (SWM) and the finalized verifiable
> memory (VM) corpus — including content published before it subscribed?

**Answer: YES, for both public policy cells.** One internal redundancy path is
broken, but it is not load-bearing and does not block the product claim.

---

## Status matrix

Both cells = `public/open` (accessPolicy 0, publishPolicy 1) and
`public/curated` (accessPolicy 0, publishPolicy 0).

| Capability | Status | Evidence |
| --- | --- | --- |
| Create + register public CG on-chain | ✅ WORKS | both cells, `onChainId` assigned |
| SWM live sync to a pre-subscribed receiver | ✅ WORKS | exact content match, **~3 ms**, both cells |
| SWM **cold backfill** — receiver gets content published *before it subscribed* | ✅ WORKS | exact content, **~2-6 ms**, both cells |
| VM publish by the author | ✅ WORKS | `status=confirmed`, on-chain, 3 storage ACKs |
| **VM sync to a NON-HOST subscriber** | ✅ **WORKS** | exact content match, **1 ms – 3 s**, both cells, receiver provably outside the storage-ACK set |
| Curated gate: non-curator VM publication | ✅ REFUSED (409) | correct |
| Curated: non-curator staging into SWM | ✅ ALLOWED | correct per spec — see note |
| Chain-reconcile watermark advance | ❌ **STUCK** | `watermark=0/1, unresolved=1` forever — **redundant path, see below** |

**Result: 24/26 checks pass. Both failures are the same non-blocking defect.**

### Note on the curated semantics

`accessPolicy` governs SWM submission; `publishPolicy` governs **VM transaction
admission only**. A non-curator staging into SWM on a publicly-readable CG is
therefore *correct behavior*, not a leak.

---

## The defect: chain reconciliation never advances (redundant path)

### What is broken

`handleChainReconciledKC` requires `trustedAssertionEvidence`; without it, it
returns `verified-vm-metadata-pending` and defers permanently
(`packages/agent/src/finalization-handler.ts:1266`, and the sibling at `:1349`).
That value is constructed at exactly **one** site — the author's own publish
flow (`packages/agent/src/dkg-agent-publish.ts:4843`). The type comment says so:

```ts
/** Receipt/seal-validated assertion policy supplied only by named recovery. */
```

The chain-reconcile path builds its input at
`packages/agent/src/dkg-agent-swm-host.ts:3679` without that field, so a
subscribing peer can never satisfy the gate. Observable as a permanently stuck
watermark:

```
{ status: 'pending', headOrdinal: 1, watermarkAfter: 0, unresolvedOrdinals: 1 }
```

### Why it is NOT release-blocking

**Durable peer sync delivers finalized VM independently, and is on by default.**
The responder projects the per-KA V2 descriptor from the CG `_meta` graph and
admits only `dkg:status = confirmed`
(`packages/agent/src/sync/responder/graph-plan.ts:652`, `:893`); the requester
re-verifies before materializing
(`authenticateVerifiedGraphScopedAsset` → `materializeVerifiedGraphScopedAsset`).

Proven decisively: a node **provably absent from the publish storage-ACK set**,
subscribing **after** publication, obtained byte-identical VM content while its
own chain-reconcile watermark remained stuck at `0/1`. Content therefore arrived
via durable sync, not via the broken path or via hosting.

### Why it still matters

1. **Completeness accounting is wrong.** The node reports `pending` forever
   despite holding the content — misleading for status, and for anything that
   consumes reconcile state.
2. **Redundancy is lost.** If no peer can serve the manifest, there is no
   fallback, because the chain-driven path can never complete on its own.
3. **The sibling branch does bite in the field.** Issue **#1760**
   (`priority:high`, no PR) reports graph-scoped VM reconciliation holding
   `watermark=0, head=4, pending=4` for over an hour while re-fetching 6,101
   triples per sweep. Same subsystem, adjacent branch (`no-swm` vs
   `verified-vm-metadata-pending`).

### This is NOT an RFC-64 regression

`finalization-handler.ts`, `dkg-agent-swm-host.ts` and `chain-reconciler.ts` are
**byte-identical to `origin/main`**. The gate came from post-rootless hardening
commits on main (`2cfbaf147`, `89cd047a0`, `d957c89fc`) — not from RFC-64 and
not from the rootless PRs themselves (#1715's head contains neither symbol).

### The fix is plumbing, not protocol

`txHash` is already on the wire — `packages/core/src/proto/finalization.ts:21`,
field 4 of the finalization envelope — and the gossip receive path already
consumes it. A subscriber that received finalization gossip **already holds
authenticated transaction provenance**; it simply is not threaded into
`handleChainReconciledKC`. The author left the signpost at
`finalization-handler.ts:1343`:

> "A generic sweep can prove content and the current chain root, but it has no
> assertion-specific transaction provenance. Never synthesize confirmed metadata
> with an empty transaction hash; named recovery or an exact VM snapshot can
> complete the provenance-bearing transition."

**No open PR touches this code** (verified by grepping every open PR diff for
`trustedAssertionEvidence`, `verified-vm-metadata-pending`,
`handleChainReconciledKC`, `applyVerifiedGraphScopedFinalization` — zero hits),
so a fix races nobody. Best filed as a second root cause on issue **#1760**.

---

## Methodology: three false results this proof caught

All three would have shipped a wrong conclusion. They are the reason the
assertions are shaped the way they are.

**1. A green VM check whose reasoning was wrong.** An early run reported "LIVE
receiver converged on VM ✅" while chain reconciliation was stuck the entire
time, and it was initially attributed to *storage hosting*. That attribution was
itself wrong: **storage ACK does not deliver VM at all** — the ACK path persists
into SWM only (`packages/publisher/src/storage-ack-handler.ts:1182-1188`); a VM
graph URI is built only on the UPDATE path (`:1837-1843`). Hosting is also not
chain-sharded (`packages/agent/src/swm/enumerate-cg-hosts.ts:15-23`). The real
delivery was durable peer sync in every case. Two lessons survive regardless:
assert content presence and **sync-mechanism progress** separately, and keep the
decisive receiver at arm's length from the publish (not in the ACK set, and not
a node already used as the LIVE receiver).

**2. A devnet too small to contain the answer.** On 4 nodes, ACK quorum is 3, so
author + 3 peers means **every peer must ACK** — no non-host subscriber can
exist. Confirmed directly: stopping one node made publish fail with
`QuorumUnmetError(collected=0/3, dialled=2)`. The proof now **selects the late
receiver after the publish**, choosing a node provably outside the ACK set, and
reports `INFO` rather than a false pass when no such node exists.

> Generalization: small devnets cannot exercise the non-host subscriber path —
> i.e. the majority of nodes on a real network. This is very likely why the
> reconcile defect went unnoticed.

**3. A false security finding.** The curated negative originally asserted that a
non-curator's **SWM write** must be refused. It must not be. The real gate is at
`vm/publish`, which refuses correctly (409). A negative test asserting a rule the
spec does not contain manufactures bugs that do not exist.

---

## Release claims

### CAN claim (devnet-proven, reproducible)

> Agents subscribing to a public Context Graph — both open-contribution and
> curated-contribution — converge on the author's finalized, chain-verified
> Verifiable Memory, including agents that subscribe *after* publication.
> Observed convergence ~3 s on a 6-node devnet, for receivers proven not to be
> in the publish ACK set.

### MUST NOT claim

1. **Bounded or guaranteed delivery latency.** If a subscriber misses the live
   window *and* has already synced cleanly, the reconciler will not retry for up
   to ~10 min (`SYNC_RECONCILER_INTERVAL_MS` 5 min, `SYNC_STALENESS_THRESHOLD_MS`
   10 min — `packages/agent/src/dkg-agent-constants.ts:175,183`). This is
   eventual consistency, not an SLA.
2. **Anything about private / invite-only CGs.** Untested here. Note the
   reconciler is *not* public-scoped — `resolveVmReconcileTarget` admits any
   subscribed or core-hosted CG with an `onChainId` — so the access-widening
   exposure lives there.
3. **That the reconcile watermark is a health signal.** It sits at 0 with VM
   fully present. Monitoring and docs must not read `watermark < head` as "sync
   broken"; that will raise false alarms on healthy nodes.
4. **That chain-driven VM reconciliation works**, or that VM sync survives
   durable peer sync being unavailable.

### Not fully explained

The original "0 VM on the receiver" observation from the first 6-node run was
never root-caused — those node logs were overwritten by a devnet restart. The
timing explanation (sampling during the window that races the author's
`status='confirmed'` flip, before the responder will serve the graph —
`sync/responder/graph-plan.ts:893`) is **inference, not observation**.

## Recommendation

1. **Ship it, with no code change.** The user-visible requirement is met and now
   has a reproducible proof artifact. Shipping is current behavior plus evidence,
   so there is no diff to regress.
2. **Do not touch the defer.** It is a deliberate fence
   (`finalization-handler.ts:1345-1348`): a locally synthesized
   `status='confirmed'` is re-served to other peers as authoritative
   (`graph-plan.ts:893`) and is unauditable forever without a txHash on disk.
3. **Fast-follow, not now:** widen the active-fetch trigger at
   `dkg-agent-swm-host.ts:3693` to also fire on a *new, split* outcome label for
   the SWM-verified/VM-absent case. Split the label — gating on the bare
   `verified-vm-metadata-pending` would re-fetch forever after VM lands (25
   defers observed on a single node). This clears the watermark and tightens
   worst-case latency without relaxing any check.
4. **File on issue #1760** as a second root cause.
5. **The one criterion that flips "ship" to "hold":** if bounded delivery latency
   is a hard release requirement. It is not bounded today.
