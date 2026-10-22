import type { Quad } from '@origintrail-official/dkg-storage';
import { hexlify } from 'ethers';
import { parseMetadataBytes32Literal,
  type ConfirmedGraphKnowledgeAssetMetadataEnvelope } from './metadata.js';
import { reconcileSameAssertionGraphKnowledgeAssetMetadataV1 } from './graph-knowledge-asset-metadata.js';

const rootHex = (root: Uint8Array): string => hexlify(root).slice(2).toLowerCase();
/** Validated execution proof contains no mutable byte arrays or RDF parsing ambiguity. */
export interface ConfirmedGraphKnowledgeAssetProof {
  readonly assertionVersion: string;
  readonly publicTripleCount: number;
  readonly privateTripleCount: number;
  readonly privateMerkleRoot?: string;
  readonly assertionGraph: string;
  readonly subGraphName?: string;
  readonly merkleRoot: string;
  readonly batchId: string;
}
export function confirmedGraphKnowledgeAssetProof(envelope: ConfirmedGraphKnowledgeAssetMetadataEnvelope): ConfirmedGraphKnowledgeAssetProof {
  return Object.freeze({ assertionVersion: envelope.assertionVersion, publicTripleCount: envelope.publicTripleCount,
    privateTripleCount: envelope.privateTripleCount, privateMerkleRoot: envelope.privateMerkleRoot && rootHex(envelope.privateMerkleRoot),
    assertionGraph: envelope.assertionGraph, subGraphName: envelope.subGraphName,
    merkleRoot: rootHex(envelope.merkleRoot), batchId: envelope.batchId.toString() });
}
/** Compare normalized immutable content evidence independently of transaction provenance. */
export function sameConfirmedGraphKnowledgeAssetProof(
  left: ConfirmedGraphKnowledgeAssetProof, right: ConfirmedGraphKnowledgeAssetProof,
): boolean {
  return left.assertionVersion === right.assertionVersion && left.assertionGraph === right.assertionGraph
    && left.publicTripleCount === right.publicTripleCount && left.privateTripleCount === right.privateTripleCount
    && left.privateMerkleRoot === right.privateMerkleRoot && left.subGraphName === right.subGraphName
    && left.merkleRoot === right.merkleRoot && left.batchId === right.batchId;
}

/** Reconcile admitted confirmed evidence; the caller owns version fencing and access controls. */
export function reconcileConfirmedGraphKnowledgeAssetMetadata(
  snapshot: { metadataQuads: readonly Quad[]; proof: ConfirmedGraphKnowledgeAssetProof },
  metadata: readonly Quad[], sameVersion: boolean,
): Quad[] {
  const roots = metadata.filter(q => q.predicate === 'http://dkg.io/ontology/merkleRoot');
  const storedRoot = roots.length === 1 ? parseMetadataBytes32Literal(roots[0]!.object) : undefined;
  if (!sameVersion || !storedRoot || rootHex(storedRoot) !== snapshot.proof.merkleRoot) return [...snapshot.metadataQuads];
  return reconcileSameAssertionGraphKnowledgeAssetMetadataV1({ lane: 'lifecycle-recovery',
    incomingMetadata: snapshot.metadataQuads, currentMetadata: metadata });
}
