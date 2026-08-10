import { describe, expect, it } from 'vitest';
import {
  exactAssetFilterKey,
  MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
} from '../src/sync/exact-assets.js';
import {
  getSyncCheckpointKey,
  MemorySyncCheckpointStore,
} from '../src/sync/checkpoint/state.js';
import {
  deleteSyncPageCheckpoint,
  fetchSyncPages,
} from '../src/sync/requester/page-fetch.js';
import { estimateQuadHeapBytes } from '../src/sync/memory-telemetry.js';

const EXACT_UAL = 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7';
const encoder = new TextEncoder();
type FetchParams = Parameters<typeof fetchSyncPages>[0];

function fetchParams(overrides: Partial<FetchParams> = {}): FetchParams {
  return {
    ctx: { operationId: 'test', operationName: 'sync' },
    remotePeerId: 'legacy-peer',
    contextGraphId: 'large-legacy-cg',
    includeSharedMemory: false,
    phase: 'data',
    graphUri: 'urn:data',
    deadline: Date.now() + 10_000,
    syncPageTimeoutMs: 1_000,
    syncRouterAttempts: 1,
    syncPageRetryAttempts: 1,
    syncPageSize: 8_192,
    syncDeniedResponse: 'denied',
    debugSyncProgress: false,
    protocolSync: '/dkg/test/sync',
    checkpointStore: new MemorySyncCheckpointStore(),
    assetUals: [EXACT_UAL],
    maxAcceptedBytes: 1_000,
    maxAcceptedQuads: 100,
    buildSyncRequest: async () => encoder.encode('request'),
    parseAndFilter: async () => ({ quads: [], totalQuads: 0 }),
    send: async () => new Uint8Array(),
    logWarn: () => {},
    logInfo: () => {},
    logDebug: () => {},
    ...overrides,
  };
}

