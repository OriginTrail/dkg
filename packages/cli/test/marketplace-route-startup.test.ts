// SPDX-License-Identifier: Apache-2.0
/**
 * The marketplace at boot (`startMarketplace`, which the daemon's start-up
 * calls): off without its settings, and off, logged once, on a chain without
 * the marketplace's contracts; a part that fails to start is logged and stays
 * off, its job stopped, and the boot goes on with the other part.
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
import { withNetworkMarketplaceContextGraph } from '../src/daemon/marketplace-network-default.js';

const SIGNER = new ethers.Wallet(`0x${'22'.repeat(32)}`);
const SELLING = {
  enabled: true,
  services: [{ model: 'urn:test:model:startup', pricePerUnit: '10', backend: { kind: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'synthetic' } }],
};

let dir: string;
let agent: Record<string, unknown>;
let log: ReturnType<typeof vi.fn>;
/** The chain the fake agent hands out: the same one on every call. */
const chainOf = () => (agent.marketplaceChain as () => NonNullable<ReturnType<typeof marketplaceChainOf>>)();

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
    const asks = vi.spyOn(chainOf(), 'getMarketplaceContracts');
    expect(await startMarketplace(options())).toEqual({ marketplace: undefined, marketplaceGateway: undefined, marketplaceSeller: undefined });
    expect(log).not.toHaveBeenCalled();
    expect(asks).not.toHaveBeenCalled();
  });

  it('stays off, logged once, on a chain without the marketplace contracts', async () => {
    const missing = Object.assign(new Error('ServiceSubscriptions is not in the Hub'), { name: 'HubContractNotFoundError' });
    vi.spyOn(chainOf(), 'getMarketplaceContracts').mockRejectedValue(missing);
    const starts = vi.spyOn(Buyer.prototype, 'start');
    const registers = vi.fn(() => () => undefined);
    agent.registerMarketplaceHandlers = registers;
    const parts = await startMarketplace(options({ enabled: true, tickSeconds: 3_600, seller: SELLING }));
    expect(parts).toEqual({ marketplace: undefined, marketplaceGateway: undefined, marketplaceSeller: undefined });
    expect(log.mock.calls).toEqual([['[marketplace] the chain has no marketplace contracts: buying and selling stay off']]);
    expect(starts).not.toHaveBeenCalled();
    expect(registers).not.toHaveBeenCalled();
  });

  it('starts as before when the contract check fails for another reason', async () => {
    vi.spyOn(chainOf(), 'getMarketplaceContracts').mockRejectedValueOnce(new Error('no RPC endpoint answered'));
    const parts = await startMarketplace(options({ enabled: true, tickSeconds: 3_600 }));
    expect(parts.marketplace).toBeInstanceOf(Buyer);
    expect(parts.marketplaceGateway).toBeDefined();
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('no marketplace contracts'));
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
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

describe("the network's Marketplace Context Graph", () => {
  const NETWORK = { marketplace: { contextGraphId: 'network-graph' } };
  // The fake agent has no admission reads, so a part that has a graph says once that it cannot be admitted yet.
  const askedFor = (graph: string) => `[marketplace] "${graph}" cannot admit this node yet: asked again later`;

  beforeEach(() => {
    agent.query = async () => ({ bindings: [] });
  });

  it('is the default where the node names none, and changes nothing else', () => {
    const own = { marketplace: { enabled: true, tickSeconds: 60 } };
    expect(withNetworkMarketplaceContextGraph(own, NETWORK)).toEqual({ marketplace: { enabled: true, tickSeconds: 60, contextGraphId: 'network-graph' } });
    expect(own).toEqual({ marketplace: { enabled: true, tickSeconds: 60 } });
    expect(withNetworkMarketplaceContextGraph({ marketplace: { enabled: true, contextGraphId: 'own-graph' } }, NETWORK).marketplace)
      .toEqual({ enabled: true, contextGraphId: 'own-graph' });
    // An empty id is the node's own choice: no graph.
    expect(withNetworkMarketplaceContextGraph({ marketplace: { seller: SELLING, contextGraphId: '' } }, NETWORK).marketplace)
      .toEqual({ seller: SELLING, contextGraphId: '' });
    // Without a marketplace block the marketplace is off: nothing to fill in.
    expect(withNetworkMarketplaceContextGraph({}, NETWORK)).toEqual({});
  });

  it('adds nothing for a network that names no graph', () => {
    const own = { marketplace: { enabled: true } };
    for (const network of [null, undefined, {}, { marketplace: {} }, { marketplace: { contextGraphId: ' ' } }, { marketplace: { contextGraphId: 7 } }]) {
      expect(withNetworkMarketplaceContextGraph(own, network)).toBe(own);
    }
    expect(withNetworkMarketplaceContextGraph(own, { marketplace: { contextGraphId: ' network-graph ' } }).marketplace)
      .toEqual({ enabled: true, contextGraphId: 'network-graph' });
  });

  it("is the buyer's gateway's graph at boot when the node names none", async () => {
    const parts = await startMarketplace({ ...options({ enabled: true, tickSeconds: 3_600 }), network: NETWORK });
    expect(parts.marketplaceGateway).toBeDefined();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(askedFor('network-graph')));
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
  });

  it("is the seller's graph at boot when the node names none", async () => {
    const parts = await startMarketplace({ ...options({ seller: SELLING }), network: NETWORK });
    expect(parts.marketplace).toBeUndefined();
    expect(parts.marketplaceSeller?.seller).toBeDefined();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(askedFor('network-graph')));
    await parts.marketplaceSeller!.stop();
  });

  it("gives way to the node's own graph", async () => {
    const parts = await startMarketplace({ ...options({ enabled: true, tickSeconds: 3_600, contextGraphId: 'own-graph', seller: SELLING }), network: NETWORK });
    await vi.waitFor(() => expect(log.mock.calls.filter(([line]) => line === askedFor('own-graph'))).toHaveLength(2));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('network-graph'));
    await parts.marketplaceSeller!.stop();
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
  });

  it('leaves a node without one on a network that names none, as on mainnet', async () => {
    const parts = await startMarketplace({ ...options({ enabled: true, tickSeconds: 3_600, seller: SELLING }), network: { networkName: 'mainnet' } });
    expect(parts.marketplaceSeller?.seller).toBeDefined();
    // Two turns of the event loop: room for an admission read, had either part a graph.
    for (let turn = 0; turn < 2; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('cannot admit'));
    await parts.marketplaceSeller!.stop();
    await parts.marketplaceGateway!.stop();
    await parts.marketplace!.stop();
  });
});
