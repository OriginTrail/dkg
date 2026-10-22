import { describe, expect, it, vi } from 'vitest';
import { FetchRequest, JsonRpcProvider, Network, ethers } from 'ethers';
import { EVMChainAdapter, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { ChainEventPoller } from '../src/chain-event-poller.js';
import type { ChainEventPollerLane, LaneCursorPersistence } from '../src/chain-event-poller.js';
import { makeHandler } from './helpers/chain-event-lane-fixture.js';

/**
 * A restarted Base mainnet node, 20,000 blocks behind, on the default public
 * RPC set (network/mainnet-base.json), as the three endpoints behaved on
 * 2026-09-23:
 *
 *  - mainnet.base.org  refuses spans over 2,000 blocks:
 *                      {"code":-32614,"message":"eth_getLogs is limited to a 2,000 range"}
 *  - publicnode        refuses blocks older than ~4 hours at any span:
 *                      {"code":-32602,"message":"Archive requests require a personal token. ..."}
 *  - base.drpc.org     refuses the same, at any span, with HTTP 400:
 *                      {"code":35,"message":"ranges over 10000 blocks are not supported on free plan"}
 *
 * Before the fix the lane asked every endpoint for its 9,000-block page as one
 * eth_getLogs, all three refused, and the cursor never moved. This drives the
 * REAL poller, lane runner and EVM adapter; only the HTTP transport is fake.
 */

const HEAD = 51_689_638;
const BEHIND = 20_000;
const RECENT_BLOCKS = 7_000;
const CG_STORAGE = '0x1B37447CC735Ab8Ac29f057c8874087Fe9A98154';
const OWNER = '0x64529c0200000000000000000000000000000001';
const cgInterface = new ethers.Interface([
  'event ContextGraphCreated(uint256 indexed contextGraphId, address indexed owner, bytes32 indexed nameHash, address[] participantAgents, uint256 metadataBatchId, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
]);
const word = (seed: number) => `0x${seed.toString(16).padStart(64, '0')}`;
const hex = (value: number) => `0x${value.toString(16)}`;

interface RpcLog {
  blockNumber: number;
  logIndex: number;
  contextGraphId: bigint;
}

// Five graphs created while the node was down (the canary found five).
const CREATED: readonly RpcLog[] = [
  { blockNumber: HEAD - 19_500, logIndex: 0, contextGraphId: 30n },
  { blockNumber: HEAD - 16_010, logIndex: 0, contextGraphId: 31n },
  { blockNumber: HEAD - 16_010, logIndex: 1, contextGraphId: 32n },
  { blockNumber: HEAD - 9_100, logIndex: 0, contextGraphId: 33n },
  { blockNumber: HEAD - 700, logIndex: 0, contextGraphId: 34n },
];

type Refusal = { status?: number; error: { code: number; message: string } } | undefined;

function fakeEndpoint(url: string, refuse: (fromBlock: number, toBlock: number) => Refusal) {
  const getLogs: Array<[number, number]> = [];
  const request = new FetchRequest(url);
  request.getUrlFunc = async (req) => {
    const payload = JSON.parse(new TextDecoder().decode(req.body!)) as {
      id: number;
      method: string;
      params: Array<{ fromBlock: string; toBlock: string }>;
    };
    const reply = (statusCode: number, body: Record<string, unknown>) => ({
      statusCode,
      statusMessage: statusCode === 200 ? 'OK' : 'Bad Request',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: payload.id, ...body })),
    });
    if (payload.method === 'eth_blockNumber') return reply(200, { result: hex(HEAD) });
    if (payload.method === 'eth_chainId') return reply(200, { result: hex(8453) });
    if (payload.method !== 'eth_getLogs') throw new Error(`unexpected ${payload.method}`);
    const fromBlock = Number.parseInt(payload.params[0]!.fromBlock, 16);
    const toBlock = Number.parseInt(payload.params[0]!.toBlock, 16);
    getLogs.push([fromBlock, toBlock]);
    const refusal = refuse(fromBlock, toBlock);
    if (refusal !== undefined) return reply(refusal.status ?? 200, { error: refusal.error });
    return reply(200, {
      result: CREATED
        .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
        .map((log) => {
          const encoded = cgInterface.encodeEventLog(cgInterface.getEvent('ContextGraphCreated')!, [
            log.contextGraphId, OWNER, word(0xab00 + Number(log.contextGraphId)), [OWNER], 0n, 1, 0, OWNER, 0n,
          ]);
          return {
            address: CG_STORAGE,
            topics: encoded.topics,
            data: encoded.data,
            blockNumber: hex(log.blockNumber),
            blockHash: word(log.blockNumber),
            transactionHash: word(0x10_0000 + log.blockNumber * 2 + log.logIndex),
            transactionIndex: '0x0',
            logIndex: hex(log.logIndex),
            removed: false,
          };
        }),
    });
  };
  const network = Network.from(8453);
  return {
    getLogs,
    provider: new JsonRpcProvider(request, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 }),
  };
}

function baseDefaultRpcSet() {
  const tooOld = (fromBlock: number) => fromBlock < HEAD - RECENT_BLOCKS;
  return {
    primary: fakeEndpoint('https://mainnet.base.org', (fromBlock, toBlock) => (
      toBlock - fromBlock + 1 > 2_000
        ? { error: { code: -32614, message: 'eth_getLogs is limited to a 2,000 range' } }
        : undefined
    )),
    publicnode: fakeEndpoint('https://base-rpc.publicnode.com', (fromBlock) => (
      tooOld(fromBlock)
        ? {
          error: {
            code: -32602,
            message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
          },
        }
        : undefined
    )),
    drpc: fakeEndpoint('https://base.drpc.org', (fromBlock) => (
      tooOld(fromBlock)
        ? { status: 400, error: { code: 35, message: 'ranges over 10000 blocks are not supported on free plan' } }
        : undefined
    )),
  };
}

