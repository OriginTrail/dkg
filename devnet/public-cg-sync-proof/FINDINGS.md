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

**1. A green VM check that meant nothing.** An early run reported "LIVE receiver
converged on VM ✅" — but via *storage hosting*, while chain reconciliation was
stuck the entire time. Fix: assert content presence and **sync-mechanism
progress** separately, and classify the receiver against the storage-ACK set.

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

## Recommendation

1. **Ship it.** "Any agent subscribing to a public Context Graph converges to
   both SWM and VM, including content published before it subscribed" is TRUE
   for both public cells and is now devnet-proven and reproducible.
2. **File the reconcile defect on #1760** as a second root cause, with the fix
   locus above. Not release-blocking; do not rush it into a release build.
3. **Do not claim** that chain-driven VM reconciliation works, or that VM sync is
   resilient to durable-sync being unavailable.
