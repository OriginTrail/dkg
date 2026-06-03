import { describe, it, expect } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

/**
 * Phase C (#27) — requester-side `sinceBatchId` threading.
 *
 * The durable DATA fetch must carry the per-CG delta high-water mark
 * (`sinceBatchIdFor`) at the correct POSITIONAL slot of `fetchSyncPages`
 * (after `snapshotRef`), while the META fetch must NOT — meta is never
 * delta-filtered. A positional regression here silently disables delta sync or
 * misroutes the value into `snapshotRef`.
 */

interface FetchCall {
  phase: string;
  snapshotRef: string | undefined;
  sinceBatchId: string | undefined;
}

function makeContext(sinceBatchIdFor?: (cg: string) => string | undefined) {
  const calls: FetchCall[] = [];
  const page = (phase: 'data' | 'meta'): SyncPageResult => ({
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `cp|${phase}`,
    completed: true,
  });
  return {
    calls,
    context: {
      ctx: createOperationContext('sync'),
      remotePeerId: 'peerR',
      contextGraphIds: ['mfacts'],
      createContextGraphSyncDeadline: () => Date.now() + 10_000,
      fetchSyncPages: async (
        _ctx: unknown,
        _peer: string,
        _cg: string,
        _swm: boolean,
        phase: 'data' | 'meta',
        _graphUri: string,
        _deadline: number,
        snapshotRef?: string,
        sinceBatchId?: string,
      ) => {
        calls.push({ phase, snapshotRef, sinceBatchId });
        return page(phase);
      },
      sinceBatchIdFor,
      processDurableBatchInWorker: async () => ({
        verifiedData: [],
        verifiedMeta: [],
        totalFetchedDataQuads: 0,
        totalFetchedMetaQuads: 0,
        rejectedKcs: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
      }),
      storeInsert: async () => undefined,
      deleteCheckpoint: () => undefined,
      setCheckpoint: () => undefined,
      logInfo: () => undefined,
      logWarn: () => undefined,
      logDebug: () => undefined,
    },
  };
}

describe('runDurableSync — sinceBatchId threading (#27)', () => {
  it('passes sinceBatchIdFor() to the DATA fetch only, not the META fetch', async () => {
    const { calls, context } = makeContext(() => '7');
    await runDurableSync(context);

    const meta = calls.find((c) => c.phase === 'meta')!;
    const data = calls.find((c) => c.phase === 'data')!;
    expect(meta.sinceBatchId).toBeUndefined();      // meta is never delta-filtered
    expect(data.sinceBatchId).toBe('7');            // data carries the high-water mark
    expect(data.snapshotRef).toBeUndefined();       // not misrouted into snapshotRef
  });

  it('passes undefined when no high-water mark resolver is wired (full scan)', async () => {
    const { calls, context } = makeContext(undefined);
    await runDurableSync(context);
    const data = calls.find((c) => c.phase === 'data')!;
    expect(data.sinceBatchId).toBeUndefined();
  });

  it('passes undefined when the resolver returns undefined for the CG', async () => {
    const { calls, context } = makeContext(() => undefined);
    await runDurableSync(context);
    const data = calls.find((c) => c.phase === 'data')!;
    expect(data.sinceBatchId).toBeUndefined();
  });
});
