import { describe, it, expect } from 'vitest';
import { MerkleTree, hashTriple } from '../src/index.js';
import {
  verifyOracleResponse,
  type OracleProvedTriple,
  type OracleVerificationInfo,
} from '../src/crypto/oracle-verify.js';

function toHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * Build a realistic oracle response for a set of triples,
 * as a Context Oracle node would produce.
 */
function buildOraclePayload(
  triples: Array<{ subject: string; predicate: string; object: string }>,
  batchId: string,
): { provedTriples: OracleProvedTriple[]; verification: OracleVerificationInfo } {
  const hashes = triples.map(t => hashTriple(t.subject, t.predicate, t.object));
  const sorted = [...hashes].sort(compareBytes);
  const tree = new MerkleTree(sorted);
  const merkleRoot = toHex(tree.root);

  const provedTriples: OracleProvedTriple[] = triples.map(t => {
    const tripleHash = hashTriple(t.subject, t.predicate, t.object);
    const sortedIdx = sorted.findIndex(s => compareBytes(s, tripleHash) === 0);
    const siblings = tree.proof(sortedIdx);

    return {
      subject: t.subject,
      predicate: t.predicate,
      object: t.object,
      proof: {
        tripleHash: toHex(tripleHash),
        leafIndex: sortedIdx,
        siblings: siblings.map(toHex),
        merkleRoot,
        batchId,
      },
    };
  });

  const verification: OracleVerificationInfo = {
    chainId: 'eip155:84532',
    contextGraphId: '1',
    batchIds: [batchId],
    merkleRoots: { [batchId]: merkleRoot },
  };

  return { provedTriples, verification };
}

describe('verifyOracleResponse', () => {
  const testTriples = [
    { subject: 'did:dkg:agent:Alice', predicate: 'http://schema.org/name', object: '"Alice"' },
    { subject: 'did:dkg:agent:Alice', predicate: 'http://schema.org/age', object: '"30"' },
    { subject: 'did:dkg:agent:Bob', predicate: 'http://schema.org/name', object: '"Bob"' },
    { subject: 'did:dkg:agent:Bob', predicate: 'http://schema.org/age', object: '"25"' },
  ];

  describe('valid responses', () => {
    it('verifies a single triple', () => {
      const { provedTriples, verification } = buildOraclePayload([testTriples[0]], '5');
      const result = verifyOracleResponse(provedTriples, verification);

      expect(result.valid).toBe(true);
      expect(result.tripleResults).toHaveLength(1);
      expect(result.tripleResults[0].hashValid).toBe(true);
      expect(result.tripleResults[0].proofValid).toBe(true);
      expect(result.unverifiedBatches).toHaveLength(0);
    });

    it('verifies multiple triples from the same batch', () => {
      const { provedTriples, verification } = buildOraclePayload(testTriples, '5');
      const result = verifyOracleResponse(provedTriples, verification);

      expect(result.valid).toBe(true);
      expect(result.tripleResults).toHaveLength(4);
      for (const tr of result.tripleResults) {
        expect(tr.hashValid).toBe(true);
        expect(tr.proofValid).toBe(true);
      }
    });

    it('verifies triples from multiple batches', () => {
      const batch1 = buildOraclePayload([testTriples[0], testTriples[1]], '10');
      const batch2 = buildOraclePayload([testTriples[2]], '20');

      const allTriples = [...batch1.provedTriples, ...batch2.provedTriples];
      const verification: OracleVerificationInfo = {
        chainId: 'eip155:84532',
        contextGraphId: '1',
        batchIds: ['10', '20'],
        merkleRoots: {
          ...batch1.verification.merkleRoots,
          ...batch2.verification.merkleRoots,
        },
      };

      const result = verifyOracleResponse(allTriples, verification);
      expect(result.valid).toBe(true);
    });
  });

  describe('tampered responses', () => {
    it('detects a tampered triple (subject changed)', () => {
      const { provedTriples, verification } = buildOraclePayload(testTriples, '5');

      provedTriples[0] = {
        ...provedTriples[0],
        subject: 'did:dkg:agent:Mallory',
      };

      const result = verifyOracleResponse(provedTriples, verification);

      expect(result.valid).toBe(false);
      expect(result.tripleResults[0].hashValid).toBe(false);
    });

    it('detects a tampered triple (object changed)', () => {
      const { provedTriples, verification } = buildOraclePayload(testTriples, '5');

      provedTriples[1] = {
        ...provedTriples[1],
        object: '"99"',
      };

      const result = verifyOracleResponse(provedTriples, verification);
      expect(result.valid).toBe(false);
      expect(result.tripleResults[1].hashValid).toBe(false);
    });

    it('detects a tampered proof (wrong sibling)', () => {
      const { provedTriples, verification } = buildOraclePayload(testTriples, '5');

      expect(provedTriples[0].proof.siblings.length).toBeGreaterThan(0);

      provedTriples[0] = {
        ...provedTriples[0],
        proof: {
          ...provedTriples[0].proof,
          siblings: ['0x' + 'ff'.repeat(32)],
        },
      };

      const result = verifyOracleResponse(provedTriples, verification);
      expect(result.valid).toBe(false);
      expect(result.tripleResults[0].proofValid).toBe(false);
    });

    it('detects when proof merkle root does not match verification merkle root', () => {
      const { provedTriples, verification } = buildOraclePayload(testTriples, '5');

      verification.merkleRoots['5'] = '0x' + 'ab'.repeat(32);

      const result = verifyOracleResponse(provedTriples, verification);
      expect(result.valid).toBe(false);
    });
  });

  describe('missing verification data', () => {
    it('reports unverified batches when merkle root is missing', () => {
      const { provedTriples, verification } = buildOraclePayload(testTriples, '5');

      delete verification.merkleRoots['5'];

      const result = verifyOracleResponse(provedTriples, verification);
      expect(result.valid).toBe(false);
      expect(result.unverifiedBatches).toContain('5');
    });
  });

  describe('empty responses', () => {
    it('valid=true for empty triple array', () => {
      const verification: OracleVerificationInfo = {
        chainId: 'eip155:84532',
        contextGraphId: '1',
        batchIds: [],
        merkleRoots: {},
      };
      const result = verifyOracleResponse([], verification);
      expect(result.valid).toBe(true);
      expect(result.tripleResults).toHaveLength(0);
    });
  });

  describe('end-to-end proof chain', () => {
    it('client can independently verify the full chain from triple to merkle root', () => {
      const triple = testTriples[0];
      const { provedTriples, verification } = buildOraclePayload([triple], '5');

      const pt = provedTriples[0];

      // Step 1: Re-hash the triple
      const recomputedHash = hashTriple(pt.subject, pt.predicate, pt.object);
      expect(toHex(recomputedHash)).toBe(pt.proof.tripleHash);

      // Step 2: Walk the Merkle proof
      const rootBytes = hexToBytes(pt.proof.merkleRoot);
      const siblingBytes = pt.proof.siblings.map(hexToBytes);
      expect(MerkleTree.verify(rootBytes, recomputedHash, siblingBytes, pt.proof.leafIndex)).toBe(true);

      // Step 3: Compare root to on-chain root
      const onChainRoot = verification.merkleRoots[pt.proof.batchId];
      expect(pt.proof.merkleRoot).toBe(onChainRoot);
    });
  });
});

function hexToBytes(h: string): Uint8Array {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
