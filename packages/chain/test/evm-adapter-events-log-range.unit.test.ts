// SPDX-License-Identifier: Apache-2.0

/**
 * The event-lane scan (`listenForEvents` → `queryFilterWithFailover`) against
 * the default Base RPC set, through the REAL adapter, failover client, ethers
 * contract and JSON-RPC provider. Only the HTTP transport is scripted.
 *
 * Before the fix a 9,000-block lane page reached every endpoint as one
 * request: mainnet.base.org refused the span, publicnode and dRPC refused the
 * depth, and the lane retried the same page forever.
 */

import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { RPC_LOG_SCAN_TIMEOUT_MS } from '../src/evm-adapter-constants.js';
import type { ChainEvent } from '../src/chain-adapter.js';
import {
  baseDefaultRpcSet,
  fakeLogRpc,
  type FakeLogRpc,
  type FakeRpcLog,
} from './helpers/fake-log-rpc.js';

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CG_STORAGE = '0x1B37447CC735Ab8Ac29f057c8874087Fe9A98154';
const OWNER = '0x64529c0200000000000000000000000000000001';
const HEAD = 51_689_638;
const cgInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));

const word = (seed: number) => `0x${seed.toString(16).padStart(64, '0')}`;

function createdLog(blockNumber: number, contextGraphId: bigint, logIndex = 0): FakeRpcLog {
  const encoded = cgInterface.encodeEventLog(cgInterface.getEvent('ContextGraphCreated')!, [
    contextGraphId,
    OWNER,
    word(0xab00 + Number(contextGraphId)),
    [OWNER],
    0n,
    1,
    0,
    OWNER,
    0n,
  ]);
  return {
    address: CG_STORAGE,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: word(blockNumber),
    transactionHash: word(0x10_0000 + blockNumber),
    logIndex,
  };
}

// Five graphs spread over the 20,000 blocks a restarted node is behind.
const LOGS: readonly FakeRpcLog[] = [
  createdLog(HEAD - 19_500, 30n),
  createdLog(HEAD - 16_010, 31n),
  createdLog(HEAD - 16_010, 32n, 1),
  createdLog(HEAD - 9_100, 33n),
  createdLog(HEAD - 700, 34n),
];

type RpcSet = ReturnType<typeof baseDefaultRpcSet>;

/** The default set in its configured order: the primary, then the two backups. */
const inOrder = (set: RpcSet): FakeLogRpc[] => [set.primary, set.publicnode, set.drpc];

/**
 * The real adapter over scripted endpoints, configured with each endpoint's own
 * URL in the order given (the first is the primary). The URLs must be distinct:
 * the adapter drops a repeated one.
 */
function makeAdapter(endpoints: readonly FakeLogRpc[]): EVMChainAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = new EVMChainAdapter({
    rpcUrl: endpoints[0]!.url,
    rpcUrls: endpoints.slice(1).map((endpoint) => endpoint.url),
    privateKey: DEPLOYER_PK,
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'base:8453',
    staticNetwork: false,
  });
  for (const unused of adapter.providers as ethers.JsonRpcProvider[]) unused.destroy();
  adapter.providers = endpoints.map((endpoint) => endpoint.provider);
  adapter.initialized = true;
  adapter.init = async () => { adapter.initialized = true; };
  adapter.contracts = {
    contextGraphStorage: new ethers.Contract(CG_STORAGE, cgInterface, endpoints[0]!.provider),
  };
  return adapter as EVMChainAdapter;
}

async function collect(adapter: EVMChainAdapter, fromBlock: number, toBlock: number): Promise<ChainEvent[]> {
  const events: ChainEvent[] = [];
  for await (const event of adapter.listenForEvents({
    eventTypes: ['ContextGraphCreated'],
    fromBlock,
    toBlock,
  })) events.push(event);
  return events;
}

