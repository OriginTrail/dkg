import { createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import {
  GraphManager,
  canonicalSharedMemoryScopeWriteGraph,
  invalidateSwmMaterializationWitness,
  resolveSharedMemoryScopeGraphs,
  tryReplaceGraphAtomically,
  type Quad,
  type SharedMemoryGraphScope,
  type TripleStore,
} from '@origintrail-official/dkg-storage';

import { swmKaWriteLockKey, withKeyedLocks } from './keyed-lock.js';
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from './workspace-resolution.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

export interface StageKnowledgeAssetSharedWorkingMemoryInputV1 {
  readonly contextGraphId: string;
  readonly kaUal: string;
  readonly assertionVersion: string | number | bigint;
  readonly shareOperationId: string;
  readonly quads: readonly Quad[];
  readonly privateMerkleRoot?: Uint8Array;
  readonly privateTripleCount?: number;
  readonly publisherPeerId?: string;
  readonly accessPolicy?: 'public' | 'ownerOnly' | 'allowList';
  readonly allowedPeers?: readonly string[];
  readonly agentAddress?: string;
  readonly subGraphName?: string;
  readonly timestamp?: Date;
}

export interface StagedKnowledgeAssetSharedWorkingMemoryV1 {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
  readonly swmGraph: string;
  readonly tripleCount: number;
}

interface StageKnowledgeAssetSharedWorkingMemoryStorageInputV1
  extends StageKnowledgeAssetSharedWorkingMemoryInputV1 {
  readonly store: TripleStore;
  readonly writeLocks: Map<string, Promise<void>>;
  readonly graphManager: GraphManager;
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
}

/**
 * Stage one complete graph-scoped SWM snapshot under the publisher-owned
 * canonical per-store lock domain. The returned reference names immutable
 * operation bytes, so chain and network work never runs while holding the
 * local storage lock.
 */
export async function stageKnowledgeAssetSharedWorkingMemoryStorageV1(
  input: StageKnowledgeAssetSharedWorkingMemoryStorageInputV1,
): Promise<StagedKnowledgeAssetSharedWorkingMemoryV1> {
  const scope = createGraphKnowledgeAssetScope(input.kaUal, input.assertionVersion);
  const lockKey = swmKaWriteLockKey(
    input.contextGraphId,
    input.subGraphName,
    scope.ual,
  );
  return withKeyedLocks(input.writeLocks, [lockKey], async () => {
    const graphManager = input.graphManager;
    const swmBucket = graphManager.sharedMemoryUri(input.contextGraphId, input.subGraphName);
    const sharedMemoryScope: SharedMemoryGraphScope = {
      kind: 'named-lifecycle',
      identity: {
        agentAddress: scope.agentAddress,
        kaNumber: BigInt(scope.kaNumber),
      },
    };
    const swmGraph = canonicalSharedMemoryScopeWriteGraph(swmBucket, sharedMemoryScope);
    const priorSwmGraphs = await resolveSharedMemoryScopeGraphs(
      input.store,
      swmBucket,
      sharedMemoryScope,
    );
    const replaced = await tryReplaceGraphAtomically(
      input.store,
      swmGraph,
      input.quads.map((quad) => ({ ...quad, graph: swmGraph })),
    );
    await invalidateSwmMaterializationWitness(input.store, swmGraph, {
      source: 'publisher.stageKnowledgeAssetSharedWorkingMemoryV1.witnessInvalidate',
    }).catch(() => {});
    if (!replaced) {
      throw Object.assign(
        new Error(`Graph-scoped update requires atomic SWM replacement at ${swmGraph}`),
        { code: 'ATOMIC_GRAPH_REPLACE_UNSUPPORTED', graphUri: swmGraph },
      );
    }
    for (const graph of priorSwmGraphs) {
      if (graph !== swmGraph) await input.store.dropGraph(graph);
    }
    await storeKnowledgeAssetOperationPublicQuads({
      store: input.store,
      graphManager,
      contextGraphId: input.contextGraphId,
      shareOperationId: input.shareOperationId,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      quads: input.quads,
      ...(input.privateMerkleRoot === undefined
        ? {}
        : { privateMerkleRoot: input.privateMerkleRoot }),
      ...(input.privateTripleCount === undefined
        ? {}
        : { privateTripleCount: input.privateTripleCount }),
      ...(input.publisherPeerId === undefined
        ? {}
        : { publisherPeerId: input.publisherPeerId }),
      ...(input.accessPolicy === undefined ? {} : { accessPolicy: input.accessPolicy }),
      ...(input.allowedPeers === undefined ? {} : { allowedPeers: input.allowedPeers }),
      ...(input.agentAddress === undefined ? {} : { agentAddress: input.agentAddress }),
      ...(input.subGraphName === undefined ? {} : { subGraphName: input.subGraphName }),
      ...(input.timestamp === undefined ? {} : { timestamp: input.timestamp }),
      ...(input.publicSnapshotStore === undefined
        ? {}
        : { publicSnapshotStore: input.publicSnapshotStore }),
    });
    await storeKnowledgeAssetWorkspaceHead({
      store: input.store,
      graphManager,
      contextGraphId: input.contextGraphId,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      shareOperationId: input.shareOperationId,
      ...(input.subGraphName === undefined ? {} : { subGraphName: input.subGraphName }),
    });
    return Object.freeze({
      contextGraphId: input.contextGraphId,
      shareOperationId: input.shareOperationId,
      kaUal: scope.ual,
      assertionVersion: scope.assertionVersion,
      ...(input.subGraphName === undefined ? {} : { subGraphName: input.subGraphName }),
      swmGraph,
      tripleCount: input.quads.length,
    });
  });
}
