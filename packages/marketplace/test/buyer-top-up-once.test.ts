// SPDX-License-Identifier: Apache-2.0
/**
 * Top-ups sent with a key (`Buyer.topUpOnce`) against MockChainAdapter: sent
 * at most once per key, a repeat answered from the record, after a restart
 * too; a key that names another request refused; an answer lost after the
 * send never sent again, and confirmed once the budgets show it; a refusal
 * before the send leaving the key free; the keys of an ended epoch dropped;
 * and a record that cannot be read tried again at the next top-up.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { ChainRpcTransportError, MockChainAdapter, marketplaceChainOf, subscriptionIdOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { Buyer, BuyerStore, Journal, refusalOf, type PlannedService } from '../src/index.js';

const TRAC = 10n ** 18n;
const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const A = `0x${'0a'.repeat(32)}`;
const B = `0x${'0b'.repeat(32)}`;
const KEY = 'top-up-1';
const service = (serviceId: string, value: bigint): PlannedService => ({ serviceId, serviceClass: 1, value, maxPricePerUnit: 10n ** 9n });

let dir: string;
let mock: MockChainAdapter;
let chain: MarketplaceChainAdapter;
let subscriptionId: string;

const buyerOf = () => new Buyer({
  chain, store: new BuyerStore(dir), config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300 },
});
const budgetOf = async (serviceId: string) => (await chain.getBudgets(subscriptionId)).find((b) => b.serviceId.toLowerCase() === serviceId)?.value ?? 0n;
const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (err: unknown) => refusalOf(err)?.code ?? String(err));
const records = async () => (await readFile(join(dir, 'top-ups.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-top-up-once-'));
  mock = new MockChainAdapter('mock:31337', SIGNER.address);
  chain = marketplaceChainOf(mock)!;
  const { epoch } = await chain.getEpochTimes();
  subscriptionId = (await buyerOf().fund({ epoch, source: { kind: 'wallet' }, services: [service(A, 10n * TRAC)] })).subscriptionId;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a top-up sent with a key', () => {
  it('is sent once, and a repeat gets the first answer, through a restart too', async () => {
    const sends = vi.spyOn(chain, 'topUpFromWallet');
    const buyer = buyerOf();
    const first = await buyer.topUpOnce(subscriptionId.toUpperCase().replace('0X', '0x'), [service(A, TRAC)], KEY);
    expect(first.txHash).toEqual(expect.any(String));
    expect(await buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).toEqual(first);
    expect(await buyerOf().topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).toEqual(first);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await budgetOf(A)).toBe(11n * TRAC);
    expect((await records()).map((r) => r.type)).toEqual(['sent', 'done']);
  });

  it('refuses a key that names another request, sending nothing', async () => {
    const buyer = buyerOf();
    await buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY);
    const sends = vi.spyOn(chain, 'topUpFromWallet');
    expect(await codeOf(buyer.topUpOnce(subscriptionId, [service(A, 2n * TRAC)], KEY))).toBe('IdempotencyKeyReused');
    expect(await codeOf(buyer.topUpOnce(subscriptionId, [service(A, TRAC), service(B, TRAC)], KEY))).toBe('IdempotencyKeyReused');
    expect(sends).not.toHaveBeenCalled();
  });

  it('never sends again a top-up whose answer was lost, and confirms it once the budgets show it', async () => {
    const send = chain.topUpFromWallet.bind(chain);
    const sends = vi.spyOn(chain, 'topUpFromWallet').mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new ChainRpcTransportError('RPC_TIMEOUT', 'timed out after 30000ms');
    });
    const buyer = buyerOf();
    await expect(buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).rejects.toThrow('timed out');
    expect(await buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).toEqual({ txHash: null, blockNumber: null });
    expect(await buyerOf().topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).toEqual({ txHash: null, blockNumber: null });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await budgetOf(A)).toBe(11n * TRAC);
  });

  it('answers that the outcome is not known while the budgets do not show it, and never sends it again', async () => {
    const sends = vi.spyOn(chain, 'topUpFromWallet').mockRejectedValueOnce(new ChainRpcTransportError('RPC_TIMEOUT', 'timed out after 30000ms'));
    const buyer = buyerOf();
    await expect(buyer.topUpOnce(subscriptionId, [service(B, TRAC)], KEY)).rejects.toThrow('timed out');
    expect(await codeOf(buyer.topUpOnce(subscriptionId, [service(B, TRAC)], KEY))).toBe('TopUpOutcomeUnknown');
    expect(await codeOf(buyerOf().topUpOnce(subscriptionId, [service(B, TRAC)], KEY))).toBe('TopUpOutcomeUnknown');
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await budgetOf(B)).toBe(0n);
  });

  it('leaves the key free when the top-up was refused before it went', async () => {
    const buyer = buyerOf();
    // Refused by the contract in simulation: nothing was added.
    const account = chain.topUpFromAccount.bind(chain);
    const sends = vi.spyOn(chain, 'topUpFromWallet').mockImplementationOnce((id, additions, digest, opts) => account(id, additions, digest, opts));
    expect(await codeOf(buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY))).toBe('WrongFundingSource');
    expect((await records()).map((r) => r.type)).toEqual(['sent', 'refused']);
    // Refused by the checks: nothing recorded.
    vi.spyOn(chain, 'getWalletBalances').mockResolvedValueOnce({ eth: 0n, trac: 0n });
    expect(await codeOf(buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY))).toBe('ERC20InsufficientBalance');
    expect(sends).toHaveBeenCalledTimes(1);
    // A restart reads the key as free, and the top-up goes.
    expect((await buyerOf().topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).txHash).toEqual(expect.any(String));
    expect(sends).toHaveBeenCalledTimes(2);
    expect(await budgetOf(A)).toBe(11n * TRAC);
  });

  it("drops the keys of an ended epoch's subscription when it reads them", async () => {
    await buyerOf().topUpOnce(subscriptionId, [service(A, TRAC)], KEY);
    mock.__advanceEpoch();
    const { epoch } = await chain.getEpochTimes();
    const next = (await buyerOf().fund({ epoch, source: { kind: 'wallet' }, services: [service(A, TRAC)] })).subscriptionId;
    expect(next).toBe(subscriptionIdOf(SIGNER.address, epoch));
    // The same key on the new subscription is a new top-up: the old one's record is gone.
    const buyer = buyerOf();
    const answer = await buyer.topUpOnce(next, [service(A, TRAC)], KEY);
    expect(answer.txHash).toEqual(expect.any(String));
    expect((await records()).map((r) => [r.type, r.subscriptionId ?? null])).toEqual([['sent', next], ['done', null]]);
  });

  it('reads its records again at the next top-up when a read fails', async () => {
    const buyer = buyerOf();
    vi.spyOn(Journal.prototype, 'read').mockRejectedValueOnce(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
    await expect(buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).rejects.toThrow('EIO');
    expect((await buyer.topUpOnce(subscriptionId, [service(A, TRAC)], KEY)).txHash).toEqual(expect.any(String));
  });
});
