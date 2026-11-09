import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SYNC_REQUEST_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import { MemorySyncCheckpointStore, getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import type { GraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import {
  createDurableDataRoundBoundary,
  DEFAULT_DURABLE_DATA_ROUND_BUDGET,
  manifestGraphsAfter,
} from '../src/sync/requester/durable-data-round.js';
import { planBoundedGraphScopedDurableBatch } from '../src/sync/durable-integrity.js';
import { estimateQuadHeapBytes } from '../src/sync/memory-telemetry.js';
import { fetchSyncPages, type SyncPageProgress } from '../src/sync/requester/page-fetch.js';

const CG_ID = 'durable-round-cg';
const PEER = '12D3KooWDurableRoundPeer';
const DIGEST = `sha256:${'ab'.repeat(32)}` as const;
const PREFIX = `sha256:${'cd'.repeat(32)}` as const;

function graphOf(index: number): string {
  return `did:dkg:context-graph:${CG_ID}/assertion/${String(index).padStart(6, '0')}`;
}

/** A rootless manifest of `graphCount` graphs with `rowsPerGraph` public rows each. */
function syntheticManifest(graphCount: number, rowsPerGraph: number): GraphScopedDurableManifestPlan {
  return manifestOfSizes(Array.from({ length: graphCount }, () => rowsPerGraph));
}

/** A rootless manifest whose graphs have the given public row counts, in order. */
function manifestOfSizes(rowCounts: readonly number[]): GraphScopedDurableManifestPlan {
  return {
    contextGraphId: CG_ID,
    manifestDigest: DIGEST,
    descriptors: rowCounts.map((publicTripleCount, index) => ({
      assertionGraph: graphOf(index),
      publicTripleCount,
    })),
    manifestRowCount: rowCounts.reduce((total, count) => total + count, 0),
  } as unknown as GraphScopedDurableManifestPlan;
}

/** `count` retained rows of graph `index`, each with a literal of `literalLength` characters. */
function rowsOf(index: number, count: number, literalLength = 1): Quad[] {
  return Array.from({ length: count }, (_, row) => ({
    subject: `urn:durable-round:${index}:${row}`,
    predicate: 'urn:durable-round:value',
    object: `"${'v'.repeat(literalLength)}"`,
    graph: graphOf(index),
  }));
}

/**
 * Feed one round's pages to its boundary. Each page retains `quads` and moves
 * the responder's raw offset past them and past `filtered` rows it dropped.
 */
function roundOf(stop: (progress: SyncPageProgress) => boolean, resumedFromOffset = 0) {
  let nextOffset = resumedFromOffset;
  let acceptedQuads = 0;
  let acceptedHeapBytesEstimate = 0;
  return (quads: Quad[], filtered = 0): boolean => {
    nextOffset += quads.length + filtered;
    acceptedQuads += quads.length;
    acceptedHeapBytesEstimate += quads.reduce((total, quad) => total + estimateQuadHeapBytes(quad), 0);
    return stop({ resumedFromOffset, nextOffset, acceptedQuads, acceptedHeapBytesEstimate, pageQuads: quads });
  };
}

const ROW_BUDGET = { softRows: 10, softHeapBytes: 1e12, maxRows: 30, maxHeapBytes: 1e12 };
const HEAP_BUDGET = { softRows: 1e12, softHeapBytes: 1_000, maxRows: 1e12, maxHeapBytes: 3_000 };

/**
 * A responder for one rootless snapshot: DATA row `i` belongs to the manifest
 * graph whose range holds it, served in pages of the requested size. Rows are
 * built only when a page is asked for, so a test of a multi-million-row graph
 * costs only the pages the requester fetches.
 */
function syntheticResponder(manifest: GraphScopedDurableManifestPlan) {
  const requests: Array<{ offset: number; limit: number }> = [];
  const encoder = new TextEncoder();
  const graphEnds: number[] = [];
  for (const descriptor of manifest.descriptors) {
    graphEnds.push((graphEnds.at(-1) ?? 0) + descriptor.publicTripleCount);
  }
  let graphIndex = 0;
  const graphOfRow = (row: number): string => {
    while (graphEnds[graphIndex]! <= row) graphIndex += 1;
    while (graphIndex > 0 && graphEnds[graphIndex - 1]! > row) graphIndex -= 1;
    return manifest.descriptors[graphIndex]!.assertionGraph;
  };
  return {
    requests,
    buildSyncRequest: async (_cg: string, offset: number, limit: number) => (
      encoder.encode(JSON.stringify({ offset, limit }))
    ),
    send: async (_peer: string, _protocol: string, data: Uint8Array) => {
      const { offset, limit } = JSON.parse(new TextDecoder().decode(data)) as { offset: number; limit: number };
      requests.push({ offset, limit });
      const end = Math.min(manifest.manifestRowCount, offset + limit);
      const lines: string[] = [];
      for (let row = offset; row < end; row += 1) {
        lines.push(`${row}\t${graphOfRow(row)}`);
      }
      return encoder.encode(lines.join('\n'));
    },
    parseAndFilter: async (text: string) => {
      const quads: Quad[] = text.split('\n').map((line) => {
        const [row, graph] = line.split('\t');
        return {
          subject: `urn:durable-round:subject:${row}`,
          predicate: 'urn:durable-round:value',
          object: `"synthetic literal value of row ${row}"`,
          graph: graph!,
        };
      });
      return { quads, totalQuads: quads.length };
    },
  };
}

function dataFetchParams(
  responder: ReturnType<typeof syntheticResponder>,
  overrides: Partial<Parameters<typeof fetchSyncPages>[0]> = {},
): Parameters<typeof fetchSyncPages>[0] {
  return {
    ctx: { kind: 'system', id: 'durable-round-test', startedAt: Date.now() } as unknown as OperationContext,
    remotePeerId: `${PEER}-default`,
    contextGraphId: CG_ID,
    includeSharedMemory: false,
    phase: 'data',
    graphUri: `did:dkg:context-graph:${CG_ID}`,
    deadline: Date.now() + 60_000,
    syncPageTimeoutMs: 5_000,
    syncRouterAttempts: 1,
    syncPageRetryAttempts: 1,
    syncPageSize: SYNC_REQUEST_PAGE_SIZE,
    syncDeniedResponse: '#DENIED',
    debugSyncProgress: false,
    protocolSync: '/dkg/test/sync',
    checkpointStore: new MemorySyncCheckpointStore(),
    buildSyncRequest: responder.buildSyncRequest,
    parseAndFilter: responder.parseAndFilter,
    send: responder.send,
    logWarn: () => {},
    logInfo: () => {},
    logDebug: () => {},
    ...overrides,
  };
}

describe('full-graph durable data round boundary', () => {
  it('keeps reading until the round holds a graph it can checkpoint, then stops at a soft limit', () => {
    const page = roundOf(createDurableDataRoundBoundary({ manifest: syntheticManifest(10, 4), budget: ROW_BUDGET }));
    expect(page(rowsOf(0, 3))).toBe(false);
    expect(page(rowsOf(0, 1))).toBe(false);
    // Ten rows: the soft limit, with two whole graphs.
    expect(page([...rowsOf(1, 4), ...rowsOf(2, 2)])).toBe(true);
  });

  it('never stops at the end of the only whole graph, which an incomplete round replays', () => {
    const budget = { ...ROW_BUDGET, softRows: 4 };
    const page = roundOf(createDurableDataRoundBoundary({ manifest: syntheticManifest(3, 4), budget }));
    expect(page(rowsOf(0, 4))).toBe(false);
    expect(page(rowsOf(1, 1))).toBe(true);
  });

  it('counts the rows a round retains, not the raw responder offset, when rows are filtered', () => {
    const onHardLimit = vi.fn();
    const page = roundOf(createDurableDataRoundBoundary({
      manifest: manifestOfSizes([300, 10]), budget: ROW_BUDGET, onHardLimit,
    }));
    // 30 filtered rows and 280 rows of the first graph: the raw offset (310) is past
    // that graph's end, but the graph is not whole yet.
    expect(page(rowsOf(0, 280), 30)).toBe(false);
    expect(page(rowsOf(0, 20))).toBe(true);
    expect(onHardLimit).not.toHaveBeenCalled();
  });

  it('reads a first graph larger than the hard limits whole, and stops just past it', () => {
    const onHardLimit = vi.fn();
    const page = roundOf(createDurableDataRoundBoundary({
      manifest: manifestOfSizes([100, 4, 4]), budget: ROW_BUDGET, onHardLimit,
    }));
    // Inside its first graph a round reads on past every limit: that graph is its allowance.
    expect(page(rowsOf(0, 50))).toBe(false);
    expect(page(rowsOf(0, 50))).toBe(false);
    expect(page(rowsOf(1, 1))).toBe(true);
    // A resumed round starts at a verified graph boundary: its first graph is the one starting there.
    const resumed = roundOf(createDurableDataRoundBoundary({
      manifest: manifestOfSizes([4, 100, 4]), budget: ROW_BUDGET, onHardLimit,
    }), 4);
    expect(resumed(rowsOf(1, 60))).toBe(false);
    expect(resumed(rowsOf(1, 40))).toBe(false);
    expect(resumed(rowsOf(2, 1))).toBe(true);
    // The same holds for the heap estimate of a few very large rows.
    const heavy = roundOf(createDurableDataRoundBoundary({
      manifest: manifestOfSizes([3, 1, 1]), budget: HEAP_BUDGET, onHardLimit,
    }));
    expect(heavy(rowsOf(0, 2, 20_000))).toBe(false);
    expect(heavy(rowsOf(0, 1, 20_000))).toBe(false);
    expect(heavy(rowsOf(1, 1))).toBe(true);
    expect(onHardLimit).not.toHaveBeenCalled();
  });

  it('keeps the soft deadline of a recovery slice', () => {
    let now = 1_000;
    const boundary = () => createDurableDataRoundBoundary({
      manifest: syntheticManifest(10, 4), budget: ROW_BUDGET, settlementSliceDeadline: 2_000, now: () => now,
    });
    const page = roundOf(boundary());
    expect(page([...rowsOf(0, 4), ...rowsOf(1, 1)])).toBe(false);
    now = 2_000;
    expect(page(rowsOf(1, 1))).toBe(true);
    // A round with no whole graph reads on past the deadline.
    expect(roundOf(boundary())(rowsOf(0, 3))).toBe(false);
  });

  it('ends a round at the hard limit for rows outside its first graph\'s allowance', () => {
    const onHardLimit = vi.fn();
    const boundary = () => createDurableDataRoundBoundary({ manifest: manifestOfSizes([100, 50, 50]), budget: ROW_BUDGET, onHardLimit });
    // More rows of the first graph than it declares.
    expect(roundOf(boundary())(rowsOf(0, 101))).toBe(true);
    // Rows of later graphs while the first is still incomplete: graphs come in manifest
    // order, so the responder lacks the rest of the first graph.
    const gap = roundOf(boundary());
    expect(gap([...rowsOf(0, 5), ...rowsOf(1, 29)])).toBe(false);
    expect(gap(rowsOf(1, 1))).toBe(true);
    // Read to the end of the phase, such a round would still keep nothing.
    const wholePhase = [...rowsOf(0, 5), ...rowsOf(1, 50), ...rowsOf(2, 50)];
    expect(planBoundedGraphScopedDurableBatch(
      wholePhase, manifestOfSizes([100, 50, 50]), 0, wholePhase.length, true,
    )?.completedGraphCount ?? 0).toBe(0);
    // Rows past the manifest's end.
    const pastEnd = roundOf(boundary(), 200);
    expect(pastEnd(rowsOf(7, 29))).toBe(false);
    expect(pastEnd(rowsOf(7, 1))).toBe(true);
    const heavyPastEnd = roundOf(createDurableDataRoundBoundary({
      manifest: manifestOfSizes([4]), budget: HEAP_BUDGET, onHardLimit,
    }), 4);
    expect(heavyPastEnd(rowsOf(7, 1, 3_000))).toBe(true);
    expect(onHardLimit).toHaveBeenCalledTimes(4);
  });

  it('reads on to the end of the phase once every remaining graph is whole, past filtered rows too', () => {
    const budget = { ...ROW_BUDGET, softRows: 4 };
    // A filtered row before a round's only remaining graph moves the raw offset one past its end.
    expect(roundOf(createDurableDataRoundBoundary({ manifest: manifestOfSizes([100]), budget }))(rowsOf(0, 100), 1))
      .toBe(false);
    // Both remaining graphs whole, with a filtered row between them.
    const both = roundOf(createDurableDataRoundBoundary({ manifest: manifestOfSizes([4, 8]), budget }));
    expect(both(rowsOf(0, 4))).toBe(false);
    expect(both(rowsOf(1, 8), 1)).toBe(false);
    // A resumed round whose only remaining graph is the last one.
    expect(roundOf(createDurableDataRoundBoundary({ manifest: manifestOfSizes([4, 8]), budget }), 4)(rowsOf(1, 8), 1))
      .toBe(false);
    // An incomplete round that stops there anyway keeps the last graph for the next round,
    // whatever the raw offset: no graph starts at the manifest's end to resume from.
    const rows = [...rowsOf(0, 4), ...rowsOf(1, 8)];
    const rawOffsets = [0, 1, 2, 3, ...Array.from({ length: 8 }, (_, index) => 5 + index)];
    expect(planBoundedGraphScopedDurableBatch(rows, manifestOfSizes([4, 8]), 0, 13, false, 0, rawOffsets))
      .toMatchObject({ safeNextOffset: 4, safeRawNextOffset: 4, completedGraphCount: 1 });
  });

  it('lists the graphs with rows a round reads after its resume offset', () => {
    const manifest = manifestOfSizes([0, 5, 0, 7]);
    expect(manifestGraphsAfter(manifest, 0)).toEqual([{ graph: graphOf(1), rows: 5 }, { graph: graphOf(3), rows: 7 }]);
    expect(manifestGraphsAfter(manifest, 5)).toEqual([{ graph: graphOf(3), rows: 7 }]);
    expect(manifestGraphsAfter(manifest, 12)).toEqual([]);
  });

  it('holds one asset larger than the hard limit whole and checkpoints it, then resumes after it', async () => {
    const budget = DEFAULT_DURABLE_DATA_ROUND_BUDGET;
    // One valid asset of 300,000 public rows (over the 262,144-row hard limit), then small ones.
    const largeRows = 300_000;
    expect(largeRows).toBeGreaterThan(budget.maxRows);
    const manifest = manifestOfSizes([largeRows, 20_000, 20_000, 20_000]);
    const responder = syntheticResponder(manifest);
    const remotePeerId = `${PEER}-large`;
    const checkpointStore = new MemorySyncCheckpointStore();

    const first = await fetchSyncPages(dataFetchParams(responder, {
      remotePeerId,
      checkpointStore,
      manifestDigest: DIGEST,
      manifestPrefixDigestAtOffset: () => PREFIX,
      shouldStopAfterPage: createDurableDataRoundBoundary({ manifest }),
    }));

    // The round read the whole asset and stopped on the next page.
    expect(first.completed).toBe(false);
    expect(first.quads.length).toBeGreaterThan(largeRows);
    expect(first.quads.length).toBeLessThanOrEqual(largeRows + SYNC_REQUEST_PAGE_SIZE);
    const planned = planBoundedGraphScopedDurableBatch(
      first.quads, manifest, 0, first.nextOffset, false, 0, first.quadRawOffsets,
    );
    expect(planned?.safeNextOffset).toBe(largeRows);
    expect(planned?.completedGraphCount).toBe(1);

    // Fetch has retained the token without advancing its durable cursor.
    expect(checkpointStore.get(first.checkpointKey)).toMatchObject({ offset: 0, responderSessionOffset: 0 });
    // The next round continues after the asset: the durable layer checkpoints its
    // boundary and advances the held responder session to it.
    checkpointStore.setManifestBoundOffset(
      getSyncCheckpointKey(remotePeerId, CG_ID, false, 'data'), largeRows, DIGEST, Date.now(), PREFIX, false, largeRows,
    );
    responder.requests.length = 0;
    const second = await fetchSyncPages(dataFetchParams(responder, {
      remotePeerId,
      checkpointStore,
      manifestDigest: DIGEST,
      manifestPrefixDigestAtOffset: () => PREFIX,
      shouldStopAfterPage: createDurableDataRoundBoundary({ manifest }),
    }));
    expect(second.resumedFromOffset).toBe(largeRows);
    expect(responder.requests[0]!.offset).toBe(largeRows);
    expect(second.completed).toBe(true);
    expect(second.quads.length).toBe(60_000);
  });

  it('ends a round of a multi-million-row graph at a checkpointable graph within its budget', async () => {
    // 565 assets of about 11,000 public rows each.
    const rowsPerGraph = 11_287;
    const manifest = syntheticManifest(565, rowsPerGraph);
    expect(manifest.manifestRowCount).toBeGreaterThan(6_000_000);
    const responder = syntheticResponder(manifest);
    const observed: SyncPageProgress[] = [];
    const boundary = createDurableDataRoundBoundary({ manifest });

    const round = await fetchSyncPages(dataFetchParams(responder, {
      shouldStopAfterPage: (page) => {
        observed.push(page);
        return boundary(page);
      },
    }));

    const budget = DEFAULT_DURABLE_DATA_ROUND_BUDGET;
    const retainedHeap = round.quads.reduce((sum, quad) => sum + estimateQuadHeapBytes(quad), 0);
    expect(round.completed).toBe(false);
    expect(round.timedOut).toBe(false);
    expect(round.quads.length).toBeLessThan(budget.maxRows);
    expect(retainedHeap).toBeLessThan(budget.maxHeapBytes);
    expect(round.quads.length).toBe(observed.at(-1)!.acceptedQuads);
    expect(retainedHeap).toBe(observed.at(-1)!.acceptedHeapBytesEstimate);
    // It ended at the first page past a soft limit that holds a whole graph.
    const last = observed.at(-1)!;
    expect(last.acceptedQuads >= budget.softRows || last.acceptedHeapBytesEstimate >= budget.softHeapBytes).toBe(true);
    const planned = planBoundedGraphScopedDurableBatch(
      round.quads, manifest, 0, round.nextOffset, false, 0, round.quadRawOffsets,
    );
    expect(planned?.completedGraphCount).toBeGreaterThan(0);
    // Replayed page by page, the same boundary decides to stop only on the last page.
    const replay = createDurableDataRoundBoundary({ manifest });
    expect(observed.map((page) => replay(page))).toEqual([...observed.slice(1).map(() => false), true]);
    expect(responder.requests.at(-1)!.offset + responder.requests.at(-1)!.limit)
      .toBeLessThan(manifest.manifestRowCount);
  });

  it.each(['complete', 'bounded', 'transport', 'abort', 'parse'] as const)(
    'retains the verified raw cursor before settlement after %s fetch', async (ending) => {
      const responder = syntheticResponder(syntheticManifest(6, 5));
      const checkpointStore = new MemorySyncCheckpointStore();
      const remotePeerId = `${PEER}-unsettled-${ending}`;
      const key = getSyncCheckpointKey(remotePeerId, CG_ID, false, 'data');
      checkpointStore.setManifestBoundOffset(key, 5, DIGEST, Date.now(), PREFIX);
      checkpointStore.setResponderSession(key, 'stored-session', Date.now() + 60_000,
        Date.now(), DIGEST, PREFIX, 7);
      const controller = new AbortController();
      let calls = 0;
      const pending = fetchSyncPages(dataFetchParams(responder, {
        remotePeerId, checkpointStore, manifestDigest: DIGEST,
        manifestPrefixDigestAtOffset: () => PREFIX, syncPageSize: 5, signal: controller.signal,
        shouldStopAfterPage: ending === 'bounded' ? () => true : undefined,
        send: async (...args) => {
          if (++calls === 2) {
            if (ending === 'transport') throw new Error('stream reset');
            if (ending === 'abort') { controller.abort(new Error('caller cancelled')); throw controller.signal.reason; }
          }
          return responder.send(...args);
        },
        parseAndFilter: async (text) => {
          if (calls === 2 && ending === 'parse') throw new Error('invalid page');
          return responder.parseAndFilter(text);
        },
      }));
      if (ending === 'abort' || ending === 'parse') await expect(pending).rejects.toThrow();
      else {
        const result = await pending;
        expect(result.resumedFromOffset).toBe(5);
        expect(result.rawResumedFromOffset).toBe(7);
        expect(result.rawNextOffset).toBeGreaterThan(7);
        expect(result.completed).toBe(ending === 'complete');
      }
      expect(checkpointStore.get(key)).toMatchObject({ offset: 5, responderSessionOffset: 7,
        manifestDigest: DIGEST, manifestPrefixDigest: PREFIX, responderSessionId: 'stored-session' });
    },
  );

  it('primes a fresh responder session to a proven boundary whose token is gone', async () => {
    const rowsPerGraph = 5;
    const manifest = syntheticManifest(6, rowsPerGraph);
    const responder = syntheticResponder(manifest);
    const checkpointStore = new MemorySyncCheckpointStore();
    const remotePeerId = `${PEER}-prime`;
    const checkpointKey = getSyncCheckpointKey(remotePeerId, CG_ID, false, 'data');
    // A verified boundary of this generation, written without a responder
    // token (an expired session, a restart, or another peer's prefix).
    checkpointStore.setManifestBoundOffset(checkpointKey, 15, DIGEST, Date.now(), PREFIX);
    const info: string[] = [];

    const result = await fetchSyncPages(dataFetchParams(responder, {
      remotePeerId,
      checkpointStore,
      manifestDigest: DIGEST,
      manifestPrefixDigestAtOffset: (offset) => (offset === 15 ? PREFIX : undefined),
      logInfo: (_ctx, message) => { info.push(message); },
    }));

    // One discarded prime page at zero, then the verified boundary onward.
    expect(responder.requests[0]!.offset).toBe(0);
    expect(responder.requests.slice(1).map(({ offset }) => offset)[0]).toBe(15);
    expect(info).toContainEqual(expect.stringContaining('before reusing verified offset 15'));
    expect(result.resumedFromOffset).toBe(15);
    expect(result.completed).toBe(true);
    expect(result.quads.map((quad) => quad.graph)).toEqual(
      Array.from({ length: 15 }, (_, index) => graphOf(3 + Math.floor(index / rowsPerGraph))),
    );
  });
});
