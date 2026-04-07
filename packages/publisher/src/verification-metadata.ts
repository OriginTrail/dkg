import type { Quad } from '@origintrail-official/dkg-storage';

const DKG = 'https://dkg.network/ontology#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/**
 * Build metadata quads for a completed verification.
 * Written to _verified_memory/{verifiedMemoryId}/_meta graph.
 */
export function buildVerificationMetadata(params: {
  contextGraphId: string;
  verifiedMemoryId: string;
  batchId: bigint;
  txHash: string;
  blockNumber: number;
  signers: string[];
  verifiedAt: Date;
  graph: string;
}): Quad[] {
  const { contextGraphId, verifiedMemoryId, batchId, txHash, blockNumber, signers, verifiedAt, graph } = params;
  const verificationUri = `did:dkg:verification:${contextGraphId}:${verifiedMemoryId}:${batchId}`;

  const quads: Quad[] = [
    { subject: verificationUri, predicate: RDF_TYPE, object: `${DKG}Verification`, graph },
    { subject: verificationUri, predicate: `${DKG}contextGraphId`, object: `"${contextGraphId}"`, graph },
    { subject: verificationUri, predicate: `${DKG}verifiedMemoryId`, object: `"${verifiedMemoryId}"`, graph },
    { subject: verificationUri, predicate: `${DKG}batchId`, object: `"${batchId}"^^<${XSD_INTEGER}>`, graph },
    { subject: verificationUri, predicate: `${DKG}transactionHash`, object: `"${txHash}"`, graph },
    { subject: verificationUri, predicate: `${DKG}blockNumber`, object: `"${blockNumber}"^^<${XSD_INTEGER}>`, graph },
    { subject: verificationUri, predicate: `${DKG}verifiedAt`, object: `"${verifiedAt.toISOString()}"^^<${XSD_DATETIME}>`, graph },
    { subject: verificationUri, predicate: `${DKG}signerCount`, object: `"${signers.length}"^^<${XSD_INTEGER}>`, graph },
  ];

  for (const signer of signers) {
    quads.push({
      subject: verificationUri,
      predicate: `${DKG}signedBy`,
      object: signer.startsWith('did:') ? signer : `did:dkg:agent:${signer}`,
      graph,
    });
  }

  return quads;
}