function baseMainnetAdapter(set: ReturnType<typeof baseDefaultRpcSet>): ChainAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter: any = new EVMChainAdapter({
    rpcUrl: 'https://mainnet.base.org',
    rpcUrls: ['https://base-rpc.publicnode.com', 'https://base.drpc.org'],
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    hubAddress: '0x0000000000000000000000000000000000000001',
    chainId: 'base:8453',
    staticNetwork: false,
  });
  for (const unused of adapter.providers as JsonRpcProvider[]) unused.destroy();
  adapter.providers = [set.primary.provider, set.publicnode.provider, set.drpc.provider];
  adapter.initialized = true;
  adapter.init = async () => { adapter.initialized = true; };
  adapter.contracts = {
    contextGraphStorage: new ethers.Contract(CG_STORAGE, cgInterface, set.primary.provider),
  };
  return adapter as ChainAdapter;
}

function laneCursor(initial: number) {
  const saved: number[] = [];
  const persistence: LaneCursorPersistence = {
    loadLane: async (lane: ChainEventPollerLane) => (lane === 'contextGraphDiscovery' ? initial : undefined),
    saveLane: async (lane: ChainEventPollerLane, blockNumber: number) => {
      if (lane === 'contextGraphDiscovery') saved.push(blockNumber);
    },
  };
  return { persistence, saved };
}

describe('contextGraphDiscovery lane on the default Base RPC set', () => {
  it('catches up 20,000 blocks behind in bounded 9,000-block pages through a 2,000-block span cap', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const set = baseDefaultRpcSet();
    const cursor = laneCursor(HEAD - BEHIND);
    const discovered: Array<{ contextGraphId: string; blockNumber: number }> = [];
    let now = 1_000_000;
    const poller = new ChainEventPoller({
      chain: baseMainnetAdapter(set),
      publishHandler: makeHandler(),
      intervalMs: 12_000,
      clock: () => now,
      cursorPersistence: cursor.persistence,
      onContextGraphCreated: async ({ contextGraphId, blockNumber }) => {
        discovered.push({ contextGraphId, blockNumber });
      },
    });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();

    try {
      for (let tick = 0; tick < 3; tick += 1) {
        await poll();
        now += 12_000;
      }

      // Bounded pages: the cursor unit stays one 9,000-block lane page.
      expect(cursor.saved).toEqual([HEAD - BEHIND + 9_000, HEAD - BEHIND + 18_000, HEAD]);
      // Every graph, once, in chain order.
      expect(discovered).toEqual(CREATED.map((log) => ({
        contextGraphId: log.contextGraphId.toString(),
        blockNumber: log.blockNumber,
      })));
      // Without hammering: one refusal teaches the cap, then five requests per
      // page and one for the 2,000-block remainder. The backups, which cannot
      // serve these blocks, are never asked.
      expect(set.primary.getLogs).toHaveLength(1 + 5 + 5 + 1);
      expect(set.primary.getLogs.every(([from, to]) => to - from + 1 <= 2_000 || (
        from === HEAD - BEHIND + 1 && to === HEAD - BEHIND + 9_000
      ))).toBe(true);
      expect(set.publicnode.getLogs).toEqual([]);
      expect(set.drpc.getLogs).toEqual([]);

      // Caught up: the next tick is an ordinary live-tail read.
      await poll();
      expect(cursor.saved).toEqual([HEAD - BEHIND + 9_000, HEAD - BEHIND + 18_000, HEAD]);
    } finally {
      await poller.stop();
      vi.restoreAllMocks();
    }
  });

  it('holds its cursor when no endpoint can serve the page, and resumes from it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const set = baseDefaultRpcSet();
    // The primary is down; neither backup serves blocks this old.
    const primaryDown = { value: true };
    const primary = fakeEndpoint('https://mainnet.base.org', (fromBlock, toBlock) => {
      if (primaryDown.value) return { status: 503, error: { code: -32000, message: 'service unavailable' } };
      return toBlock - fromBlock + 1 > 2_000
        ? { error: { code: -32614, message: 'eth_getLogs is limited to a 2,000 range' } }
        : undefined;
    });
    const withFlakyPrimary = { ...set, primary };
    const cursor = laneCursor(HEAD - BEHIND);
    const discovered: string[] = [];
    let now = 1_000_000;
    const poller = new ChainEventPoller({
      chain: baseMainnetAdapter(withFlakyPrimary),
      publishHandler: makeHandler(),
      intervalMs: 12_000,
      clock: () => now,
      cursorPersistence: cursor.persistence,
      onContextGraphCreated: async ({ contextGraphId }) => { discovered.push(contextGraphId); },
    });
    const poll = () => (poller as unknown as { poll(): Promise<void> }).poll();

    try {
      await poll();
      expect(cursor.saved).toEqual([]);
      expect(discovered).toEqual([]);
      // Each backup refused the old page ONCE — no split storm against a
      // history/plan limit.
      expect(set.publicnode.getLogs).toEqual([[HEAD - BEHIND + 1, HEAD - BEHIND + 9_000]]);
      expect(set.drpc.getLogs).toEqual([[HEAD - BEHIND + 1, HEAD - BEHIND + 9_000]]);

      // After the lane's failure backoff, with the primary back, the SAME page
      // is read and the cursor moves on from where it held.
      primaryDown.value = false;
      now += 60_000;
      await poll();
      expect(cursor.saved).toEqual([HEAD - BEHIND + 9_000]);
      expect(discovered).toEqual(['30', '31', '32']);
    } finally {
      await poller.stop();
      vi.restoreAllMocks();
    }
  });
});
