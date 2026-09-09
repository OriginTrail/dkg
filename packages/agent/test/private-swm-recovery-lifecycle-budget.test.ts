import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { generateKnowledgeAssetShareMetadata, workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../src/index.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import type { SwmTargetExecutorPortsV1 } from '../src/sync/requester/swm-target-executor.js';
import { PrivateSwmSnapshotWalkRegistry } from
  '../src/sync/requester/private-swm-snapshot-walk-registry.js';
import type { SyncWorkAdmission } from '../src/sync/work-admission.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';
import { createSwmTargetExecutorSessionFactoryForTest } from './_helpers/swm-target-executor-session-fixture.js';
import { CG, WS, WS_META, DKG, XSD_INTEGER, recoveryPage as page } from './_helpers/swm-recovery-fixture.js';

function snapshotFixture(kaNumber = 7, value = 'new') {
  const ual = `did:dkg:hardhat:31337/0x00000000000000000000000000000000000000ab/${kaNumber}`;
  const payload = [{ subject: `urn:s:${kaNumber}`, predicate: 'urn:p', object: `"${value}"`, graph: '' }];
  const digest = workspacePublicQuadsDigest(payload);
  const operationId = `budget-recovery-${kaNumber}`;
  const operation = `urn:dkg:share:${CG}:${operationId}`;
  const head = `${ual}#dkg-swm-head`;
  const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(ual, 1));
  const metadata = [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId: operationId, contextGraphId: CG, kaUal: ual, assertionVersion: 1,
      publicTripleCount: 1, privateTripleCount: 0, publisherPeerId: 'peer-source', timestamp: new Date(0),
    }, WS_META),
    { subject: operation, predicate: `${DKG}publicQuadsDigest`, object: `"${digest}"`, graph: WS_META },
    { subject: head, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: head, predicate: `${DKG}kaUal`, object: ual, graph: WS_META },
    { subject: head, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: head, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
    { subject: head, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
  ];
  return { assertionGraph, digest, metadata, payload };
}

function snapshotMetadata(): Quad[] {
  return snapshotFixture().metadata;
}

function legacyMetadata(): Quad[] {
  const operation = `urn:dkg:share:${CG}:legacy-budget-recovery`;
  return [
    { subject: operation, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: `${DKG}WorkspaceOperation`, graph: WS_META },
    { subject: operation, predicate: `${DKG}rootEntity`, object: 'urn:legacy:budget-root', graph: WS_META },
  ];
}

const stores: OxigraphStore[] = [];
function harness(publicSnapshotStore?: WorkspacePublicSnapshotStore, detectLegacyRoots = false) {
  const store = new OxigraphStore(); stores.push(store);
  const fetchSyncPages = vi.fn<SwmTargetExecutorPortsV1['fetchSyncPages']>();
  const host = {
    config: { syncContextGraphPriorities: {} }, store, publicSnapshotStore,
    listSubGraphs: async () => [],
    createContextGraphSyncDeadline: () => Number.MAX_SAFE_INTEGER,
    fetchSyncPages,
    getOrCreateSyncVerifyWorker: () => ({
      processSharedMemoryBatch: async (data: Quad[], meta: Quad[]) => ({
        verifiedData: data, verifiedMeta: meta, totalFetchedDataQuads: data.length,
        totalFetchedMetaQuads: meta.length, droppedDataTriples: 0, emptyResponses: 0,
        entityCreators: detectLegacyRoots
          ? [{ dataGraph: WS, entity: 'urn:legacy:budget-root', creator: 'peer-source' }]
          : [],
      }),
    }),
    runContextGraphSyncWithBackpressure: async (
      _ctx: unknown, _cg: string, _lane: string, _label: string, work: () => Promise<unknown>,
    ) => work(),
    syncCheckpoints: new MemorySyncCheckpointStore(), workspaceOwnedEntities: new Map<string, Map<string, string>>(),
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    resolveRfc64CompleteSwmProviderPeerIdsV1: () => [],
    resolveRfc64CatalogReceiverAuthorityV1: () => ({ legacySyncAllowed: true }),
    createSwmTargetExecutorSessionV1: () => factory(),
    syncSharedMemoryFromPeerDetailedExecution: LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailedExecution,
  };
  const factory = createSwmTargetExecutorSessionFactoryForTest(host);
  return {
    fetchSyncPages, executor: factory(), store,
    run: () => LifecycleSyncMethods.prototype.syncSharedMemoryFromPeerDetailed.call(
      host as unknown as DKGAgent, 'peer-source', [CG],
      { sharedMemorySyncPlan: { targets: [{ contextGraphId: CG, lane: 'ordinary-private' }] } },
    ),
  };
}

