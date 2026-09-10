import { emitSwmRecord } from '@origintrail-official/dkg-publisher';
import { admitSharedMemoryMetadata } from '../src/sync/shared-memory-metadata-admission.js';

admitSharedMemoryMetadata([], { kind: 'allGraphs' });
admitSharedMemoryMetadata([], { kind: 'context', contextGraphId: 'cg', registeredSubGraphNames: new Set() });
// @ts-expect-error Context scope must state its admitted named subgraphs.
admitSharedMemoryMetadata([], { kind: 'context', contextGraphId: 'cg' });
// @ts-expect-error A registration list cannot be silently ignored in broad mode.
admitSharedMemoryMetadata([], { kind: 'allGraphs', registeredSubGraphNames: new Set(['code']) });
// @ts-expect-error Root controls do not belong to graph-scoped head records.
emitSwmRecord('headV2', 'head', 'graph', { rootEntity: 'urn:root' });
