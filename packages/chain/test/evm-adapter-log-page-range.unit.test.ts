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
import {
  BASE_SPAN_CAP_REFUSAL,
  baseDefaultRpcSet,
  fakeLogRpc,
  type FakeLogRpcRequest,
  type FakeRpcLog,
} from './helpers/fake-log-rpc.js';

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

/** `KA_HIGH_WATER_PAGE_TIMEOUT_MS` in evm-adapter-base.ts: one request's deadline. */
const PAGE_REQUEST_TIMEOUT_MS = 15_000;

/**
 * `staticNetwork` pins the adapter to chain 8453, which turns on its per-provider
 * `eth_chainId` preflight before each page request.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAdapter(providers: ethers.JsonRpcProvider[], { staticNetwork = false } = {}): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'https://mainnet.base.org',
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'base:8453',
    staticNetwork,
  });
  for (const unused of adapter.providers as ethers.JsonRpcProvider[]) unused.destroy();
  adapter.providers = providers;
  return adapter;
}

/** mainnet.base.org's 2,000-block span cap, answering each eth_getLogs after `delay`. */
function slowCappedPrimary(delay: (request: FakeLogRpcRequest) => Promise<void>) {
  return fakeLogRpc({
    url: 'https://mainnet.base.org',
    head: () => HEAD,
    logs: () => LOGS,
    delay,
    refuse: ({ fromBlock, toBlock }) => (toBlock - fromBlock + 1 > 2_000 ? BASE_SPAN_CAP_REFUSAL : undefined),
  });
}

const ids = (logs: ReadonlyArray<ethers.EventLog | ethers.Log>) => (
  logs.map((log) => (log as ethers.EventLog).args.contextGraphId)
);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('queryEventLogsPage on the default Base RPC set', () => {
  it('skips the depth-limited backups after one request each and fits the page to the primary', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const set = baseDefaultRpcSet({ head: () => HEAD, logs: () => LOGS });
    const adapter = makeAdapter([set.primary.provider, set.publicnode.provider, set.drpc.provider]);
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

  it('gives each physical request of a split page its own deadline, not one for the page', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Healthy but slow: 4s per request, so the refusal and the five fitted
    // requests take 24s — past one 15s deadline for the whole page.
    const primary = slowCappedPrimary(() => new Promise((resolve) => { setTimeout(resolve, 4_000); }));
    // An archive backup that serves any range: asked only if the primary fails.
    const backup = fakeLogRpc({ url: 'https://archive.example', head: () => HEAD, logs: () => LOGS });
    const adapter = makeAdapter([primary.provider, backup.provider]);
    const storage = new ethers.Contract(CG_STORAGE, cgInterface, primary.provider);
    const scanProviders = [
      { provider: primary.provider, backendHead: HEAD },
      { provider: backup.provider, backendHead: HEAD },
    ];
    const lo = HEAD - 18_000;
    const hi = lo + 8_999;

    let settled = false;
    const pending = adapter.queryEventLogsPage(
      storage, storage.filters.ContextGraphCreated(), lo, hi, scanProviders, new Map(), 'test page',
    ).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(PAGE_REQUEST_TIMEOUT_MS + 1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    const page = await pending;

    expect(page.provider).toBe(primary.provider);
    expect(ids(page.logs)).toEqual([7n, 8n]);
    expect(primary.logRanges()).toHaveLength(6);
    expect(backup.logRanges()).toEqual([]);
  });

  it('fails a hung request over after its own deadline and hands the server back as preferred', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const lo = HEAD - 18_000;
    const hi = lo + 8_999;
    // The third fitted request never answers.
    const primary = slowCappedPrimary(({ fromBlock }) => (
      fromBlock === lo + 4_000 ? new Promise<void>(() => {}) : Promise.resolve()
    ));
    const backup = fakeLogRpc({ url: 'https://archive.example', head: () => HEAD, logs: () => LOGS });
    const adapter = makeAdapter([primary.provider, backup.provider]);
    const storage = new ethers.Contract(CG_STORAGE, cgInterface, primary.provider);
    const scanProviders = [
      { provider: primary.provider, backendHead: HEAD },
      { provider: backup.provider, backendHead: HEAD },
    ];

    const pending = adapter.queryEventLogsPage(
      storage, storage.filters.ContextGraphCreated(), lo, hi, scanProviders, new Map(), 'test page',
    );
    await vi.advanceTimersByTimeAsync(PAGE_REQUEST_TIMEOUT_MS - 1_000);
    expect(backup.logRanges()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    const page = await pending;

    expect(page.provider).toBe(backup.provider);
    expect(ids(page.logs)).toEqual([7n, 8n]);
    expect(primary.logRanges()).toEqual([
      [lo, hi], [lo, lo + 1_999], [lo + 2_000, lo + 3_999], [lo + 4_000, lo + 5_999],
    ]);
    expect(backup.logRanges()).toEqual([[lo, hi]]);

    // The backup that served is handed back as `preferred`: the next page
    // starts there, and the primary is not asked again.
    primary.requests.length = 0;
    const next = adapter.queryEventLogsPage(
      storage, storage.filters.ContextGraphCreated(), hi + 1, hi + 9_000, scanProviders, new Map(),
      'test page', page.provider,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await next).provider).toBe(backup.provider);
    expect(primary.logRanges()).toEqual([]);
    expect(backup.logRanges()).toEqual([[lo, hi], [hi + 1, hi + 9_000]]);
  });
});

describe('queryEventLogsPage keeps configured RPC URLs out of its error', () => {
  it('reports an endpoint whose chainId preflight fails by host only', async () => {
    const printers = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
    ];
    // The preflight runs before the range reader, so ethers' own error for the
    // gateway's page (full request URL, fake key included) reaches the page's
    // error without passing through the reader.
    const keyed = fakeLogRpc({
      url: 'https://rpc.example.invalid/v2/FAKEKEY123?apikey=FAKEKEY123',
      head: () => HEAD,
      logs: () => LOGS,
      refuseChainId: () => ({
        httpStatus: 401,
        contentType: 'text/html',
        rawBody: '<html><body><h1>401 Unauthorized</h1></body></html>',
      }),
    });
    const adapter = makeAdapter([keyed.provider], { staticNetwork: true });
    const storage = new ethers.Contract(CG_STORAGE, cgInterface, keyed.provider);
    const lo = HEAD - 18_000;
    const hi = lo + 8_999;

    const err = await adapter.queryEventLogsPage(
      storage,
      storage.filters.ContextGraphCreated(),
      lo,
      hi,
      [{ provider: keyed.provider, backendHead: HEAD }],
      new Map(),
      'test page',
    ).catch((e: unknown) => e);

    const message = (err as Error).message;
    expect(message).toContain(
      `test page: no configured RPC could serve the log range [${lo}, ${hi}]: server response 401 Unauthorized`,
    );
    expect(message).toContain('"requestUrl": "rpc.example.invalid"');
    const printed = printers
      .flatMap((printer) => printer.mock.calls.map((call) => call.map(String).join(' ')))
      .join('\n');
    for (const text of [message, printed]) expect(text).not.toMatch(/FAKEKEY123|\/v2\/|apikey=/);
    // The preflight refused, so the page itself was never asked for.
    expect(keyed.requests).toEqual([{ method: 'eth_chainId' }]);
  });
});
