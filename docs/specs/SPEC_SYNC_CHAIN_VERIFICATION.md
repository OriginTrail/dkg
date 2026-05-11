# Sync Chain Verification (Tier 2)

**Status**: Draft
**Depends on**: [sync-flow.md](../diagrams/sync-flow.md), [SPEC_TRUST_LAYER.md](../SPEC_TRUST_LAYER.md)

---

## Problem

Tier 1 sync verification (implemented) recomputes merkle roots from received
triples and compares them to the meta graph's `dkg:merkleRoot`. This catches
injection, alteration, and omission of triples within a KC.

However, a sophisticated adversary can:

1. **Omit entire KCs** — send 9 of 10 KCs and the receiver has no way to
   know the 10th exists.
2. **Forge both data and metadata** — fabricate triples *and* a matching
   merkle root that was never anchored on-chain.

Tier 2 verification solves both by querying the blockchain as the source
of truth.

## Approach

After Tier 1 verification passes, the receiver performs on-chain validation:

### Step 1: Enumerate on-chain KCs for the contextGraph

Query the chain for all `KnowledgeBatchCreated` events (or equivalent
storage reads) that reference the target contextGraph. This gives the
authoritative list of `(batchId, merkleRoot, publisherAddress, startKAId,
endKAId)` tuples.

### Step 2: Compare received vs on-chain

For each on-chain KC:
- If we received it and the merkle root matches → verified
- If we received it but the merkle root differs → **reject** (forged metadata)
- If we didn't receive it → **flag as missing** (peer withheld it)

For each received KC:
- If it has a corresponding on-chain record → verified
- If it claims `dkg:status "confirmed"` but has no on-chain record → **reject**
- If it has `dkg:status "tentative"` → accept (not yet on-chain, normal)

### Step 3: Request missing KCs

For KCs flagged as missing, request them from other peers. If no peer
has them, the data may be lost (all nodes that stored it went offline)
or the KC may have expired.

## Chain adapter requirements

New method on `ChainAdapter`:

```typescript
interface ChainAdapter {
  /**
   * Returns all KC batch records for a given contextGraph from the chain.
   * Used for Tier 2 sync verification.
   */
  getContextGraphBatches?(contextGraphId: string): Promise<Array<{
    batchId: bigint;
    merkleRoot: Uint8Array;
    publisherAddress: string;
    startKAId: bigint;
    endKAId: bigint;
  }>>;
}
```

## Performance considerations

- On-chain queries are expensive (RPC calls). Tier 2 should run **once**
  after initial sync, not on every page.
- Results can be cached: the on-chain KC list only grows (new publishes)
  and never shrinks (KCs are immutable).
- For large contextGraphs, batch the RPC calls and use event log filtering
  rather than storage reads.

## When to run Tier 2

- After initial sync from a new peer (one-time catch-up)
- Periodically in the background (e.g., every 10 minutes)
- On demand via CLI command (`dkg verify-sync <contextGraphId>`)
