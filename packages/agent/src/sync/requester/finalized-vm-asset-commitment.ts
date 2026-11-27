// SPDX-License-Identifier: Apache-2.0
import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import { parseGraphScopedDescriptor, type GraphScopedDescriptor } from '../durable-integrity.js';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';
import { literalValue } from './finalized-swm-twin-literals.js';

/** Compact verified content plus confirmed VM metadata; no payload survives the proof read. */
export interface FinalizedVmAssetCommitment {
  readonly contextGraphId: string;
  readonly ual: string;
  readonly assertionVersion: bigint;
  readonly assertionGraph: string;
  readonly metaGraph: string;
  readonly subGraphName?: string;
  readonly publicQuadsDigest: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly merkleRootHex: string;
}

/** Both paths retain the same normalized descriptor and compact public-content digest. */
export function commitmentFromDescriptor(
  descriptor: GraphScopedDescriptor, publicQuadsDigest: string,
): FinalizedVmAssetCommitment {
  return {
    contextGraphId: descriptor.contextGraphId, ual: descriptor.ual,
    assertionVersion: BigInt(descriptor.assertionVersion), assertionGraph: descriptor.assertionGraph,
    metaGraph: contextGraphMetaUri(descriptor.contextGraphId), subGraphName: descriptor.subGraphName,
    publicQuadsDigest, publicTripleCount: descriptor.publicTripleCount,
    privateTripleCount: descriptor.privateTripleCount, privateMerkleRoot: descriptor.privateRootHex,
    merkleRootHex: descriptor.claimedRootHex,
  };
}

/** Confirmation is an admission decision, separate from canonical structural decoding. */
export function commitmentFromVmAsset(asset: VerifiedGraphScopedAsset): FinalizedVmAssetCommitment {
  const rows = asset.metadataQuads.filter(quad => quad.subject === asset.ual);
  const statuses = rows.filter(quad => quad.predicate === 'http://dkg.io/ontology/status');
  if (statuses.length !== 1 || literalValue(statuses[0]!.object) !== 'confirmed') {
    throw new Error('Authenticated VM metadata is not confirmed');
  }
  return commitmentFromDescriptor(parseGraphScopedDescriptor(asset.ual, rows),
    workspacePublicQuadsDigest(asset.dataQuads));
}
