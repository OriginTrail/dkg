// SPDX-License-Identifier: Apache-2.0

/**
 * A node whose one-log start cannot complete for now gets its log later,
 * without a restart.
 *
 * The start resolves each indexed contract's deploy block: a head probe of
 * every endpoint, then a search of `eth_getCode` reads. Each read has a
 * four-second deadline, and that deadline also covers the time the read waits
 * in the node's own request queue. A read that is still queued when it expires
 * was never sent, a read that was admitted late is not answered in time, and
 * an endpoint can throttle the probe. In each case the build rejects, and
 * before this change the node ran without its log for the rest of the process.
 *
 * The first three tests play those through the real deploy-block resolution,
 * transport and request governor; only the HTTP exchange is answered
 * in-process. The others pin the adapter's side of the three ways a deferred
 * start ends, and the failure that still ends it at once.
 */

import { ethers } from 'ethers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({
  answer: undefined as undefined | ((method: string, params: readonly unknown[]) => unknown),
  /** An HTTP status to answer with instead of a result. */
  refusal: undefined as undefined | ((method: string) => number | undefined),
  /** How long the endpoint takes to answer. */
  roundTripMs: 0,
  sent: [] as Array<{ url: string; method: string; params: readonly unknown[] }>,
}));

vi.mock('../src/rpc-http1-dispatcher.js', () => ({
  chainRpcFetch: async (input: string | URL, init: RequestInit) => {
    const call = JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer)) as {
      id: number;
      method: string;
      params: readonly unknown[];
    };
    rpc.sent.push({ url: String(input), method: call.method, params: call.params });
    if (rpc.roundTripMs > 0) {
      await new Promise<void>((resolve) => { setTimeout(resolve, rpc.roundTripMs); });
    }
    const status = rpc.refusal?.(call.method);
    if (status !== undefined) return new Response('refused', { status });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: call.id, result: rpc.answer!(call.method, call.params) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  },
}));

const { EVMChainAdapter } = await import('../src/evm-adapter.js');
const { loadAbi } = await import('../src/evm-adapter-abi.js');
const { createRpcAdmissionTimeoutError } = await import('../src/chain-rpc-transport-error.js');
const {
  CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS,
  CHAIN_INDEX_START_RETRY_MAX_DELAY_MS,
} = await import('../src/evm-chain-index-runtime-owner.js');
const { RpcRequestGovernor } = await import('../src/rpc-request-governor.js');
const {
  withDetachedRpcRequestContext,
  withRpcRequestContext,
} = await import('../src/rpc-request-transport.js');
const { MemoryChainEventLogStore } = await import('./helpers/chain-event-log.js');

type Adapter = InstanceType<typeof EVMChainAdapter>;
type Governor = InstanceType<typeof RpcRequestGovernor>;

const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const HUB = '0x0000000000000000000000000000000000000001';
const CG_STORAGE = '0x00000000000000000000000000000000000000aa';
const ROTATED_CG_STORAGE = '0x00000000000000000000000000000000000000bb';
const RPC_URL = 'http://rpc-a.invalid:8545';
const SECOND_RPC_URL = 'http://rpc-b.invalid:8545';
const HEAD = 64;
const HUB_DEPLOY_BLOCK = 21;
const CG_STORAGE_DEPLOY_BLOCK = 30;

interface Internals {
  contracts: Record<string, unknown>;
  providers: ethers.JsonRpcProvider[];
  ensureConfiguredStaticChainIdValidated(provider: ethers.JsonRpcProvider): Promise<bigint>;
  readTipProvider: unknown;
  resolveContractDeployBlockNumber(address: string): Promise<number>;
  startChainIndexRuntime(): void;
  applyHubRotationEventName(name: string): void;
  invalidateAllBoundContracts(): void;
  chainIndexOwner: Readonly<{ starting?: Promise<void>; runtime?: unknown }>;
}

const internalsOf = (adapter: Adapter): Internals => adapter as unknown as Internals;

