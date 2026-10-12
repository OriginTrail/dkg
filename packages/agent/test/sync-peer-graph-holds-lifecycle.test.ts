import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockedFetchParams = {
  remotePeerId: string;
  contextGraphId: string;
  includeSharedMemory: boolean;
  phase: string;
  assetUals?: string[];
};

const fetchSyncPagesMock = vi.hoisted(() => vi.fn<(params: MockedFetchParams) => Promise<unknown>>());

vi.mock('../src/sync/requester/page-fetch.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/sync/requester/page-fetch.js')>(),
  fetchSyncPages: fetchSyncPagesMock,
}));

import { createOperationContext } from '@origintrail-official/dkg-core';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { formatSyncNotServable } from '../src/sync/not-servable.js';
import { syncPeerGraphHoldsFor } from '../src/sync/requester/peer-graph-holds.js';

/**
 * The requester side of "this graph cannot be served by that peer": the graph
 * is asked for once, the refusal is reported, and until the hold ends the peer
 * is asked for its other graphs only. The round stays incomplete, so nothing
 * reads the held graph as synced.
 */

const ctx = createOperationContext('sync');
const PEER = '12D3KooWHoldsLifecycleResponderAAAAAAAA';

/** A clean, empty phase: a graph with nothing to send completes its round. */
function page(contextGraphId: string, phase: string) {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `${contextGraphId}:${phase}`,
    completed: true,
    timedOut: false,
  };
}

function lifecycleAgent() {
  const warnings: string[] = [];
  const debug: string[] = [];
  const agent = {
    config: { syncContextGraphPriorities: {} },
    node: { stopSignal: new AbortController().signal },
    messenger: { sendToPeer: vi.fn(async () => new Uint8Array()) },
    buildSyncRequest: vi.fn(),
    getOrCreateSyncVerifyWorker: () => ({ parseAndFilter: vi.fn() }),
    createContextGraphSyncDeadline: () => Date.now() + 1_000,
    createGraphScopedAuthenticationDeadline: () => Date.now() + 1_000,
    // The real page-fetch wrapper, over the mocked wire fetch above.
    fetchSyncPages: LifecycleSyncMethods.prototype.fetchSyncPages,
    processDurableBatchInWorker: async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    insertSyncedQuadsAndInvalidateListCache: async () => {},
    syncCheckpoints: new Map(),
    runLegacyDurableSyncForContextGraph: LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph,
    runContextGraphSyncWithBackpressure: async (
      _ctx: unknown,
      _contextGraphId: string,
      _lane: string,
      _label: string,
      work: () => Promise<unknown>,
    ) => work(),
    log: {
      info: () => {},
      warn: (_ctx: unknown, message: string) => { warnings.push(message); },
      debug: (_ctx: unknown, message: string) => { debug.push(message); },
    },
  };
  return { agent, warnings, debug };
}

function runRound(agent: object, contextGraphIds: string[], options?: Record<string, unknown>) {
  return (LifecycleSyncMethods.prototype.runLegacyDurableSync as (...args: unknown[]) => Promise<{
    complete?: boolean;
    completedPhases?: number;
    failedPeers?: number;
    backoffWorthyFailures?: number;
  }>).call(agent, ctx, PEER, contextGraphIds, undefined, undefined, undefined, options);
}

function askedFor(): string[] {
  return [...new Set(fetchSyncPagesMock.mock.calls.map(([params]) => params.contextGraphId))];
}

