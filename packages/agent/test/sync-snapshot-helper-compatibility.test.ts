import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import {
  settlePublicSnapshotsForMeta,
  syncPublicSnapshotsForMeta,
} from '@origintrail-official/dkg-agent/dist/sync/requester/shared-memory-sync.js';
import { createSyncWorkAdmission } from '@origintrail-official/dkg-agent/dist/sync/work-admission.js';

const payload: Quad[] = [{ subject: 'urn:legacy:asset', predicate: 'urn:legacy:value', object: '"one"', graph: '' }];
const digest = workspacePublicQuadsDigest(payload);
const metaQuads: Quad[] = [
  { subject: 'urn:legacy:manifest', predicate: 'http://dkg.io/ontology/publicSnapshotRef', object: `"${digest}"`, graph: '' },
  { subject: 'urn:legacy:manifest', predicate: 'http://dkg.io/ontology/publicQuadsDigest', object: `"${digest}"`, graph: '' },
  { subject: 'urn:legacy:manifest', predicate: 'http://dkg.io/ontology/publicQuadsCount', object: '"1"', graph: '' },
];

function legacyParams(cached = false) {
  const fetchSyncPages = vi.fn<Parameters<typeof syncPublicSnapshotsForMeta>[0]['fetchSyncPages']>(async () => ({
    quads: payload, bytesReceived: 42, resumedFromOffset: 0, nextOffset: 1,
    checkpointKey: 'snapshot', completed: true, timedOut: false,
  }));
  return {
    ctx: createOperationContext('sync'), remotePeerId: 'legacy-peer', contextGraphId: 'legacy-cg',
    deadline: 100, metaQuads, fetchSyncPages,
    publicSnapshotStore: {
      getSnapshot: vi.fn(async (): Promise<Quad[] | null> => cached ? payload : null),
      putSnapshot: vi.fn(async () => ({ ref: digest, byteLength: 42 })),
    },
    deleteCheckpoint: vi.fn(), setCheckpoint: vi.fn(), onSnapshotReady: vi.fn(),
  };
}

/**
 * A four-ref manifest that cannot finish: two refs are already cached, one
 * fetch fails outright, and one answers with a prefix that never completed.
 */
