// SPDX-License-Identifier: Apache-2.0

/**
 * `queryEventLogsPage` — the page reader behind the pre-10.0.4 KA high-water
 * scan, the Context Graph registry scans and the name-hash fence — against the
 * default Base RPC set. It owns its own freshest-first provider order, so it
 * gets the same span/depth policy as the event lanes, per provider.
 */

import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { baseDefaultRpcSet, type FakeRpcLog } from './helpers/fake-log-rpc.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CG_STORAGE = '0x1B37447CC735Ab8Ac29f057c8874087Fe9A98154';
const OWNER = '0x64529c0200000000000000000000000000000001';
const HEAD = 51_689_638;
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
const word = (seed: number) => `0x${seed.toString(16).padStart(64, '0')}`;

function createdLog(blockNumber: number, contextGraphId: bigint): FakeRpcLog {
  const encoded = cgInterface.encodeEventLog(cgInterface.getEvent('ContextGraphCreated')!, [
    contextGraphId, OWNER, word(0xcd00 + Number(contextGraphId)), [OWNER], 0n, 1, 0, OWNER, 0n,
  ]);
  return {
    address: CG_STORAGE,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: word(blockNumber),
    transactionHash: word(0x20_0000 + blockNumber),
    logIndex: 0,
  };
}

const LOGS = [createdLog(HEAD - 17_000, 7n), createdLog(HEAD - 12_500, 8n)];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queryEventLogsPage on the default Base RPC set', () => {
  it('skips the depth-limited backups after one request each and fits the page to the primary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const set = baseDefaultRpcSet({ head: () => HEAD, logs: () => LOGS });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter: any = new EVMChainAdapter({
      rpcUrl: 'https://mainnet.base.org',
      rpcUrls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
      privateKey: DEPLOYER_PK,
      hubAddress: '0x0000000000000000000000000000000000000001',
      chainId: 'base:8453',
      staticNetwork: false,
    });
    for (const unused of adapter.providers as ethers.JsonRpcProvider[]) unused.destroy();
    adapter.providers = [set.primary.provider, set.publicnode.provider, set.drpc.provider];
    const storage = new ethers.Contract(CG_STORAGE, cgInterface, set.primary.provider);
    // Freshest-first, as `resolveLogScanHead` orders them: the backups can
    // report the higher head and so be tried before the primary.
    const scanProviders = [
      { provider: set.drpc.provider, backendHead: HEAD },
      { provider: set.publicnode.provider, backendHead: HEAD },
      { provider: set.primary.provider, backendHead: HEAD },
    ];
    const lo = HEAD - 18_000;
    const hi = lo + 8_999;

    const page = await adapter.queryEventLogsPage(
      storage,
      storage.filters.ContextGraphCreated(),
      lo,
      hi,
      scanProviders,
      new Map(),
      'test page',
    );

    expect(page.provider).toBe(set.primary.provider);
    expect(page.logs.map((log: ethers.EventLog) => log.args.contextGraphId)).toEqual([7n, 8n]);
    expect(set.drpc.logRanges()).toEqual([[lo, hi]]);
    expect(set.publicnode.logRanges()).toEqual([[lo, hi]]);
    expect(set.primary.logRanges()).toEqual([
      [lo, hi],
      [lo, lo + 1_999], [lo + 2_000, lo + 3_999], [lo + 4_000, lo + 5_999],
      [lo + 6_000, lo + 7_999], [lo + 8_000, hi],
    ]);

    // The scan hands the serving provider back as `preferred` for its next
    // page: that page starts on the primary at the learned cap, and neither
    // depth-limited backup is asked again.
    set.primary.requests.length = 0;
    const next = await adapter.queryEventLogsPage(
      storage,
      storage.filters.ContextGraphCreated(),
      hi + 1,
      hi + 9_000,
      scanProviders,
      new Map(),
      'test page',
      page.provider,
    );
    expect(next.provider).toBe(set.primary.provider);
    expect(set.primary.logRanges()).toEqual([
      [hi + 1, hi + 2_000], [hi + 2_001, hi + 4_000], [hi + 4_001, hi + 6_000],
      [hi + 6_001, hi + 8_000], [hi + 8_001, hi + 9_000],
    ]);
    expect(set.drpc.logRanges()).toEqual([[lo, hi]]);
    expect(set.publicnode.logRanges()).toEqual([[lo, hi]]);
  });
});