function createAdapter(options: { governor?: Governor; secondEndpoint?: boolean } = {}): Adapter {
  const adapter = new EVMChainAdapter({
    rpcUrl: RPC_URL,
    ...(options.secondEndpoint ? { rpcUrls: [SECOND_RPC_URL] } : {}),
    privateKey: DEPLOYER_PK,
    hubAddress: HUB,
    chainId: 'evm:31337',
    allowNoAdminSigner: true,
    chainEventLogStore: new MemoryChainEventLogStore(),
    ...(options.governor === undefined ? {} : { rpcRequestAdmission: options.governor }),
  });
  const internals = internalsOf(adapter);
  internals.contracts.hub = {
    interface: new ethers.Interface(loadAbi('Hub')),
    getAddress: async () => ethers.getAddress(HUB),
  };
  internals.contracts.knowledgeAssetStorage = undefined;
  bindContextGraphStorage(adapter, CG_STORAGE);
  // The tick's own reads are not what is under test here.
  internals.readTipProvider = async (
    _label: string,
    read: (provider: unknown) => Promise<unknown>,
  ) => read({
    getBlock: async (tag: string | number) => ({
      number: typeof tag === 'number' ? tag : HEAD,
      hash: `0x${(typeof tag === 'number' ? tag : HEAD).toString(16).padStart(64, '0')}`,
      timestamp: 1_700_000_000,
    }),
    getLogs: async () => [],
  });
  return adapter;
}

/**
 * Every endpoint's chain id is validated already, as it is by the time
 * `initContracts` reaches the start on a node.
 */
async function validateChainIds(adapter: Adapter): Promise<void> {
  const internals = internalsOf(adapter);
  const validated = Promise.all(internals.providers.map(
    (provider) => internals.ensureConfiguredStaticChainIdValidated(provider),
  ));
  await vi.advanceTimersByTimeAsync(50);
  await expect(validated).resolves.toEqual(internals.providers.map(() => 31337n));
}

/** `ContextGraphStorage` as `initContracts` would have resolved it. */
function bindContextGraphStorage(adapter: Adapter, address: string): void {
  internalsOf(adapter).contracts.contextGraphStorage = {
    interface: new ethers.Interface(loadAbi('ContextGraphStorage')),
    getAddress: async () => ethers.getAddress(address),
  };
}

/** The error a deploy-block read raises when it is not admitted before its deadline. */
const refused = (): Error => createRpcAdmissionTimeoutError(
  'chainIndex deploy block eth_getCode at block 24 waited 4000ms for local RPC admission and was not sent',
);

const indexLines = (spy: { mock: { calls: unknown[][] } }): string[] => spy.mock.calls
  .map(([line]) => String(line))
  .filter((line) => line.includes('one-log chain index'));

/** Move the fake clock in small steps until `done()`; fail rather than run on. */
async function advanceUntil(done: () => boolean, withinMs: number): Promise<number> {
  let advanced = 0;
  while (!done()) {
    if (advanced >= withinMs) throw new Error(`condition not reached within ${withinMs}ms`);
    await vi.advanceTimersByTimeAsync(50);
    advanced += 50;
  }
  return advanced;
}

/**
 * Authority reads as a node issues them while it evaluates saved state at
 * start: several at once, each back in the queue as soon as it is answered.
 */
function startAuthorityReads(governor: Governor, readers: number, roundTripMs: number) {
  const burst = new AbortController();
  let admitted = 0;
  const running = Array.from({ length: readers }, async () => {
    while (!burst.signal.aborted) {
      try {
        await withRpcRequestContext(
          { requestClass: 'foreground', admissionPriority: 'authority', signal: burst.signal },
          () => governor.acquireActiveRequest(),
        );
      } catch {
        return;
      }
      admitted += 1;
      await new Promise<void>((resolve) => { setTimeout(resolve, roundTripMs); });
    }
  });
  return {
    admitted: () => admitted,
    stop: async (): Promise<void> => {
      burst.abort(new Error('burst over'));
      await vi.advanceTimersByTimeAsync(roundTripMs);
      await Promise.all(running);
    },
  };
}

