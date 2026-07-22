import {
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

/** Canonical single-call projection over the generic finalized-read transport. */
export interface CurrentFinalizedEvmCallRequestV1 {
  readonly chainId: ChainIdV1;
  readonly to: EvmAddressV1;
  readonly data: string;
  readonly maxReturnBytes: number;
  readonly signal: AbortSignal;
}

export interface CurrentFinalizedEvmCallResultV1 {
  readonly chainId: ChainIdV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly returnData: string;
}

/**
 * Trusted local single-call seam. EIP-1271 is one ABI specialization; its
 * exact calldata and 32-byte magic-result rules stay in the verifier.
 */
export interface CurrentFinalizedEvmCallV1 {
  (request: CurrentFinalizedEvmCallRequestV1): Promise<CurrentFinalizedEvmCallResultV1>;
}
