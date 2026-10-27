// SPDX-License-Identifier: Apache-2.0
import { workspacePublicQuadsDigest } from '@origintrail-official/dkg-publisher';
import type { VerifiedGraphScopedAsset } from './graph-scoped-materialization.js';
import { literalValue, parseSafeCount, optionalHex32 } from './finalized-swm-twin-terms.js';

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

const DKG = 'http://dkg.io/ontology/';

/** Fetched materialization and held-copy proofs feed the same canonical cleanup contract. */
export function commitmentFromVmAsset(asset: VerifiedGraphScopedAsset): FinalizedVmAssetCommitment {
  if (optionalMetadataLiteral(asset, `${DKG}status`) !== 'confirmed') {
    throw new Error('Authenticated VM metadata is not confirmed');
  }
  return {
    contextGraphId: asset.contextGraphId, ual: asset.ual, assertionVersion: asset.assertionVersion,
    assertionGraph: asset.assertionGraph, metaGraph: asset.metaGraph,
    subGraphName: optionalMetadataLiteral(asset, `${DKG}subGraphName`),
    publicQuadsDigest: workspacePublicQuadsDigest(asset.dataQuads),
    publicTripleCount: requiredMetadataCount(asset, `${DKG}publicTripleCount`),
    privateTripleCount: requiredMetadataCount(asset, `${DKG}privateTripleCount`),
    privateMerkleRoot: optionalMetadataHex32(asset, `${DKG}privateMerkleRoot`),
    merkleRootHex: requiredMetadataHex32(asset, `${DKG}merkleRoot`),
  };
}

function metadataObjects(asset: VerifiedGraphScopedAsset, predicate: string): string[] {
  return asset.metadataQuads
    .filter((quad) => (
      quad.graph === asset.metaGraph
      && quad.subject === asset.ual
      && quad.predicate === predicate
    ))
    .map((quad) => quad.object);
}

function optionalMetadataLiteral(
  asset: VerifiedGraphScopedAsset,
  predicate: string,
): string | undefined {
  const values = metadataObjects(asset, predicate);
  if (values.length > 1) throw new Error(`Authenticated VM metadata has ambiguous ${predicate}`);
  return values[0] === undefined ? undefined : literalValue(values[0]);
}

function requiredMetadataCount(asset: VerifiedGraphScopedAsset, predicate: string): number {
  const values = metadataObjects(asset, predicate);
  if (values.length !== 1) throw new Error(`Authenticated VM metadata has non-unique ${predicate}`);
  const value = parseSafeCount(values[0]);
  if (value === null) throw new Error(`Authenticated VM metadata has invalid ${predicate}`);
  return value;
}

function optionalMetadataHex32(
  asset: VerifiedGraphScopedAsset,
  predicate: string,
): string | undefined {
  const values = metadataObjects(asset, predicate);
  if (values.length > 1) throw new Error(`Authenticated VM metadata has ambiguous ${predicate}`);
  return optionalHex32(values[0]);
}

function requiredMetadataHex32(asset: VerifiedGraphScopedAsset, predicate: string): string {
  const value = optionalMetadataHex32(asset, predicate);
  if (value === undefined) throw new Error(`Authenticated VM metadata has invalid ${predicate}`);
  return value;
}
