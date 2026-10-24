import {
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

/** One trusted-local ABI call in a same-finalized-anchor read. */
export interface StrictCurrentFinalizedEvmReadCallV1 {
  readonly to: EvmAddressV1;
  readonly data: string;
  readonly maxReturnBytes: number;
}

export interface StrictCurrentFinalizedEvmReadRequestV1 {
  readonly chainId: ChainIdV1;
  readonly calls: readonly StrictCurrentFinalizedEvmReadCallV1[];
  readonly signal: AbortSignal;
}

export interface StrictCurrentFinalizedEvmReadResultV1 {
  readonly chainId: ChainIdV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly returnData: readonly string[];
}

export interface StrictCurrentFinalizedEvmReadV1 {
  (request: StrictCurrentFinalizedEvmReadRequestV1):
    Promise<StrictCurrentFinalizedEvmReadResultV1>;
}
