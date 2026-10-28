// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import {
  BASE_FEE_HEADROOM_MULTIPLIER,
  CHAIN_FEE_FLOORS,
  DEFAULT_PRIORITY_FEE_PER_GAS_WEI,
  bumpedFee,
  chainFeeFloor,
  isAcceptedReplacement,
  priceEip1559Fees,
  readSuggestedPriorityFee,
  replacementFees,
  replacementTransactionRequest,
  signedEip1559Fees,
} from '../src/evm-fee-policy.js';

const GWEI = 1_000_000_000n;
const GNOSIS = chainFeeFloor(100n)!;
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

describe('EVM fee pricing', () => {
  it('floors Gnosis and Chiado only', () => {
    expect(chainFeeFloor(100n)).toEqual({ maxFeePerGasWei: 2n * GWEI, maxPriorityFeePerGasWei: GWEI });
    expect(chainFeeFloor(10200n)).toEqual(chainFeeFloor(100n));
    for (const chainId of [1n, 8453n, 84532n, 2043n, 31337n]) {
      expect(chainFeeFloor(chainId)).toBeUndefined();
    }
    expect(chainFeeFloor(undefined)).toBeUndefined();
    expect([...CHAIN_FEE_FLOORS.keys()]).toEqual([100n, 10200n]);
  });

  it('covers several full blocks of base-fee growth on a chain without a floor', () => {
    expect(BASE_FEE_HEADROOM_MULTIPLIER).toBe(3n);
    expect(priceEip1559Fees({ baseFeePerGas: 5_000_000n, suggestedPriorityFeePerGas: 1_000_000n })).toEqual({
      maxFeePerGas: 16_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
    });
    // Nine consecutive full blocks (+12.5% each) still fit under the cap.
    let baseFee = 5_000_000n;
    for (let block = 0; block < 9; block += 1) baseFee += baseFee / 8n;
    expect(baseFee).toBeLessThan(16_000_000n);
  });

  it("falls back to ethers' 1 gwei tip when the RPC suggests none", () => {
    expect(DEFAULT_PRIORITY_FEE_PER_GAS_WEI).toBe(GWEI);
    expect(priceEip1559Fees({ baseFeePerGas: 7n, suggestedPriorityFeePerGas: null })).toEqual({
      maxFeePerGas: GWEI + 21n,
      maxPriorityFeePerGas: GWEI,
    });
  });

  it('keeps a Gnosis base fee far above the floor on its own multiple', () => {
    expect(priceEip1559Fees({ baseFeePerGas: 5n * GWEI, suggestedPriorityFeePerGas: 2n * GWEI, floor: GNOSIS })).toEqual({
      maxFeePerGas: 17n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
  });

  // Regression, 2026-10-20 on Gnosis mainnet (DKG 10.0.25, dkg-v10-mainnet-terminus): a publish
  // mined at maxFee 150 / tip 100 wei over a 23-wei base fee; minutes later publishes signed at
  // 614-736 / 100 wei stranded behind a base fee of 4.9M-36M wei and held three wallets' nonces.
  it('prices the 2026-10-20 Gnosis publishes above the base-fee spike that stranded them', () => {
    const spikeBaseFees = [4_900_000n, 36_000_000n];
    const strandedMaxFees = [150n, 614n, 672n, 736n];
    for (const spike of spikeBaseFees) {
      for (const maxFee of strandedMaxFees) expect(maxFee).toBeLessThan(spike);
    }

    // The base fees those transactions were signed over, with the tip the RPC suggested.
    for (const signedOverBaseFee of [23n, 257n, 286n, 318n]) {
      const fees = priceEip1559Fees({
        baseFeePerGas: signedOverBaseFee,
        suggestedPriorityFeePerGas: 100n,
        floor: GNOSIS,
      });
      expect(fees).toEqual({ maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI });
      for (const spike of spikeBaseFees) {
        // Includable through the whole spike, and still paying the full tip at its peak.
        expect(fees.maxFeePerGas).toBeGreaterThan(spike);
        expect(fees.maxFeePerGas - spike).toBeGreaterThanOrEqual(fees.maxPriorityFeePerGas);
      }
      expect(fees.maxFeePerGas / 36_000_000n).toBeGreaterThanOrEqual(55n);
    }
  });
});

describe('same-nonce replacement fees', () => {
  it('bumps every field by at least 12.5%, rounding up, and at least by one wei', () => {
    expect(bumpedFee(614n)).toBe(691n);
    expect(bumpedFee(736n)).toBe(828n);
    expect(bumpedFee(100n)).toBe(113n);
    expect(bumpedFee(8n)).toBe(9n);
    expect(bumpedFee(1n)).toBe(2n);
    expect(bumpedFee(0n)).toBe(1n);
    // Strictly above the 10% every mainstream mempool requires.
    for (const previous of [1n, 7n, 100n, 614n, 2n * GWEI]) {
      expect(bumpedFee(previous) * 10n).toBeGreaterThan(previous * 11n);
    }
  });

  it('catches up with a runaway base fee in one replacement', () => {
    const stuck = { maxFeePerGas: 614n, maxPriorityFeePerGas: 100n };
    const market = priceEip1559Fees({ baseFeePerGas: 4_900_000n, suggestedPriorityFeePerGas: 100n, floor: GNOSIS });
    const fees = replacementFees(stuck, market);
    expect(fees).toEqual({ maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI });
    expect(isAcceptedReplacement(stuck, fees)).toBe(true);
  });

  it('still outbids the previous signature when the market has not moved', () => {
    const previous = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI };
    const fees = replacementFees(previous, previous);
    expect(fees).toEqual({ maxFeePerGas: 2_250_000_000n, maxPriorityFeePerGas: 1_125_000_000n });
    expect(isAcceptedReplacement(previous, fees)).toBe(true);
    expect(isAcceptedReplacement(previous, { ...fees, maxPriorityFeePerGas: GWEI })).toBe(false);
  });

  it('never lets the tip exceed the fee cap', () => {
    const fees = replacementFees(
      { maxFeePerGas: 100n, maxPriorityFeePerGas: 100n },
      { maxFeePerGas: 10n, maxPriorityFeePerGas: 500n },
    );
    expect(fees.maxPriorityFeePerGas).toBe(500n);
    expect(fees.maxFeePerGas).toBe(500n);
  });

  it('re-signs the same transaction at its own nonce with only the fees changed', async () => {
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    const original = await wallet.signTransaction({
      type: 2,
      chainId: 100n,
      nonce: 6722,
      gasLimit: 966_191n,
      to: '0x38b54901f0ade112fd9002024dbdd0db3d7321b5',
      value: 0n,
      data: '0x2f9bbcec00000000000000000000000000000000000000000000000000000000000000200000',
      maxFeePerGas: 614n,
      maxPriorityFeePerGas: 100n,
    });
    expect(signedEip1559Fees(original)).toEqual({ maxFeePerGas: 614n, maxPriorityFeePerGas: 100n });

    const fees = { maxFeePerGas: 2n * GWEI, maxPriorityFeePerGas: GWEI };
    const replacement = ethers.Transaction.from(
      await wallet.signTransaction(replacementTransactionRequest(original, fees)),
    );
    const before = ethers.Transaction.from(original);
    expect(replacement.hash).not.toBe(before.hash);
    expect(replacement.from).toBe(before.from);
    for (const field of ['type', 'chainId', 'nonce', 'gasLimit', 'to', 'value', 'data'] as const) {
      expect(replacement[field]).toEqual(before[field]);
    }
    expect(replacement.maxFeePerGas).toBe(fees.maxFeePerGas);
    expect(replacement.maxPriorityFeePerGas).toBe(fees.maxPriorityFeePerGas);
  });

  it('re-prices only EIP-1559 transactions', async () => {
    const legacy = await new ethers.Wallet(PRIVATE_KEY).signTransaction({
      type: 0,
      chainId: 100n,
      nonce: 1,
      gasLimit: 21_000n,
      to: '0x38b54901f0ade112fd9002024dbdd0db3d7321b5',
      gasPrice: 1_000n,
    });
    expect(signedEip1559Fees(legacy)).toBeUndefined();
    expect(signedEip1559Fees('0xsigned')).toBeUndefined();
  });
});

describe('suggested priority fee read', () => {
  it("reads eth_maxPriorityFeePerGas and treats a failure as no suggestion, like ethers' getFeeData", async () => {
    const methods: string[] = [];
    const answering = {
      send: async (method: string) => { methods.push(method); return '0x64'; },
    } as unknown as ethers.Provider;
    await expect(readSuggestedPriorityFee(answering)).resolves.toBe(100n);
    expect(methods).toEqual(['eth_maxPriorityFeePerGas']);

    const failing = { send: async () => { throw new Error('method not found'); } } as unknown as ethers.Provider;
    await expect(readSuggestedPriorityFee(failing)).resolves.toBeNull();

    const feeDataOnly = {
      getFeeData: async () => ({ maxPriorityFeePerGas: 7n }),
    } as unknown as ethers.Provider;
    await expect(readSuggestedPriorityFee(feeDataOnly)).resolves.toBe(7n);
  });
});