const ids = (events: readonly ChainEvent[]) => events.map((event) => event.data['contextGraphId']);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('listenForEvents on the default Base RPC set', () => {
  it('serves a 9,000-block page through the primary\'s 2,000-block cap, then starts later pages at the cap', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const set = baseDefaultRpcSet({ head: () => HEAD, logs: () => LOGS });
    const adapter = makeAdapter(inOrder(set));
    const from = HEAD - 20_000 + 1;

    const first = await collect(adapter, from, from + 8_999);
    expect(ids(first)).toEqual(['30', '31', '32']);
    expect(first.map((event) => event.blockNumber)).toEqual([HEAD - 19_500, HEAD - 16_010, HEAD - 16_010]);
    expect(set.primary.logRanges()).toEqual([
      [from, from + 8_999],
      [from, from + 1_999],
      [from + 2_000, from + 3_999],
      [from + 4_000, from + 5_999],
      [from + 6_000, from + 7_999],
      [from + 8_000, from + 8_999],
    ]);
    expect(set.publicnode.logRanges()).toEqual([]);
    expect(set.drpc.logRanges()).toEqual([]);

    set.primary.requests.length = 0;
    const second = await collect(adapter, from + 9_000, from + 17_999);
    expect(ids(second)).toEqual(['33']);
    // The cap is known: five requests, no refusal first.
    expect(set.primary.logRanges()).toHaveLength(5);
    expect(set.primary.logRanges()[0]).toEqual([from + 9_000, from + 10_999]);
  });

  it('tries each backup once without splitting when the primary fails, and reports why', async () => {
    let primaryDown = false;
    const set = baseDefaultRpcSet({
      head: () => HEAD,
      logs: () => LOGS,
      primaryRefuse: () => (primaryDown ? { networkError: 'fetch failed' } : undefined),
    });
    const adapter = makeAdapter(inOrder(set));
    primaryDown = true;
    const from = HEAD - 20_000 + 1;

    const err = await collect(adapter, from, from + 8_999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      'read failed on all configured RPC endpoints (mainnet.base.org, base-rpc.publicnode.com, base.drpc.org)',
    );
    expect((err as Error).message).toContain(
      'is beyond the history, archive or plan limit at base.drpc.org: '
        + 'ranges over 10000 blocks are not supported on free plan',
    );
    // A depth refusal costs ONE request per backup: never a split storm.
    expect(set.publicnode.logRanges()).toEqual([[from, from + 8_999]]);
    expect(set.drpc.logRanges()).toEqual([[from, from + 8_999]]);

    // A depth refusal never narrows a backup for recent blocks: with the
    // primary still down, publicnode serves the live tail in one request.
    const tail = await collect(adapter, HEAD - 900, HEAD);
    expect(ids(tail)).toEqual(['34']);
    expect(set.publicnode.logRanges()).toEqual([[from, from + 8_999], [HEAD - 900, HEAD]]);
  });

  it('gives each physical request its own wide-scan deadline, not one for the whole page', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const set = baseDefaultRpcSet({ head: () => HEAD, logs: () => LOGS });
    const slow = fakeLogRpc({
      url: 'https://mainnet.base.org',
      head: () => HEAD,
      logs: () => LOGS,
      // Every request takes 20s: five of them are 100s, well past one 30s cap.
      delay: () => new Promise((resolve) => { setTimeout(resolve, 20_000); }),
      refuse: ({ fromBlock, toBlock }) => (
        toBlock - fromBlock + 1 > 2_000
          ? { rpcError: { code: -32614, message: 'eth_getLogs is limited to a 2,000 range' } }
          : undefined
      ),
    });
    const adapter = makeAdapter([slow, set.publicnode, set.drpc]);
    const from = HEAD - 20_000 + 1;

    const pending = collect(adapter, from, from + 8_999);
    await vi.advanceTimersByTimeAsync(6 * 20_000 + 1_000);
    await expect(pending.then(ids)).resolves.toEqual(['30', '31', '32']);
    expect(slow.logRanges()).toHaveLength(6);
    expect(set.publicnode.logRanges()).toEqual([]);

    // One hung request still fails over after its own deadline.
    const hung = fakeLogRpc({
      url: 'https://mainnet.base.org',
      head: () => HEAD,
      logs: () => LOGS,
      delay: () => new Promise(() => { /* never answers */ }),
    });
    const hungAdapter = makeAdapter([hung, set.publicnode, set.drpc]);
    const hungRead = collect(hungAdapter, HEAD - 900, HEAD);
    await vi.advanceTimersByTimeAsync(RPC_LOG_SCAN_TIMEOUT_MS + 1_000);
    await expect(hungRead.then(ids)).resolves.toEqual(['34']);
    expect(set.publicnode.logRanges()).toEqual([[HEAD - 900, HEAD]]);
  });

  it('keeps a single-RPC node\'s wide scans uncapped (#894) while still fitting the span', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const primary = fakeLogRpc({
      url: 'https://mainnet.base.org',
      head: () => HEAD,
      logs: () => LOGS,
      delay: () => new Promise((resolve) => { setTimeout(resolve, RPC_LOG_SCAN_TIMEOUT_MS * 2); }),
      refuse: ({ fromBlock, toBlock }) => (
        toBlock - fromBlock + 1 > 2_000
          ? { rpcError: { code: -32614, message: 'eth_getLogs is limited to a 2,000 range' } }
          : undefined
      ),
    });
    const adapter = makeAdapter([primary]);
    const from = HEAD - 9_999;

    const pending = collect(adapter, from, from + 2_999);
    await vi.advanceTimersByTimeAsync(3 * RPC_LOG_SCAN_TIMEOUT_MS * 2 + 1_000);
    await expect(pending.then(ids)).resolves.toEqual(['33']);
    expect(primary.logRanges()).toEqual([
      [from, from + 2_999],
      [from, from + 1_999],
      [from + 2_000, from + 2_999],
    ]);
  });

  it('passes an open-ended range straight through', async () => {
    const set = baseDefaultRpcSet({ head: () => HEAD, logs: () => LOGS, recentBlocks: 100_000 });
    const adapter = makeAdapter(inOrder(set));
    const events: ChainEvent[] = [];
    for await (const event of adapter.listenForEvents({
      eventTypes: ['ContextGraphCreated'],
      fromBlock: HEAD - 1_000,
    })) events.push(event);
    expect(ids(events)).toEqual(['34']);
    expect(set.primary.logRanges()).toEqual([[HEAD - 1_000, HEAD]]);
  });
});

