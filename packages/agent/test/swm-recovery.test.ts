import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OxigraphStore,
  readSwmMaterializationWitness,
  writeSwmMaterializationWitness,
} from '@origintrail-official/dkg-storage';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  MemoryLayer,
  createGraphKnowledgeAssetScope,
  contextGraphWorkspaceGraphUri,
  contextGraphWorkspaceMetaGraphUri,
  knowledgeAssetLayerGraphUri,
  type OperationContext,
} from '@origintrail-official/dkg-core';
import {
  generateKnowledgeAssetShareMetadata,
  workspacePublicQuadsDigest,
  type WorkspacePublicSnapshotStore,
} from '@origintrail-official/dkg-publisher';
import type { Quad } from '@origintrail-official/dkg-storage';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import {
  collectPublicSnapshotMetadata,
  orderPublicSnapshotsForBalancedRecency,
  syncPublicSnapshotsForMeta,
  type PublicSnapshotMetadata,
} from '../src/sync/requester/shared-memory-sync.js';
import {
  recoverContextGraphSwm,
  recoverContextGraphSwmWithProgressRetries,
  type RecoverContextGraphSwmResult,
} from '../src/sync/requester/swm-recovery.js';

/**
 * integration. `recoverContextGraphSwm` fetches a CG's
 * full current state from a peer and applies it via REPLACE (not the shared
 * incremental path's blind union), so a stale local store converges to the
 * source's value rather than accumulating a corrupt `{v1,v2}` superset.
 * Transport + verifier are mocked (no libp2p); the apply hits a real store.
 */
const CG = 'ws00-recovery';
const WS = contextGraphWorkspaceGraphUri(CG);
const WS_META = contextGraphWorkspaceMetaGraphUri(CG);
const SUBJ = 'urn:ws00r:shipment';
const STATUS = 'http://schema.org/status';
const ctx: OperationContext = { operationId: 'test', operationName: 'sync' } as never;
const DKG = 'http://dkg.io/ontology/';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function recoveryResult(
  readySnapshots: number,
  totalSnapshots: number,
  completed = false,
): RecoverContextGraphSwmResult {
  return {
    replacedRoots: 0,
    replacedGraphs: completed ? totalSnapshots : 0,
    insertedDataQuads: completed ? totalSnapshots : 0,
    insertedMetaQuads: completed ? totalSnapshots : 0,
    droppedDataTriples: 0,
    readySnapshots,
    totalSnapshots,
    completed,
  };
}

describe('recoverContextGraphSwmWithProgressRetries', () => {
  it('consumes monotonic immutable-snapshot progress inside one bounded catch-up job', async () => {
    const outcomes = [
      recoveryResult(5, 20),
      recoveryResult(10, 20),
      recoveryResult(15, 20),
      recoveryResult(20, 20, true),
    ];
    const retries: string[] = [];
    let calls = 0;

    const result = await recoverContextGraphSwmWithProgressRetries({
      recover: async () => outcomes[calls++]!,
      onRetry: ({ completedRound, readySnapshots, totalSnapshots }) => {
        retries.push(`${completedRound}:${readySnapshots}/${totalSnapshots}`);
      },
    });

    expect(result).toMatchObject({ completed: true, readySnapshots: 20, totalSnapshots: 20 });
    expect(calls).toBe(4);
    expect(retries).toEqual(['1:5/20', '2:10/20', '3:15/20']);
  });

  it('stops after one transient retry when snapshot progress is flat', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      recover: async () => {
        calls += 1;
        return recoveryResult(0, 20);
      },
    });

    expect(result.completed).toBe(false);
    expect(calls).toBe(3);
  });

  it('continues after one flat transport window when snapshot progress resumes', async () => {
    const outcomes = [
      recoveryResult(5, 20),
      recoveryResult(5, 20),
      recoveryResult(10, 20),
      recoveryResult(20, 20, true),
    ];
    const retries: string[] = [];
    let calls = 0;

    const result = await recoverContextGraphSwmWithProgressRetries({
      recover: async () => outcomes[calls++]!,
      onRetry: ({ completedRound, readySnapshots, totalSnapshots }) => {
        retries.push(`${completedRound}:${readySnapshots}/${totalSnapshots}`);
      },
    });

    expect(result).toMatchObject({ completed: true, readySnapshots: 20, totalSnapshots: 20 });
    expect(calls).toBe(4);
    expect(retries).toEqual(['1:5/20', '2:5/20', '3:10/20']);
  });

  it('extends the default cap while declared snapshots keep making progress', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      recover: async () => {
        calls += 1;
        return recoveryResult(calls, 20, calls === 20);
      },
    });

    expect(result).toMatchObject({ completed: true, readySnapshots: 20, totalSnapshots: 20 });
    expect(calls).toBe(20);
  });

  it('keeps snapshot-aware progress retries under an absolute ceiling', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      recover: async () => {
        calls += 1;
        return recoveryResult(calls, 100);
      },
    });

    expect(result).toMatchObject({ completed: false, readySnapshots: 24, totalSnapshots: 100 });
    expect(calls).toBe(24);
  });

  it('honours the hard recovery-round cap while progress continues', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      maxRounds: 3,
      recover: async () => {
        calls += 1;
        return recoveryResult(calls, 100);
      },
    });

    expect(result).toMatchObject({ completed: false, readySnapshots: 3, totalSnapshots: 100 });
    expect(calls).toBe(3);
  });
});

