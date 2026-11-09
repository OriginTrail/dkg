import { expect, it, vi } from 'vitest';
import { SYSTEM_CONTEXT_GRAPHS, type OperationContext } from '@origintrail-official/dkg-core';
import { runDurableSyncDetailed, type DurableSyncContext } from '../src/sync/requester/durable-sync.js';
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';

const graphs = [SYSTEM_CONTEXT_GRAPHS.ONTOLOGY, SYSTEM_CONTEXT_GRAPHS.AGENTS];

function fixture(failures: ReadonlySet<string> = new Set()) {
  const controller = new AbortController();
  const visits: string[] = [];
  const budget = vi.fn(() => ({ fetchDeadline: Date.now() + 60_000,
    createGraphScopedAuthenticationDeadline: () => Date.now() + 60_000 }));
  const context: DurableSyncContext = {
    ctx: { kind: 'sync', id: 'fanout-test', startedAt: 0 } as OperationContext,
    remotePeerId: 'one-peer', contextGraphIds: graphs, signal: controller.signal,
    durableSyncBudget: { createContextGraphBudget: budget },
    fetchSyncPages: async request => {
      if (request.phase === 'meta') visits.push(request.contextGraphId);
      if (failures.has(request.contextGraphId)) throw toSyncTransportFailureError(new Error('transport failed'));
      const quads = request.phase === 'meta' ? [] : [{ subject: `urn:${request.contextGraphId}`,
        predicate: 'urn:p', object: '"value"', graph: request.graphUri }];
      return { quads, bytesReceived: quads.length, resumedFromOffset: 0, nextOffset: quads.length,
        checkpointKey: `${request.contextGraphId}:${request.phase}`, completed: true, timedOut: false };
    },
    processDurableBatchInWorker: async (data, meta) => ({
      verifiedData: data, verifiedMeta: meta, consumedUnpersistedMetaTriples: 0,
      totalFetchedDataQuads: data.length, totalFetchedMetaQuads: meta.length,
      rejectedKcs: 0, emptyResponses: 0, metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0, dataRejectedMissingMeta: 0,
    }),
    storeInsert: async () => {}, deleteCheckpoint: vi.fn(), setCheckpoint: vi.fn(),
    logInfo: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(),
  };
  return { context, controller, visits, budget };
}

it('folds each graph once and allocates its remaining fanout budget', async () => {
  const f = fixture();
  const detailed = await runDurableSyncDetailed(f.context);
  expect(detailed.result).toMatchObject({ insertedTriples: 2, insertedDataTriples: 2,
    fetchedDataTriples: 2, completedPhases: 2, complete: true, failedPeers: 0 });
  expect(f.visits).toEqual(graphs);
  expect(f.budget.mock.calls).toEqual(graphs.map((contextGraphId, index) => [
    { contextGraphId, remainingContextGraphs: graphs.length - index },
  ]));
  expect(Object.keys(detailed)).toEqual(['result']);
});

it.each([graphs, [graphs[0]], [graphs[1]]])('keeps failures from graphs %j while preserving other progress', async (...failed) => {
  const failures = new Set(failed);
  const f = fixture(failures);
  const { result } = await runDurableSyncDetailed(f.context);
  expect(result).toMatchObject({ failedPeers: 1, failedPhases: 0,
    backoffWorthyFailures: failures.size, insertedDataTriples: graphs.length - failures.size, complete: false });
  expect(f.visits).toEqual(graphs);
});

it('stops fanout after a backoff-worthy failure when requested', async () => {
  const f = fixture(new Set(graphs));
  f.context.stopOnBackoffWorthyFailure = true;
  const { result } = await runDurableSyncDetailed(f.context);
  expect(f.visits).toEqual([graphs[0]]);
  expect(result).toMatchObject({ failedPeers: 1, backoffWorthyFailures: 1, complete: false });
});

it('counts an atomic write completed during cancellation and never starts the next graph', async () => {
  const f = fixture();
  f.context.storeInsert = async () => { f.controller.abort(new Error('caller cancelled')); };
  const { result } = await runDurableSyncDetailed(f.context);
  expect(f.visits).toEqual([graphs[0]]);
  expect(result).toMatchObject({ insertedDataTriples: 1, failedPeers: 0, failedPhases: 1, complete: false });
});
