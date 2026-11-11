// SPDX-License-Identifier: Apache-2.0
/**
 * Reconciliation on its own (OT-RFC-27): the groups that landed matched
 * to the receipts a buyer holds, per seller and budget, and what it still
 * holds by the nonces the chain has seen used.
 */
import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { hashQueryInferenceReceipt, receiptsDigest, type LandedGroup, type MarketplaceDomain } from '@origintrail-official/dkg-chain';
import { reconcileSubscription, type HeldReceiptRef } from '../src/index.js';

const DOMAIN: MarketplaceDomain = { name: 'DKGQueryInference', version: '1', chainId: 31337, verifyingContract: ethers.getAddress(`0x${'55'.repeat(20)}`) };
const SUB = ethers.id('subscription');

function held(seller: string, nonce: number, budgetIndex = 0, completedAt = 100 + nonce, valueWei = '200'): HeldReceiptRef {
  const callId = ethers.id(`call ${seller} ${nonce} ${budgetIndex}`);
  return {
    callId, subscriptionId: SUB, budgetIndex, seller,
    request: { subscriptionId: SUB, serviceId: ethers.id('service'), seller, nonce: String(nonce), pricePerUnit: '10', maxUnits: '100', maxValueWei: '1000', issuedAt: 1, expiry: 601 },
    receipt: { requestDigest: callId, resultCommitment: ethers.id('synthetic answer'), units: '20', valueWei, completedAt },
  };
}

const digestOf = (r: HeldReceiptRef) => hashQueryInferenceReceipt(DOMAIN, {
  requestDigest: r.receipt.requestDigest, resultCommitment: r.receipt.resultCommitment, units: BigInt(r.receipt.units),
  valueWei: BigInt(r.receipt.valueWei), completedAt: r.receipt.completedAt,
});

function group(receipts: HeldReceiptRef[], txHash: string, blockNumber: number, counted = 200n * BigInt(receipts.length)): LandedGroup {
  const [first] = receipts;
  return {
    subscriptionId: SUB, budgetIndex: first!.budgetIndex, seller: BigInt(first!.seller), itemCount: receipts.length, value: 200n * BigInt(receipts.length),
    counted, stakeFactor18: 10n ** 18n, groupDigest: receiptsDigest(receipts.map(digestOf)), txHash, blockNumber,
  };
}

describe('reconciliation', () => {
  it('matches the runs of receipts that landed, per seller and budget, and holds the rest', () => {
    const one = [0, 1, 2, 3].map((n) => held('7', n));
    // Of another value than the group's: never hashed against it.
    const other = held('9', 0, 0, 100, '300');
    const elsewhere = held('7', 0, 1);
    // Seller 7 lands its first two in one group, then the third in a second group of the same batch; the fourth is not landed yet.
    // Seller 9 lands a receipt this node never took; this node's own one from it is used too.
    const stranger = held('9', 5);
    const landed = [group(one.slice(0, 2), ethers.id('tx 1'), 3), group([one[2]!], ethers.id('tx 1'), 3, 100n), group([stranger], ethers.id('tx 2'), 5)];
    const used = new Set([...one.slice(0, 3), other].map((r) => r.callId));
    const rows = reconcileSubscription(DOMAIN, [one[3]!, one[1]!, other, one[0]!, one[2]!, elsewhere], landed, (r) => used.has(r.callId), (i) => ethers.id(`service ${i}`));
    expect(rows.map((r) => [r.budgetIndex, r.seller, r.held.count, r.landed.count, r.landed.matched, r.landed.counted, r.landed.txs.length])).toEqual([
      [0, 7, 1, 3, 3, '500', 1],
      [0, 9, 0, 1, 0, '200', 1],
      [1, 7, 1, 0, 0, '0', 0],
    ]);
    expect(rows[0]).toMatchObject({ subscriptionId: SUB, serviceId: ethers.id('service 0'), held: { value: '200', valueTrac: ethers.formatEther(200n) } });
  });
});
