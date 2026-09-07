import { afterEach, describe, expect, it } from 'vitest';
import { type OperationContext } from '@origintrail-official/dkg-core';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { createSharedMemorySnapshotMaterializer } from '../src/sync/requester/swm-snapshot-materializer.js';
import { swmFixtures } from './swm-descriptor-fixtures.js';
import { runSharedMemorySync } from '../src/sync/requester/shared-memory-sync.js';
import { ctx, noop, pageResult, transportError, sharedMemoryProcessResult } from './sync-requester-fixtures.js';


/**
 * T14 (#2050) — a throw must not erase the progress the round actually made.
 *
 * This is a CONVERGENCE property, not a diagnostics one. The continuation loop
 * reads `swmCoverage.snapshotsResolved` as its progress signal, and that record
 * is assembled from `syncPublicSnapshotsForMeta`'s RETURN value. A snapshot-
 * phase transport failure throws, so before this fix the return never happened,
 * no coverage record was built, the high-water mark did not move, and the loop
 * declared `coverage-stalled` and abandoned a peer that had just materialized
 * real Knowledge Assets — the r26 shape, and the exact behaviour #2050 exists
 * to remove.
 */
describe('T14 — a throwing snapshot round still reports what it resolved', () => {
  const T14_CG = 'throwing-swm';
  const T14_UAL = 'did:dkg:hardhat:31337/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const { share } = swmFixtures(T14_CG);

  const stores: OxigraphStore[] = [];
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  });

  it('carries the resolved count out through the throw instead of reporting zero', async () => {
    // Two Knowledge Assets whose snapshots are already cached — and therefore
    // materializable without a fetch — then a third whose fetch blows up.
    //
    // The metadata is DESCRIPTOR-shaped, built by the shared fixtures, rather
    // than the bare `publicQuadsDigest`/`publicQuadsCount` pair this row used
    // to carry. That is the entire point of the row. Materialization is gated
    // on `snapshotDescriptorsByRef.size > 0`, which only descriptor-shaped meta
    // populates — so under the old shape nothing could ever materialize and
    // `snapshotsResolved` was `0` BY CONSTRUCTION, under a title promising a
    // non-zero count. The row passed while unable to observe its own property.
    //
    // Two opposite properties live on this field and a no-materializer fixture
    // collapses them to the same number:
    //   - do not OVER-report: a round that fetches N and materializes 0 must
    //     not claim `N/N` (covered by the coverage rows in this file);
    //   - do not UNDER-report: a round that materializes some and then THROWS
    //     must report what it wrote, not zero — which is what this row pins,
    //     and the reason the carry-through-the-throw change exists at all.
    const resolvedA = share({ version: 1, operationId: 'op-a', marker: 't14-a', ual: `${T14_UAL}/1` });
    const resolvedB = share({ version: 1, operationId: 'op-b', marker: 't14-b', ual: `${T14_UAL}/2`, payloadCount: 3 });
    const unreachable = share({ version: 1, operationId: 'op-boom', marker: 't14-boom', ual: `${T14_UAL}/3`, payloadCount: 4 });
    const meta = [...resolvedA.meta, ...resolvedB.meta, ...unreachable.meta];

    // A real store and the real materializer: a hand-rolled stub that silently
    // fails to materialize would reproduce `resolved: 0` for a NEW reason and
    // look identical to a pass.
    const store = new OxigraphStore();
    stores.push(store);
    const materializer = createSharedMemorySnapshotMaterializer({
      store,
      writeLocks: new Map<string, Promise<void>>(),
      invalidateListContextGraphsCache: () => {},
    });

    const cached = new Map<string, Quad[]>([
      [resolvedA.digest, resolvedA.payload],
      [resolvedB.digest, resolvedB.payload],
    ]);

    const summary = await runSharedMemorySync({
      mode: { kind: 'ordinary' },
      ctx,
      remotePeerId: 'peer-throwing-99887766',
      contextGraphIds: [T14_CG],
      createContextGraphSyncDeadline: () => Date.now() + 60_000,
      fetchSyncPages: async (
        _ctx: OperationContext,
        _peer: string,
        contextGraphId: string,
        _includeSharedMemory: boolean,
        phase: string,
      ) => {
        // Only the uncached third ref reaches a fetch; the other two are served
        // from cache and never touch the transport.
        if (phase === 'snapshot') throw transportError('snapshot stream reset');
        return pageResult(contextGraphId, phase);
      },
      processSharedMemoryBatch: async () => ({
        ...sharedMemoryProcessResult(),
        emptyResponses: 0,
        verifiedMeta: meta,
        totalFetchedMetaQuads: meta.length,
      }),
      ensureContextGraph: async () => {},
      storeInsert: async (quads: Quad[]) => { await store.insert(quads); },
      snapshotMaterializer: materializer,
      publicSnapshotStore: {
        getSnapshot: async (ref: string) => cached.get(ref) ?? null,
        putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
      },
      deleteCheckpoint: () => {},
      setCheckpoint: () => {},
      ensureOwnedMap: () => new Map(),
      logInfo: noop,
      logWarn: noop,
      logDebug: noop,
    });

    // Pre-fix the whole record was `undefined` — the throw unwound past it, so
    // the pass looked non-advancing and the peer was dropped. What this row now
    // pins is stronger: the record survives the throw carrying the count of
    // Knowledge Assets actually MATERIALIZED (2), not refs fetched and not zero.
    expect(summary.swmCoverage).toEqual({
      contextGraphId: T14_CG,
      peerIdSuffix: '99887766',
      snapshotsResolved: 2,
      snapshotsTotal: 3,
      manifestComplete: true,
      descriptorsAuthoritative: true,
      missingCount: 1,
      missingSample: [unreachable.digest],
      materializationFailures: 0,
    });
  });

  // The `resolved + missing === total` invariant is deliberately NOT asserted
  // here. `recordSnapshotCoverage` derives `missingCount` as
  // `totalSnapshots - snapshotsResolved`, so the invariant holds by
  // construction and any test of it restates numbers the deep-equal above
  // already pinned. An assertion that cannot fail is worse than none: it reads
  // as coverage of a property nothing is checking.
});
