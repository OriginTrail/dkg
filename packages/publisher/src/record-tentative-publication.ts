// SPDX-License-Identifier: Apache-2.0


import { isAgentRegistryContextGraph, type Logger } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import { generateGraphKnowledgeAssetMetadata, generateTentativeMetadata, replaceLocallyTrustedKnowledgeAssetControls } from './metadata.js';
import type { PreparedLocalPublication, PreparedPublicationContent } from './prepared-publication.js';

type TentativePublicationRecording = Pick<PreparedPublicationContent, 'payload' | 'target' | 'execution' | 'ctx'>;

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
  const { privateRoots, kcMerkleRoot, effectiveAccessPolicy, normalizedAllowedPeers, kaMetadata,
    allSkolemizedQuads, publisherPeerId: normalizedPublisherPeerId } = recording.payload;
  const { graphPublish, dataGraph, contextGraphId, subGraphName, targetMetaGraphUri } = recording.target;
  const { ctx } = recording;
  const authorAddress = recording.execution.precomputedAttestation?.authorAddress;
  const normalizedQuads = allSkolemizedQuads.map(quad => ({ ...quad, graph: dataGraph }));
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
