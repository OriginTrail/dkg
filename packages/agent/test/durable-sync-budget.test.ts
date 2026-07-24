import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';

import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  runDurableSync,
  type DurableSyncBudget,
} from '../src/sync/requester/durable-sync.js';
import type {
  GraphScopedMaterializationOutcome,
  VerifiedGraphScopedAsset,
} from '../src/sync/requester/graph-scoped-materialization.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const DKG = 'http://dkg.io/ontology/';
const contextGraphId = 'durable-sync-budget';
const metaGraph = `did:dkg:context-graph:${contextGraphId}/_meta`;
const ctx = { kind: 'sync', id: 'durable-sync-budget-test', startedAt: 0 } as OperationContext;

function requesterFixture(index: number): {
  data: Quad;
  metadata: Quad[];
  assertionGraph: string;
} {
  const ual = `did:dkg:otp:2043/0x1111111111111111111111111111111111111111/${index}`;
  const assertionGraph = `did:dkg:context-graph:${contextGraphId}/_verifiable_memory/${index}`;
  const metadata = [
    ['contentScopeVersion', '"2"'],
    ['kaUal', ual],
    ['assertionVersion', `"${index}"`],
    ['assertionGraph', assertionGraph],
    ['contextGraph', `did:dkg:context-graph:${contextGraphId}`],
    ['merkleRoot', `"${String(index).padStart(64, '0')}"`],
    ['transactionHash', `"0x${index.toString(16).padStart(64, '0')}"`],
  ].map(([predicate, object]) => ({
    subject: ual,
    predicate: `${DKG}${predicate}`,
    object,
    graph: metaGraph,
  }));
  return {
    data: {
      subject: `http://example.com/budget/${index}`,
      predicate: 'http://example.com/value',
      object: `"${index}"`,
      graph: assertionGraph,
    },
    metadata,
    assertionGraph,
  };
}

function requesterPage(phase: 'data' | 'meta', quads: Quad[]): SyncPageResult {
  return {
    quads,
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: quads.length,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
  };
}

function runRequesterBudgetHarness(options: {
  assetCount?: number;
  durableSyncBudget?: DurableSyncBudget;
  createContextGraphSyncDeadline?: (remainingContextGraphs: number) => number;
  storeGraphScopedAsset: (
    asset: VerifiedGraphScopedAsset,
    deadline: number,
  ) => Promise<GraphScopedMaterializationOutcome>;
}) {
  const fixtures = Array.from(
    { length: options.assetCount ?? 1 },
    (_, index) => requesterFixture(index + 1),
  );
  const dataQuads = fixtures.map((fixture) => fixture.data);
  const metadataQuads = fixtures.flatMap((fixture) => fixture.metadata);
  const deadlineConfig = options.durableSyncBudget
    ? { durableSyncBudget: options.durableSyncBudget }
    : { createContextGraphSyncDeadline: options.createContextGraphSyncDeadline! };

  return runDurableSync({
    ctx,
    remotePeerId: 'peer-durable-sync-budget',
    contextGraphIds: [contextGraphId],
    ...deadlineConfig,
    fetchSyncPages: async (_ctx, _peer, _cg, _shared, phase) => (
      phase === 'data'
        ? requesterPage(phase, dataQuads)
        : requesterPage(phase, metadataQuads)
    ),
    processDurableBatchInWorker: async () => ({
      verifiedData: dataQuads,
      verifiedMeta: metadataQuads,
      verifiedGraphScopedDataGraphs: fixtures.map((fixture) => fixture.assertionGraph),
      consumedUnpersistedMetaTriples: 0,
      totalFetchedDataQuads: dataQuads.length,
      totalFetchedMetaQuads: metadataQuads.length,
      rejectedKcs: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    storeInsert: async () => {},
    storeGraphScopedAsset: options.storeGraphScopedAsset,
    deleteCheckpoint: () => {},
    setCheckpoint: () => {},
    logInfo: () => {},
    logWarn: () => {},
    logDebug: () => {},
  });
}

describe('durable sync deadline budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a caller-supplied bounded total budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createContextGraphSyncDeadline.call(
        {} as any,
        1,
        299_000,
      ),
    ).toBe(1_299_000);
  });

  it('clamps untrusted oversized budgets to five minutes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createContextGraphSyncDeadline.call(
        {} as any,
        1,
        900_000,
      ),
    ).toBe(1_300_000);
  });

  it('preserves the two-minute default for normal sync callers', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createContextGraphSyncDeadline.call(
        {} as any,
        1,
      ),
    ).toBe(1_120_000);
  });

  it('uses a caller-supplied bounded graph-scoped authentication budget', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createGraphScopedAuthenticationDeadline.call(
        {} as any,
        299_000,
      ),
    ).toBe(1_299_000);
  });

  it('clamps oversized graph-scoped authentication budgets to five minutes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createGraphScopedAuthenticationDeadline.call(
        {} as any,
        900_000,
      ),
    ).toBe(1_300_000);
  });

  it('preserves the two-minute graph-scoped authentication default', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

    expect(
      LifecycleSyncMethods.prototype.createGraphScopedAuthenticationDeadline.call(
        {} as any,
      ),
    ).toBe(1_120_000);
  });

  it('starts graph-scoped authentication with its fresh provider deadline', async () => {
    const authenticationDeadline = 1_800_000_234_567;
    const storeGraphScopedAsset = vi.fn(async (
      _asset: VerifiedGraphScopedAsset,
      _deadline: number,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    await runRequesterBudgetHarness({
      durableSyncBudget: {
        fetchDeadline: () => 1,
        graphScopedAuthenticationDeadline: () => authenticationDeadline,
      },
      storeGraphScopedAsset,
    });

    expect(storeGraphScopedAsset).toHaveBeenCalledTimes(1);
    expect(storeGraphScopedAsset.mock.calls[0]?.[1]).toBe(authenticationDeadline);
  });

  it('shares one provider authentication deadline across the verified page', async () => {
    const authenticationDeadline = 1_800_000_345_678;
    const graphScopedAuthenticationDeadline = vi.fn(() => authenticationDeadline);
    const storeGraphScopedAsset = vi.fn(async (
      _asset: VerifiedGraphScopedAsset,
      _deadline: number,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    await runRequesterBudgetHarness({
      assetCount: 2,
      durableSyncBudget: {
        fetchDeadline: () => Date.now() + 60_000,
        graphScopedAuthenticationDeadline,
      },
      storeGraphScopedAsset,
    });

    expect(graphScopedAuthenticationDeadline).toHaveBeenCalledTimes(1);
    expect(storeGraphScopedAsset.mock.calls.map((call) => call[1])).toEqual([
      authenticationDeadline,
      authenticationDeadline,
    ]);
  });

  it('preserves the legacy single-deadline callback contract', async () => {
    const deadline = 1_800_000_123_456;
    const createContextGraphSyncDeadline = vi.fn(() => deadline);
    const storeGraphScopedAsset = vi.fn(async (
      _asset: VerifiedGraphScopedAsset,
      _deadline: number,
    ): Promise<GraphScopedMaterializationOutcome> => 'applied');

    await runRequesterBudgetHarness({
      createContextGraphSyncDeadline,
      storeGraphScopedAsset,
    });

    expect(createContextGraphSyncDeadline).toHaveBeenCalledOnce();
    expect(createContextGraphSyncDeadline).toHaveBeenCalledWith(1);
    expect(storeGraphScopedAsset).toHaveBeenCalledTimes(1);
    expect(storeGraphScopedAsset.mock.calls[0]?.[1]).toBe(deadline);
  });
});