describe('listenForEvents keeps configured RPC URLs out of errors and logs', () => {
  it('reports a non-JSON HTTP refusal from key-bearing endpoints by host only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Two configured endpoints with keys in path and query. Fake values only.
    const urls = [
      'https://base-mainnet.rpc-provider.test/v2/FAKE-KEY-0123456789abcdef?apikey=FAKE-QUERY-KEY-1',
      'https://base-backup.rpc-provider.test/FAKE-KEY-fedcba9876543210',
    ];
    // A gateway's HTML page, not JSON-RPC: ethers then embeds the full
    // request URL in its own error message.
    const archivePage = {
      httpStatus: 403,
      contentType: 'text/html',
      rawBody: '<html><body><h1>403 Forbidden</h1>'
        + '<p>Archive requests require an API key on this endpoint.</p></body></html>',
    } as const;
    const endpoints = urls.map((url) => fakeLogRpc({
      url,
      head: () => HEAD,
      logs: () => LOGS,
      refuse: () => archivePage,
    }));
    const adapter = makeAdapter(endpoints);
    const from = HEAD - 20_000 + 1;

    const err = await collect(adapter, from, from + 8_999).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(
      'read failed on all configured RPC endpoints '
        + '(base-mainnet.rpc-provider.test, base-backup.rpc-provider.test)',
    );
    expect(message).toContain(
      `eth_getLogs [${from}, ${from + 8_999}] is beyond the history, archive or plan limit `
        + 'at base-backup.rpc-provider.test: server response 403 Forbidden',
    );
    const printed = [...log.mock.calls, ...warn.mock.calls]
      .map((call) => call.map(String).join(' '))
      .join('\n');
    for (const text of [message, printed]) {
      expect(text).not.toMatch(/FAKE-KEY|FAKE-QUERY|\/v2\/|apikey=/);
    }
    // A history refusal costs each endpoint one request: never a split storm.
    expect(endpoints.map((endpoint) => endpoint.logRanges())).toEqual([
      [[from, from + 8_999]],
      [[from, from + 8_999]],
    ]);
  });
});
