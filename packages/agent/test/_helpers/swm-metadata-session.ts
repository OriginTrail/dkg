import type { Quad } from '@origintrail-official/dkg-storage';
import type { SharedMemoryMetadataFetcher } from '../../src/sync/requester/shared-memory-sync.js';
import type { SwmTargetExecutorPortsV1 } from '../../src/sync/requester/swm-target-executor.js';

/**
 * Public targets take a metadata session. These read one whole page per round,
 * which is all a fixture that serves its metadata at once needs.
 */
export function directSwmMetadataSession(fetchSyncPages: SwmTargetExecutorPortsV1['fetchSyncPages']): SharedMemoryMetadataFetcher {
  return {
    fetch: async ({ ctx, remotePeerId, contextGraphId, graphUri, deadline, workAdmission }) => ({
      result: await fetchSyncPages(ctx, remotePeerId, contextGraphId, true, 'meta', graphUri, deadline, { workAdmission }),
      continuationYielded: false,
    }),
    release: () => undefined,
  };
}

export function servedSwmMetadataSession(meta: readonly Quad[]): SharedMemoryMetadataFetcher {
  return {
    fetch: async () => ({
      result: {
        quads: meta.map((quad) => ({ ...quad })),
        bytesReceived: 0,
        resumedFromOffset: 0,
        nextOffset: meta.length,
        checkpointKey: 'served:meta',
        completed: true,
        timedOut: false,
      },
      continuationYielded: false,
    }),
    release: () => undefined,
  };
}
