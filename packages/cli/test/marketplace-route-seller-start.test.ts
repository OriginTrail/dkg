// SPDX-License-Identifier: Apache-2.0
/**
 * The daemon's seller at boot (`startMarketplaceSeller`): a backend time limit
 * that is not a whole number of milliseconds, or longer than buyers wait for an
 * answer, leaves selling off; seller files it cannot read leave selling off,
 * logged, and the boot goes on; and each `serve` reaches the seller with the
 * peer that sent it.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter, marketplaceChainOf } from '@origintrail-official/dkg-chain';
import { MAX_BACKEND_TIMEOUT_MS, Seller, decodeMessage, encodeMessage } from '@origintrail-official/dkg-marketplace';
import { startMarketplace } from '../src/daemon/marketplace-buyer.js';
import { startMarketplaceSeller } from '../src/daemon/marketplace-seller.js';

const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const service = (backend: Record<string, unknown> = {}) => ({
  model: 'urn:test:model:seller-start', pricePerUnit: '10',
  backend: { kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'synthetic', ...backend },
});

type Handlers = { serve(payload: Uint8Array, peerId: string): Promise<Uint8Array> };

let dir: string;
let agent: Record<string, unknown>;
let handlers: Handlers | undefined;
let log: ReturnType<typeof vi.fn>;

const start = (services: unknown[] = [service()]) => startMarketplaceSeller({
  config: { marketplace: { seller: { enabled: true, services } } },
  agent: agent as unknown as DKGAgent,
  signer: SIGNER.address,
  wallets: [SIGNER.address],
  dataDir: dir,
  log,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-route-seller-start-'));
  const chain = marketplaceChainOf(new MockChainAdapter('mock:31337', SIGNER.address))!;
  handlers = undefined;
  agent = {
    peerId: 'node-peer',
    marketplaceChain: () => chain,
    registerMarketplaceHandlers: (registered: Handlers) => {
      handlers = registered;
      return () => undefined;
    },
  };
  log = vi.fn();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("the daemon's seller at boot", () => {
  it('leaves selling off, logged, for a backend time limit that is not a whole number of milliseconds, or past what buyers wait', async () => {
    expect(MAX_BACKEND_TIMEOUT_MS).toBe(110_000);
    for (const timeoutMs of [0, -1, 1.5, '60000', MAX_BACKEND_TIMEOUT_MS + 1]) expect(await start([service({ timeoutMs })])).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(5);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/backend\.timeoutMs must be a whole number of milliseconds, from 1 to 110000: selling stays off$/));
    expect(handlers).toBeUndefined();
    // The longest it takes sells.
    const runtime = await start([service({ timeoutMs: MAX_BACKEND_TIMEOUT_MS })]);
    expect(runtime).toBeDefined();
    await runtime!.stop();
  });

  it('leaves selling off, logged, when its files cannot be read, and the boot goes on', async () => {
    // The prices file is a directory: the seller cannot read it.
    await mkdir(join(dir, 'marketplace', 'seller-prices.json'), { recursive: true });
    expect(await start()).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[marketplace\] the seller's files under .+ could not be read \(.*EISDIR.*\): selling stays off$/));
    expect(handlers).toBeUndefined();
    // Through the boot's start-up: buying starts, selling stays off, and nothing is thrown.
    const parts = await startMarketplace({
      config: { marketplace: { enabled: true, tickSeconds: 3_600, seller: { enabled: true, services: [service()] } } },
      agent: agent as unknown as DKGAgent, wallets: [SIGNER.address], dataDir: dir, dashDb: { insertNotification: vi.fn() }, log,
    });
    expect(parts.marketplace).toBeDefined();
    expect(parts.marketplaceSeller).toBeUndefined();
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
  });

  it('passes each serve the peer that sent it, and answers a payload that is not JSON itself', async () => {
    const runtime = await start();
    expect(runtime).toBeDefined();
    const refused = { ok: false, code: 'NotServing', retry: true } as const;
    const serve = vi.spyOn(Seller.prototype, 'serve').mockResolvedValue(refused);
    const raw = { request: { nonce: '0' }, signature: '0x00', body: { messages: [] } };
    expect(decodeMessage(await handlers!.serve(encodeMessage(raw), 'buyer-peer'))).toEqual(refused);
    expect(serve).toHaveBeenCalledWith(raw, 'buyer-peer');
    expect(decodeMessage(await handlers!.serve(new TextEncoder().encode('not json'), 'buyer-peer'))).toMatchObject({ ok: false, code: 'BadRequest' });
    expect(serve).toHaveBeenCalledTimes(1);
    await runtime!.stop();
  });
});
