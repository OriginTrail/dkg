import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { toSyncTransportFailureError } from '../src/sync/error-tags.js';
import { formatSyncNotServable } from '../src/sync/not-servable.js';
import {
  syncPeerGraphHoldsFor,
  SyncPeerGraphHeldError,
  SYNC_PEER_GRAPH_HOLD_BASE_MS,
} from '../src/sync/requester/peer-graph-holds.js';

/**
 * The requester side of "this graph cannot be served by that peer": the fetch
 * is sent once, the refusal is reported, and until the hold ends it is not sent
 * again by any caller, while the peer's other graphs sync as before. The round
 * stays incomplete, so nothing reads the held graph as synced.
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
    failedPhases?: number;
    backoffWorthyFailures?: number;
  }>).call(agent, ctx, PEER, contextGraphIds, undefined, undefined, undefined, options);
}

function fetchPages(agent: object, phase: string, includeSharedMemory = false, options?: Record<string, unknown>) {
  const graphUri = phase === 'meta' ? 'did:dkg:context-graph:big/_meta' : 'did:dkg:context-graph:big';
  return (LifecycleSyncMethods.prototype.fetchSyncPages as (...args: unknown[]) => Promise<unknown>).call(
    agent, ctx, PEER, 'big', includeSharedMemory, phase, graphUri, Date.now() + 1_000, options,
  );
}

/** The reports of a new or longer hold; the round's own failure line quotes them. */
function holdReports(warnings: string[]): string[] {
  return warnings.filter((message) => message.startsWith('Context graph "big"'));
}

function askedFor(): string[] {
  return [...new Set(fetchSyncPagesMock.mock.calls.map(([params]) => params.contextGraphId))];
}

