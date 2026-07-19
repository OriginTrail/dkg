# Public Context Graph sync — what works, what doesn't

**Date:** 2026-07-20
**Branch under test:** `integration/rfc64-v2-staging`
= `origin/integration/rfc64-devnet` (`0470e6b7d`) + PRs #1835, #1821, #1822 merged
**Method:** live 4-node devnet, driven through the daemon HTTP API a real agent uses.
No fixtures, no library shortcuts, no mocks.
**Reproduce:** `node devnet/public-cg-sync-proof/proof.mjs`

---

## The product question

> Can any agent subscribing to a **public** Context Graph reliably converge to
> **both** the shared working memory (SWM) and the finalized verifiable
> memory (VM) corpus — including content published before it subscribed?

**Answer: SWM yes, VM no.** One defect stands between the current code and a
complete "yes", and that defect is **not** in RFC-64.

---

## Status matrix

Both cells = `public/open` (accessPolicy 0, publishPolicy 1) and
`public/curated` (accessPolicy 0, publishPolicy 0).

| Capability | Status | Evidence |
| --- | --- | --- |
| Create + register public CG on-chain | ✅ WORKS | both cells, `onChainId` assigned |
| SWM live sync to a pre-subscribed receiver | ✅ WORKS | exact content match, **~3 ms**, both cells |
| SWM **cold backfill** — receiver gets content published *before it subscribed* | ✅ WORKS | exact content, **~4 ms**, both cells |
| VM publish by the author | ✅ WORKS | `status=confirmed`, on-chain, 3 storage ACKs |
| Curated gate: non-curator VM publication | ✅ REFUSED (409) | correct |
| Curated: non-curator staging into SWM | ✅ ALLOWED | correct per spec — see note below |
| **VM sync to a subscribing peer** | ❌ **BROKEN** | watermark stuck `0/1`, `unresolved=1`, indefinitely |

**Result: 20/22 checks pass. Both failures are the same single defect.**

### Note on the curated semantics

`accessPolicy` governs SWM submission; `publishPolicy` governs **VM transaction
admission only**. A non-curator staging into SWM on a publicly-readable CG is
therefore *correct behavior*, not a leak. An early version of this proof
asserted the opposite and produced a false security finding.

---

## The one real defect: VM never reaches a subscriber

### Symptom

A node subscribed to a public CG, holding the exact SWM content, repeatedly
reports:

```
POST /api/context-graph/reconcile
{ status: 'pending', headOrdinal: 1, watermarkBefore: 0, watermarkAfter: 0,
  reconciledOrdinals: 0, unresolvedOrdinals: 1 }
```

Stable across many attempts and many minutes of periodic sweeps. Node log:

```
[FinalizationHandler] Chain-reconcile: exact SWM content for <ual> is verified
but transaction provenance is unavailable; deferring VM promotion
[DKGAgent] chain-promote action=defer ... detail="verified-vm-metadata-pending"
```

The subscriber **has the content and has verified it**. It simply cannot prove
the on-chain provenance, so it defers — forever.

### Root cause

- `handleChainReconciledKC` requires `trustedAssertionEvidence`; without it, it
  returns `verified-vm-metadata-pending`
  (`packages/agent/src/finalization-handler.ts:1266`).
- `trustedAssertionEvidence` is constructed in exactly **one** place: the
  author's own publish flow (`packages/agent/src/dkg-agent-publish.ts:4843`).
- The chain-reconcile path builds its input at
  `packages/agent/src/dkg-agent-swm-host.ts:3679` as
  `{contextGraphId, onChainCgId, ual, merkleRoot, publisherAddress, kaId, versionBlock}`
  — **no `trustedAssertionEvidence`**.

A subscribing peer therefore can never satisfy the gate. Only the author (which
has its own publish evidence) and sharding-table-selected storage hosts (which
receive content during publish) end up with VM.

### This is NOT an RFC-64 regression

`finalization-handler.ts`, `dkg-agent-swm-host.ts` and `chain-reconciler.ts`
are **byte-identical to `origin/main`**. The gate at line 1266 and the
incomplete reconcile input at 3679 both exist verbatim on main, which ships to
mainnet. The RFC-64 branch inherited this; it did not cause it.

**Possible field correlation (unverified):** a known symptom where a CG returns
thousands of quads via `query-remote` while catch-up sync yields `data=0` has
the same signature — content reachable, never landing locally.

---

## Methodology warning: two false results this proof caught

Both would have shipped a wrong conclusion.

**1. A green VM check that meant nothing.** The first run reported
"LIVE receiver converged on VM ✅". It had — but via *storage hosting*, because
shrinking the devnet to 4 all-core nodes made the receiver a host for every
publish. Chain reconciliation was stuck the entire time. The proof now asserts
content presence and **sync-mechanism progress** separately, and classifies the
receiver against the publish storage-ACK peer set.

*Generalization:* on a small devnet every node tends to be a host, which hides
exactly the class of bug that only affects non-host subscribers — i.e. most
nodes on a real network.

**2. A false security finding.** The curated negative originally asserted that
a non-curator's **SWM write** must be refused. It isn't, and shouldn't be. The
real gate is at `vm/publish`, which does refuse correctly (409).

*Generalization:* a negative test asserting a rule the spec doesn't contain
manufactures bugs that don't exist.

---

## Recommendation

1. **Ship the SWM story.** Live sync + cold backfill, both public cells, is
   real, fast, and now devnet-proven. It was already true this morning — nobody
   could demonstrate it.
2. **File the VM subscriber gap against `main`,** not against RFC-64. It is a
   pre-existing production defect. Fixing it requires letting a reconciling peer
   establish assertion provenance from chain reads rather than from the
   publisher's own in-process evidence — which must be designed so a peer can
   never *synthesize* provenance it cannot verify.
3. **Do not claim** "any agent syncs both SWM and VM" until the watermark
   assertion in this proof passes.
