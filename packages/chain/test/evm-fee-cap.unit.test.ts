// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  FeeCapBelowBaseFeeError,
  applyTransactionFeeCap,
  resolveMaxFeePerGasWei,
} from '../src/evm-fee-cap.js';

describe('EVM fee-cap policy', () => {
  it('validates the configured cap', () => {
    expect(resolveMaxFeePerGasWei(undefined)).toBeUndefined();
    expect(resolveMaxFeePerGasWei(10n)).toBe(10n);
    expect(() => resolveMaxFeePerGasWei(0n)).toThrow(/greater than zero/);
  });

  it('caps legacy gas price', () => {
    expect(applyTransactionFeeCap({ gasPrice: 200n }, 100n)).toMatchObject({ gasPrice: 100n });
  });

  it('caps EIP-1559 fee and priority fields', () => {
    expect(applyTransactionFeeCap({
      maxFeePerGas: 300n,
      maxPriorityFeePerGas: 200n,
    }, 100n, 50n)).toMatchObject({
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 100n,
    });
  });

  it('rejects an EIP-1559 cap below the current base fee with a named error', () => {
    expect(() => applyTransactionFeeCap({ maxFeePerGas: 300n }, 100n, 101n))
      .toThrow(FeeCapBelowBaseFeeError);
  });
});