describe('syncPublicSnapshotsForMeta', () => {
  it('prioritizes three recent snapshots for every historical snapshot', () => {
    const snapshots: PublicSnapshotMetadata[] = Array.from({ length: 8 }, (_, index) => ({
      ref: `sha256:${index.toString(16).padStart(64, '0')}`,
      digest: `sha256:${index.toString(16).padStart(64, '0')}`,
      count: 1,
    }));
    const metaQuads: Quad[] = snapshots.flatMap((snapshot, index) => {
      const subject = `urn:dkg:share:balanced-${index}`;
      return [
        { subject, predicate: `${DKG}publicQuadsDigest`, object: `"${snapshot.digest}"`, graph: WS_META },
        { subject, predicate: `${DKG}publicQuadsCount`, object: '"1"', graph: WS_META },
        { subject, predicate: `${DKG}publishedAt`, object: `"2026-08-10T22:00:${index.toString().padStart(2, '0')}.000Z"`, graph: WS_META },
        { subject, predicate: `${DKG}kaUal`, object: `"did:dkg:base:84532/0x0000000000000000000000000000000000000001/${100 + index}"`, graph: WS_META },
      ];
    });

    const parsed = collectPublicSnapshotMetadata(metaQuads);
    expect(orderPublicSnapshotsForBalancedRecency(parsed).map(({ ref }) => ref))
      .toEqual([
        snapshots[7]!.ref,
        snapshots[6]!.ref,
        snapshots[5]!.ref,
        snapshots[0]!.ref,
        snapshots[4]!.ref,
        snapshots[3]!.ref,
        snapshots[2]!.ref,
        snapshots[1]!.ref,
      ]);
  });

  it('preserves manifest order when no recency evidence exists', () => {
    const snapshots: PublicSnapshotMetadata[] = [
      { ref: 'ref-b', digest: 'digest-b', count: 1 },
      { ref: 'ref-a', digest: 'digest-a', count: 1 },
    ];
    expect(orderPublicSnapshotsForBalancedRecency(snapshots)).toEqual(snapshots);
  });

  it('retries a cleanly-closed short snapshot response without caching its prefix', async () => {
    const expected: Quad[] = [
      { subject: 'urn:snapshot:a', predicate: STATUS, object: '"one"', graph: '' },
      { subject: 'urn:snapshot:b', predicate: STATUS, object: '"two"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(expected);
    const snapshotSubject = 'urn:dkg:share:short-snapshot';
    const snapshotStore = new MemorySnapshotStore();
    let deletedCheckpoints = 0;

    const result = await syncPublicSnapshotsForMeta({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      metaQuads: [
        { subject: snapshotSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
        { subject: snapshotSubject, predicate: `${DKG}publicQuadsCount`, object: `"${expected.length}"^^<${XSD_INTEGER}>`, graph: WS_META },
      ],
      publicSnapshotStore: snapshotStore,
      fetchSyncPages: async () => ({
        ...page([expected[0]!]),
        checkpointKey: `snapshot:${digest}`,
      }),
      deleteCheckpoint: () => { deletedCheckpoints += 1; },
      setCheckpoint: () => {},
    });

    expect(result).toMatchObject({
      completed: false,
      readySnapshots: 0,
      totalSnapshots: 1,
      completedPhases: 0,
    });
    expect(deletedCheckpoints).toBeGreaterThan(0);
    await expect(snapshotStore.getSnapshot(digest)).resolves.toBeNull();
  });

  it('skips one short-prefix ref and still fetches the rest of the manifest', async () => {
    // TWO declared refs, and that is the whole point of the row. The sibling
    // test above — and every other short-prefix assertion in the repo —
    // declares exactly ONE ref, where "skip this ref and keep walking" and
    // "abandon the manifest at this ref" produce byte-identical results. With
    // one ref this branch cannot be observed at all.
    //
    // Why the second ref matters in production: ref order is byte-identical on
    // every pass (`collectPublicSnapshotMetadata` returns `Map` insertion
    // order over the signed metadata), so returning/breaking here would pin
    // every future pass at this same index. One permanently unserveable
    // Knowledge Asset — a relay that always closes cleanly after a prefix —
    // would stall the entire context graph at zero progress forever, and the
    // bounded repeat-pass driver would converge on a fixed point having
    // materialized nothing. Skipping costs that one KA and nothing else.
    //
    // Ordering is load-bearing: the SHORT ref is declared FIRST so that a
    // `return`/`break` regression never reaches the second ref. If the full
    // snapshot were declared first, the walk would resolve it before ever
    // touching the short one and the row would pass under the bug.
    const shortPayload: Quad[] = [
      { subject: 'urn:snapshot:short:a', predicate: STATUS, object: '"one"', graph: '' },
      { subject: 'urn:snapshot:short:b', predicate: STATUS, object: '"two"', graph: '' },
    ];
    // Deliberately a DIFFERENT payload, so the two digests (and therefore the
    // two refs) cannot collide and `requestedRefs` can distinguish them.
    const fullPayload: Quad[] = [
      { subject: 'urn:snapshot:full:a', predicate: STATUS, object: '"three"', graph: '' },
    ];
    const shortDigest = workspacePublicQuadsDigest(shortPayload);
    const fullDigest = workspacePublicQuadsDigest(fullPayload);
    const shortSubject = 'urn:dkg:share:short-prefix-ka';
    const fullSubject = 'urn:dkg:share:complete-ka';
    const snapshotStore = new MemorySnapshotStore();
    const requestedRefs: string[] = [];
    const deletedCheckpoints: string[] = [];

    const result = await syncPublicSnapshotsForMeta({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      // Not the deadline branch: this row must isolate the short-prefix skip.
      // An expired deadline would abandon the tail for an unrelated reason and
      // the row would pass even with the skip reverted.
      deadline: Number.MAX_SAFE_INTEGER,
      // Digest-only (store-backed) rows: no explicit `dkg:publicSnapshotRef`,
      // so each ref IS its digest. Both rows carry digest AND count — a row
      // missing either is silently dropped from the manifest, which would
      // quietly shrink `totalSnapshots` to 1 and re-create the blind spot.
      metaQuads: [
        { subject: shortSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${shortDigest}"`, graph: WS_META },
        { subject: shortSubject, predicate: `${DKG}publicQuadsCount`, object: `"${shortPayload.length}"^^<${XSD_INTEGER}>`, graph: WS_META },
        { subject: fullSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${fullDigest}"`, graph: WS_META },
        { subject: fullSubject, predicate: `${DKG}publicQuadsCount`, object: `"${fullPayload.length}"^^<${XSD_INTEGER}>`, graph: WS_META },
      ],
      publicSnapshotStore: snapshotStore,
      fetchSyncPages: async (_c, _p, _cg, _inc, _phase, _graph, _deadline, fetchOptions): Promise<SyncPageResult> => {
        const snapshotRef = fetchOptions?.snapshotRef;
        requestedRefs.push(snapshotRef ?? '');
        // `completed: true` with FEWER quads than the signed count — a relayed
        // stream that terminated cleanly on a prefix. Not corrupt (the digest
        // check is only reached at equal count), so it must stay a retryable
        // skip rather than the fatal throw.
        if (snapshotRef === shortDigest) {
          return { ...page([shortPayload[0]!]), checkpointKey: `snapshot:${shortDigest}` };
        }
        return { ...page(fullPayload), checkpointKey: `snapshot:${fullDigest}` };
      },
      deleteCheckpoint: (key) => { deletedCheckpoints.push(key); },
      setCheckpoint: () => {},
    });

    // The walk reached the SECOND ref. Without this the skip is unproven: a
    // `break` leaves `requestedRefs` at `[shortDigest]`.
    expect(requestedRefs).toEqual([shortDigest, fullDigest]);
    expect(result).toMatchObject({
      // Still not a clean round — the manifest is NOT satisfied. `completed` is
      // derived from `missingCount === 0`, so continuing past a skipped ref must
      // never be mistaken for success; the caller has to come back for it.
      completed: false,
      readySnapshots: 1,
      totalSnapshots: 2,
      missingCount: 1,
      completedPhases: 1,
      // A skip is OUR classification of the peer's response, not a local budget
      // decision, so the voluntary-yield flag must stay down.
      yieldedAtDeadline: false,
    });
    // The shortfall names the ref that was skipped, not the one that succeeded.
    expect(result.missingSample).toEqual([shortDigest]);
    // `MemorySnapshotStore.putSnapshot` genuinely persists into `this.snapshots`,
    // so these two are real round-trips through the cache, not stub echoes: the
    // second KA was verified and written, and the unverified prefix was not.
    await expect(snapshotStore.getSnapshot(fullDigest)).resolves.toEqual(fullPayload);
    await expect(snapshotStore.getSnapshot(shortDigest)).resolves.toBeNull();
    // The skipped ref's checkpoint is dropped so its retry restarts at offset
    // zero — resuming at nextOffset would validate only the tail against the
    // full digest and could never succeed.
    expect(deletedCheckpoints).toContain(`snapshot:${shortDigest}`);
  });

  it('yields at the round deadline without charging the peer a timeout', async () => {
    // Every OTHER direct call of `syncPublicSnapshotsForMeta` in this repo —
    // including the two rows above — passes `deadline: Number.MAX_SAFE_INTEGER`,
    // so the voluntary-yield branch is never entered anywhere. This row is the
    // only thing driving it.
    //
    // The contract being pinned is an ATTRIBUTION rule, not a counting rule:
    // stopping on OUR OWN round budget is a local scheduling decision, so it
    // must surface as an incomplete snapshot plane (`yieldedAtDeadline`, which
    // the caller in `runSharedMemorySync` turns into `snapshotPlaneIncomplete`
    // + `failedPhases`) and must NEVER touch `timedOutPhases` — that field
    // feeds `backoffWorthyFailure` in `durable-progress.ts`, so folding a
    // yield into it would back off a perfectly healthy responder for the
    // crime of us running out of clock.
    //
    // Fake timers rather than a real short deadline: the clock has to cross the
    // deadline BETWEEN the first and second Knowledge Asset, deterministically.
    // A wall-clock margin would race the first `Date.now() >= deadline` check
    // and flake on a loaded machine, and a busy-wait would burn real time.
    const BASE_TIME = 1_700_000_000_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(BASE_TIME);
      const deadline = BASE_TIME + 1_000;

      const cachedPayload: Quad[] = [
        { subject: 'urn:snapshot:before-deadline', predicate: STATUS, object: '"kept"', graph: '' },
      ];
      const deferredPayload: Quad[] = [
        { subject: 'urn:snapshot:after-deadline', predicate: STATUS, object: '"deferred"', graph: '' },
      ];
      const cachedDigest = workspacePublicQuadsDigest(cachedPayload);
      const deferredDigest = workspacePublicQuadsDigest(deferredPayload);
      const cachedSubject = 'urn:dkg:share:before-deadline-ka';
      const deferredSubject = 'urn:dkg:share:after-deadline-ka';
      const snapshotStore = new MemorySnapshotStore();
      // Pre-seeded so the FIRST ref resolves from the CACHE. That keeps the
      // pre-yield progress entirely off the network: `readySnapshots: 1` below
      // therefore cannot be confused with a fetch, and `fetches: 0` stays a
      // clean statement about the whole round.
      await snapshotStore.putSnapshot({ digest: cachedDigest, quads: cachedPayload });
      let fetches = 0;

      const result = await syncPublicSnapshotsForMeta({
        ctx,
        remotePeerId: 'peer-source',
        contextGraphId: CG,
        deadline,
        // Order is load-bearing: the cached ref FIRST, the deferred ref second.
        // The clock is only pushed past the deadline once the first one is
        // resolved, so the walk is forced to stop mid-manifest — which is the
        // only shape that can show a yield PRESERVING earlier progress rather
        // than discarding the round.
        metaQuads: [
          { subject: cachedSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${cachedDigest}"`, graph: WS_META },
          { subject: cachedSubject, predicate: `${DKG}publicQuadsCount`, object: `"${cachedPayload.length}"^^<${XSD_INTEGER}>`, graph: WS_META },
          { subject: deferredSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${deferredDigest}"`, graph: WS_META },
          { subject: deferredSubject, predicate: `${DKG}publicQuadsCount`, object: `"${deferredPayload.length}"^^<${XSD_INTEGER}>`, graph: WS_META },
        ],
        publicSnapshotStore: snapshotStore,
        fetchSyncPages: async (): Promise<SyncPageResult> => {
          fetches += 1;
          return page([]);
        },
        // The hook that burns the budget. It fires for the cache hit, so by the
        // time the loop re-checks the clock for the second ref the round is
        // over. Nothing here touches the transport.
        onSnapshotReady: async () => { vi.setSystemTime(deadline); },
        deleteCheckpoint: () => {},
        setCheckpoint: () => {},
      });

      expect(result).toMatchObject({
        // The local yield signal the caller maps to `snapshotPlaneIncomplete`.
        yieldedAtDeadline: true,
        // A yield is not a clean round: `completed` is derived from
        // `missingCount === 0`, so the abandoned tail keeps the graph from
        // being stamped caught-up while Knowledge Assets are still missing.
        completed: false,
        // Progress made BEFORE the deadline survives it.
        readySnapshots: 1,
        totalSnapshots: 2,
        // `readySnapshots + missingCount === totalSnapshots` still holds across
        // the yield — the abandoned tail is counted, not dropped.
        missingCount: 1,
        // The whole point. No peer fault was observed, so none is recorded:
        // nothing here may reach `backoffWorthyFailure`.
        timedOutPhases: 0,
        // No network work happened at all this round.
        completedPhases: 0,
        resumedPhases: 0,
        bytesReceived: 0,
      });
      // Names the ref we still owe, not the one we already have.
      expect(result.missingSample).toEqual([deferredDigest]);
      // The clock is checked BEFORE the fetch, so no `SyncPageResult` for the
      // deferred ref ever exists — which is structurally why `timedOutPhases`
      // cannot move on this path. If the check ever migrates below the fetch,
      // this is the assertion that catches it.
      expect(fetches).toBe(0);
      // The yield left the deferred snapshot unfetched and uncached, so the
      // next round restarts it from offset zero rather than resuming a prefix.
      await expect(snapshotStore.getSnapshot(deferredDigest)).resolves.toBeNull();
    } finally {
      // Scoped to this row: the rest of the file (and the OxigraphStore-backed
      // suite below) runs on the real clock.
      vi.useRealTimers();
    }
  });
});
const UAL = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/7';
const UAL_2 = 'did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/8';

class MemorySnapshotStore implements WorkspacePublicSnapshotStore {
  readonly snapshots = new Map<string, Quad[]>();

  async putSnapshot(input: { readonly digest: string; readonly quads: readonly Quad[] }) {
    this.snapshots.set(input.digest, input.quads.map((quad) => ({ ...quad })));
    return { ref: input.digest, byteLength: 0 };
  }

  async getSnapshot(ref: string): Promise<Quad[] | null> {
    return this.snapshots.get(ref)?.map((quad) => ({ ...quad })) ?? null;
  }
}

function page(quads: Quad[], completed = true): SyncPageResult {
  return { quads, bytesReceived: 0, resumedFromOffset: 0, nextOffset: quads.length, checkpointKey: 'k', completed };
}
async function statusValues(store: OxigraphStore): Promise<string[]> {
  const r = await store.query(`SELECT ?o WHERE { GRAPH <${WS}> { <${SUBJ}> <${STATUS}> ?o } }`);
  return r.type === 'bindings' ? r.bindings.map((b) => b['o']) : [];
}

describe('recoverContextGraphSwm (fetch → verify → replace)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  function makeDeps(store: OxigraphStore, sourceData: Quad[], sourceMeta: Quad[] = []) {
    return {
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean,
        phase: 'data' | 'meta',
      ): Promise<SyncPageResult> => page(phase === 'data' ? sourceData : sourceMeta),
      processSharedMemoryBatch: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
        verifiedData: dataQuads,
        verifiedMeta: metaQuads,
        // Production derives the legacy recovery plan from rootEntity metadata,
        // so it is available during the metadata-only classification call. This
        // compact fixture models that plan from the declared source snapshot.
        entityCreators: [...new Set(sourceData.map((q) => q.subject))].map((entity) => ({
          dataGraph: WS, entity, creator: 'peer-source',
        })),
        droppedDataTriples: 0,
      }),
      writeLocks: new Map<string, Promise<void>>(),
      store,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    };
  }

  it('replaces a stale local value with the source value (no union corruption)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);

    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ]));

    expect(result.completed).toBe(true);
    expect(result.replacedRoots).toBe(1);
    expect(await statusValues(store)).toEqual(['"v2"']); // ONLY v2 — the bug would leave {v1,v2}
  });

  it('is a clean recovery into an empty store (cold-start parity)', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ]));
    expect(result.insertedDataQuads).toBe(1);
    expect(await statusValues(store)).toEqual(['"v2"']);
  });

  it('keeps independent Context Graph recoveries concurrent', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const writeLocks = new Map<string, Promise<void>>();
    let activeFetches = 0;
    let maxActiveFetches = 0;
    let signalBothEntered!: () => void;
    const bothEntered = new Promise<void>((resolve) => { signalBothEntered = resolve; });
    let releaseFetches!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetches = resolve; });
    const base = makeDeps(store, []);
    const recover = (contextGraphId: string) => recoverContextGraphSwm({
      ...base,
      contextGraphId,
      remotePeerId: `peer-${contextGraphId}`,
      writeLocks,
      fetchSyncPages: async (): Promise<SyncPageResult> => {
        activeFetches += 1;
        maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
        if (activeFetches === 2) signalBothEntered();
        await fetchGate;
        activeFetches -= 1;
        return page([], false);
      },
    });

    const first = recover('recovery-cg-a');
    const second = recover('recovery-cg-b');
    await bothEntered;
    expect(maxActiveFetches).toBe(2);
    releaseFetches();
    await Promise.all([first, second]);
  });

  it('inserts verified meta and reports it', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const meta: Quad[] = [{ subject: 'urn:op:1', predicate: 'http://dkg.io/ontology/shareOperationId', object: '"op1"', graph: WS_META }];
    const result = await recoverContextGraphSwm(makeDeps(store, [
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS },
    ], meta));
    expect(result.insertedMetaQuads).toBe(1);
    const r = await store.query(`SELECT ?s WHERE { GRAPH <${WS_META}> { ?s ?p ?o } }`);
    expect(r.type === 'bindings' && r.bindings.length).toBe(1);
  });

  it('does NOT apply when a phase never completes — leaves the store untouched for a clean retry', async () => {
    // Row-based pagination can cut a root mid-stream. Applying a REPLACE over an
    // incomplete fetch would clear the root and reinsert only the fetched prefix,
    // truncating the entity until a later retry. So an incomplete fetch must mutate
    // NOTHING: the pre-existing state stays intact and the caller retries from scratch.
    const store = new OxigraphStore();
    stores.push(store);
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: WS }]);
    const deps = makeDeps(store, [{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS }]);
    // data phase never completes and makes no progress → loop stops, partial.
    const partialDeps = {
      ...deps,
      fetchSyncPages: async (
        _c: OperationContext, _p: string, _cg: string, _inc: boolean, phase: 'data' | 'meta',
      ): Promise<SyncPageResult> =>
        phase === 'data'
          ? { ...page([{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: WS }], false), nextOffset: 0, resumedFromOffset: 0 }
          : page([]),
    };
    const result = await recoverContextGraphSwm(partialDeps);
    expect(result.completed).toBe(false);
    expect(result.replacedRoots).toBe(0);
    // incomplete fetch → no mutation at all; the prior v1 is untouched (no truncation, no partial replace)
    expect(await statusValues(store)).toEqual(['"v1"']);
  });

  it('recovers a rootless KA snapshot into its exact UAL-derived SWM graph', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(
      CG,
      MemoryLayer.SharedWorkingMemory,
      scope,
    );
    const operationId = 'rootless-recovery-op';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const payload: Quad[] = [
      { subject: 'urn:rootless:a', predicate: STATUS, object: '"v2"', graph: '' },
      { subject: 'urn:rootless:disconnected', predicate: 'urn:p', object: '"kept"', graph: '' },
    ];
    const digest = workspacePublicQuadsDigest(payload);
    const sourceMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: operationId,
        contextGraphId: CG,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: payload.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, WS_META),
      { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
    ];
    await store.insert([
      { subject: 'urn:rootless:a', predicate: STATUS, object: '"stale"', graph: assertionGraph },
      { subject: 'urn:rootless:old', predicate: 'urn:p', object: '"must-disappear"', graph: assertionGraph },
    ]);
    // #2079: recovery REPLACES this graph, so a catch-up materialization
    // witness for it would describe content that is gone — and a replace can
    // leave the quad count unchanged, which is exactly what the count gate
    // cannot see. This lane is lane-disjoint from the public one in automatic
    // operation, but the ungated `recover-shared-memory` route reaches it, and
    // that route exists to repair a corrupt local copy — the worst moment to
    // leave a stale memo standing.
    await writeSwmMaterializationWitness(store, assertionGraph, 'sha256:stale-witness');
    expect(await readSwmMaterializationWitness(store, assertionGraph, 'sha256:stale-witness')).toBe(true);
    const snapshotStore = new MemorySnapshotStore();
    let snapshotFetches = 0;
    let dataFetches = 0;

    const result = await recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c, _p, _cg, _inc, phase,
      ): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'snapshot') {
          snapshotFetches += 1;
          return page(payload);
        }
        dataFetches += 1;
        return page([]);
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [],
        verifiedMeta: metaQuads,
        entityCreators: [],
        droppedDataTriples: 0,
      }),
      writeLocks: new Map<string, Promise<void>>(),
      store,
      publicSnapshotStore: snapshotStore,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });

    expect(result).toMatchObject({
      completed: true,
      replacedRoots: 0,
      replacedGraphs: 1,
      insertedDataQuads: payload.length,
      insertedMetaQuads: sourceMeta.length,
    });
    expect(snapshotFetches).toBe(1);
    expect(dataFetches).toBe(0);
    // #2079: the replace above must have dropped the memo. The witness lives in
    // `urn:dkg:local:*`, untouched by the graph replace itself, so only the
    // explicit invalidate in the recovery lane can clear it — which is what
    // makes this discriminate.
    expect(await readSwmMaterializationWitness(store, assertionGraph, 'sha256:stale-witness')).toBe(false);
    const recovered = await store.query(
      `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
    );
    expect(recovered.type).toBe('quads');
    if (recovered.type === 'quads') {
      expect(recovered.quads.map(({ subject, predicate, object }) => ({ subject, predicate, object })))
        .toEqual(payload.map(({ subject, predicate, object }) => ({ subject, predicate, object })));
    }
  });

  it('makes monotonic per-KA progress across a deadline without rescanning aggregate SWM data', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const assets = [
      {
        ual: UAL,
        operationId: 'rootless-recovery-page-1',
        payload: [{ subject: 'urn:rootless:page:1', predicate: STATUS, object: '"one"', graph: '' }],
      },
      {
        ual: UAL_2,
        operationId: 'rootless-recovery-page-2',
        payload: [{ subject: 'urn:rootless:page:2', predicate: STATUS, object: '"two"', graph: '' }],
      },
    ].map((asset) => {
      const scope = createGraphKnowledgeAssetScope(asset.ual, 1);
      const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
      const digest = workspacePublicQuadsDigest(asset.payload);
      const operationSubject = `urn:dkg:share:${CG}:${asset.operationId}`;
      const headSubject = `${asset.ual}#dkg-swm-head`;
      return {
        ...asset,
        assertionGraph,
        digest,
        meta: [
          ...generateKnowledgeAssetShareMetadata({
            shareOperationId: asset.operationId,
            contextGraphId: CG,
            kaUal: asset.ual,
            assertionVersion: 1,
            publicTripleCount: asset.payload.length,
            privateTripleCount: 0,
            publisherPeerId: 'peer-source',
            timestamp: new Date(0),
          }, WS_META),
          { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}kaUal`, object: asset.ual, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
          { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${asset.operationId}"`, graph: WS_META },
        ] satisfies Quad[],
      };
    });
    const sourceMeta = assets.flatMap((asset) => asset.meta);
    const snapshotStore = new MemorySnapshotStore();
    const snapshotFetches = new Map<string, number>();
    let round = 1;
    let dataFetches = 0;
    const recover = () => recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (
        _c, _p, _cg, _inc, phase, _graph, _deadline, fetchOptions,
      ): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'data') {
          dataFetches += 1;
          throw new Error('rootless recovery must not request aggregate data');
        }
        const asset = assets.find(
          (candidate) => candidate.digest === fetchOptions?.snapshotRef,
        );
        if (!asset) throw new Error(`Unexpected snapshot ref ${fetchOptions?.snapshotRef}`);
        snapshotFetches.set(asset.digest, (snapshotFetches.get(asset.digest) ?? 0) + 1);
        if (round === 1 && asset === assets[1]) {
          return { ...page([], false), checkpointKey: `snapshot:${asset.digest}` };
        }
        return { ...page(asset.payload), checkpointKey: `snapshot:${asset.digest}` };
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [], verifiedMeta: metaQuads, entityCreators: [], droppedDataTriples: 0,
      }),
      writeLocks: new Map<string, Promise<void>>(),
      store,
      publicSnapshotStore: snapshotStore,
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    });

    const partial = await recover();
    expect(partial.completed).toBe(false);
    expect(partial.replacedGraphs).toBe(1);
    await expect(snapshotStore.getSnapshot(assets[0]!.digest)).resolves.toEqual(assets[0]!.payload);
    await expect(snapshotStore.getSnapshot(assets[1]!.digest)).resolves.toBeNull();
    const firstVisible = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${assets[0]!.assertionGraph}> { ?s ?p ?o } }`,
    );
    const secondStillHidden = await store.query(
      `SELECT ?s ?p ?o WHERE { GRAPH <${assets[1]!.assertionGraph}> { ?s ?p ?o } }`,
    );
    expect(firstVisible.type === 'bindings' ? firstVisible.bindings : []).toHaveLength(1);
    expect(secondStillHidden.type === 'bindings' ? secondStillHidden.bindings : []).toHaveLength(0);

    round = 2;
    const completed = await recover();
    expect(completed).toMatchObject({ completed: true, replacedGraphs: 2, insertedDataQuads: 2 });
    expect(snapshotFetches.get(assets[0]!.digest)).toBe(1);
    expect(snapshotFetches.get(assets[1]!.digest)).toBe(2);
    expect(dataFetches).toBe(0);
    for (const asset of assets) {
      const result = await store.query(
        `SELECT ?s ?p ?o WHERE { GRAPH <${asset.assertionGraph}> { ?s ?p ?o } }`,
      );
      expect(result.type === 'bindings' ? result.bindings : []).toHaveLength(asset.payload.length);
    }
  });

  it('rejects a corrupt rootless snapshot before replacing the existing exact graph', async () => {
    const store = new OxigraphStore();
    stores.push(store);
    const scope = createGraphKnowledgeAssetScope(UAL, 1);
    const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, scope);
    const operationId = 'rootless-corrupt-op';
    const operationSubject = `urn:dkg:share:${CG}:${operationId}`;
    const headSubject = `${UAL}#dkg-swm-head`;
    const committed: Quad[] = [{ subject: 'urn:rootless:a', predicate: STATUS, object: '"good"', graph: '' }];
    const sourceMeta: Quad[] = [
      ...generateKnowledgeAssetShareMetadata({
        shareOperationId: operationId,
        contextGraphId: CG,
        kaUal: UAL,
        assertionVersion: 1,
        publicTripleCount: committed.length,
        privateTripleCount: 0,
        publisherPeerId: 'peer-source',
        timestamp: new Date(0),
      }, WS_META),
      { subject: operationSubject, predicate: `${DKG}publicQuadsDigest`, object: `"${workspacePublicQuadsDigest(committed)}"`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}contentScopeVersion`, object: `"2"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
      { subject: headSubject, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
    ];
    await store.insert([{ subject: 'urn:rootless:a', predicate: STATUS, object: '"stale-safe"', graph: assertionGraph }]);

    await expect(recoverContextGraphSwm({
      ctx,
      remotePeerId: 'peer-source',
      contextGraphId: CG,
      deadline: Number.MAX_SAFE_INTEGER,
      fetchSyncPages: async (_c, _p, _cg, _inc, phase): Promise<SyncPageResult> => {
        if (phase === 'meta') return page(sourceMeta);
        if (phase === 'snapshot') {
          return page([{ subject: 'urn:rootless:a', predicate: STATUS, object: '"tampered"', graph: '' }]);
        }
        return page([]);
      },
      processSharedMemoryBatch: async (_dataQuads, metaQuads) => ({
        verifiedData: [], verifiedMeta: metaQuads, entityCreators: [], droppedDataTriples: 0,
      }),
      writeLocks: new Map<string, Promise<void>>(),
      store,
      publicSnapshotStore: new MemorySnapshotStore(),
      ensureContextGraph: async () => {},
      setCheckpoint: () => {},
      deleteCheckpoint: () => {},
    })).rejects.toThrow('failed digest/count validation');

    const stale = await store.query(
      `SELECT ?o WHERE { GRAPH <${assertionGraph}> { <urn:rootless:a> <${STATUS}> ?o } }`,
    );
    expect(stale.type === 'bindings' ? stale.bindings.map((row) => row['o']) : []).toEqual(['"stale-safe"']);
  });
});