describe('private recovery job ownership and lifecycle outcome', () => {
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await Promise.all(stores.splice(0).map(store => store.close()));
  });

  it.each([100, 0])('shares one %i ms executor window across actual recovery rounds', async budget => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', String(budget));
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - elapsed * 10);
    const { executor, fetchSyncPages } = harness();
    const windows: SyncWorkAdmission[] = [];
    const allowances: number[] = [];
    fetchSyncPages.mockImplementation(async (_ctx, _peer, _cg, _swm, _phase, _graph, _deadline, options) => {
      const window = options!.workAdmission!;
      windows.push(window); allowances.push(window.capTimeout(Infinity));
      elapsed += windows.length === 1 ? 60 : 40;
      vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '1000');
      return { ...page([], false), timedOut: true };
    });
    const onRetry = vi.fn();
    const result = await executor.recoverPrivateTarget({ contextGraphId: CG, remotePeerId: 'peer-source', onRetry });
    expect(result.completed).toBe(false);
    expect(allowances).toEqual(budget === 0 ? [Infinity] : [100, 40]);
    expect(onRetry).toHaveBeenCalledTimes(budget === 0 ? 0 : 1);
    if (budget > 0) expect(windows[1]).toBe(windows[0]);
  });

  it('reports a local yield with no snapshot send or peer backoff after cache validation consumes the job', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '100');
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const getSnapshot = vi.fn(async () => { elapsed = 100; return null; });
    const { run, fetchSyncPages } = harness({
      getSnapshot, putSnapshot: async () => { throw new Error('No incomplete snapshot may be written'); },
    });
    fetchSyncPages.mockImplementation(async (_ctx, _peer, _cg, _swm, phase) => {
      expect(phase).toBe('meta');
      return page(snapshotMetadata());
    });
    const result = await run();
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(fetchSyncPages).toHaveBeenCalledTimes(1); // Metadata only; zero snapshot requests.
    expect(result).toMatchObject({
      incompleteReason: 'local-budget-yield',
      completedPhases: 0, failedPhases: 1, snapshotPlaneIncomplete: 1,
      failedPeers: 0, backoffWorthyFailures: 0, insertedTriples: 0,
    });
  });

  it('skips a verified cached prefix across jobs and eventually fetches the manifest tail', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '100');
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fixtures = [snapshotFixture(9, 'cached-a'), snapshotFixture(8, 'cached-b'), snapshotFixture(7, 'tail')];
    const snapshots = new Map<string, Quad[]>([
      [fixtures[0].digest, fixtures[0].payload],
      [fixtures[1].digest, fixtures[1].payload],
    ]);
    const getSnapshot = vi.fn(async (ref: string) => {
      const value = snapshots.get(ref);
      if (value) elapsed += 60;
      return value?.map((quad) => ({ ...quad })) ?? null;
    });
    const putSnapshot = vi.fn(async ({ digest, quads }: { digest: string; quads: readonly Quad[] }) => {
      snapshots.set(digest, quads.map((quad) => ({ ...quad })));
      return { ref: digest, byteLength: 0 };
    });
    const { run, fetchSyncPages } = harness({ getSnapshot, putSnapshot });
    fetchSyncPages.mockImplementation(async (_ctx, _peer, _cg, _swm, phase, _graph, _deadline, options) => {
      if (phase === 'meta') return page(fixtures.flatMap(({ metadata }) => metadata));
      expect(phase).toBe('snapshot');
      expect(options?.snapshotRef).toBe(fixtures[2].digest);
      return page(fixtures[2].payload);
    });

    const first = await run();
    expect(first).toMatchObject({
      incompleteReason: 'local-budget-yield',
      failedPhases: 1,
      snapshotPlaneIncomplete: 1,
    });
    expect(getSnapshot).toHaveBeenCalledTimes(2);

    const second = await run();
    expect(second).toMatchObject({
      incompleteReason: 'local-budget-yield',
      failedPhases: 1,
      snapshotPlaneIncomplete: 1,
    });
    expect(getSnapshot).toHaveBeenCalledTimes(4);

    const third = await run();
    expect(third.failedPhases).toBe(0);
    expect(putSnapshot).toHaveBeenCalledExactlyOnceWith({
      digest: fixtures[2].digest,
      quads: fixtures[2].payload,
    });
    expect(getSnapshot.mock.calls.map(([ref]) => ref)).toEqual([
      fixtures[0].digest,
      fixtures[0].digest,
      fixtures[1].digest,
      fixtures[1].digest,
      fixtures[2].digest,
      fixtures[2].digest,
    ]);
    expect(fetchSyncPages.mock.calls.map((call) => call[4]))
      .toEqual(['meta', 'meta', 'meta', 'snapshot']);
  });

  it('revalidates retained progress and repairs an assertion graph deleted between jobs', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '100');
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const fixtures = [snapshotFixture(8, 'repair-me'), snapshotFixture(7, 'tail')];
    const snapshots = new Map(fixtures.map(({ digest, payload }) => [digest, payload]));
    const getSnapshot = vi.fn(async (ref: string) => {
      const value = snapshots.get(ref);
      if (value) elapsed += 100;
      return value?.map((quad) => ({ ...quad })) ?? null;
    });
    const { run, fetchSyncPages, store } = harness({
      getSnapshot,
      putSnapshot: async () => { throw new Error('Every snapshot is cached'); },
    });
    fetchSyncPages.mockImplementation(async (_ctx, _peer, _cg, _swm, phase) => {
      expect(phase).toBe('meta');
      return page(fixtures.flatMap(({ metadata }) => metadata));
    });

    await expect(run()).resolves.toMatchObject({
      completedPhases: 0, incompleteReason: 'local-budget-yield',
    });
    expect(await store.countQuads(fixtures[0].assertionGraph)).toBe(1);
    await store.dropGraph(fixtures[0].assertionGraph);
    expect(await store.countQuads(fixtures[0].assertionGraph)).toBe(0);

    await expect(run()).resolves.toMatchObject({
      completedPhases: 0, incompleteReason: 'local-budget-yield',
    });
    expect(await store.countQuads(fixtures[0].assertionGraph)).toBe(1);
    expect(getSnapshot.mock.calls.map(([ref]) => ref))
      .toEqual(Array(4).fill(fixtures[0].digest));
  });

  it('isolates, invalidates, expires, completes, and bounds private snapshot walks', () => {
    let now = 0;
    const registry = new PrivateSwmSnapshotWalkRegistry({
      now: () => now,
      retentionTtlMs: 10,
      maxTargets: 2,
    });
    const manifest = [
      { ref: 'a', digest: 'a', count: 1 },
      { ref: 'b', digest: 'b', count: 1 },
    ];
    const ownerA = { contextGraphId: 'cg-a', remotePeerId: 'peer-a' };
    const walkA = registry.open(ownerA, manifest);
    walkA.markResolved('a');
    expect(registry.open(ownerA, manifest).isResolved('a')).toBe(true);
    expect(registry.open(ownerA, [...manifest].reverse()).isResolved('a')).toBe(false);
    expect(registry.open({ ...ownerA, remotePeerId: 'peer-b' }, manifest).isResolved('a')).toBe(false);

    const ownerC = { contextGraphId: 'cg-c', remotePeerId: 'peer-c' };
    registry.open(ownerC, manifest);
    expect(registry.retainedTargetCount).toBe(2);
    expect(registry.open(ownerA, manifest)).not.toBe(walkA);

    const completing = registry.open(ownerC, [{ ref: 'only', digest: 'only', count: 1 }]);
    completing.markResolved('only');
    expect(registry.retainedTargetCount).toBe(1);
    now = 11;
    expect(registry.retainedTargetCount).toBe(0);
  });

  it.each(['meta', 'data'] as const)(
    'classifies a local %s-page budget yield without peer backoff',
    async yieldedPhase => {
      vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '100');
      let elapsed = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
      const { run, fetchSyncPages } = harness(undefined, yieldedPhase === 'data');
      fetchSyncPages.mockImplementation(async (_ctx, _peer, _cg, _swm, phase) => {
        if (phase === 'meta' && yieldedPhase === 'data') return page(legacyMetadata());
        expect(phase).toBe(yieldedPhase);
        elapsed = 100;
        return { ...page([], false), incompleteReason: 'local-budget-yield' };
      });

      const result = await run();

      expect(fetchSyncPages.mock.calls.map(call => call[4]))
        .toEqual(yieldedPhase === 'meta' ? ['meta'] : ['meta', 'data']);
      expect(result).toMatchObject({
        incompleteReason: 'local-budget-yield',
        completedPhases: 0,
        failedPhases: 1,
        snapshotPlaneIncomplete: 1,
        failedPeers: 0,
        backoffWorthyFailures: 0,
        insertedTriples: 0,
      });
    },
  );

  it('retains peer backoff for an admitted snapshot transport timeout', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '100');
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const { run, fetchSyncPages } = harness({
      getSnapshot: async () => null, putSnapshot: async () => { throw new Error('No incomplete snapshot may be written'); },
    });
    fetchSyncPages.mockImplementation(async (_ctx, _peer, _cg, _swm, phase) => {
      if (phase === 'meta') return page(snapshotMetadata());
      elapsed = 100;
      throw toSyncTransportFailureError(new Error('request timeout'));
    });
    const result = await run();
    expect(fetchSyncPages.mock.calls.map(call => call[4])).toEqual(['meta', 'snapshot']);
    expect(result).toMatchObject({ completedPhases: 0, backoffWorthyFailures: 1 });
  });
});
