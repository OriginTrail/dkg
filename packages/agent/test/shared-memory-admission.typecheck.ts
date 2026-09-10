import { projectStrictSwmRecovery } from '../src/sync/shared-memory-metadata-projections.js';
import { admitSharedMemoryMetadata } from '../src/sync/shared-memory-metadata-admission.js';

admitSharedMemoryMetadata([], { kind: 'allGraphs' });
admitSharedMemoryMetadata([], { kind: 'context', contextGraphId: 'cg', registeredSubGraphNames: new Set() });
// @ts-expect-error Context scope must state its admitted named subgraphs.
admitSharedMemoryMetadata([], { kind: 'context', contextGraphId: 'cg' });
// @ts-expect-error A registration list cannot be silently ignored in broad mode.
admitSharedMemoryMetadata([], { kind: 'allGraphs', registeredSubGraphNames: new Set(['code']) });
// @ts-expect-error Strict recovery requires an explicitly bound context scope.
projectStrictSwmRecovery(admitSharedMemoryMetadata([], { kind: 'allGraphs' }));
projectStrictSwmRecovery(admitSharedMemoryMetadata([], {
  kind: 'context', contextGraphId: 'cg', registeredSubGraphNames: new Set(),
}));
