// SPDX-License-Identifier: Apache-2.0
/**
 * `decodeReceiptBatch` (evm-adapter-marketplace.ts): a landed batch, read from
 * the logs of its receipt.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { decodeReceiptBatch } from '../src/evm-adapter-marketplace.js';

describe('decodeReceiptBatch', () => {
  const settlement = new ethers.Interface(loadAbi('QueryInferenceSettlement'));
  const SETTLEMENT = ethers.getAddress('0x00000000000000000000000000000000000000c1');

  it('reads the accepted batch and its landed groups, from the settlement only', () => {
    const log = (address: string, name: string, args: unknown[]) => ({ address, ...settlement.encodeEventLog(name, args) });
    const subscriptionId = ethers.keccak256('0x07');
    const logs = [
      log(SETTLEMENT, 'ReceiptsLanded', [subscriptionId, 0, 9, 2, 300n, 300n, 10n ** 18n, ethers.keccak256('0x08')]),
      log(SETTLEMENT, 'ReceiptsLanded', [subscriptionId, 1, 9, 1, 200n, 150n, 10n ** 18n, ethers.keccak256('0x09')]),
      log(ethers.getAddress('0x00000000000000000000000000000000000000c2'), 'ReceiptsLanded', [subscriptionId, 2, 9, 1, 1n, 1n, 1n, ethers.ZeroHash]),
      log(SETTLEMENT, 'ReceiptBatchAccepted', [9, ethers.keccak256('0x0a'), 3, 500n, 450n, 10n ** 18n]),
    ];
    expect(decodeReceiptBatch(logs, SETTLEMENT.toLowerCase())).toEqual({
      seller: 9n,
      batchDigest: ethers.keccak256('0x0a'),
      itemCount: 3,
      value: 500n,
      counted: 450n,
      stakeFactor18: 10n ** 18n,
      groups: [
        { subscriptionId, budgetIndex: 0, seller: 9n, itemCount: 2, value: 300n, counted: 300n, stakeFactor18: 10n ** 18n, groupDigest: ethers.keccak256('0x08') },
        { subscriptionId, budgetIndex: 1, seller: 9n, itemCount: 1, value: 200n, counted: 150n, stakeFactor18: 10n ** 18n, groupDigest: ethers.keccak256('0x09') },
      ],
    });
    expect(decodeReceiptBatch(logs.slice(0, 3), SETTLEMENT)).toBeNull();
  });
});
