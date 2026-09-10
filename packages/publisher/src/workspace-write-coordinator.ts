import type { TripleStore } from '@origintrail-official/dkg-storage';
import { swmKaWriteLockKey, withKeyedLocks } from './keyed-lock.js';

export interface WorkspaceWriteCoordinateV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string;
  readonly kaUal: string;
}

/** Canonical per-store lock capability for graph-scoped workspace writes. */
export interface WorkspaceWriteCoordinator {
  withKnowledgeAsset<T>(
    coordinate: Readonly<WorkspaceWriteCoordinateV1>,
    work: () => Promise<T>,
  ): Promise<T>;
}

interface StoreWorkspaceWriteDomain {
  readonly locks: Map<string, Promise<void>>;
  readonly coordinator: WorkspaceWriteCoordinator;
}

const STORE_WORKSPACE_WRITES = new WeakMap<TripleStore, StoreWorkspaceWriteDomain>();

function workspaceWriteDomainForStore(
  store: TripleStore,
  suppliedLocks?: Map<string, Promise<void>>,
): StoreWorkspaceWriteDomain {
  const existing = STORE_WORKSPACE_WRITES.get(store);
  if (existing) {
    if (suppliedLocks && suppliedLocks !== existing.locks) {
      throw new Error(
        'Components sharing one TripleStore must share its workspace write coordinator',
      );
    }
    return existing;
  }
  const locks = suppliedLocks ?? new Map<string, Promise<void>>();
  const coordinator: WorkspaceWriteCoordinator = Object.freeze({
    withKnowledgeAsset: <T>(
      coordinate: Readonly<WorkspaceWriteCoordinateV1>,
      work: () => Promise<T>,
    ) => withKeyedLocks(
      locks,
      [swmKaWriteLockKey(
        coordinate.contextGraphId,
        coordinate.subGraphName,
        coordinate.kaUal,
      )],
      work,
    ),
  });
  const created = Object.freeze({ locks, coordinator });
  STORE_WORKSPACE_WRITES.set(store, created);
  return created;
}

/** Resolve the one workspace-write coordinator owned by a TripleStore instance. */
export function workspaceWriteCoordinatorForStore(
  store: TripleStore,
): WorkspaceWriteCoordinator {
  return workspaceWriteDomainForStore(store).coordinator;
}

/** Internal compatibility seam for DKGPublisher's wider multi-key lock API. */
export function workspaceWriteLocksForStore(
  store: TripleStore,
  suppliedLocks?: Map<string, Promise<void>>,
): Map<string, Promise<void>> {
  return workspaceWriteDomainForStore(store, suppliedLocks).locks;
}
