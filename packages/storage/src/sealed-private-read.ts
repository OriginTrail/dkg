import { readExactGraphPaged, type ReadExactGraphPagedOptions } from './bounded-rdf.js';
import type { Quad, TripleStore } from './triple-store.js';

/** Count and commitment from the authenticated operation metadata or seal. */
export interface SealedKnowledgeAssetPrivateCommitment {
  privateTripleCount: number;
  privateMerkleRoot: Uint8Array | string | null | undefined;
}

export type SealedKnowledgeAssetPrivateReadOptions = Omit<
  ReadExactGraphPagedOptions, 'expectedQuadCount' | 'outputGraph'
>;

export async function readSealedKnowledgeAssetPrivateGraph(
  store: TripleStore,
  seal: SealedKnowledgeAssetPrivateCommitment,
  graphs: { version(): string; commitment(root: string): string },
  options?: SealedKnowledgeAssetPrivateReadOptions,
): Promise<Quad[]> {
  if (!Number.isSafeInteger(seal.privateTripleCount) || seal.privateTripleCount < 0) {
    throw new Error('Sealed private triple count must be a non-negative safe integer');
  }
  // A public-only seal cannot observe a private draft reusing its version.
  if (seal.privateTripleCount === 0) return [];
  const root = seal.privateMerkleRoot instanceof Uint8Array
    ? Array.from(seal.privateMerkleRoot, byte => byte.toString(16).padStart(2, '0')).join('')
    : seal.privateMerkleRoot;
  if (!root || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(root)) {
    throw new Error('Sealed private content requires a 32-byte hexadecimal Merkle root');
  }
  const archive = graphs.commitment(root);
  // Pre-upgrade seals have only a version partition. Its declared count is
  // still enforced here, and callers retain their Merkle integrity checks.
  const graph = await store.countQuads(archive) > 0 ? archive : graphs.version();
  return readExactGraphPaged(store, graph, {
    ...options, expectedQuadCount: seal.privateTripleCount, outputGraph: '',
  });
}
