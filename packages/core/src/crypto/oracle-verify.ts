import { MerkleTree } from './merkle.js';
import { hashTriple } from './canonicalize.js';

export interface OracleTripleProof {
  tripleHash: string;
  leafIndex: number;
  siblings: string[];
  merkleRoot: string;
  batchId: string;
}

export interface OracleProvedTriple {
  subject: string;
  predicate: string;
  object: string;
  proof: OracleTripleProof;
}

export interface OracleVerificationInfo {
  chainId: string;
  contextGraphId: string;
  batchIds: string[];
  merkleRoots: Record<string, string>;
}

export interface VerifyResult {
  valid: boolean;
  tripleResults: Array<{
    subject: string;
    predicate: string;
    object: string;
    hashValid: boolean;
    proofValid: boolean;
    batchId: string;
  }>;
  unverifiedBatches: string[];
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Client-side verification of Context Oracle responses.
 *
 * For each proved triple:
 * 1. Re-hashes (subject, predicate, object) → tripleHash
 * 2. Walks the Merkle proof to recompute the root
 * 3. Compares against the expected merkleRoot from verification info
 *
 * The caller must separately verify that the merkleRoots match what's stored
 * on-chain (via getBatchMerkleRoot on KnowledgeAssetsStorage).
 */
export function verifyOracleResponse(
  triples: OracleProvedTriple[],
  verification: OracleVerificationInfo,
): VerifyResult {
  const tripleResults: VerifyResult['tripleResults'] = [];
  const verifiedBatches = new Set<string>();

  for (const t of triples) {
    const recomputedHash = hashTriple(t.subject, t.predicate, t.object);
    const expectedHash = hexToBytes(t.proof.tripleHash);
    const hashValid = bytesEqual(recomputedHash, expectedHash);

    const root = hexToBytes(t.proof.merkleRoot);
    const siblings = t.proof.siblings.map(hexToBytes);
    const proofValid = MerkleTree.verify(root, recomputedHash, siblings, t.proof.leafIndex);

    verifiedBatches.add(t.proof.batchId);

    tripleResults.push({
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      hashValid,
      proofValid,
      batchId: t.proof.batchId,
    });
  }

  const expectedRoot = (batchId: string) => verification.merkleRoots[batchId];
  const unverifiedBatches: string[] = [];
  for (const batchId of verifiedBatches) {
    const onChainRoot = expectedRoot(batchId);
    if (!onChainRoot) {
      unverifiedBatches.push(batchId);
      continue;
    }
    const rootBytes = hexToBytes(onChainRoot);
    for (const tr of tripleResults) {
      if (tr.batchId === batchId && tr.proofValid) {
        const proofRoot = hexToBytes(
          triples.find(
            t => t.subject === tr.subject && t.predicate === tr.predicate && t.object === tr.object,
          )!.proof.merkleRoot,
        );
        if (!bytesEqual(proofRoot, rootBytes)) {
          tr.proofValid = false;
        }
      }
    }
  }

  const valid = tripleResults.every(t => t.hashValid && t.proofValid) && unverifiedBatches.length === 0;

  return { valid, tripleResults, unverifiedBatches };
}
