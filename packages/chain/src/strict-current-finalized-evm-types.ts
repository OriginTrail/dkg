import type {
  BlockNumberV1,
  ChainIdV1,
  Digest32V1,
} from '@origintrail-official/dkg-core';

export const CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1 = Object.freeze([
  'eip1898',
  'trusted-block-number-hash-sandwich',
] as const);

export type CurrentFinalizedEvmBlockReferenceProfileV1 =
  (typeof CURRENT_FINALIZED_EVM_BLOCK_REFERENCE_PROFILES_V1)[number];

export interface StrictCurrentFinalizedEvmRpcConfigV1 {
  /** Canonical decimal chain ID permanently bound to this adapter. */
  readonly chainId: ChainIdV1;
  /** Trusted local configuration, in canonical failover order. */
  readonly endpoints: readonly string[];
  /**
   * EIP-1898 is the default. The number/hash sandwich is an explicit trusted
   * chain profile for deployments whose RPC endpoints cannot execute EIP-1898.
   */
  readonly blockReferenceProfile?: CurrentFinalizedEvmBlockReferenceProfileV1;
}

export interface StrictRpcConfigSnapshotV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
}

export interface FinalizedAnchorV1 {
  readonly blockNumber: BlockNumberV1;
  readonly blockNumberQuantity: string;
  readonly blockHash: Digest32V1;
}

export interface DeadlineScopeV1 {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
  readonly close: () => void;
}
