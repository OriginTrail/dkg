// SPDX-License-Identifier: Apache-2.0

import {
  assertionLifecycleUri,
  contextGraphMetaUri,
  DKG_ENTITY,
  DKG_ROOT_ENTITY_LEGACY,
  type GraphKnowledgeAssetScope,
} from '@origintrail-official/dkg-core';
import {
  deleteByPatternWithoutCount,
  invalidateSwmMaterializationWitness,
  type GraphManager,
  type Quad,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { generateAssertionPromotedMetadata } from './metadata.js';
import { runPromoteCommittedFinalization } from './promote-replay-safety.js';
import {
  storeKnowledgeAssetOperationPublicQuads,
  storeKnowledgeAssetWorkspaceHead,
} from './workspace-resolution.js';
import type { WorkspacePublicSnapshotStore } from './workspace-snapshot-store.js';

export type PromoteOperationIntent = {
  version: 1;
  operationId: string;
  timestampMs: number;
  publisherPeerId?: string;
  confirmationRequired: boolean;
  accessPolicy: 'public' | 'ownerOnly' | 'allowList';
  allowedPeers: string[];
};

/** Validated exact SWM graph and immutable intent after a successful commit. */
export type CommittedAssertionPromoteContext = Readonly<{
  contextGraphId: string;
  name: string;
  agentAddress: string;
  subGraphName?: string;
  contentScope: GraphKnowledgeAssetScope;
  graphUri: string;
  swmGraphUri: string;
  swmQuads: Quad[];
  promotedPrivateRoot: Uint8Array | undefined;
  privateTripleCount: number;
  operationIntent: PromoteOperationIntent;
}>;

interface AssertionPromoteFinalizationHost {
  readonly store: TripleStore;
  readonly graphManager: GraphManager;
  readonly provenanceEvents: boolean;
  readonly publicSnapshotStore?: WorkspacePublicSnapshotStore;
  /** Remove this assertion's WM graph family while its lifecycle lock is held. */
  dropWorkingMemory(): Promise<void>;
  /** Expose publishability only after every other durable operation succeeds. */
  markComplete(): Promise<void>;
}

/** Idempotent durable tail; no authority, curator, gossip or observer callbacks. */
export async function finalizeCommittedAssertionPromote(
  host: AssertionPromoteFinalizationHost,
  context: CommittedAssertionPromoteContext,
): Promise<void> {
  await runPromoteCommittedFinalization(async () => {
    const {
      contextGraphId, name, agentAddress, subGraphName, contentScope, graphUri,
      swmGraphUri, swmQuads, promotedPrivateRoot, privateTripleCount, operationIntent,
    } = context;
    const promoteMetaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, agentAddress, name, subGraphName);
    const operationId = operationIntent.operationId;
    const operationTimestamp = new Date(operationIntent.timestampMs);
    const { accessPolicy, allowedPeers } = operationIntent;
    // The exact SWM replacement invalidates the witness even when its quad count is unchanged.
    await invalidateSwmMaterializationWitness(host.store, swmGraphUri, {
      source: 'publisher.promoteWmToSwm.witnessInvalidate',
    }).catch(() => {});
    // Retain WM until all durable metadata is complete. The operation intent
    // remains available even after cleanup so empty-WM recovery can validate
    // the exact SWM payload and repair this same operation.

    // Update the assertion's memory layer from WM → SWM in _meta
    const assertionMetaGraph = contextGraphMetaUri(contextGraphId);
    const DKG_MEMORY_LAYER = 'http://dkg.io/ontology/memoryLayer';
    await deleteByPatternWithoutCount(host.store, {
      graph: assertionMetaGraph,
      subject: graphUri,
      predicate: DKG_MEMORY_LAYER,
    });
    await host.store.insert([{
      subject: swmGraphUri,
      predicate: DKG_MEMORY_LAYER,
      object: '"SWM"',
      graph: assertionMetaGraph,
    }]);
    await deleteByPatternWithoutCount(host.store, { graph: promoteMetaGraph, subject: lifecycleSubject, predicate: DKG_ROOT_ENTITY_LEGACY });
    await deleteByPatternWithoutCount(host.store, { graph: promoteMetaGraph, subject: lifecycleSubject, predicate: DKG_ENTITY });

    // Update assertion lifecycle record in _meta: created → promoted
    const promoted = generateAssertionPromotedMetadata({
      contextGraphId,
      agentAddress,
      assertionName: name,
      subGraphName,
      kaNumber: BigInt(contentScope.kaNumber),
      shareOperationId: operationId,
      rootEntities: [],
      timestamp: operationTimestamp,
    }, { provenanceEvents: host.provenanceEvents });
    await host.store.delete(promoted.delete);
    await host.store.insert(promoted.insert);

    await storeKnowledgeAssetOperationPublicQuads({
      store: host.store,
      graphManager: host.graphManager,
      contextGraphId,
      shareOperationId: operationId,
      kaUal: contentScope.ual,
      assertionVersion: contentScope.assertionVersion,
      quads: swmQuads,
      ...(promotedPrivateRoot ? { privateMerkleRoot: promotedPrivateRoot } : {}),
      privateTripleCount,
      publisherPeerId: operationIntent.publisherPeerId,
      accessPolicy,
      allowedPeers,
      agentAddress: contentScope.agentAddress,
      subGraphName,
      timestamp: operationTimestamp,
      publicSnapshotStore: host.publicSnapshotStore,
    });
    // The originator does not receive its own GossipSub message, so it must
    // persist the same monotonic KA head the receiver writes. Without this,
    // a delayed older peer replay could look like the first version locally
    // and replace the freshly promoted graph.
    await storeKnowledgeAssetWorkspaceHead({
      store: host.store,
      graphManager: host.graphManager,
      contextGraphId,
      shareOperationId: operationId,
      kaUal: contentScope.ual,
      assertionVersion: contentScope.assertionVersion,
      subGraphName,
    });

    // Keep the immutable intent after WM cleanup: an empty-WM retry validates
    // the exact SWM payload and repairs the same operation, timestamp and policy.
    await host.dropWorkingMemory();

    // Publishability is the final durable write, including successful WM cleanup.
    // A proven non-started cleanup/marker write can retry only while this marker
    // is absent; no fallible work remains after it becomes visible.
    await host.markComplete();
  });
}
