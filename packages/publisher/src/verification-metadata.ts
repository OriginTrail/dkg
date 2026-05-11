import type { Quad } from '@origintrail-official/dkg-storage';

const DKG = 'https://dkg.network/ontology#';
const DKG_IO = 'http://dkg.io/ontology/';
const PROV = 'http://www.w3.org/ns/prov#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_DATETIME = 'http://www.w3.org/2001/XMLSchema#dateTime';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

/**
 * Build metadata quads for a completed verification.
 * Written to _verified_memory/{verifiedMemoryId}/_meta graph.
 *
 * V10 Axiom 3 + 4 corollary "trust transitions are independently
 * verifiable": VERIFY is the seventh canonical typed transition and
 * MUST emit a `prov:Activity` row (typed `dkg:Verification`) carrying
 * `prov:wasAssociatedWith` (the proposer / first signer) and
 * `dkg:transitionType "VERIFY"` so the verification is composable in
 * a uniform prov:Activity audit-trail scan with the other six
 * transitions (CREATE, SHARE, PUBLISH, UPDATE, REVOKE, DISCARD,
 * ENDORSE).
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
  const proposerSigner = signers[0];
  const proposerDid = proposerSigner
    ? (proposerSigner.startsWith('did:') ? proposerSigner : `did:dkg:agent:${proposerSigner}`)
    : undefined;

  const quads: Quad[] = [
    { subject: verificationUri, predicate: RDF_TYPE, object: `${DKG}Verification`, graph },
    // V10 Axiom 3 + 4 corollary: VERIFY emits a uniform prov:Activity
    // row so audit-trail joins with CREATE/SHARE/PUBLISH/UPDATE/REVOKE/
    // DISCARD/ENDORSE work in a single SPARQL scan.
    { subject: verificationUri, predicate: RDF_TYPE, object: `${PROV}Activity`, graph },
    { subject: verificationUri, predicate: `${PROV}startedAtTime`, object: `"${verifiedAt.toISOString()}"^^<${XSD_DATETIME}>`, graph },
    { subject: verificationUri, predicate: `${DKG_IO}transitionType`, object: `"VERIFY"`, graph },
    { subject: verificationUri, predicate: `${DKG}contextGraphId`, object: `"${contextGraphId}"`, graph },
    { subject: verificationUri, predicate: `${DKG}verifiedMemoryId`, object: `"${verifiedMemoryId}"`, graph },
    { subject: verificationUri, predicate: `${DKG}batchId`, object: `"${batchId}"^^<${XSD_INTEGER}>`, graph },
    { subject: verificationUri, predicate: `${DKG}transactionHash`, object: `"${txHash}"`, graph },
    { subject: verificationUri, predicate: `${DKG}blockNumber`, object: `"${blockNumber}"^^<${XSD_INTEGER}>`, graph },
    { subject: verificationUri, predicate: `${DKG}verifiedAt`, object: `"${verifiedAt.toISOString()}"^^<${XSD_DATETIME}>`, graph },
    { subject: verificationUri, predicate: `${DKG}signerCount`, object: `"${signers.length}"^^<${XSD_INTEGER}>`, graph },
  ];
  if (proposerDid) {
    quads.push({ subject: verificationUri, predicate: `${PROV}wasAssociatedWith`, object: proposerDid, graph });
  }

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
