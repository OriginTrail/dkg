// SPDX-License-Identifier: Apache-2.0

import type { ethers } from 'ethers';

export class FeeCapBelowBaseFeeError extends Error {
  readonly code = 'FEE_CAP_BELOW_BASE_FEE' as const;

  constructor() {
    super('chain.maxFeePerGasWei is below the current base fee');
    this.name = 'FeeCapBelowBaseFeeError';
  }
}

export function resolveMaxFeePerGasWei(value: bigint | undefined): bigint | undefined {
  if (value !== undefined && value <= 0n) {
    throw new Error('chain.maxFeePerGasWei must be greater than zero');
  }
  return value;
}

/** Apply the operator fee ceiling without changing unrelated transaction fields. */
export function applyTransactionFeeCap<T extends ethers.TransactionRequest>(
  transaction: T,
  cap: bigint,
  baseFeePerGas?: bigint | null,
): T {
  const out = { ...transaction } as T;
  if (out.maxFeePerGas !== null && out.maxFeePerGas !== undefined
    && baseFeePerGas !== null && baseFeePerGas !== undefined
    && cap < baseFeePerGas) {
    throw new FeeCapBelowBaseFeeError();
  }
  if (out.gasPrice !== null && out.gasPrice !== undefined && BigInt(out.gasPrice) > cap) {
    out.gasPrice = cap;
  }
  if (out.maxFeePerGas !== null && out.maxFeePerGas !== undefined && BigInt(out.maxFeePerGas) > cap) {
    out.maxFeePerGas = cap;
  }
  if (out.maxPriorityFeePerGas !== null && out.maxPriorityFeePerGas !== undefined) {
    const effectiveCap = out.maxFeePerGas === null || out.maxFeePerGas === undefined
      ? cap
      : BigInt(out.maxFeePerGas) < cap ? BigInt(out.maxFeePerGas) : cap;
    if (BigInt(out.maxPriorityFeePerGas) > effectiveCap) {
      out.maxPriorityFeePerGas = effectiveCap;
    }
  }
  return out;
}
