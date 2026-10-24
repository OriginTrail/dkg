import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import { syncPublicSnapshotsForMeta } from '@origintrail-official/dkg-agent/dist/sync/requester/shared-memory-sync.js';
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
});
