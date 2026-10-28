// SPDX-License-Identifier: Apache-2.0


import {type Logger} from '@origintrail-official/dkg-core';
import type {Quad, TripleStore} from '@origintrail-official/dkg-storage';


import {generateGraphKnowledgeAssetMetadata, generateTentativeMetadata, replaceLocallyTrustedKnowledgeAssetControls} from './metadata.js';



import {isAgentRegistryContextGraph} from '@origintrail-official/dkg-core';







import type {PreparedPublication} from './prepared-publication.js';
import type {PublicationAcquisition} from './prepared-publication-acquisition.js';

export interface TentativePublicationRecordingPorts {
  store: TripleStore;
  log: Logger;
  replaceExactKnowledgeAssetGraph(graphUri: string, quads: readonly Quad[], operation: string): Promise<void>;
  persistFinalizedPrivateSlices(): Promise<void>;
  persistCatalogEntry(): Promise<void>;
}
/** The recording stage owns every local write, including intentional local-only publications. */
export async function recordTentativePublication(input: PreparedPublication,
  outcome: Extract<PublicationAcquisition, { kind: 'tentative' }>, ports: TentativePublicationRecordingPorts): Promise<void> {
  const { privateRoots, kcMerkleRoot, effectiveAccessPolicy, normalizedAllowedPeers, kaMetadata, normalizedQuads } = input.payload;
  const { graphPublish, normalizedPublisherPeerId, dataGraph, contextGraphId } = input.target;
  const { options, ctx } = input;
  const { publisherSigner } = input;
  const { ual } = outcome;
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
      subGraphName: options.subGraphName,
      ...((options.precomputedAttestation?.authorAddress
        ?? publisherSigner?.address) != null
        ? {
            authorAddress: (options.precomputedAttestation?.authorAddress
              ?? publisherSigner!.address),
          }
        : {}),
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
    if (options.targetMetaGraphUri) {
      const defaultMeta = `did:dkg:context-graph:${contextGraphId}/_meta`;
      tentativeMeta = tentativeMeta.map((q) =>
        q.graph === defaultMeta ? { ...q, graph: options.targetMetaGraphUri! } : q,
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
}
