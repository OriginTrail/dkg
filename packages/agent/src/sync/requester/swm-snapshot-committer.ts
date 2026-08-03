import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';
import type { SharedMemorySnapshotMaterializer } from './swm-snapshot-materializer.js';

/**
 * Higher-level graph-scoped snapshot transaction boundary.
 *
 * The materializer remains a store adapter. This coordinator owns the
 * post-commit settlement policy that runs only after verified metadata has
 * landed and outside the per-KA materialization lock.
 */
export interface SharedMemorySnapshotCommitter {
  readonly materializer: SharedMemorySnapshotMaterializer;
  settleCommittedSnapshots(
    contextGraphId: string,
    descriptors: readonly GraphScopedSwmRecoveryDescriptor[],
  ): Promise<void>;
}

export function createSharedMemorySnapshotCommitter(deps: {
  materializer: SharedMemorySnapshotMaterializer;
  settleGraphScopedSnapshot: (
    contextGraphId: string,
    descriptor: GraphScopedSwmRecoveryDescriptor,
  ) => Promise<void>;
}): SharedMemorySnapshotCommitter {
  return {
    materializer: deps.materializer,
    settleCommittedSnapshots: async (contextGraphId, descriptors) => {
      for (const descriptor of descriptors) {
        await deps.settleGraphScopedSnapshot(contextGraphId, descriptor);
      }
    },
  };
}
