import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { SYNC_REQUEST_PAGE_SIZE } from '../src/dkg-agent-constants.js';
import { MemorySyncCheckpointStore, getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import type { GraphScopedDurableManifestPlan } from '../src/sync/durable-integrity.js';
import {
  createDurableDataRoundBoundary,
  DEFAULT_DURABLE_DATA_ROUND_BUDGET,
  manifestHasCheckpointableGraph,
} from '../src/sync/requester/durable-data-round.js';
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
  return {
    contextGraphId: CG_ID,
    manifestDigest: DIGEST,
    descriptors: Array.from({ length: graphCount }, (_, index) => ({
      assertionGraph: graphOf(index),
      publicTripleCount: rowsPerGraph,
    })),
    manifestRowCount: graphCount * rowsPerGraph,
  } as unknown as GraphScopedDurableManifestPlan;
}

function progress(
  resumedFromOffset: number,
  nextOffset: number,
  acceptedQuads = nextOffset - resumedFromOffset,
  acceptedHeapBytesEstimate = 0,
): SyncPageProgress {
  return { resumedFromOffset, nextOffset, acceptedQuads, acceptedHeapBytesEstimate };
}

const SMALL_BUDGET = { softRows: 10, softHeapBytes: 1_000, maxRows: 30, maxHeapBytes: 3_000 };

/**
 * A responder for one rootless snapshot: DATA row `i` belongs to graph
 * `floor(i / rowsPerGraph)`, served in pages of the requested size. Rows are
 * built only when a page is asked for, so a test of a multi-million-row graph
 * costs only the pages the requester fetches.
 */
function syntheticResponder(manifest: GraphScopedDurableManifestPlan, rowsPerGraph: number) {
  const requests: Array<{ offset: number; limit: number }> = [];
  const encoder = new TextEncoder();
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
        lines.push(`${row}\t${graphOf(Math.floor(row / rowsPerGraph))}`);
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
  it('needs a graph boundary strictly inside the round to keep a checkpoint', () => {
    const manifest = syntheticManifest(3, 4);
    expect(manifestHasCheckpointableGraph(manifest, 0, 3)).toBe(false);
    // An incomplete round never checkpoints a final graph ending at its stop offset.
    expect(manifestHasCheckpointableGraph(manifest, 0, 4)).toBe(false);
    expect(manifestHasCheckpointableGraph(manifest, 0, 5)).toBe(true);
    expect(manifestHasCheckpointableGraph(manifest, 0, 8)).toBe(true);
    expect(manifestHasCheckpointableGraph(manifest, 4, 8)).toBe(false);
    expect(manifestHasCheckpointableGraph(manifest, 4, 9)).toBe(true);
    expect(manifestHasCheckpointableGraph(manifest, 8, 12)).toBe(false);
    // Rows past the manifest's last graph, or no graphs at all, hold nothing to keep.
    expect(manifestHasCheckpointableGraph(manifest, 12, 20)).toBe(false);
    expect(manifestHasCheckpointableGraph(syntheticManifest(0, 4), 0, 4)).toBe(false);
    // Zero-public descriptors add no boundary of their own.
    const withEmpty = {
      ...manifest,
      descriptors: [{ assertionGraph: graphOf(9), publicTripleCount: 0 }, ...manifest.descriptors],
    } as unknown as GraphScopedDurableManifestPlan;
    expect(manifestHasCheckpointableGraph(withEmpty, 0, 4)).toBe(false);
    expect(manifestHasCheckpointableGraph(withEmpty, 0, 5)).toBe(true);
  });

  it('stops at a checkpointable graph once a soft row or heap limit is reached', () => {
    const manifest = syntheticManifest(10, 4);
    const stop = createDurableDataRoundBoundary({ manifest, budget: SMALL_BUDGET });
    expect(stop(progress(0, 9, 9))).toBe(false);
    expect(stop(progress(0, 10, 10))).toBe(true);
    // A soft limit inside the round's only graph waits for the next boundary.
    expect(stop(progress(8, 12, 10))).toBe(false);
    expect(stop(progress(8, 13, 10))).toBe(true);
    // The heap estimate ends a round of a few large rows the same way.
    expect(stop(progress(0, 6, 6, 999))).toBe(false);
    expect(stop(progress(0, 6, 6, 1_000))).toBe(true);
  });

  it('keeps the soft deadline of a recovery slice', () => {
    const manifest = syntheticManifest(10, 4);
    let now = 1_000;
    const stop = createDurableDataRoundBoundary({
      manifest,
      budget: SMALL_BUDGET,
      settlementSliceDeadline: 2_000,
      now: () => now,
    });
    expect(stop(progress(0, 6, 6))).toBe(false);
    now = 2_000;
    expect(stop(progress(0, 6, 6))).toBe(true);
    expect(stop(progress(0, 4, 4))).toBe(false);
  });

  it('ends a round at the hard limit even without a checkpointable graph', () => {
    const manifest = syntheticManifest(2, 100);
    const onHardLimit = vi.fn();
    const stop = createDurableDataRoundBoundary({ manifest, budget: SMALL_BUDGET, onHardLimit });
    expect(stop(progress(0, 29, 29))).toBe(false);
    expect(onHardLimit).not.toHaveBeenCalled();
    expect(stop(progress(0, 30, 30))).toBe(true);
    expect(stop(progress(0, 12, 12, 3_000))).toBe(true);
    expect(onHardLimit.mock.calls).toEqual([[progress(0, 30, 30)], [progress(0, 12, 12, 3_000)]]);
  });

  it('fits the largest legal asset and one page between its soft and hard limits', () => {
    const budget = DEFAULT_DURABLE_DATA_ROUND_BUDGET;
    const largestAssetRows = 100_000;
    expect(budget.softRows + largestAssetRows + SYNC_REQUEST_PAGE_SIZE).toBeLessThan(budget.maxRows);
    expect(budget.softHeapBytes + 4 * 1024 * 1024 + largestAssetRows * 160 + 6 * 1024 * 1024)
      .toBeLessThan(budget.maxHeapBytes);
  });

  it('ends a round of a multi-million-row graph at a checkpointable graph within its budget', async () => {
    // 565 assets of about 11,000 public rows each.
    const rowsPerGraph = 11_287;
    const manifest = syntheticManifest(565, rowsPerGraph);
    expect(manifest.manifestRowCount).toBeGreaterThan(6_000_000);
    const responder = syntheticResponder(manifest, rowsPerGraph);
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
    expect(manifestHasCheckpointableGraph(manifest, 0, last.nextOffset)).toBe(true);
    expect(observed.slice(0, -1).every((page) => !boundary(page))).toBe(true);
    expect(responder.requests.at(-1)!.offset + responder.requests.at(-1)!.limit)
      .toBeLessThan(manifest.manifestRowCount);
  });

  it('primes a fresh responder session to a proven boundary whose token is gone', async () => {
    const rowsPerGraph = 5;
    const manifest = syntheticManifest(6, rowsPerGraph);
    const responder = syntheticResponder(manifest, rowsPerGraph);
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
