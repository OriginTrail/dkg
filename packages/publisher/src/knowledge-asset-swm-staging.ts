import {
  createGraphKnowledgeAssetScope,
  isSwmMerkleExcludedQuad,
} from '@origintrail-official/dkg-core';
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
import { toHex } from './metadata.js';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from './workspace-resolution.js';
import { workspacePublicQuadsDigest } from './workspace-snapshot-store.js';
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
  /** Validate and reuse an already-promoted queued intent without restaging it. */
  readonly reuseExistingOperation?: true;
}

export interface StagedKnowledgeAssetSharedWorkingMemoryV1 {
  readonly contextGraphId: string;
  readonly shareOperationId: string;
  readonly kaUal: string;
  readonly assertionVersion: string;
  readonly subGraphName?: string;
  readonly swmGraph: string;
  readonly tripleCount: number;
  /** Exact immutable public operation snapshot consumed by this reference. */
  readonly publicQuadsDigest: string;
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
    const publicQuads = input.quads.filter((quad) => !isSwmMerkleExcludedQuad(quad));
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
    const publicQuadsDigest = workspacePublicQuadsDigest(publicQuads);
    if (input.reuseExistingOperation) {
      // A queued UPDATE already owns durable operation bytes and an access
      // envelope. Rewriting either would invalidate its retry intent or restore
      // stale work over a newer promotion. Validate under the writer lock and
      // leave every graph, operation row and original timestamp untouched.
      const head = await resolveKnowledgeAssetWorkspaceHead({
        store: input.store,
        graphManager,
        contextGraphId: input.contextGraphId,
        kaUal: scope.ual,
        subGraphName: input.subGraphName,
      });
      const normalizePeers = (peers: readonly string[] = []): string => JSON.stringify(
        [...new Set(peers.map((peer) => peer.trim()).filter(Boolean))].sort(),
      );
      const privateMerkleRoot = input.privateMerkleRoot === undefined
        ? undefined
        : `0x${toHex(input.privateMerkleRoot)}`;
      const stale = (): Error & { code: 'PUBLISH_INTENT_STALE' } => Object.assign(
        new Error(`Queued SWM operation ${input.shareOperationId} no longer matches its immutable intent`),
        { code: 'PUBLISH_INTENT_STALE' as const },
      );
      if (
        !head
        || head.shareOperationId !== input.shareOperationId
        || head.assertionVersion !== scope.assertionVersion
        || head.publicQuadsDigest !== publicQuadsDigest
        || head.publicTripleCount !== publicQuads.length
        || head.privateTripleCount !== (input.privateTripleCount ?? 0)
        || head.privateMerkleRoot?.toLowerCase() !== privateMerkleRoot
        || head.publisherPeerId !== input.publisherPeerId?.trim()
        || input.accessPolicy === undefined
        || head.accessPolicy !== input.accessPolicy
        || normalizePeers(head.allowedPeers) !== normalizePeers(input.allowedPeers)
      ) {
        throw stale();
      }
      // The resolver checks stored bytes against their recorded digest/count.
      // Let operational read failures propagate; they are not evidence of drift.
      const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
        store: input.store,
        graphManager,
        contextGraphId: input.contextGraphId,
        shareOperationId: input.shareOperationId,
        kaUal: scope.ual,
        assertionVersion: scope.assertionVersion,
        subGraphName: input.subGraphName,
        publicSnapshotStore: input.publicSnapshotStore,
      });
      if (
        snapshot.publicQuadsDigest !== publicQuadsDigest
        || snapshot.quads.length !== publicQuads.length
        || snapshot.publisherPeerId !== head.publisherPeerId
      ) {
        throw stale();
      }
      return Object.freeze({
        contextGraphId: input.contextGraphId,
        shareOperationId: input.shareOperationId,
        kaUal: scope.ual,
        assertionVersion: scope.assertionVersion,
        ...(input.subGraphName === undefined ? {} : { subGraphName: input.subGraphName }),
        swmGraph,
        tripleCount: publicQuads.length,
        publicQuadsDigest,
      });
    }
    const priorSwmGraphs = await resolveSharedMemoryScopeGraphs(
      input.store,
      swmBucket,
      sharedMemoryScope,
    );
    const replaced = await tryReplaceGraphAtomically(
      input.store,
      swmGraph,
      publicQuads.map((quad) => ({ ...quad, graph: swmGraph })),
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
      quads: publicQuads,
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
      tripleCount: publicQuads.length,
      publicQuadsDigest,
    });
  });
}
