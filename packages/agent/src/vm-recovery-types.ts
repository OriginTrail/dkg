/**
 * Neutral, serialization-free contracts shared by VM recovery producers and
 * scheduling strategies. This module must not depend on a recovery executor.
 */

/** Version-bound public-chain cost hints used only for VM recovery admission. */
export type VmRecoveryChainFootprint =
  | {
      readonly kind: 'public-v10';
      /** On-chain public N-Quads byte floor. Private payload bytes are excluded. */
      readonly byteSize: bigint;
      /** On-chain public post-canonicalization Merkle-leaf count. */
      readonly merkleLeafCount: bigint;
      /** Root/update version associated with this cost observation. */
      readonly assertionVersion: string;
      /**
       * Provenance of this soft scheduling hint.
       *
       * A pinned-finalized hint binds policy, root and sizing to one snapshot.
       * The classic reconciler can only obtain a latest-bounded scalar read;
       * it deliberately carries no synthetic block hash. Both remain hints:
       * exact executor caps and post-fetch chain reconciliation are the
       * correctness boundary.
       */
      readonly anchor:
        | {
            readonly kind: 'pinned-finalized';
            readonly blockHash: string;
          }
        | { readonly kind: 'latest-bounded' };
    }
  | { readonly kind: 'unknown' };
