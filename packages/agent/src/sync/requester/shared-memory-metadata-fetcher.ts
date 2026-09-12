import type {
  PublicSnapshotMetadata,
  SharedMemoryMetadataFetcher,
  SharedMemoryMetadataFetchRequest,
  SharedMemorySnapshotWalkContinuation,
  SharedMemorySyncContext,
} from './shared-memory-sync.js';
import type { SyncPageResult } from './page-fetch.js';

type MetadataFetcherInput = Pick<SharedMemorySyncContext, 'mode' | 'metadataFetcher'>;

/** Resolve the current and deprecated selected layouts before any work is admitted. */
export function selectSharedMemoryMetadataFetcher(input: MetadataFetcherInput): SharedMemoryMetadataFetcher | undefined {
  const legacy = input.mode.kind === 'selected-recovery' ? input.mode.metadataFetcher : undefined;
  if (input.metadataFetcher && legacy && input.metadataFetcher !== legacy) {
    throw new TypeError('Conflicting shared-memory metadata fetchers at context and selected-mode boundaries');
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

/** The requester consumes one complete strategy, including direct low-level callers. */
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
  } satisfies SharedMemoryMetadataFetcher;
  // Delegate methods on their original receiver; retained strategies may own
  // state on class prototypes rather than enumerable object properties.
  return {
    fetch: request => selected.fetch(request),
    release: contextGraphId => selected.release(contextGraphId),
    snapshotWalk: (contextGraphId, manifest) => selected.snapshotWalk?.(contextGraphId, manifest),
  };
}