describe('one-log start that cannot complete for now', () => {
  const adapters: Adapter[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    rpc.sent.length = 0;
    rpc.refusal = undefined;
    rpc.roundTripMs = 0;
    rpc.answer = (method, params) => {
      if (method === 'eth_chainId') return '0x7a69';
      if (method === 'eth_blockNumber') return ethers.toQuantity(HEAD);
      if (method === 'eth_getCode') {
        const [address, blockTag] = params as [string, string];
        const deployedAt = address.toLowerCase() === HUB ? HUB_DEPLOY_BLOCK : CG_STORAGE_DEPLOY_BLOCK;
        return Number(blockTag) >= deployedAt ? '0x6000' : '0x';
      }
      throw new Error(`unexpected RPC method ${method}`);
    };
  });

  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const codeReads = (address: string): number[] => rpc.sent
    .filter(({ method, params }) => method === 'eth_getCode'
      && String(params[0]).toLowerCase() === address)
    .map(({ params }) => Number(params[1]));

  it('defers the start when a deploy-block read is not admitted in time, and attaches the log once reads are admitted again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const governor = new RpcRequestGovernor({ startupJitterMs: 0 });
    const adapter = createAdapter({ governor });
    adapters.push(adapter);
    const internals = internalsOf(adapter);
    await validateChainIds(adapter);

    // The start runs as ordinary foreground work. Part-way through the second
    // contract's search, authority reads start to arrive faster than the node's
    // request budget admits them. They go first, so the search's next read
    // stays queued behind them.
    let authorityReads: ReturnType<typeof startAuthorityReads> | undefined;
    const answer = rpc.answer!;
    rpc.answer = (method, params) => {
      if (
        authorityReads === undefined
        && method === 'eth_getCode'
        && String(params[0]).toLowerCase() === CG_STORAGE
        && Number(params[1]) === 16
      ) {
        // Issued by other work on the node, so outside this read's own context.
        authorityReads = withDetachedRpcRequestContext(
          'foreground',
          () => startAuthorityReads(governor, 20, 100),
        );
      }
      return answer(method, params);
    };

    internals.startChainIndexRuntime();
    const starting = internals.chainIndexOwner.starting;
    await advanceUntil(() => authorityReads !== undefined, 2_000);
    expect(codeReads(HUB)).toEqual([64, 32, 16, 24, 20, 22, 21]);
    expect(codeReads(CG_STORAGE)).toEqual([64, 32, 16]);

    // Four seconds later the queued read gives up. It was never sent.
    await advanceUntil(() => indexLines(warn).length > 0, 4_500);
    expect(indexLines(warn)).toEqual([
      '[chain] one-log chain index start deferred (retrying, next attempt in 5s): '
        + 'chainIndex deploy block eth_getCode at block 24 waited 4000ms for local RPC admission and was not sent',
    ]);
    expect(codeReads(CG_STORAGE)).toEqual([64, 32, 16]);
    expect(adapter.chainEventLog).toBeUndefined();
    expect(internals.chainIndexOwner.starting).toBe(starting);

    // The second attempt meets the same queue and is refused at its first
    // read. Nothing is printed for it, and nothing reaches the endpoint.
    const sentBeforeRetry = rpc.sent.length;
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS + 4_100);
    expect(rpc.sent).toHaveLength(sentBeforeRetry);
    expect(indexLines(warn)).toHaveLength(1);
    expect(indexLines(log)).toEqual([]);
    expect(adapter.chainEventLog).toBeUndefined();
    expect(governor.snapshot().cancelled).toBe(2);
    expect(authorityReads!.admitted()).toBeGreaterThan(80);

    // The authority reads end. The third attempt, ten seconds after the
    // second, is admitted, and the log attaches.
    await authorityReads!.stop();
    await advanceUntil(() => adapter.chainEventLog !== undefined, 12_000);
    await starting;

    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(CG_STORAGE);
    // The Hub's deploy block was found by the first attempt and not searched
    // for again; the second contract's search started over and finished.
    expect(codeReads(HUB)).toEqual([64, 32, 16, 24, 20, 22, 21]);
    expect(codeReads(CG_STORAGE)).toEqual([64, 32, 16, 64, 32, 16, 24, 28, 30, 29]);
    await expect(internals.resolveContractDeployBlockNumber(HUB)).resolves.toBe(HUB_DEPLOY_BLOCK);
    await expect(internals.resolveContractDeployBlockNumber(CG_STORAGE))
      .resolves.toBe(CG_STORAGE_DEPLOY_BLOCK);
    expect(indexLines(warn)).toHaveLength(1);
    // 5 s to the second attempt, 4 s until it was refused, 10 s to the third.
    expect(indexLines(log)).toEqual([
      '[chain] one-log chain index started on attempt 3, 19s after its start was deferred',
    ]);
  });

  it('retries a start whose head probe was admitted too late to be answered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const governor = new RpcRequestGovernor({ startupJitterMs: 0 });
    const adapter = createAdapter({ governor });
    adapters.push(adapter);
    const internals = internalsOf(adapter);
    await validateChainIds(adapter);
    rpc.roundTripMs = 300;

    // Authority reads hold the queue until 150 ms before the probe's deadline.
    // The probe is then admitted and sent, and its answer comes 150 ms too late.
    const authorityReads = withDetachedRpcRequestContext(
      'foreground',
      () => startAuthorityReads(governor, 20, 100),
    );
    await vi.advanceTimersByTimeAsync(3_000);
    internals.startChainIndexRuntime();
    const starting = internals.chainIndexOwner.starting;
    await vi.advanceTimersByTimeAsync(3_850);
    expect(rpc.sent.filter(({ method }) => method === 'eth_blockNumber')).toEqual([]);
    await authorityReads.stop();
    await advanceUntil(() => indexLines(warn).length > 0, 200);

    // A timeout this time, not a refusal: the request did leave the node.
    expect(rpc.sent.filter(({ method }) => method === 'eth_blockNumber')).toHaveLength(1);
    expect(indexLines(warn)).toEqual([
      '[chain] one-log chain index start deferred (retrying, next attempt in 5s): '
        + 'chainIndex deploy block backend head probe timed out after 4000ms',
    ]);
    expect(adapter.chainEventLog).toBeUndefined();
    expect(internals.chainIndexOwner.starting).toBe(starting);

    rpc.roundTripMs = 0;
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS + 100);
    await starting;

    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(CG_STORAGE);
    expect(indexLines(warn)).toHaveLength(1);
    expect(indexLines(log)).toEqual([
      '[chain] one-log chain index started on attempt 2, 5s after its start was deferred',
    ]);
  });

  it('retries a start whose head probe every endpoint throttled, and attaches the log when they answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adapter = createAdapter({ secondEndpoint: true });
    adapters.push(adapter);
    const internals = internalsOf(adapter);
    await validateChainIds(adapter);
    const headProbes = (): string[] => rpc.sent
      .filter(({ method }) => method === 'eth_blockNumber')
      .map(({ url }) => url);

    let throttled = true;
    rpc.refusal = (method) => (throttled && method === 'eth_blockNumber' ? 429 : undefined);
    internals.startChainIndexRuntime();
    const starting = internals.chainIndexOwner.starting;
    await advanceUntil(() => indexLines(warn).length > 0, 500);

    // Each endpoint was asked once and said 429. No endpoint is left to anchor
    // the search, and that is all this attempt learned.
    expect(headProbes()).toEqual([RPC_URL, SECOND_RPC_URL]);
    expect(indexLines(warn)).toHaveLength(1);
    expect(indexLines(warn)[0]).toMatch(
      /^\[chain\] one-log chain index start deferred \(retrying, next attempt in 5s\): .*\b429\b/,
    );
    // The line names the endpoint by host only.
    expect(indexLines(warn)[0]).toContain('rpc-b.invalid:8545');
    expect(indexLines(warn)[0]).not.toContain('://');
    expect(rpc.sent.filter(({ method }) => method === 'eth_getCode')).toEqual([]);
    expect(adapter.chainEventLog).toBeUndefined();
    expect(internals.chainIndexOwner.starting).toBe(starting);

    throttled = false;
    await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS - 100);
    expect(headProbes()).toHaveLength(2);
    await advanceUntil(() => adapter.chainEventLog !== undefined, 500);
    await starting;

    expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(CG_STORAGE);
    await expect(internals.resolveContractDeployBlockNumber(HUB)).resolves.toBe(HUB_DEPLOY_BLOCK);
    await expect(internals.resolveContractDeployBlockNumber(CG_STORAGE))
      .resolves.toBe(CG_STORAGE_DEPLOY_BLOCK);
    expect(indexLines(warn)).toHaveLength(1);
    expect(indexLines(log)).toEqual([
      '[chain] one-log chain index started on attempt 2, 5s after its start was deferred',
    ]);
  });

  describe('with the deploy-block search stubbed', () => {
    function refuseContextGraphStorage(adapter: Adapter) {
      const search = vi.fn(async (address: string) => {
        if (address.toLowerCase() === CG_STORAGE) throw refused();
        return 1;
      });
      internalsOf(adapter).resolveContractDeployBlockNumber = search;
      return search;
    }

    const searchesFor = (search: { mock: { calls: unknown[][] } }, address: string): number => (
      search.mock.calls.filter(([searched]) => String(searched).toLowerCase() === address).length
    );

    it.each([
      ['a rotation of an indexed contract', (adapter: Adapter) => {
        internalsOf(adapter).applyHubRotationEventName('ContextGraphStorage');
      }],
      ['the bulk self-heal of every binding', (adapter: Adapter) => {
        internalsOf(adapter).invalidateAllBoundContracts();
      }],
    ])('lets %s retire a deferred start and builds around the new address', async (_name, retire) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const adapter = createAdapter();
      adapters.push(adapter);
      const internals = internalsOf(adapter);
      const search = refuseContextGraphStorage(adapter);

      internals.startChainIndexRuntime();
      const deferred = internals.chainIndexOwner.starting;
      await vi.advanceTimersByTimeAsync(0);
      expect(indexLines(warn)).toHaveLength(1);
      expect(searchesFor(search, CG_STORAGE)).toBe(1);

      retire(adapter);
      expect(internals.chainIndexOwner.starting).toBeUndefined();
      await deferred;

      // `initContracts` re-resolves the name; this assignment stands in for it.
      bindContextGraphStorage(adapter, ROTATED_CG_STORAGE);
      internals.startChainIndexRuntime();
      await internals.chainIndexOwner.starting;
      await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

      expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(ROTATED_CG_STORAGE);
      // The deferred start was built around the retired address. It is gone.
      expect(searchesFor(search, CG_STORAGE)).toBe(1);
      expect(searchesFor(search, ROTATED_CG_STORAGE)).toBe(1);
      expect(indexLines(warn)).toHaveLength(1);
      expect(indexLines(log)).toEqual([]);
    });

    it('keeps a deferred start through a rotation of a contract the log does not index', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const adapter = createAdapter();
      adapters.push(adapter);
      const internals = internalsOf(adapter);
      const search = vi.fn<(address: string) => Promise<number>>()
        .mockRejectedValueOnce(refused())
        .mockResolvedValue(1);
      internals.resolveContractDeployBlockNumber = search;

      internals.startChainIndexRuntime();
      const deferred = internals.chainIndexOwner.starting;
      await vi.advanceTimersByTimeAsync(0);
      internals.applyHubRotationEventName('ParametersStorage');
      // `initContracts` runs again after any rotation, and starts nothing new.
      internals.startChainIndexRuntime();
      expect(internals.chainIndexOwner.starting).toBe(deferred);

      await vi.advanceTimersByTimeAsync(CHAIN_INDEX_START_RETRY_INITIAL_DELAY_MS);
      await deferred;

      expect(adapter.chainEventLog!.contextGraphStorageAddress).toBe(CG_STORAGE);
      expect(indexLines(log)).toEqual([
        '[chain] one-log chain index started on attempt 2, 5s after its start was deferred',
      ]);
    });

    it('makes no further attempt once the adapter is destroyed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const adapter = createAdapter();
      const internals = internalsOf(adapter);
      const search = refuseContextGraphStorage(adapter);

      internals.startChainIndexRuntime();
      const deferred = internals.chainIndexOwner.starting;
      await vi.advanceTimersByTimeAsync(0);
      expect(searchesFor(search, CG_STORAGE)).toBe(1);

      adapter.destroy();
      await deferred;
      await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

      expect(searchesFor(search, CG_STORAGE)).toBe(1);
      expect(adapter.chainEventLog).toBeUndefined();
      expect(internals.chainIndexOwner.runtime).toBeUndefined();
      expect(indexLines(log)).toEqual([]);
    });

    it('still ends the start on a failure another attempt cannot change, with the line it always printed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const adapter = createAdapter();
      adapters.push(adapter);
      const internals = internalsOf(adapter);
      const search = vi.fn<(address: string) => Promise<number>>()
        .mockRejectedValueOnce(new Error(
          'chainIndex deploy block: eth_getCode for Hub failed after 3 attempts: execution reverted',
        ))
        .mockResolvedValue(1);
      internals.resolveContractDeployBlockNumber = search;

      internals.startChainIndexRuntime();
      await internals.chainIndexOwner.starting;
      await vi.advanceTimersByTimeAsync(10 * CHAIN_INDEX_START_RETRY_MAX_DELAY_MS);

      expect(indexLines(warn)).toEqual([
        '[chain] one-log chain index disabled: chainIndex deploy block: eth_getCode for Hub '
          + 'failed after 3 attempts: execution reverted',
      ]);
      expect(search).toHaveBeenCalledTimes(1);
      expect(adapter.chainEventLog).toBeUndefined();
      expect(internals.chainIndexOwner.starting).toBeUndefined();

      // As before, the next `initContracts` is what starts it again.
      internals.startChainIndexRuntime();
      await internals.chainIndexOwner.starting;
      expect(adapter.chainEventLog).toBeDefined();
    });
  });
});
