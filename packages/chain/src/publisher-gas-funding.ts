import type { PreparedTransaction } from './rpc-failover-client.js';

export interface PublisherGasFundingObservation {
  readonly observedAt: number;
  readonly balanceWei: bigint;
  readonly requiredWei: bigint;
  readonly gasLimit: bigint;
  readonly feePerGasWei: bigint;
}

/** Raised before signing, never after a publish transaction has been dispatched. */
export class PublisherGasFundingError extends Error {
  readonly code = 'PUBLISHER_GAS_FUNDING_UNAVAILABLE' as const;
  constructor(readonly observation: PublisherGasFundingObservation) {
    super('Publisher wallet cannot cover the prepared transaction maximum gas cost');
  }
}

/** Checks the prepared execution-gas budget. Base's separate L1/operator fees are not estimated here. */
export class PublisherGasFunding {
  async assertPrepared(prepared: PreparedTransaction, provider = prepared.signer.provider): Promise<PreparedTransaction> {
    const { signer, transaction } = prepared;
    const price = transaction.maxFeePerGas ?? transaction.gasPrice;
    if (!provider || transaction.gasLimit == null || price == null) {
      throw new Error('Prepared publisher transaction gas cost unavailable');
    }
    const gasLimit = BigInt(transaction.gasLimit);
    const observedAt = Date.now();
    const balanceWei = await provider.getBalance(signer.address, 'pending');
    const observation = gasObservation(observedAt, balanceWei, gasLimit, BigInt(price), BigInt(transaction.value ?? 0));
    if (observation.balanceWei < observation.requiredWei) throw new PublisherGasFundingError(observation);
    return prepared;
  }
}

/** Pure cost calculation; observation age starts before any RPC acquisition. */
function gasObservation(
  observedAt: number, balanceWei: bigint, gasLimit: bigint, feePerGasWei: bigint, value = 0n,
): PublisherGasFundingObservation {
  return { observedAt, balanceWei, requiredWei: gasLimit * feePerGasWei + value, gasLimit, feePerGasWei };
}
