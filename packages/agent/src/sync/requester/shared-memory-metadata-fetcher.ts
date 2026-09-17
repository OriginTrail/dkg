import type {
  PublicSnapshotMetadata,
  SharedMemoryMetadataFetcher,
  SharedMemoryMetadataFetchRequest,
  SharedMemorySnapshotWalkContinuation,
  SharedMemorySyncContext,
} from './shared-memory-sync.js';
import type { SyncPageResult } from './page-fetch.js';

type MetadataFetcherInput = Pick<SharedMemorySyncContext, 'mode' | 'metadataFetcher'>;

/** Resolve current and deprecated selected layouts before admitting any work. */
export function selectSharedMemoryMetadataFetcher(
  input: MetadataFetcherInput,
): SharedMemoryMetadataFetcher | undefined {
  const legacy = input.mode.kind === 'selected-recovery'
    ? input.mode.metadataFetcher
    : undefined;
  if (input.metadataFetcher && legacy && input.metadataFetcher !== legacy) {
    throw new TypeError(
      'Conflicting shared-memory metadata fetchers at context and selected-mode boundaries',
    );
  }
  return input.metadataFetcher ?? legacy;
}

interface NormalizedSharedMemoryMetadataFetcher {
  fetch: SharedMemoryMetadataFetcher['fetch'];
  release: SharedMemoryMetadataFetcher['release'];
  snapshotWalk(
    contextGraphId: string,
    orderedManifest: readonly PublicSnapshotMetadata[],
  ): SharedMemorySnapshotWalkContinuation | undefined;
}

/** Give the requester one complete strategy, including direct-page callers. */
export function normalizeSharedMemoryMetadataFetcher(
  input: MetadataFetcherInput,
  fetchDirect: (request: SharedMemoryMetadataFetchRequest) => Promise<SyncPageResult>,
): NormalizedSharedMemoryMetadataFetcher {
  const selected: SharedMemoryMetadataFetcher = selectSharedMemoryMetadataFetcher(input) ?? {
    fetch: async (request: SharedMemoryMetadataFetchRequest) => ({
      result: await fetchDirect(request),
      continuationYielded: false,
    }),
    release: () => {},
  };
  // Retained strategies may store state on their receiver.
  return {
    fetch: request => selected.fetch(request),
    release: contextGraphId => selected.release(contextGraphId),
    snapshotWalk: (contextGraphId, manifest) => selected.snapshotWalk?.(
      contextGraphId,
      manifest,
    ),
  };
}
