import type {
  PublicSnapshotMetadata,
  SharedMemoryMetadataFetcher,
  SharedMemoryMetadataFetchRequest,
  SharedMemorySnapshotWalkContinuation,
  SharedMemorySyncContext,
  SharedMemorySyncMode,
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

type CanonicalSharedMemorySyncMode =
  | Extract<SharedMemorySyncMode, { kind: 'ordinary' }>
  | Omit<Extract<SharedMemorySyncMode, { kind: 'selected-recovery' }>, 'metadataFetcher'>;

export type CanonicalSharedMemoryFetcherContext<T extends MetadataFetcherInput> =
  Omit<T, 'mode' | 'metadataFetcher'> & {
    mode: CanonicalSharedMemorySyncMode;
    metadataFetcher: SharedMemoryMetadataFetcher | undefined;
  };

/** Consume the released nested layout once, before entering requester algorithms. */
export function normalizeSharedMemoryFetcherContext<T extends MetadataFetcherInput>(
  input: T,
): CanonicalSharedMemoryFetcherContext<T> {
  const metadataFetcher = selectSharedMemoryMetadataFetcher(input);
  const { mode: originalMode, metadataFetcher: _metadataFetcher, ...context } = input;
  const mode = originalMode.kind === 'selected-recovery'
    ? (({ metadataFetcher: _legacy, ...canonical }) => canonical)(originalMode)
    : originalMode;
  return { ...context, mode, metadataFetcher };
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
  return completeSharedMemoryMetadataFetcher(selectSharedMemoryMetadataFetcher(input), fetchDirect);
}

/** Complete the canonical port without consulting compatibility layouts. */
export function completeSharedMemoryMetadataFetcher(
  fetcher: SharedMemoryMetadataFetcher | undefined,
  fetchDirect: (request: SharedMemoryMetadataFetchRequest) => Promise<SyncPageResult>,
): NormalizedSharedMemoryMetadataFetcher {
  const selected: SharedMemoryMetadataFetcher = fetcher ?? {
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
