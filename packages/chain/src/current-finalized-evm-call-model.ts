import {
  type BlockNumberV1,
  type ChainIdV1,
  type Digest32V1,
  type EvmAddressV1,
} from '@origintrail-official/dkg-core';

/**
 * Existing V1 EIP-1271 gateway contract. Keep the fixed transport fields on
 * this public seam even though the built-in transport owns and revalidates
 * their values; external gateways may still inspect them.
 */
export interface CurrentFinalizedEvmCallRequestV1 {
  readonly chainId: ChainIdV1;
  readonly to: EvmAddressV1;
  readonly from: '0x0000000000000000000000000000000000000000';
  readonly data: string;
  readonly gasLimit: bigint;
  readonly maxReturnBytes: number;
  readonly maxRpcResponseBytes: number;
  readonly attemptTimeoutMs: number;
  readonly maxAttempts: number;
  readonly endpointAttemptPolicy: 'distinct-configured-endpoints-no-same-endpoint-retry';
  readonly maxConcurrentCallsPerChain: number;
  readonly totalDeadlineMs: number;
  readonly ccipReadEnabled: false;
  readonly signal: AbortSignal;
}

export interface CurrentFinalizedEvmCallResultV1 {
  readonly chainId: ChainIdV1;
  readonly blockNumber: BlockNumberV1;
  readonly blockHash: Digest32V1;
  readonly returnData: string;
}

/**
 * Trusted local current-finalized EIP-1271 seam retained for V1 compatibility.
 */
export interface CurrentFinalizedEvmCallV1 {
  (request: CurrentFinalizedEvmCallRequestV1): Promise<CurrentFinalizedEvmCallResultV1>;
}