describe('a graph a peer cannot serve is held for that peer', () => {
  const refuse = () => {
    fetchSyncPagesMock.mockImplementation(async ({ contextGraphId, phase }) => {
      if (contextGraphId === 'big' && phase === 'meta') {
        // As the transport hands it up: the peer's reply to a request that was sent.
        throw toSyncTransportFailureError(new Error(formatSyncNotServable('store-deadline', 10 * 60_000)));
      }
      return page(contextGraphId, phase);
    });
  };
  const serve = () => {
    fetchSyncPagesMock.mockImplementation(async ({ contextGraphId, phase }) => page(contextGraphId, phase));
  };

  beforeEach(() => {
    fetchSyncPagesMock.mockReset();
    refuse();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the fetch once, reports the hold, and then syncs only the other graphs', async () => {
    const { agent, warnings } = lifecycleAgent();

    const first = await runRound(agent, ['big', 'small']);
    expect(askedFor()).toEqual(['big', 'small']);
    expect(first.complete).toBe(false);
    expect(first.backoffWorthyFailures).toBe(1);
    const reports = holdReports(warnings);
    expect(reports).toHaveLength(1);
    // The hold is the base period, lengthened by up to a fifth.
    expect(reports[0]).toMatch(new RegExp(
      `^Context graph "big" \\(meta\\) is not syncable from peer ${PEER.slice(-8)} right now `
      + '\\(store-deadline, 1 in a row\\); asking again in about 1[0-2] min$',
    ));
    expect(syncPeerGraphHoldsFor(agent).current(PEER, 'big', 'meta')).toMatchObject({ refusals: 1 });

    fetchSyncPagesMock.mockClear();
    const second = await runRound(agent, ['big', 'small']);
    // Nothing is sent for the held graph; the other one syncs as before.
    expect(askedFor()).toEqual(['small']);
    expect(second.completedPhases).toBeGreaterThan(0);
    // The peer is not treated as failing, and is not backed off as a whole.
    expect(second.failedPeers).toBe(0);
    expect(second.backoffWorthyFailures).toBe(0);
    // The graph stays owed: a failed phase and an incomplete round.
    expect(second.failedPhases).toBe(1);
    expect(second.complete).toBe(false);
    // No second report while the hold is in force.
    expect(holdReports(warnings)).toHaveLength(1);
  });

  it('reports nothing complete when the only graph asked for is held', async () => {
    const { agent } = lifecycleAgent();
    await runRound(agent, ['big']);
    fetchSyncPagesMock.mockClear();
    const round = await runRound(agent, ['big']);
    expect(fetchSyncPagesMock).not.toHaveBeenCalled();
    expect(round.complete).toBe(false);
    expect(round.failedPeers).toBe(0);
    expect(round.failedPhases).toBe(1);
  });

  it('gives each of two concurrent rounds its own verdict', async () => {
    const { agent } = lifecycleAgent();
    await runRound(agent, ['big']);
    // A round that does not want the held graph, and one that does.
    const [without, withHeld] = await Promise.all([
      runRound(agent, ['small']),
      runRound(agent, ['big', 'small']),
    ]);
    expect(without.complete).toBe(true);
    expect(withHeld.complete).toBe(false);
  });

  it('covers every caller of the page fetch, and only the fetch that was refused', async () => {
    const { agent } = lifecycleAgent();
    await runRound(agent, ['big']);
    fetchSyncPagesMock.mockClear();

    // A caller that goes straight to the page fetch is not sent either.
    const held = await fetchPages(agent, 'meta').catch((error: unknown) => error);
    expect(held).toBeInstanceOf(SyncPeerGraphHeldError);
    expect(fetchSyncPagesMock).not.toHaveBeenCalled();

    // The data walk of the same graph was not refused: it is still sent.
    await expect(fetchPages(agent, 'data')).resolves.toMatchObject({ completed: true });
    expect(fetchSyncPagesMock).toHaveBeenCalledTimes(1);
    // Its completion says nothing about the metadata walk.
    expect(syncPeerGraphHoldsFor(agent).current(PEER, 'big', 'meta')).toBeDefined();
  });

  it('sends the fetch again when the hold ends: a longer hold if refused, none once served', async () => {
    const { agent, warnings } = lifecycleAgent();
    // The holds read the clock they were created with, so it is replaced first.
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => startedAt);
    await runRound(agent, ['big']);

    // Past the first hold (base period plus at most a fifth).
    clock.mockImplementation(() => startedAt + 1.25 * SYNC_PEER_GRAPH_HOLD_BASE_MS);
    fetchSyncPagesMock.mockClear();
    const refusedAgain = await runRound(agent, ['big']);
    expect(askedFor()).toEqual(['big']);
    expect(refusedAgain.complete).toBe(false);
    expect(holdReports(warnings)).toHaveLength(2);
    expect(holdReports(warnings)[1]).toMatch(/\(store-deadline, 2 in a row\); asking again in about 2[0-4] min$/);

    // Past the second hold the peer serves the walk: the hold is gone.
    clock.mockImplementation(() => startedAt + 4 * SYNC_PEER_GRAPH_HOLD_BASE_MS);
    serve();
    fetchSyncPagesMock.mockClear();
    const served = await runRound(agent, ['big']);
    expect(askedFor()).toEqual(['big']);
    expect(served.complete).toBe(true);
    expect(syncPeerGraphHoldsFor(agent).snapshot()).toEqual([]);
  });

  it('does not hold on shared-memory, exact-asset or recovery fetches', async () => {
    const { agent, warnings } = lifecycleAgent();
    await expect(fetchPages(agent, 'meta', true)).rejects.toThrow(/request not servable/);
    await expect(fetchPages(agent, 'meta', false, {
      assetUals: ['did:dkg:base:84532/0x0000000000000000000000000000000000000001/7'],
    })).rejects.toThrow(/request not servable/);
    await expect(fetchPages(agent, 'meta', false, { recovery: true })).rejects.toThrow(/request not servable/);
    expect(syncPeerGraphHoldsFor(agent).snapshot()).toEqual([]);
    expect(warnings).toEqual([]);

    await expect(fetchPages(agent, 'meta')).rejects.toThrow(/request not servable/);
    expect(syncPeerGraphHoldsFor(agent).current(PEER, 'big', 'meta')).toBeDefined();
    // Those fetches are not held by it either: they are still sent.
    fetchSyncPagesMock.mockClear();
    await expect(fetchPages(agent, 'meta', true)).rejects.toThrow(/request not servable/);
    expect(fetchSyncPagesMock).toHaveBeenCalledTimes(1);
  });
});