describe('a graph a peer cannot serve is held for that peer', () => {
  beforeEach(() => {
    fetchSyncPagesMock.mockReset();
    fetchSyncPagesMock.mockImplementation(async ({ contextGraphId, phase }) => {
      if (contextGraphId === 'big') throw new Error(formatSyncNotServable('store-deadline', 10 * 60_000));
      return page(contextGraphId, phase);
    });
  });

  it('asks once, reports the hold, and then asks only for the other graphs', async () => {
    const { agent, warnings, debug } = lifecycleAgent();

    const first = await runRound(agent, ['big', 'small']);
    expect(askedFor()).toEqual(['big', 'small']);
    expect(first.complete).toBe(false);
    expect(first.backoffWorthyFailures).toBe(1);
    const reports = warnings.filter((message) => message.includes('is not syncable from peer'));
    expect(reports).toHaveLength(1);
    // The hold is the base period, lengthened by up to a fifth.
    expect(reports[0]).toMatch(new RegExp(
      `^Context graph "big" is not syncable from peer ${PEER.slice(-8)} right now `
      + '\\(store-deadline, 1 in a row\\); asking again in about 1[0-2] min$',
    ));
    expect(syncPeerGraphHoldsFor(agent).heldAmong(PEER, ['big', 'small'])).toEqual(['big']);

    fetchSyncPagesMock.mockClear();
    const second = await runRound(agent, ['big', 'small']);
    // The held graph is not asked for again; the other one syncs as before.
    expect(askedFor()).toEqual(['small']);
    expect(second.completedPhases).toBeGreaterThan(0);
    expect(second.failedPeers).toBe(0);
    expect(second.backoffWorthyFailures).toBe(0);
    // It stays owed: the round is not complete, so nothing reads it as synced.
    expect(second.complete).toBe(false);
    expect(debug.some((message) => message.includes('1 held Context Graph(s): big'))).toBe(true);
    // No second report while the hold is in force.
    expect(warnings.filter((message) => message.includes('is not syncable from peer'))).toHaveLength(1);
  });

  it('reports nothing complete when every graph asked for is held', async () => {
    const { agent } = lifecycleAgent();
    await runRound(agent, ['big']);
    fetchSyncPagesMock.mockClear();
    const round = await runRound(agent, ['big']);
    expect(fetchSyncPagesMock).not.toHaveBeenCalled();
    expect(round.complete).toBe(false);
    expect(round.failedPeers).toBe(0);
  });

  it('completes a round with no held graph, and asks again once the graph was served', async () => {
    const { agent } = lifecycleAgent();
    const clean = await runRound(agent, ['small']);
    expect(clean.complete).toBe(true);

    await runRound(agent, ['big']);
    expect(syncPeerGraphHoldsFor(agent).heldAmong(PEER, ['big'])).toEqual(['big']);
    // The peer serves the graph again: a completed data phase clears the hold.
    fetchSyncPagesMock.mockImplementation(async ({ contextGraphId, phase }) => page(contextGraphId, phase));
    await (LifecycleSyncMethods.prototype.fetchSyncPages as (...args: unknown[]) => Promise<unknown>).call(
      agent, ctx, PEER, 'big', false, 'data', 'did:dkg:context-graph:big', Date.now() + 1_000,
    );
    expect(syncPeerGraphHoldsFor(agent).snapshot()).toEqual([]);

    fetchSyncPagesMock.mockClear();
    const served = await runRound(agent, ['big']);
    expect(askedFor()).toEqual(['big']);
    expect(served.complete).toBe(true);
  });

  it('does not hold on shared-memory or exact-asset fetches', async () => {
    const { agent, warnings } = lifecycleAgent();
    const fetch = (includeSharedMemory: boolean, options?: Record<string, unknown>) => (
      LifecycleSyncMethods.prototype.fetchSyncPages as (...args: unknown[]) => Promise<unknown>
    ).call(agent, ctx, PEER, 'big', includeSharedMemory, 'meta', 'did:dkg:context-graph:big/_meta', Date.now() + 1_000, options);

    await expect(fetch(true)).rejects.toThrow(/request not servable/);
    await expect(fetch(false, {
      assetUals: ['did:dkg:base:84532/0x0000000000000000000000000000000000000001/7'],
    })).rejects.toThrow(/request not servable/);
    await expect(fetch(false, { recovery: true })).rejects.toThrow(/request not servable/);
    expect(syncPeerGraphHoldsFor(agent).snapshot()).toEqual([]);
    expect(warnings).toEqual([]);

    await expect(fetch(false)).rejects.toThrow(/request not servable/);
    expect(syncPeerGraphHoldsFor(agent).heldAmong(PEER, ['big'])).toEqual(['big']);
  });
});
