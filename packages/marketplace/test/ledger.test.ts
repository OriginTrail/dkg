// SPDX-License-Identifier: Apache-2.0
/**
 * The seller's ledger on its own: each state a receipt goes through, the value
 * a budget has not landed, a batch's record from its send to its landing, and
 * pruning an ended epoch to its summary and the batches that landed, read
 * back from disk.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { SellerLedger, type ServedCall } from '../src/index.js';

const SUB = ethers.id('subscription');
const OTHER = ethers.id('another subscription');

function call(n: number, epoch = 5, subscriptionId = SUB): ServedCall {
  const requestDigest = ethers.id(`call ${n} of ${subscriptionId} in ${epoch}`);
  return {
    requestDigest, subscriptionId, budgetIndex: 0, epoch,
    request: { subscriptionId, serviceId: ethers.id('service'), seller: '7', nonce: String(n), pricePerUnit: '10', maxUnits: '100', maxValueWei: '1000', issuedAt: 1, expiry: 601 },
    signature: `0x${'11'.repeat(64)}`,
    receipt: { requestDigest, resultCommitment: ethers.id('synthetic answer'), units: '20', valueWei: '200', completedAt: 2 },
    receiptSignature: `0x${'22'.repeat(65)}`,
    result: { content: 'synthetic answer' },
  };
}

let dir: string;
let ledger: SellerLedger;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-ledger-'));
  ledger = new SellerLedger(dir);
  await ledger.load();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the seller's ledger", () => {
  it('follows each receipt from served to landed, refused or missed, and what a budget has not landed', async () => {
    const calls = [0, 1, 2, 3, 4].map((n) => call(n));
    for (const c of calls) await ledger.recordServed(c);
    expect(ledger.nonceUsed(SUB, '3')).toBe(true);
    expect(ledger.nonceUsed(SUB, '9')).toBe(false);
    expect(ledger.nonceUsed(OTHER, '0')).toBe(false);
    expect(ledger.unlanded(SUB, 0)).toBe(1_000n);

    const digests = calls.slice(0, 3).map((c) => c.requestDigest);
    await ledger.recordSent({ batchId: 'b1', epoch: 5, at: 10, hash: ethers.id('tx'), wallet: ethers.ZeroAddress, nonce: 4, digests });
    await ledger.recordSpeedup('b1', ethers.id('faster'));
    expect(ledger.pendingBatches()).toMatchObject([{ batchId: 'b1', hashes: [ethers.id('tx'), ethers.id('faster')], items: 3, state: 'sent' }]);
    // Sent still counts against the budget; landed does not.
    expect(ledger.unlanded(SUB, 0)).toBe(1_000n);
    await ledger.recordLanded('b1', { hash: ethers.id('faster'), blockNumber: 9, gasUsed: 90_000n }, digests, { [digests[0]!]: '200', [digests[1]!]: '100' });
    expect(ledger.unlanded(SUB, 0)).toBe(400n);
    expect(ledger.batch('b1')).toMatchObject({ state: 'landed', txHash: ethers.id('faster'), blockNumber: 9, gasUsed: '90000', value: '600', counted: '300' });

    await ledger.recordRefused(calls[3]!.requestDigest, 'OutsideTime');
    await ledger.recordMissed([calls[4]!.requestDigest]);
    // Nothing to record, and receipts the ledger never had: no change.
    await ledger.recordLanded(null, null, []);
    await ledger.recordMissed([]);
    await ledger.recordMissed([ethers.id('unknown')]);
    await ledger.recordReverted('unknown batch');
    expect(ledger.stateOf(calls[3]!.requestDigest)).toBe('refused');
    expect(ledger.stateOf(ethers.id('unknown'))).toBeUndefined();
    expect(ledger.unlanded(SUB, 0)).toBe(0n);
    expect(ledger.epochReport(5).summary).toEqual({
      epoch: 5, counts: { served: 0, sent: 0, landed: 3, refused: 1, missed: 1 }, heldValue: '0', landedValue: '600', counted: '300',
    });
  });

  it('puts the receipts of a batch that reverted back to served, and keeps those that landed meanwhile', async () => {
    const calls = [0, 1].map((n) => call(n));
    for (const c of calls) await ledger.recordServed(c);
    await ledger.recordSent({ batchId: 'b1', epoch: 5, at: 10, hash: ethers.id('tx'), wallet: ethers.ZeroAddress, nonce: null, digests: calls.map((c) => c.requestDigest) });
    await ledger.recordLanded(null, null, [calls[0]!.requestDigest]);
    await ledger.recordReverted('b1');
    expect(calls.map((c) => ledger.stateOf(c.requestDigest))).toEqual(['landed', 'served']);
    expect(ledger.inState('served', 5)).toEqual([calls[1]]);
    expect(ledger.inState('served', 6)).toEqual([]);
    expect(ledger.batch('b1')!.state).toBe('reverted');
    expect(ledger.unlanded(SUB, 0)).toBe(200n);
  });

  it('prunes ended epochs with no batch still sent to a summary and their landed batches, and reads them back', async () => {
    const old = [0, 1, 2, 3].map((n) => call(n, 4));
    const pending = call(0, 5, OTHER);
    const current = call(9, 6);
    for (const c of [...old, pending, current]) await ledger.recordServed(c);
    await ledger.recordSent({ batchId: 'landed', epoch: 4, at: 10, hash: ethers.id('tx 1'), wallet: ethers.ZeroAddress, nonce: 1, digests: [old[0]!.requestDigest] });
    await ledger.recordSpeedup('landed', ethers.id('tx 2'));
    await ledger.recordLanded('landed', { hash: ethers.id('tx 2'), blockNumber: 3, gasUsed: 70_000n }, [old[0]!.requestDigest], { [old[0]!.requestDigest]: '200' });
    await ledger.recordSent({ batchId: 'reverted', epoch: 4, at: 11, hash: ethers.id('tx 3'), wallet: ethers.ZeroAddress, nonce: 2, digests: [old[1]!.requestDigest] });
    await ledger.recordReverted('reverted');
    await ledger.recordLanded(null, null, [old[1]!.requestDigest]);
    await ledger.recordRefused(old[2]!.requestDigest, 'BadSignature');
    await ledger.recordMissed([old[3]!.requestDigest]);
    // Epoch 5 has a batch still sent: it stays as it is.
    await ledger.recordSent({ batchId: 'pending', epoch: 5, at: 12, hash: ethers.id('tx 4'), wallet: ethers.ZeroAddress, nonce: 3, digests: [pending.requestDigest] });

    const before = ledger.epochReport(4);
    await ledger.prune(6);
    expect(ledger.epochReport(4)).toEqual({
      summary: before.summary,
      batches: [expect.objectContaining({ batchId: 'landed', digests: [], items: 1, hashes: [ethers.id('tx 1'), ethers.id('tx 2')], counted: '200' })],
    });
    expect(before.summary.counts).toEqual({ served: 0, sent: 0, landed: 2, refused: 1, missed: 1 });
    expect(ledger.served(old[0]!.requestDigest)).toBeUndefined();
    expect(ledger.stateOf(pending.requestDigest)).toBe('sent');
    expect(ledger.served(current.requestDigest)).toEqual(current);
    // Once pruned, a later prune keeps the summary and changes nothing else.
    await ledger.prune(6);
    const lines = (await readFile(join(dir, 'seller-ledger.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l).type);
    expect(lines).toEqual(['summary', 'served', 'served', 'sent']);

    const reread = new SellerLedger(dir);
    await reread.load();
    expect(reread.epochReport(4)).toEqual(ledger.epochReport(4));
    expect(reread.pendingBatches().map((b) => b.batchId)).toEqual(['pending']);
    expect(reread.nonceUsed(SUB, '9')).toBe(true);
    expect(reread.nonceUsed(SUB, '1')).toBe(false);
    // Now it lands, and epoch 5 goes too.
    await reread.recordLanded('pending', { hash: ethers.id('tx 4'), blockNumber: 5, gasUsed: 70_000n }, [pending.requestDigest], { [pending.requestDigest]: '200' });
    await reread.prune(6);
    expect(reread.epochReport(5).summary.counts.landed).toBe(1);
    expect(reread.epochReport(4).summary).toEqual(before.summary);
  });
});