function partialWalkParams(failure: Error) {
  const payloads = Array.from({ length: 4 }, (_, index): Quad[] => [
    { subject: `urn:legacy:partial:${index}`, predicate: 'urn:legacy:value', object: `"${index}"`, graph: '' },
  ]);
  const refs = payloads.map(workspacePublicQuadsDigest);
  const walkMeta = refs.flatMap((ref, index) => [
    ['publicSnapshotRef', ref], ['publicQuadsDigest', ref], ['publicQuadsCount', '1'],
  ].map(([name, value]): Quad => ({
    subject: `urn:legacy:partial:op:${index}`,
    predicate: `http://dkg.io/ontology/${name}`,
    object: `"${value}"`,
    graph: '',
  })));
  const fetchSyncPages = vi.fn<Parameters<typeof syncPublicSnapshotsForMeta>[0]['fetchSyncPages']>(
    async (_ctx, _peer, _cg, _shared, _phase, _graph, _deadline, options) => {
      if (options!.snapshotRef === refs[1]) throw failure;
      return {
        quads: [], bytesReceived: 7, resumedFromOffset: 0, nextOffset: 1,
        checkpointKey: 'snapshot', completed: false, timedOut: false,
      };
    },
  );
  return {
    refs,
    params: {
      ctx: createOperationContext('sync'), remotePeerId: 'legacy-peer', contextGraphId: 'legacy-cg',
      deadline: Date.now() + 60_000, metaQuads: walkMeta, fetchSyncPages,
      publicSnapshotStore: {
        getSnapshot: vi.fn(async (ref: string): Promise<Quad[] | null> => {
          const index = refs.indexOf(ref);
          return index === 0 || index === 2 ? payloads[index]! : null;
        }),
        putSnapshot: vi.fn(async () => ({ ref: refs[0]!, byteLength: 7 })),
      },
      deleteCheckpoint: vi.fn(), setCheckpoint: vi.fn(),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('published snapshot helper compatibility', () => {
  it.each([false, true])('accepts legacy parameters for a non-empty manifest (cached=%s)', async cached => {
    vi.spyOn(Date, 'now').mockReturnValue(10);
    const params = legacyParams(cached);
    const result = await syncPublicSnapshotsForMeta(params);
    expect(result).toMatchObject({ completed: true, readySnapshots: 1, totalSnapshots: 1 });
    expect(params.onSnapshotReady).toHaveBeenCalledExactlyOnceWith(
      { ref: digest, digest, count: 1 }, cached ? 'cache' : 'network',
    );
    if (cached) expect(params.fetchSyncPages).not.toHaveBeenCalled();
    else {
      const forwarded = params.fetchSyncPages.mock.calls[0]![7]!.workAdmission!;
      expect(forwarded.capTimeout(1000)).toBe(90);
      expect(params.publicSnapshotStore.putSnapshot).toHaveBeenCalledExactlyOnceWith({ digest, quads: payload });
    }
  });

  it('derives deadline admission before cache work for legacy callers', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const params = legacyParams();
    expect(await syncPublicSnapshotsForMeta(params)).toMatchObject({ completed: false, localYield: true, missingCount: 1 });
    expect(params.publicSnapshotStore.getSnapshot).not.toHaveBeenCalled();
    expect(params.fetchSyncPages).not.toHaveBeenCalled();
  });

  it('does not admit transport when legacy cache lookup consumes the deadline', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10);
    const params = legacyParams();
    params.publicSnapshotStore.getSnapshot.mockImplementation(async () => { clock.mockReturnValue(100); return null; });
    expect(await syncPublicSnapshotsForMeta(params)).toMatchObject({ completed: false, localYield: true, missingCount: 1 });
    expect(params.publicSnapshotStore.getSnapshot).toHaveBeenCalledOnce();
    expect(params.fetchSyncPages).not.toHaveBeenCalled();
  });

  it('forwards explicitly supplied job admission unchanged', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);
    const params = legacyParams();
    const workAdmission = createSyncWorkAdmission(() => 25);
    expect(await syncPublicSnapshotsForMeta({ ...params, workAdmission })).toMatchObject({ completed: true });
    expect(params.fetchSyncPages.mock.calls[0]![7]!.workAdmission).toBe(workAdmission);
  });

  it('honors an exhausted explicit job allowance despite time remaining on the deadline', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10);
    const params = legacyParams();
    expect(await syncPublicSnapshotsForMeta({ ...params, workAdmission: createSyncWorkAdmission(() => 0) }))
      .toMatchObject({ completed: false, localYield: true });
    expect(params.publicSnapshotStore.getSnapshot).not.toHaveBeenCalled();
    expect(params.fetchSyncPages).not.toHaveBeenCalled();
  });

  it('recovers the ordered progress of a partially completed failed walk', async () => {
    const boom = new Error('snapshot stream reset');
    const { refs, params } = partialWalkParams(boom);

    // The published throwing helper is unchanged: it rethrows the original
    // error with its own identity and carries nothing on it.
    expect(await syncPublicSnapshotsForMeta(params).catch((error: unknown) => error)).toBe(boom);

    // What the throw cannot express, the settled helper does: a continuation
    // caller reading only the error would see a converging peer as stalled.
    const outcome = await settlePublicSnapshotsForMeta(params);
    expect(outcome.kind).toBe('failure');
    if (outcome.kind !== 'failure') throw new Error('Expected a failed walk');
    expect(outcome.error).toBe(boom);
    expect(outcome.result).toMatchObject({
      completed: false,
      readySnapshots: 2,
      totalSnapshots: 4,
      missingCount: 2,
      // Reduced in manifest order, not in the order the pool settled.
      missingSample: [refs[1], refs[3]],
    });
  });
});
