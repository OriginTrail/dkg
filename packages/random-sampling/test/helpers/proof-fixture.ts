import { V10MerkleTree, keccak256, structuredKARootV10, tripleContentV10 } from '@origintrail-official/dkg-core';
import type { ProofBuilderRequest } from '../../src/proof-builder.js';

export function proofRequest(kind: 'catalog' | 'public' = 'catalog'): ProofBuilderRequest {
  // Deliberately unsorted and duplicated; challenges address the committed tree.
  const contents = ['c', 'a', 'b', 'a'].map(value => tripleContentV10(`urn:${value}`, 'urn:p', '"value"'));
  const leaves = contents.map(keccak256);
  if (kind === 'catalog') {
    const tree = new V10MerkleTree(leaves);
    return { kind, contents, chunkId: 0, expected: { merkleRoot: tree.root, merkleLeafCount: tree.leafCount } };
  }
  const privateRoots = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(9)];
  const { root, leafCount } = structuredKARootV10(leaves, privateRoots);
  return { kind, contents, privateRoots, chunkId: 0, expected: { merkleRoot: root, merkleLeafCount: leafCount } };
}
