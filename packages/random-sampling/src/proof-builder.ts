/**
 * Proof builder seam.
 *
 * The orchestrator hands a `(leaves, chunkId, expectedCommitment)`
 * triple to a `ProofBuilder` and gets back V10 proof material. Two
 * implementations live behind the same interface:
 *
 * - {@link InProcessProofBuilder} — runs `buildV10ProofMaterial`
 *   directly on the calling thread. Default for tests + small KCs.
 * - `WorkerThreadProofBuilder` (in `proof-worker.ts`) — offloads the
 *   tree build to a dedicated `worker_threads` worker so a 100k-leaf
 *   KC does not block the agent's event loop.
 *
 * The seam matters even if the "default" path is in-process: it lets
 * the orchestrator and its tests stay agnostic to where the CPU work
 * happens, which keeps the test surface small and lets the worker
 * evolve independently.
 */

import {
  buildV10ProofMaterial,
  buildV10CatalogProofMaterial,
  type V10MerkleCommitment,
  type V10ProofMaterial,
} from '@origintrail-official/dkg-core';

interface ProofBuilderRequestBase {
  /**
   * Canonical N-Triple CONTENT bytes — the `content` the prover submits to
   * `submitProof(bytes content, ...)`; the chain derives `leaf = keccak256(content)`.
   * Public path: the KC's public triples. Catalog path: the `_catalog` triples.
   * Order does not matter — `V10MerkleTree` sorts + dedupes.
   */
  contents: Uint8Array[];
  /** On-chain `chunkId` from the challenge. */
  chunkId: number;
  /** Commitment we're trying to satisfy (chain-sourced root + leafCount). */
  expected: V10MerkleCommitment;
}

/**
 * Discriminated union on tree shape — the variant carries the invariant, so
 * `privateRoots` only exists on the `public` path (no invalid states / cross-field
 * rules to remember). Content-binding applies to both.
 */
export type ProofBuilderRequest =
  | (ProofBuilderRequestBase & {
      /** Structured `hashPair(publicRoot, privateDataHash)` — private sub-roots collapsed N->1 into the sibling. */
      kind: 'public';
      privateRoots: Uint8Array[];
    })
  | (ProofBuilderRequestBase & {
      /** Plain `V10MerkleTree` over the curated public `_catalog` (no private sibling). */
      kind: 'catalog';
    });

export interface ProofBuilder {
  /**
   * Build proof material for the given challenge. Throws the same
   * named errors as `buildV10ProofMaterial`
   * (`V10ProofRootMismatchError`, `V10ProofLeafCountMismatchError`,
   * `V10ProofChunkOutOfRangeError`) so the orchestrator can branch
   * on each.
   */
  build(req: ProofBuilderRequest): Promise<V10ProofMaterial>;
  /** Release any underlying resources (worker thread, etc.). */
  close(): Promise<void>;
}

/**
 * Synchronous in-process implementation. Cheap for KCs up to ~10k
 * leaves; above that, prefer `WorkerThreadProofBuilder` so the agent
 * event loop stays responsive.
 */
export class InProcessProofBuilder implements ProofBuilder {
  async build(req: ProofBuilderRequest): Promise<V10ProofMaterial> {
    if (req.kind === 'catalog') {
      return buildV10CatalogProofMaterial(req.contents, req.chunkId, req.expected);
    }
    return buildV10ProofMaterial(req.contents, req.privateRoots, req.chunkId, req.expected);
  }

  async close(): Promise<void> {
    // no-op
  }
}