describe('exact sync accumulation limits', () => {
  it('rejects excess wire bytes before parsing and clears resumable state', async () => {
    const firstPage = encoder.encode('page-one');
    const secondPage = encoder.encode('page-two');
    const checkpointStore = new MemorySyncCheckpointStore();
    const checkpointKey = getSyncCheckpointKey(
      'legacy-peer',
      'large-legacy-cg',
      false,
      'data',
      undefined,
      undefined,
      undefined,
      exactAssetFilterKey([EXACT_UAL]),
    );
    checkpointStore.set(checkpointKey, 7);
    checkpointStore.setResponderSession?.(
      checkpointKey,
      'legacy-session',
      Date.now() + 60_000,
    );
    const requestedOffsets: number[] = [];
    let sends = 0;
    let parses = 0;

    await expect(fetchSyncPages(fetchParams({
      checkpointStore,
      maxAcceptedBytes: firstPage.byteLength,
      buildSyncRequest: async (_contextGraphId, offset) => {
        requestedOffsets.push(offset);
        return encoder.encode('request');
      },
      parseAndFilter: async () => {
        parses += 1;
        return {
          quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:data' }],
          totalQuads: 1,
        };
      },
      send: async () => {
        sends += 1;
        return sends === 1 ? firstPage : secondPage;
      },
    }))).rejects.toMatchObject({
      code: 'SYNC_PAGE_ACCUMULATION_LIMIT',
      dimension: 'bytes',
      actual: firstPage.byteLength + secondPage.byteLength,
      limit: firstPage.byteLength,
    });

    expect(requestedOffsets[0]).toBe(7);
    expect(sends).toBe(2);
    expect(parses).toBe(1);
    expect(checkpointStore.get(checkpointKey)).toBeUndefined();

    const retry = await fetchSyncPages(fetchParams({
      checkpointStore,
      send: async () => new Uint8Array(),
    }));
    expect(retry.resumedFromOffset).toBe(0);
    expect(retry.responderSessionStartedFresh).toBe(true);
  });

  it('rejects excess parsed quads before retaining another legacy page', async () => {
    let sends = 0;
    let parses = 0;

    await expect(fetchSyncPages(fetchParams({
      phase: 'meta',
      graphUri: 'urn:meta',
      maxAcceptedQuads: 1,
      parseAndFilter: async () => {
        parses += 1;
        return {
          quads: [{ subject: `urn:s:${parses}`, predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
          totalQuads: 1,
        };
      },
      send: async () => {
        sends += 1;
        return encoder.encode(`page-${sends}`);
      },
    }))).rejects.toMatchObject({
      code: 'SYNC_PAGE_ACCUMULATION_LIMIT',
      dimension: 'quads',
      actual: 2,
      limit: 1,
    });

    expect(sends).toBe(2);
    expect(parses).toBe(2);
  });

  it('tags a fresh scoped metadata accumulation error at the real requester boundary', async () => {
    const requesterScope = 'selected-swm-meta:fresh-limit-contract' as const;
    let sends = 0;
    let parses = 0;

    await expect(fetchSyncPages(fetchParams({
      includeSharedMemory: true,
      phase: 'meta',
      graphUri: 'urn:meta',
      requesterScope,
      assetUals: undefined,
      maxAcceptedBytes: undefined,
      maxAcceptedQuads: 1,
      parseAndFilter: async () => {
        parses += 1;
        return {
          quads: [{
            subject: `urn:fresh:${parses}`,
            predicate: 'urn:p',
            object: '"o"',
            graph: 'urn:meta',
          }],
          totalQuads: 1,
        };
      },
      send: async () => {
        sends += 1;
        return encoder.encode(`page-${sends}`);
      },
    }))).rejects.toMatchObject({
      code: 'SYNC_PAGE_ACCUMULATION_LIMIT',
      dimension: 'quads',
      responderSessionStartedFresh: true,
    });

    expect(sends).toBe(2);
    expect(parses).toBe(2);
  });

  it('deletes the process-local responder token for a completed scoped requester', async () => {
    const checkpointStore = new MemorySyncCheckpointStore();
    const requesterScope = 'selected-swm-meta:cleanup-test' as const;
    const checkpointKey = getSyncCheckpointKey(
      'legacy-peer',
      'large-legacy-cg',
      true,
      'meta',
      undefined,
      undefined,
      undefined,
      undefined,
      requesterScope,
    );
    let sends = 0;
    await fetchSyncPages(fetchParams({
      checkpointStore,
      includeSharedMemory: true,
      phase: 'meta',
      graphUri: 'urn:meta',
      requesterScope,
      assetUals: undefined,
      maxAcceptedBytes: undefined,
      maxAcceptedQuads: undefined,
      parseAndFilter: async () => ({
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:meta' }],
        totalQuads: 1,
      }),
      send: async () => {
        sends += 1;
        return sends === 1 ? encoder.encode('page') : new Uint8Array();
      },
    }));

    expect(checkpointStore.get(checkpointKey)?.responderSessionId).toBeTruthy();
    deleteSyncPageCheckpoint(checkpointStore, checkpointKey);
    // Recreate only an offset. If the compatibility cache leaked the scoped
    // token, this fetch would incorrectly report a resumed responder session.
    checkpointStore.set(checkpointKey, 7);
    const retry = await fetchSyncPages(fetchParams({
      checkpointStore,
      includeSharedMemory: true,
      phase: 'meta',
      graphUri: 'urn:meta',
      requesterScope,
      assetUals: undefined,
      maxAcceptedBytes: undefined,
      maxAcceptedQuads: undefined,
      send: async () => new Uint8Array(),
    }));
    expect(retry.responderSessionStartedFresh).toBe(true);
    expect(retry.resumedFromOffset).toBe(0);
  });

  it('rejects a multi-page heap estimate before appending the excess page', async () => {
    const quad = {
      subject: 'urn:heap:s:0',
      predicate: 'urn:heap:p',
      object: '"heap"',
      graph: 'urn:meta',
    };
    const onePageHeap = estimateQuadHeapBytes(quad);
    let sends = 0;
    let parses = 0;

    await expect(fetchSyncPages(fetchParams({
      phase: 'meta',
      graphUri: 'urn:meta',
      maxAcceptedQuads: undefined,
      maxAcceptedHeapBytesEstimate: onePageHeap,
      parseAndFilter: async () => {
        parses += 1;
        return {
          quads: [{ ...quad, subject: `${quad.subject.slice(0, -1)}${parses}` }],
          totalQuads: 1,
        };
      },
      send: async () => {
        sends += 1;
        return encoder.encode(`page-${sends}`);
      },
    }))).rejects.toMatchObject({
      code: 'SYNC_PAGE_ACCUMULATION_LIMIT',
      dimension: 'heap-bytes',
      actual: onePageHeap * 2,
      limit: onePageHeap,
    });

    expect(sends).toBe(2);
    expect(parses).toBe(2);
  });

  it('accepts the exact 4 MiB per-asset boundary and rejects one byte more', async () => {
    const boundaryPage = new Uint8Array(MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET).fill(97);
    let equalitySends = 0;
    const result = await fetchSyncPages(fetchParams({
      remotePeerId: 'compatible-peer',
      contextGraphId: 'bounded-exact-cg',
      maxAcceptedBytes: MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
      maxAcceptedQuads: 1,
      parseAndFilter: async () => ({
        quads: [{ subject: 'urn:s', predicate: 'urn:p', object: '"o"', graph: 'urn:data' }],
        totalQuads: 1,
      }),
      send: async () => {
        equalitySends += 1;
        return equalitySends === 1 ? boundaryPage : new Uint8Array();
      },
    }));

    let overBoundaryParsed = false;
    await expect(fetchSyncPages(fetchParams({
      remotePeerId: 'over-boundary-peer',
      contextGraphId: 'bounded-exact-cg',
      maxAcceptedBytes: MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
      maxAcceptedQuads: 1,
      parseAndFilter: async () => {
        overBoundaryParsed = true;
        return { quads: [], totalQuads: 0 };
      },
      send: async () => new Uint8Array(MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET + 1),
    }))).rejects.toMatchObject({
      code: 'SYNC_PAGE_ACCUMULATION_LIMIT',
      dimension: 'bytes',
      actual: MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET + 1,
      limit: MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET,
    });

    expect(result.completed).toBe(true);
    expect(result.quads).toHaveLength(1);
    expect(result.bytesReceived).toBe(MAX_EXACT_SYNC_PHASE_BYTES_PER_ASSET);
    expect(equalitySends).toBe(2);
    expect(overBoundaryParsed).toBe(false);
  });
});
