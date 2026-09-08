import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION, MemoryLayer, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri } from '@origintrail-official/dkg-core';
import { generateKnowledgeAssetShareMetadata, workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { DKGAgent } from '../src/index.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import type { SwmTargetExecutorPortsV1 } from '../src/sync/requester/swm-target-executor.js';
import type { SyncWorkAdmission } from '../src/sync/work-admission.js';
import { MemorySyncCheckpointStore } from '../src/sync/checkpoint/state.js';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';
import { createSwmTargetExecutorSessionFactoryForTest } from './_helpers/swm-target-executor-session-fixture.js';
import { CG, WS, WS_META, UAL, DKG, XSD_INTEGER, recoveryPage as page } from './_helpers/swm-recovery-fixture.js';

function snapshotMetadata(): Quad[] {
  const payload = [{ subject: 'urn:s', predicate: 'urn:p', object: '"new"', graph: '' }];
  const operationId = 'budget-recovery';
  const operation = `urn:dkg:share:${CG}:${operationId}`;
  const head = `${UAL}#dkg-swm-head`;
  const assertionGraph = knowledgeAssetLayerGraphUri(CG, MemoryLayer.SharedWorkingMemory, createGraphKnowledgeAssetScope(UAL, 1));
  return [
    ...generateKnowledgeAssetShareMetadata({
      shareOperationId: operationId, contextGraphId: CG, kaUal: UAL, assertionVersion: 1,
      publicTripleCount: 1, privateTripleCount: 0, publisherPeerId: 'peer-source', timestamp: new Date(0),
    }, WS_META),
    { subject: operation, predicate: `${DKG}publicQuadsDigest`, object: `"${workspacePublicQuadsDigest(payload)}"`, graph: WS_META },
    { subject: head, predicate: `${DKG}contentScopeVersion`, object: `"${GRAPH_KA_CONTENT_SCOPE_VERSION}"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: head, predicate: `${DKG}kaUal`, object: UAL, graph: WS_META },
    { subject: head, predicate: `${DKG}assertionVersion`, object: `"1"^^<${XSD_INTEGER}>`, graph: WS_META },
    { subject: head, predicate: `${DKG}assertionGraph`, object: assertionGraph, graph: WS_META },
    { subject: head, predicate: `${DKG}shareOperationId`, object: `"${operationId}"`, graph: WS_META },
  ];
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
    fetchSyncPages, executor: factory(),
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
      completedPhases: 0, failedPhases: 1, snapshotPlaneIncomplete: 1,
      failedPeers: 0, backoffWorthyFailures: 0, insertedTriples: 0,
    });
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
        return { ...page([], false), localBudgetYielded: true };
      });

      const result = await run();

      expect(fetchSyncPages.mock.calls.map(call => call[4]))
        .toEqual(yieldedPhase === 'meta' ? ['meta'] : ['meta', 'data']);
      expect(result).toMatchObject({
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
