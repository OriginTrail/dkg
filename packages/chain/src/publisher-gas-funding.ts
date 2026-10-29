import type { ethers } from 'ethers';
import { priceTransactionRequest, type ChainFeeFloor } from './evm-fee-policy.js';
import { applyTransactionFeeCap } from './evm-fee-cap.js';
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

/** Advisory claim budget; exact preparation remains the authority for each transaction. */
export class PublisherGasFunding {
  // Start near a V10 publish; learn the actual buffered gas limit at preparation. This is
  // deliberately an estimate: a differently sized next publication can cost more or less.
  private gasLimit = 1_000_000n;

  async read(
    provider: ethers.Provider, address: string, floor?: ChainFeeFloor, cap?: bigint,
  ): Promise<PublisherGasFundingObservation> {
    const observedAt = Date.now();
    const priced = await priceTransactionRequest(provider, {}, floor);
    let request = priced.transaction;
    if (request.maxFeePerGas == null) {
      const feeData = await provider.getFeeData();
      if (feeData.gasPrice == null) throw new Error('Publisher gas price unavailable');
      request = { gasPrice: feeData.gasPrice };
    }
    if (cap !== undefined) request = applyTransactionFeeCap(request, cap, priced.baseFeePerGas);
    return { ...await this.observe(provider, address, this.gasLimit, BigInt(request.maxFeePerGas ?? request.gasPrice!)), observedAt };
  }

  async assertPrepared(prepared: PreparedTransaction, provider = prepared.signer.provider): Promise<PreparedTransaction> {
    const { signer, transaction } = prepared;
    const price = transaction.maxFeePerGas ?? transaction.gasPrice;
    if (!provider || transaction.gasLimit == null || price == null) {
      throw new Error('Prepared publisher transaction gas cost unavailable');
    }
    this.gasLimit = BigInt(transaction.gasLimit);
    const observation = await this.observe(
      provider, signer.address, this.gasLimit, BigInt(price), BigInt(transaction.value ?? 0),
    );
    if (observation.balanceWei < observation.requiredWei) throw new PublisherGasFundingError(observation);
    return prepared;
  }

  private async observe(
    provider: ethers.Provider, address: string, gasLimit: bigint, feePerGasWei: bigint, value = 0n,
  ): Promise<PublisherGasFundingObservation> {
    const balanceWei = await provider.getBalance(address, 'pending');
    return { observedAt: Date.now(), balanceWei, requiredWei: gasLimit * feePerGasWei + value, gasLimit, feePerGasWei };
  }
}
