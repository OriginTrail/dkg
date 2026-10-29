// SPDX-License-Identifier: Apache-2.0

import { Contract, ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MULTICALL3_ADDRESS } from '../src/evm-background-read-batching.js';
import type { ReadOpts, RpcReadDescriptor } from '../src/rpc-failover-client.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import { withRpcRequestContext } from '../src/rpc-request-transport.js';
import { minimalConfig } from './context-graph-registry-scan-fixture.js';
import { MULTICALL3_RUNTIME_CODE } from './fixtures/multicall3-runtime-code.js';
import {
  STORAGE, AUTHORITY, type FakeGraph, tuple, nameHashFor, graphsUpTo, idsOf, sequence,
} from './context-graph-storage-enumeration-fixture.js';

describe('EVMChainAdapter.readContextGraphStorageRange in a background pass', () => {
  const storageInterface = new ethers.Interface(loadAbi('ContextGraphStorage'));
  const nonexistentToken = new ethers.Interface(['error ERC721NonexistentToken(uint256 tokenId)']);
  const HEAD = 9_000;
  const ANCHOR = 'listContextGraphsFromChain anchor';
  const LATEST_ID = 'listContextGraphsFromChain getLatestContextGraphId';
  const AGGREGATE = 'listContextGraphsFromChain aggregate3';
  const GET_CONTEXT_GRAPH = 'listContextGraphsFromChain getContextGraph';
  const GET_NAME_HASH = 'listContextGraphsFromChain getNameHash';
  const CODE_CHECK = 'multicall3.getCode';
  const background = <T>(fn: () => T): T => withRpcRequestContext({ requestClass: 'background' }, fn);

  afterEach(() => { delete process.env.DKG_DISABLE_RPC_READ_BATCHING; });

  /** An adapter over a fake chain, with every physical request counted at the transport. */
  function makeBackgroundAdapter(options: {
    graphs: Map<number, FakeGraph>;
    latestId: number;
    /** Bytecode at the Multicall3 address. */
    multicall3Code?: string;
    /** Ids whose views fail inside an aggregate request, but not on their own. */
    failsInAggregate?: number[];
    /** Ids whose views fail however they are read. */
    unreadable?: number[];
    finalityConfirmations?: number;
  }) {
    const adapter = new EVMChainAdapter(minimalConfig(
      options.finalityConfirmations === undefined
        ? {}
        : { finalityConfirmations: options.finalityConfirmations },
    ));
    const requests: Array<{ label: string; consumer: string | null; policy: ReadOpts['policy'] }> = [];
    /** Each aggregate request: its inner calls and the block it was pinned to. */
    const aggregates: Array<{
      calls: Array<{ target: string; allowFailure: boolean; callData: string }>;
      blockTag: unknown;
    }> = [];
    /** The block every read of a single view was pinned to. */
    const blockTags: unknown[] = [];
    const control: {
      aggregateFailure?: unknown;
      beforeAggregateAnswers?: () => void;
      /** Runs before a view of one id is answered on its own. */
      beforeSingleView?: (id: number) => void;
      /** Keeps the bytecode check out until it resolves. */
      codeCheckHeld?: Promise<void>;
    } = {};

    /** The fake chain's answer to one ContextGraphStorage view. */
    const view = (callData: string, insideAggregate: boolean): { success: boolean; returnData: string } => {
      const fragment = storageInterface.getFunction(callData.slice(0, 10))!;
      if (fragment.name === 'getLatestContextGraphId') {
        return {
          success: true,
          returnData: storageInterface.encodeFunctionResult(fragment, [BigInt(options.latestId)]),
        };
      }
      const [rawId] = storageInterface.decodeFunctionData(fragment, callData);
      const id = Number(rawId);
      const graph = options.graphs.get(id);
      if (options.unreadable?.includes(id) || (insideAggregate && options.failsInAggregate?.includes(id))) {
        return { success: false, returnData: '0x' };
      }
      if (fragment.name === 'getNameHash') {
        return {
          success: true,
          returnData: storageInterface.encodeFunctionResult(fragment, [graph?.nameHash ?? ethers.ZeroHash]),
        };
      }
      if (!graph) {
        return {
          success: false,
          returnData: nonexistentToken.encodeErrorResult('ERC721NonexistentToken', [rawId]),
        };
      }
      return { success: true, returnData: storageInterface.encodeFunctionResult(fragment, tuple(graph)) };
    };

    const internals = adapter as unknown as {
      contracts: { contextGraphStorage?: Contract };
      initialized: boolean;
      readProvider(label: string, fn: (provider: unknown) => Promise<unknown>, opts?: ReadOpts): Promise<unknown>;
      rpcFailover: {
        readContract(
          descriptor: RpcReadDescriptor,
          contract: Contract,
          fn: (contract: unknown) => Promise<unknown>,
          opts?: ReadOpts,
        ): Promise<unknown>;
      };
    };
    internals.contracts = { contextGraphStorage: new Contract(STORAGE, loadAbi('ContextGraphStorage')) };
    internals.initialized = true;
    internals.readProvider = async (label, fn, opts) => {
      requests.push({
        label,
        consumer: opts?.rpcUsageConsumer === undefined ? label : opts.rpcUsageConsumer,
        policy: opts?.policy,
      });
      if (label === CODE_CHECK) await control.codeCheckHeld;
      return fn({
        getCode: async () => options.multicall3Code ?? MULTICALL3_RUNTIME_CODE,
        getBlock: async (tag: number | 'latest') => {
          const number = tag === 'latest' ? HEAD : tag;
          return { number, hash: ethers.zeroPadValue(ethers.toBeHex(number), 32) };
        },
      });
    };
    internals.rpcFailover.readContract = async (descriptor, contract, fn, opts) => {
      requests.push({ label: descriptor.label, consumer: descriptor.consumer, policy: opts?.policy });
      if (contract.target === MULTICALL3_ADDRESS) {
        return fn({
          aggregate3: {
            staticCall: async (
              calls: Array<{ target: string; allowFailure: boolean; callData: string }>,
              overrides?: { blockTag?: number },
            ) => {
              aggregates.push({ calls, blockTag: overrides?.blockTag });
              control.beforeAggregateAnswers?.();
              if (control.aggregateFailure !== undefined) throw control.aggregateFailure;
              return calls.map(({ callData }) => view(callData, true));
            },
          },
        });
      }
      // A single view: what the contract method call returns, or throws, for the same answer.
      return fn(new Proxy({}, {
        get: (_target, method: string) => async (...args: unknown[]) => {
          const overrides = args.pop() as { blockTag: number };
          blockTags.push(overrides.blockTag);
          if (args.length > 0) control.beforeSingleView?.(Number(args[0]));
          const { success, returnData } = view(storageInterface.encodeFunctionData(method, args), false);
          if (!success) {
            throw Object.assign(new Error(`execution reverted (${method})`), {
              code: 'CALL_EXCEPTION',
              data: returnData,
            });
          }
          const result = storageInterface.decodeFunctionResult(method, returnData);
          return result.length === 1 ? result[0] : result;
        },
      }));
    };
    const labels = () => requests.map(({ label }) => label);
    return { adapter, requests, labels, aggregates, blockTags, control };
  }

  it('reads 37 ids in four requests, after one bytecode check per process', async () => {
    const { adapter, requests, labels, aggregates, blockTags } = makeBackgroundAdapter({
      graphs: graphsUpTo(37),
      latestId: 37,
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 64 }));

    expect(idsOf(range)).toEqual(sequence(1, 37));
    expect(range.nextId).toBe(38n);
    expect(range.anchorBlockNumber).toBe(HEAD);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, AGGREGATE]);
    // 32 ids, then the other 5: two inner calls per id, each allowed to fail on its own.
    expect(aggregates.map(({ calls }) => calls.length)).toEqual([64, 10]);
    expect(aggregates.flatMap(({ calls }) => calls).every(
      ({ target, allowFailure }) => target === STORAGE.toLowerCase() && allowFailure === true,
    )).toBe(true);
    // Every view is pinned to the anchor, in a request or on its own.
    expect(aggregates.map(({ blockTag }) => blockTag)).toEqual([HEAD, HEAD]);
    expect(blockTags).toEqual([HEAD]);

    // A later pass re-reads them (the daily refresh) without another bytecode check.
    requests.length = 0;
    await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 37 }));
    expect(labels()).toEqual([ANCHOR, LATEST_ID, AGGREGATE, AGGREGATE]);

    // A pass with nothing new sends no aggregate request.
    requests.length = 0;
    const quiet = await background(() => adapter.readContextGraphStorageRange({ fromId: 38n, maxIds: 64 }));
    expect(quiet.entries).toEqual([]);
    expect(labels()).toEqual([ANCHOR, LATEST_ID]);
  });

  it('resolves the current run before starting a later aggregate request', async () => {
    const { adapter, labels, aggregates } = makeBackgroundAdapter({
      graphs: graphsUpTo(70), latestId: 70, failsInAggregate: [3],
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 70 }));

    expect(idsOf(range)).toEqual(sequence(1, 70));
    expect(aggregates.map(({ calls }) => calls.length)).toEqual([64, 64, 12]);
    expect(labels()).toEqual([
      ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE,
      GET_CONTEXT_GRAPH, GET_NAME_HASH, AGGREGATE, AGGREGATE,
    ]);
  });

  it('sends no later aggregate when an early run has an unreadable id', async () => {
    const { adapter, labels, aggregates } = makeBackgroundAdapter({
      graphs: graphsUpTo(70), latestId: 70, unreadable: [3],
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 70 }));

    expect(idsOf(range)).toEqual([1, 2]);
    expect(range.nextId).toBe(3n);
    expect(range.latestId).toBe(70n);
    expect(aggregates.map(({ calls }) => calls.length)).toEqual([64]);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);
  });

  it('pins the aggregate request to the finality anchor, not the head', async () => {
    const { adapter, aggregates, blockTags } = makeBackgroundAdapter({
      graphs: graphsUpTo(3),
      latestId: 3,
      finalityConfirmations: 3,
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 3 }));

    expect(range.anchorBlockNumber).toBe(HEAD - 2);
    expect(aggregates.map(({ blockTag }) => blockTag)).toEqual([HEAD - 2]);
    expect(blockTags).toEqual([HEAD - 2]);
    expect(idsOf(range)).toEqual([1, 2, 3]);
  });

  it('bills the aggregate request to the enumeration consumer, under the same read cap as its other reads', async () => {
    const { adapter, requests } = makeBackgroundAdapter({ graphs: graphsUpTo(3), latestId: 3 });

    await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 3 }));

    expect(requests).toEqual([
      { label: ANCHOR, consumer: 'listContextGraphsFromChain', policy: 'wideLogScan' },
      { label: LATEST_ID, consumer: 'listContextGraphsFromChain', policy: 'wideLogScan' },
      // The check may wait out the closed background budget at start.
      { label: CODE_CHECK, consumer: CODE_CHECK, policy: 'watchdogWideLogScan' },
      { label: AGGREGATE, consumer: 'listContextGraphsFromChain', policy: 'wideLogScan' },
    ]);
  });

  it('returns the range a foreground read gives, which still reads id by id', async () => {
    const graphs = graphsUpTo(5);
    graphs.set(2, { ...graphs.get(2), active: false, publishPolicy: 0, publishAuthority: AUTHORITY });
    const { adapter, requests, labels } = makeBackgroundAdapter({ graphs, latestId: 5 });

    const foreground = await adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 5 });
    const foregroundLabels = labels();
    requests.length = 0;
    const batched = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 5 }));

    expect(batched).toEqual(foreground);
    expect(foregroundLabels.slice(0, 2)).toEqual([ANCHOR, LATEST_ID]);
    expect(foregroundLabels.filter((label) => label === GET_CONTEXT_GRAPH)).toHaveLength(5);
    expect(foregroundLabels.filter((label) => label === GET_NAME_HASH)).toHaveLength(5);
    expect(foregroundLabels).toHaveLength(12);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it('reads an id whose views fail inside the request on its own, and the rest from the request', async () => {
    const { adapter, labels } = makeBackgroundAdapter({
      graphs: graphsUpTo(10),
      latestId: 10,
      failsInAggregate: [5],
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 }));

    expect(idsOf(range)).toEqual(sequence(1, 10));
    expect(range.entries[4]!.nameHash).toBe(nameHashFor(5).toLowerCase());
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);
  });

  it('keeps the ids before one that cannot be read at all, and reports the failure for that id', async () => {
    const { adapter, requests, labels } = makeBackgroundAdapter({
      graphs: graphsUpTo(10),
      latestId: 10,
      unreadable: [5],
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 }));

    // The ids before it are returned; a cursor stops at the id that was not read.
    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(range.nextId).toBe(5n);
    expect(range.latestId).toBe(10n);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);

    requests.length = 0;
    await expect(background(() => adapter.readContextGraphStorageRange({ fromId: 5n, maxIds: 6 })))
      .rejects.toMatchObject({ code: 'CALL_EXCEPTION' });
    // Asked for in a request, then on its own; ids 6..10 are not read one by one.
    expect(labels()).toEqual([ANCHOR, LATEST_ID, AGGREGATE, GET_CONTEXT_GRAPH, GET_NAME_HASH]);
  });

  it('ends the range at an id the chain does not hold yet, without reading it again', async () => {
    const graphs = graphsUpTo(10);
    graphs.delete(7);
    const { adapter, labels } = makeBackgroundAdapter({ graphs, latestId: 10 });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 10 }));

    expect(idsOf(range)).toEqual(sequence(1, 6));
    expect(range.nextId).toBe(7n);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it('reads id by id when the kill switch is set, without a bytecode check', async () => {
    const { adapter, labels, aggregates } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    process.env.DKG_DISABLE_RPC_READ_BATCHING = '1';

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }));

    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(aggregates).toEqual([]);
    expect(labels()).not.toContain(CODE_CHECK);
    expect(labels()).toHaveLength(2 + 2 * 4);
  });

  it('reads id by id on a chain without the aggregate contract, checking its bytecode once', async () => {
    const { adapter, requests, labels, aggregates } = makeBackgroundAdapter({
      graphs: graphsUpTo(4),
      latestId: 4,
      multicall3Code: '0x',
    });

    const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }));

    expect(idsOf(range)).toEqual([1, 2, 3, 4]);
    expect(aggregates).toEqual([]);
    expect(labels().slice(0, 3)).toEqual([ANCHOR, LATEST_ID, CODE_CHECK]);
    expect(labels()).toHaveLength(3 + 2 * 4);

    requests.length = 0;
    await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }));
    expect(labels()).not.toContain(CODE_CHECK);
  });

  it('reads id by id when the aggregate request fails, trying it once for the range and saying so', async () => {
    const { adapter, labels, aggregates, control } = makeBackgroundAdapter({
      graphs: graphsUpTo(40),
      latestId: 40,
    });
    control.aggregateFailure = new Error('https://rpc.example/v2/secret-key rejected the call');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const range = await background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 40 }));

      expect(idsOf(range)).toEqual(sequence(1, 40));
      expect(aggregates).toHaveLength(1);
      expect(labels().filter((label) => label === GET_CONTEXT_GRAPH)).toHaveLength(40);
      expect(labels().filter((label) => label === GET_NAME_HASH)).toHaveLength(40);
      // One line for the operator, with any endpoint URL reduced to its host.
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[chain] listContextGraphsFromChain: aggregate request failed, reading id by id: '
          + 'rpc.example rejected the call',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('rejects when the node itself refuses the aggregate request, without reading id by id', async () => {
    const { adapter, labels, control } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    const refusal = new RpcRequestGovernorQueueFullError(256);
    control.aggregateFailure = refusal;

    await expect(background(() => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 })))
      .rejects.toBe(refusal);
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it.each([
    ['its own signal', true],
    ['the signal of the pass it runs in', false],
  ])('rejects with the cancellation when %s ends the aggregate request', async (_name, ownSignal) => {
    const { adapter, labels, control } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    const controller = new AbortController();
    control.beforeAggregateAnswers = () => controller.abort(new Error('pass ended'));
    control.aggregateFailure = new Error('request aborted');

    const read = ownSignal
      ? background(() => adapter.readContextGraphStorageRange({
          fromId: 1n,
          maxIds: 4,
          signal: controller.signal,
        }))
      : withRpcRequestContext(
          { requestClass: 'background', signal: controller.signal },
          () => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 4 }),
        );

    await expect(read).rejects.toThrow('pass ended');
    expect(labels()).toEqual([ANCHOR, LATEST_ID, CODE_CHECK, AGGREGATE]);
  });

  it('rejects, rather than return the ids read so far, when the pass is cancelled at a later request', async () => {
    const { adapter, aggregates, control } = makeBackgroundAdapter({ graphs: graphsUpTo(40), latestId: 40 });
    const controller = new AbortController();
    control.beforeAggregateAnswers = () => {
      if (aggregates.length < 2) return;
      controller.abort(new Error('pass ended'));
      throw new Error('request aborted');
    };

    // Cancelled through the request context alone: the range has no signal of its own.
    await expect(withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 64 }),
    )).rejects.toThrow('pass ended');
    expect(aggregates).toHaveLength(2);
  });

  it('rejects when the pass is cancelled while ids are read one by one', async () => {
    const { adapter, control } = makeBackgroundAdapter({ graphs: graphsUpTo(20), latestId: 20 });
    process.env.DKG_DISABLE_RPC_READ_BATCHING = '1';
    const controller = new AbortController();
    control.beforeSingleView = (id) => {
      if (id !== 6) return;
      controller.abort(new Error('pass ended'));
      throw new Error('request aborted');
    };

    await expect(withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => adapter.readContextGraphStorageRange({ fromId: 1n, maxIds: 20 }),
    )).rejects.toThrow('pass ended');
  });

  it('stops waiting for the bytecode check when the range\'s own signal ends', async () => {
    const { adapter, labels, control } = makeBackgroundAdapter({ graphs: graphsUpTo(4), latestId: 4 });
    let releaseCodeCheck!: () => void;
    control.codeCheckHeld = new Promise<void>((resolve) => { releaseCodeCheck = resolve; });
    const controller = new AbortController();

    const read = background(() => adapter.readContextGraphStorageRange({
      fromId: 1n,
      maxIds: 4,
      signal: controller.signal,
    }));
    const outcome = read.then(() => 'resolved', (error: Error) => error.message);
    await vi.waitFor(() => expect(labels()).toContain(CODE_CHECK));
    controller.abort(new Error('pass ended'));

    // The check is still out; the range does not wait for it.
    await expect(Promise.race([
      outcome,
      new Promise((resolve) => { setTimeout(() => resolve('still waiting for the bytecode check'), 500); }),
    ])).resolves.toBe('pass ended');
    releaseCodeCheck();
  });
});

