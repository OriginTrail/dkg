// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace at boot (`startMarketplace`, which the daemon's start-up
 * calls): off without its settings; a part that fails to start is logged and
 * stays off, its job stopped, and the boot goes on with the other part.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { MockChainAdapter, marketplaceChainOf } from '@origintrail-official/dkg-chain';
import { Buyer } from '@origintrail-official/dkg-marketplace';
import { startMarketplace, type MarketplaceStartOptions } from '../src/daemon/marketplace-buyer.js';

const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SELLING = {
  enabled: true,
  services: [{ model: 'urn:test:model:startup', pricePerUnit: '10', backend: { kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'synthetic' } }],
};

let dir: string;
let agent: Record<string, unknown>;
let log: ReturnType<typeof vi.fn>;

const options = (marketplace?: Record<string, unknown>): MarketplaceStartOptions => ({
  config: marketplace ? { marketplace } : {},
  agent: agent as unknown as DKGAgent,
  wallets: [SIGNER.address],
  dataDir: dir,
  dashDb: { insertNotification: vi.fn() },
  log,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marketplace-route-startup-'));
  const chain = marketplaceChainOf(new MockChainAdapter('mock:31337', SIGNER.address))!;
  agent = {
    peerId: 'node-peer',
    marketplaceChain: () => chain,
    registerMarketplaceHandlers: () => () => undefined,
  };
  log = vi.fn();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe('the marketplace at boot', () => {
  it('stays off without its settings, and says nothing', async () => {
    expect(await startMarketplace(options())).toEqual({ marketplace: undefined, marketplaceGateway: undefined, marketplaceSeller: undefined });
    expect(log).not.toHaveBeenCalled();
  });

  it('leaves buying off, logged and its job stopped, when the gateway cannot read its files', async () => {
    // The gateway's receipts are a directory: reading them fails.
    await mkdir(join(dir, 'marketplace', 'buyer-receipts.jsonl'), { recursive: true });
    const stops = vi.spyOn(Buyer.prototype, 'stop');
    const parts = await startMarketplace(options({ enabled: true, tickSeconds: 3_600 }));
    expect(parts).toEqual({ marketplace: undefined, marketplaceGateway: undefined, marketplaceSeller: undefined });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[marketplace\] buying could not start and stays off: .*EISDIR/));
    expect(stops).toHaveBeenCalledTimes(1);
  });

  it('leaves selling off, logged, when the seller cannot start, and buys on', async () => {
    agent.registerMarketplaceHandlers = () => { throw new Error('the messenger is not running'); };
    const parts = await startMarketplace(options({ enabled: true, tickSeconds: 3_600, seller: SELLING }));
    expect(parts.marketplace).toBeInstanceOf(Buyer);
    expect(parts.marketplaceGateway).toBeDefined();
    expect(parts.marketplaceSeller).toBeUndefined();
    expect(log).toHaveBeenCalledWith('[marketplace] selling could not start and stays off: the messenger is not running');
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
  });

  it('starts both parts when both can', async () => {
    const parts = await startMarketplace(options({ enabled: true, tickSeconds: 3_600, seller: SELLING }));
    expect(parts.marketplace).toBeInstanceOf(Buyer);
    expect(parts.marketplaceSeller?.seller).toBeDefined();
    await parts.marketplaceSeller!.stop();
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
  });
});
