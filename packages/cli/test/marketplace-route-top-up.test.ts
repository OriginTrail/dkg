// SPDX-License-Identifier: Apache-2.0
/**
 * `POST /api/marketplace/subscriptions/{id}/top-up` with the `idempotencyKey`
 * the node UI sends, against MockChainAdapter: a top-up is sent at most once
 * per key, a repeat gets the first answer, through a restart too; a key that
 * names another request is refused; an answer lost after the send is never
 * sent again, and confirmed once the budgets show it; a top-up refused before
 * it went leaves the key free; and a top-up without a key is as before.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { ChainRpcTransportError, MockChainAdapter, marketplaceChainOf, type MarketplaceChainAdapter } from '@origintrail-official/dkg-chain';
import { Buyer, BuyerStore } from '@origintrail-official/dkg-marketplace';
import { handleMarketplaceRoutes } from '../src/daemon/routes/marketplace.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

const TRAC = 10n ** 18n;
const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const A = `0x${'0a'.repeat(32)}`;
const B = `0x${'0b'.repeat(32)}`;
const service = (serviceId: string, value: bigint) => ({ serviceId, serviceClass: 'inference', value: String(value), maxPricePerUnit: '1000' });
const KEY = '7d1f0c64-2b9e-4f5a-9c3d-1e2f3a4b5c6d';

let dir: string;
let chain: MarketplaceChainAdapter;
let buyer: Buyer;
let subscriptionId: string;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res: any = Object.assign(new EventEmitter(), { statusCode: 0, body: '', writableEnded: false });
  res.writeHead = (status: number) => { res.statusCode = status; };
  res.setHeader = () => undefined;
  res.end = (text: string) => { res.body = text; res.writableEnded = true; };
  const req: any = Object.assign(new EventEmitter(), { method, url: path });
  if (body !== undefined) req.__dkgPrebufferedBody = Buffer.from(JSON.stringify(body));
  const url = new URL(`http://127.0.0.1${path}`);
  await handleMarketplaceRoutes({
    req, res, url, path: url.pathname, marketplace: buyer, actor: { authentication: requestAuthentication({ kind: 'nodeOperator' }) },
  } as unknown as RequestContext);
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
}

const topUp = (body: unknown) => api('POST', `/api/marketplace/subscriptions/${subscriptionId}/top-up`, body);
const budgetOf = async (serviceId: string) => (await chain.getBudgets(subscriptionId)).find((b) => b.serviceId.toLowerCase() === serviceId)?.value ?? 0n;
const newBuyer = () => new Buyer({ chain, store: new BuyerStore(dir), config: { enabled: true, buyerWallet: SIGNER.address, prefundLeadSeconds: 7_200, tickSeconds: 300 } });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-route-top-up-'));
  const mock = new MockChainAdapter('mock:31337', SIGNER.address);
  chain = marketplaceChainOf(mock)!;
  buyer = newBuyer();
  const funded = await api('POST', '/api/marketplace/subscriptions', { epoch: 'current', source: { kind: 'wallet' }, services: [service(A, 10n * TRAC)] });
  expect(funded.status).toBe(200);
  subscriptionId = funded.body.subscription.subscriptionId;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('a top-up with an idempotency key', () => {
  it('is sent once, and a repeat gets the first answer, through a restart too', async () => {
    const sends = vi.spyOn(chain, 'topUpFromWallet');
    const request = { services: [service(A, TRAC)], idempotencyKey: KEY };
    const first = await topUp(request);
    expect(first).toMatchObject({ status: 200, body: { txHash: expect.any(String), subscription: { subscriptionId } } });
    const again = await topUp(request);
    expect(again).toMatchObject({ status: 200, body: { txHash: first.body.txHash, blockNumber: first.body.blockNumber } });
    buyer = newBuyer();
    expect((await topUp(request)).body.txHash).toBe(first.body.txHash);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await budgetOf(A)).toBe(11n * TRAC);
  });

  it('refuses a key that names another request with 409, sending nothing', async () => {
    expect((await topUp({ services: [service(A, TRAC)], idempotencyKey: KEY })).status).toBe(200);
    const sends = vi.spyOn(chain, 'topUpFromWallet');
    expect(await topUp({ services: [service(A, 2n * TRAC)], idempotencyKey: KEY }))
      .toMatchObject({ status: 409, body: { code: 'IdempotencyKeyReused', args: [KEY], retryable: false } });
    expect(await topUp({ services: [service(B, TRAC)], idempotencyKey: KEY })).toMatchObject({ status: 409 });
    expect(sends).not.toHaveBeenCalled();
  });

  it('never sends again a top-up whose answer was lost, and confirms it once the budgets show it', async () => {
    const send = chain.topUpFromWallet.bind(chain);
    // The transaction goes through; its answer is lost on the way back.
    const sends = vi.spyOn(chain, 'topUpFromWallet').mockImplementationOnce(async (...args) => {
      await send(...args);
      throw new ChainRpcTransportError('RPC_TIMEOUT', 'timed out after 30000ms');
    });
    const request = { services: [service(A, TRAC)], idempotencyKey: KEY };
    expect((await topUp(request)).status).toBeGreaterThanOrEqual(500);
    const confirmed = await topUp(request);
    expect(confirmed).toMatchObject({ status: 200, body: { txHash: null, blockNumber: null, subscription: { subscriptionId } } });
    // Restarted, the node still answers it from its record.
    buyer = newBuyer();
    expect(await topUp(request)).toMatchObject({ status: 200, body: { txHash: null } });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await budgetOf(A)).toBe(11n * TRAC);
  });

  it('answers 503 while the outcome is unknown, and never sends it again', async () => {
    const sends = vi.spyOn(chain, 'topUpFromWallet').mockRejectedValueOnce(new ChainRpcTransportError('RPC_TIMEOUT', 'timed out after 30000ms'));
    const request = { services: [service(A, TRAC)], idempotencyKey: KEY };
    expect((await topUp(request)).status).toBeGreaterThanOrEqual(500);
    for (let i = 0; i < 3; i++) {
      expect(await topUp(request)).toMatchObject({ status: 503, body: { code: 'TopUpOutcomeUnknown', args: [KEY], retryable: true } });
    }
    buyer = newBuyer();
    expect(await topUp(request)).toMatchObject({ status: 503, body: { code: 'TopUpOutcomeUnknown' } });
    expect(sends).toHaveBeenCalledTimes(1);
    expect(await budgetOf(A)).toBe(10n * TRAC);
  });

  it('leaves the key free when the top-up was refused before it went', async () => {
    const request = { services: [service(A, TRAC)], idempotencyKey: KEY };
    // Refused by the contract in simulation: nothing was added.
    const account = chain.topUpFromAccount.bind(chain);
    const sends = vi.spyOn(chain, 'topUpFromWallet').mockImplementationOnce((id, additions, digest, opts) => account(id, additions, digest, opts));
    expect(await topUp(request)).toMatchObject({ status: 409, body: { code: 'WrongFundingSource' } });
    // Refused by the node's checks: the wallet holds less TRAC than the value.
    const balances = vi.spyOn(chain, 'getWalletBalances').mockResolvedValueOnce({ eth: 0n, trac: 0n });
    expect(await topUp(request)).toMatchObject({ status: 409, body: { code: 'ERC20InsufficientBalance' } });
    expect(sends).toHaveBeenCalledTimes(1);
    balances.mockRestore();
    expect((await topUp(request)).status).toBe(200);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(await budgetOf(A)).toBe(11n * TRAC);
  });

  it('is as before without a key: each request is a top-up of its own', async () => {
    const sends = vi.spyOn(chain, 'topUpFromWallet');
    expect((await topUp({ services: [service(A, TRAC)] })).status).toBe(200);
    expect((await topUp({ services: [service(A, TRAC)] })).status).toBe(200);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(await budgetOf(A)).toBe(12n * TRAC);
    for (const idempotencyKey of ['', 7, 'has space', 'x'.repeat(129)]) {
      expect(await topUp({ services: [service(A, TRAC)], idempotencyKey })).toMatchObject({ status: 400, body: { code: 'InvalidRequest' } });
    }
    expect(sends).toHaveBeenCalledTimes(2);
  });

  it('answers a top-up that went through when the read of its subscription after it fails', async () => {
    const read = chain.getSubscription.bind(chain);
    // The top-up's own checks read the subscription; the answer's read after the send fails.
    vi.spyOn(chain, 'getSubscription')
      .mockImplementationOnce((id) => read(id))
      .mockRejectedValueOnce(new ChainRpcTransportError('RPC_TIMEOUT', 'timed out after 30000ms'));
    expect(await topUp({ services: [service(A, TRAC)], idempotencyKey: KEY }))
      .toMatchObject({ status: 200, body: { txHash: expect.any(String), subscription: null } });
    expect(await budgetOf(A)).toBe(11n * TRAC);
  });
});
