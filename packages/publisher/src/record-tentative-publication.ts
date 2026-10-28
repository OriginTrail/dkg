// SPDX-License-Identifier: Apache-2.0


import {type Logger} from '@origintrail-official/dkg-core';
import type {Quad, TripleStore} from '@origintrail-official/dkg-storage';


import {generateGraphKnowledgeAssetMetadata, generateTentativeMetadata, replaceLocallyTrustedKnowledgeAssetControls} from './metadata.js';



import {isAgentRegistryContextGraph} from '@origintrail-official/dkg-core';







import type { PreparedLocalPublication, GraphScopedPublishDescriptor } from './prepared-publication.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { KAMetadata } from './metadata.js';
import type { PublishOptions } from './publisher.js';

export interface TentativePublicationRecording {
  privateRoots: Uint8Array[]; kcMerkleRoot: Uint8Array;
  effectiveAccessPolicy: 'public' | 'ownerOnly' | 'allowList'; normalizedAllowedPeers: string[];
  kaMetadata: KAMetadata[]; normalizedQuads: Quad[];
  graphPublish: GraphScopedPublishDescriptor | undefined;
  normalizedPublisherPeerId: string; dataGraph: string; contextGraphId: string;
  authorAddress: string | undefined; subGraphName: string | undefined; targetMetaGraphUri: string | undefined;
  ctx: OperationContext; onPhase: PublishOptions['onPhase'];
}

export interface TentativePublicationRecordingPorts {
  chainId: string;
  store: TripleStore;
  log: Logger;
  replaceExactKnowledgeAssetGraph(graphUri: string, quads: readonly Quad[], operation: string): Promise<void>;
  persistFinalizedPrivateSlices(): Promise<void>;
  persistCatalogEntry(): Promise<void>;
}
/** The recording stage owns every local write, including intentional local-only publications. */
export async function recordTentativePublication(outcome: PreparedLocalPublication, recording: TentativePublicationRecording,
  ports: TentativePublicationRecordingPorts): Promise<string> {
  const { privateRoots, kcMerkleRoot, effectiveAccessPolicy, normalizedAllowedPeers, kaMetadata, normalizedQuads,
    graphPublish, normalizedPublisherPeerId, dataGraph, contextGraphId, subGraphName, targetMetaGraphUri, authorAddress, ctx, onPhase } = recording;
  onPhase?.('chain', 'start');
  ports.log.warn(ctx, `Skipping on-chain publish: ${outcome.reason}`);
  const ual = graphPublish?.scope.ual ?? `did:dkg:${ports.chainId}/${outcome.publisherAddress}/t${outcome.publishOperationId}`;
    for (const km of kaMetadata) {
      km.kcUal = ual;
    }
    const commonMeta = {
      ual,
      contextGraphId,
      merkleRoot: kcMerkleRoot,
      publisherPeerId: normalizedPublisherPeerId || 'unknown',
      accessPolicy: effectiveAccessPolicy,
      allowedPeers: normalizedAllowedPeers,
      timestamp: new Date(),
      subGraphName,
      ...(authorAddress === undefined ? {} : { authorAddress }),
    };
    let tentativeMeta = graphPublish
      ? generateGraphKnowledgeAssetMetadata(
          {
            ...commonMeta,
            assertionVersion: graphPublish.scope.assertionVersion,
            publicTripleCount: graphPublish.publicTripleCount,
            privateTripleCount: graphPublish.privateTripleCount,
            ...(privateRoots[0] ? { privateMerkleRoot: privateRoots[0] } : {}),
            assertionGraph: dataGraph,
          },
          { status: 'tentative' },
        )
      : generateTentativeMetadata(commonMeta, kaMetadata);
    if (targetMetaGraphUri) {
      const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
      tentativeMeta = tentativeMeta.map((q) =>
        q.graph === defaultMeta ? { ...q, graph: targetMetaGraphUri! } : q,
      );
    }
    if (graphPublish && !isAgentRegistryContextGraph(contextGraphId)) {
      await replaceLocallyTrustedKnowledgeAssetControls(
        ports.store,
        graphPublish.scope.ual,
        tentativeMeta,
      );
    }
    ports.log.info(ctx, `Storing ${normalizedQuads.length} triples in local store (${outcome.reason})`);
    if (graphPublish) {
      await ports.replaceExactKnowledgeAssetGraph(
        dataGraph,
        normalizedQuads,
        'Graph-scoped local publish',
      );
    } else {
      await ports.store.insert(normalizedQuads);
    }
    await ports.persistFinalizedPrivateSlices();
    if (!isAgentRegistryContextGraph(contextGraphId)) {
      await ports.store.insert(tentativeMeta);
    }
    await ports.persistCatalogEntry();
    return ual;
}
