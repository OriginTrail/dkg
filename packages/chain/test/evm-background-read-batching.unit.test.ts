// SPDX-License-Identifier: Apache-2.0

/**
 * Background contract views through Multicall3.
 *
 * Three questions run through these tests: which reads may leave in a batch,
 * whether a batched read returns exactly what the direct read would have, and
 * whose request policy each physical request runs under.
 */

import { Contract, ethers } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BATCHABLE_BACKGROUND_READ_LABELS,
  BackgroundContractReadBatching,
  MULTICALL3_ADDRESS,
  MULTICALL3_AGGREGATE_READ,
  MULTICALL3_RUNTIME_CODE_HASH,
  drainRpcReadBatchingWindow,
  isCanonicalMulticall3Code,
} from '../src/evm-background-read-batching.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import type { ReadOpts, RpcReadDescriptor } from '../src/rpc-failover-client.js';
import { RpcRequestGovernorQueueFullError } from '../src/rpc-request-governor.js';
import {
  activeRpcRequestContext,
  withRpcRequestContext,
  type RpcRequestContext,
} from '../src/rpc-request-transport.js';
import { captureRpcUsageIssuerContext, withRpcUsageConsumer } from '../src/rpc-usage.js';
import { MULTICALL3_RUNTIME_CODE } from './fixtures/multicall3-runtime-code.js';

const KAS = `0x${'a1'.repeat(20)}`;
const CG_STORAGE = `0x${'c9'.repeat(20)}`;
const ROOT = `0x${'5e'.repeat(32)}`;
const PUBLISHER = ethers.getAddress(`0x${'b0'.repeat(20)}`);

const kas = new Contract(KAS, loadAbi('DKGKnowledgeAssets'));
const cgStorage = new Contract(CG_STORAGE, loadAbi('ContextGraphStorage'));

const turn = () => new Promise<void>((resolve) => { setImmediate(resolve); });
const background = <T>(fn: () => T): T => withRpcRequestContext({ requestClass: 'background' }, fn);

/** What the fake chain answers a view with, as ABI-encoded return data. */
function answer(target: string, callData: string): { success: boolean; returnData: string } {
  const contract = target.toLowerCase() === KAS ? kas : cgStorage;
  const fragment = contract.interface.getFunction(callData.slice(0, 10))!;
  const args = contract.interface.decodeFunctionData(fragment, callData);
  switch (fragment.name) {
    case 'getLatestMerkleRoot':
      if (args[0] === 404n) return { success: false, returnData: '0x' };
      return { success: true, returnData: contract.interface.encodeFunctionResult(fragment, [ROOT]) };
    case 'getLatestMerkleRootPublisher':
      return { success: true, returnData: contract.interface.encodeFunctionResult(fragment, [PUBLISHER]) };
    case 'getKnowledgeAssetUpdateContext':
      return {
        success: true,
        returnData: contract.interface.encodeFunctionResult(fragment, [3n, 1n, 4_096n, 12n, 500n, false, 17]),
      };
    case 'kaToContextGraph':
      return { success: true, returnData: contract.interface.encodeFunctionResult(fragment, [42n]) };
    case 'getContextGraphKaAt':
      return {
        success: true,
        returnData: contract.interface.encodeFunctionResult(fragment, [1_000n + (args[1] as bigint)]),
      };
    default:
      throw new Error(`unexpected view ${fragment.name}`);
  }
}

interface Harness {
  batching: BackgroundContractReadBatching;
  /** Each aggregate request: its descriptor, inner calls and the request context it ran under. */
  aggregates: Array<{
    descriptor: RpcReadDescriptor;
    opts: ReadOpts | undefined;
    calls: Array<{ target: string; allowFailure: boolean; callData: string }>;
    /** The call overrides, when the request was pinned to a block. */
    overrides: { blockTag?: number } | undefined;
    context: RpcRequestContext;
    usage: ReturnType<typeof captureRpcUsageIssuerContext>;
  }>;
  codeReads: string[];
  /** The read options each bytecode check was issued with. */
  codeReadOpts: Array<ReadOpts | undefined>;
  /** Keep bytecode checks out until the returned function is called. */
  holdCodeReads(): () => void;
  setCode(code: string | Error): void;
  failAggregateWith(error: unknown | undefined): void;
  advance(ms: number): void;
  setEnabled(enabled: boolean): void;
}

function harness(initialCode: string | Error = MULTICALL3_RUNTIME_CODE): Harness {
  let code = initialCode;
  let aggregateFailure: unknown;
  let enabled = true;
  let now = 1_000_000;
  const aggregates: Harness['aggregates'] = [];
  const codeReads: string[] = [];
  const codeReadOpts: Array<ReadOpts | undefined> = [];
  let codeReadsHeld: Promise<void> | undefined;
  const batching = new BackgroundContractReadBatching({
    readContract: async <T>(
      descriptor: RpcReadDescriptor, contract: Contract, fn: (c: Contract) => Promise<T>, opts?: ReadOpts,
    ) => {
      expect(contract.target).toBe(MULTICALL3_ADDRESS);
      return fn({
        aggregate3: {
          staticCall: async (
            calls: Array<{ target: string; allowFailure: boolean; callData: string }>,
            overrides?: { blockTag?: number },
          ) => {
            aggregates.push({
              descriptor, opts, calls, overrides,
              context: activeRpcRequestContext(), usage: captureRpcUsageIssuerContext(),
            });
            if (aggregateFailure !== undefined) throw aggregateFailure;
            return calls.map(({ target, callData }) => answer(target, callData));
          },
        },
      } as unknown as Contract);
    },
    readProvider: async <T>(
      label: string, fn: (provider: JsonRpcProvider) => Promise<T>, opts?: ReadOpts,
    ) => {
      codeReads.push(label);
      codeReadOpts.push(opts);
      await codeReadsHeld;
      return fn({
        getCode: async (address: string) => {
          expect(address).toBe(MULTICALL3_ADDRESS);
          if (code instanceof Error) throw code;
          return code;
        },
      } as unknown as JsonRpcProvider);
    },
    isEnabled: () => enabled,
    now: () => now,
  });
  return {
    batching,
    aggregates,
    codeReads,
    codeReadOpts,
    holdCodeReads: () => {
      let release!: () => void;
      codeReadsHeld = new Promise<void>((resolve) => { release = resolve; });
      return () => {
        codeReadsHeld = undefined;
        release();
      };
    },
    setCode: (next) => { code = next; },
    failAggregateWith: (error) => { aggregateFailure = error; },
    advance: (ms) => { now += ms; },
    setEnabled: (next) => { enabled = next; },
  };
}

/** A read as the adapter passes it, with a direct path that records how it ran. */
function view<T = unknown>(
  contract: Contract,
  label: string,
  method: string,
  args: readonly unknown[],
  opts?: ReadOpts,
) {
  const direct = vi.fn(async (): Promise<T> => {
    const { success, returnData } = answer(
      contract.target as string,
      contract.interface.encodeFunctionData(method, args),
    );
    if (!success) throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
    const result = contract.interface.decodeFunctionResult(method, returnData);
    return (result.length === 1 ? result[0] : result) as T;
  });
  return { contract, label, method, args, ...(opts ? { opts } : {}), direct };
}

/** Let the bytecode check triggered by a first read settle. */
async function primed(h: Harness): Promise<Harness> {
  expect(background(() => h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]))))
    .toBeUndefined();
  await turn();
  return h;
}

beforeEach(() => { drainRpcReadBatchingWindow(); });

describe('the canonical Multicall3 bytecode check', () => {
  it('accepts the deployed runtime code and nothing else', () => {
    expect(ethers.keccak256(MULTICALL3_RUNTIME_CODE)).toBe(MULTICALL3_RUNTIME_CODE_HASH);
    expect(isCanonicalMulticall3Code(MULTICALL3_RUNTIME_CODE)).toBe(true);
    expect(isCanonicalMulticall3Code('0x')).toBe(false);
    expect(isCanonicalMulticall3Code(`${MULTICALL3_RUNTIME_CODE}00`)).toBe(false);
    expect(isCanonicalMulticall3Code('not hex')).toBe(false);
    expect(isCanonicalMulticall3Code(undefined)).toBe(false);
  });

  it('sends reads directly until the check has passed, and checks once', async () => {
    const h = harness();
    const first = view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]);

    expect(background(() => h.batching.tryRead(first))).toBeUndefined();
    expect(background(() => h.batching.tryRead(first))).toBeUndefined();
    await turn();
    await expect(background(() => h.batching.tryRead(first))).resolves.toBe(ROOT);

    expect(h.codeReads).toEqual(['multicall3.getCode']);
  });

  it.each([
    ['no code at the address', '0x'],
    ['other code at the address', '0x6080604052'],
  ])('keeps the direct reads on a chain with %s, and looks again every ten minutes', async (_name, code) => {
    const h = await primed(harness(code));
    const read = () => background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]),
    ));

    h.advance(10 * 60_000 - 1);
    expect(read()).toBeUndefined();
    expect(h.codeReads).toHaveLength(1);

    h.advance(1);
    expect(read()).toBeUndefined();
    await turn();
    expect(h.codeReads).toHaveLength(2);
    expect(read()).toBeUndefined();
    expect(h.aggregates).toEqual([]);

    // The contract appears, or the first answer came from an endpoint without the state.
    h.setCode(MULTICALL3_RUNTIME_CODE);
    h.advance(10 * 60_000);
    expect(read()).toBeUndefined();
    await turn();
    await expect(read()).resolves.toBe(ROOT);
  });

  it('checks again a minute after a check that could not be read', async () => {
    const h = await primed(harness(new Error('endpoint unavailable')));
    const read = () => background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]),
    ));

    h.advance(59_999);
    expect(read()).toBeUndefined();
    expect(h.codeReads).toHaveLength(1);

    h.setCode(MULTICALL3_RUNTIME_CODE);
    h.advance(1);
    expect(read()).toBeUndefined();
    await turn();
    expect(h.codeReads).toHaveLength(2);
    await expect(read()).resolves.toBe(ROOT);
  });

  it('runs the check as its own background request, not under the read that started it', async () => {
    const contexts: RpcRequestContext[] = [];
    const batching = new BackgroundContractReadBatching({
      readContract: async () => { throw new Error('not reached'); },
      readProvider: async () => {
        contexts.push(activeRpcRequestContext());
        return '0x' as never;
      },
      isEnabled: () => true,
    });
    const controller = new AbortController();

    withRpcRequestContext({ requestClass: 'background', signal: controller.signal, admissionPriority: 'authority' },
      () => batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n])));
    await turn();

    expect(contexts).toEqual([{ requestClass: 'background' }]);
  });
});

describe('which reads leave in a batch', () => {
  it('batches only the listed views', async () => {
    const h = await primed(harness());

    expect(background(() => h.batching.tryRead(
      view(kas, 'kas.getCatalogLeafCount', 'getLatestMerkleRoot', [1n]),
    ))).toBeUndefined();
    expect([...BATCHABLE_BACKGROUND_READ_LABELS].sort()).toEqual([
      'cgStorage.getContextGraphKaAt',
      'cgStorage.getContextGraphKaCount',
      'cgStorage.kaToContextGraph',
      'kas.getKnowledgeAssetUpdateContext',
      'kas.getLatestMerkleRoot',
      'kas.getLatestMerkleRootAuthor',
      'kas.getLatestMerkleRootPublisher',
    ]);
  });

  it('leaves a foreground read alone', async () => {
    const h = await primed(harness());
    const read = view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]);

    expect(h.batching.tryRead(read)).toBeUndefined();
    expect(withRpcRequestContext({ requestClass: 'foreground' }, () => h.batching.tryRead(read)))
      .toBeUndefined();
    expect(h.aggregates).toEqual([]);
  });

  it.each([
    ['a named timeout policy', { policy: 'watchdogPointRead' }],
    ['its own retry classifier', { isRetryable: () => false }],
    ['a consumer override', { rpcUsageConsumer: null }],
    ['the tip-read opt-out', { skipPreferred: true }],
    ['an empty-result rule', { isEmptyResult: () => false }],
    ['an endpoint-set retry', { endpointSetRetry: 'all-throttled' }],
    ['an operation deadline', { deadlineMs: Date.now() + 1_000 }],
  ] as const)('leaves a read with %s alone', async (_name, opts) => {
    const h = await primed(harness());

    expect(background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n], opts as ReadOpts),
    ))).toBeUndefined();
  });

  it('honours the kill switch on every read', async () => {
    const h = await primed(harness());
    const read = () => background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]),
    ));

    h.setEnabled(false);
    expect(read()).toBeUndefined();
    h.setEnabled(true);
    await expect(read()).resolves.toBe(ROOT);
  });

  it('leaves a call it cannot encode to the direct read', async () => {
    const h = await primed(harness());

    expect(background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', ['not a number']),
    ))).toBeUndefined();
    expect(background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'noSuchView', [1n]),
    ))).toBeUndefined();
    expect(background(() => h.batching.tryRead({
      ...view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]),
      contract: new Contract({ getAddress: async () => KAS }, loadAbi('DKGKnowledgeAssets')),
    }))).toBeUndefined();
  });
});

describe('what a batched read returns', () => {
  it('returns what the direct read returns, for one output and for several', async () => {
    const h = await primed(harness());
    const reads = [
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [7n]),
      view(kas, 'kas.getKnowledgeAssetUpdateContext', 'getKnowledgeAssetUpdateContext', [7n]),
      view(kas, 'kas.getLatestMerkleRootPublisher', 'getLatestMerkleRootPublisher', [7n]),
      view(cgStorage, 'cgStorage.kaToContextGraph', 'kaToContextGraph', [7n]),
      view(cgStorage, 'cgStorage.getContextGraphKaAt', 'getContextGraphKaAt', [42n, 5n]),
    ];

    const batched = await Promise.all(background(() => reads.map((read) => h.batching.tryRead(read)!)));
    const direct = await Promise.all(reads.map((read) => read.direct()));

    expect(batched).toEqual(direct);
    expect(batched[0]).toBe(ROOT);
    expect(batched[3]).toBe(42n);
    expect(batched[4]).toBe(1_005n);
    const context = batched[1] as ethers.Result;
    expect(context.merkleRootsCount).toBe(3n);
    expect(context.byteSize).toBe(4_096n);
    expect(context.merkleLeafCount).toBe(17n);
    // One request for all five, each inner call allowed to fail on its own.
    expect(h.aggregates).toHaveLength(1);
    expect(h.aggregates[0]!.descriptor).toEqual({
      label: MULTICALL3_AGGREGATE_READ, consumer: MULTICALL3_AGGREGATE_READ,
    });
    expect(h.aggregates[0]!.calls.map(({ target, allowFailure }) => ({ target, allowFailure }))).toEqual([
      { target: KAS, allowFailure: true },
      { target: KAS, allowFailure: true },
      { target: KAS, allowFailure: true },
      { target: CG_STORAGE, allowFailure: true },
      { target: CG_STORAGE, allowFailure: true },
    ]);
    for (const read of reads) expect(read.direct).toHaveBeenCalledTimes(1);
  });

  it('lets the direct read report an inner call that reverted', async () => {
    const h = await primed(harness());
    const reverting = view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [404n]);
    const fine = view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]);

    const settled = await Promise.allSettled(background(() => [
      h.batching.tryRead(reverting)!, h.batching.tryRead(fine)!,
    ]));

    expect(settled[0]).toMatchObject({ status: 'rejected', reason: { code: 'CALL_EXCEPTION' } });
    expect(settled[1]).toEqual({ status: 'fulfilled', value: ROOT });
    expect(reverting.direct).toHaveBeenCalledTimes(1);
    expect(fine.direct).not.toHaveBeenCalled();
  });

  it('fails the reads with the node\'s own admission refusal, and keeps batching', async () => {
    const h = await primed(harness());
    const refusal = new RpcRequestGovernorQueueFullError(256);
    h.failAggregateWith(refusal);
    const read = view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]);

    await expect(background(() => h.batching.tryRead(read))).rejects.toBe(refusal);
    expect(read.direct).not.toHaveBeenCalled();

    h.failAggregateWith(undefined);
    await expect(background(() => h.batching.tryRead(read))).resolves.toBe(ROOT);
  });

  it('answers directly when the aggregate request fails, and pauses after three in a row', async () => {
    const h = await primed(harness());
    h.failAggregateWith(new Error('endpoint rejected the call'));
    const read = () => view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]);

    for (let failure = 0; failure < 3; failure += 1) {
      const attempt = read();
      await expect(background(() => h.batching.tryRead(attempt))).resolves.toBe(ROOT);
      expect(attempt.direct).toHaveBeenCalledTimes(1);
    }
    expect(h.aggregates).toHaveLength(3);
    // Paused: the adapter is told to issue the read itself.
    expect(background(() => h.batching.tryRead(read()))).toBeUndefined();

    h.failAggregateWith(undefined);
    h.advance(60_000);
    await expect(background(() => h.batching.tryRead(read()))).resolves.toBe(ROOT);
    expect(h.aggregates).toHaveLength(4);
  });
});

describe('whose request each physical request is', () => {
  it('sends the aggregate request as the adapter\'s own background request', async () => {
    const h = await primed(harness());
    const controller = new AbortController();

    await withRpcUsageConsumer('someCaller', () => withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal, admissionPriority: 'authority', onProgress: () => undefined },
      () => h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n])),
    ));

    expect(h.aggregates).toHaveLength(1);
    expect(h.aggregates[0]!.context).toEqual({ requestClass: 'background' });
    expect(h.aggregates[0]!.usage).toEqual({});
    // No caller's signal reaches it, so its own policy bounds it: the one that
    // is capped on a node with a single endpoint as well.
    expect(h.aggregates[0]!.opts).toEqual({ policy: 'watchdogPointRead' });
  });

  it('runs a fallback under its caller\'s request policy and attribution', async () => {
    const h = await primed(harness());
    const controller = new AbortController();
    const seen: Array<{ context: RpcRequestContext; usage: ReturnType<typeof captureRpcUsageIssuerContext> }> = [];
    const reverting = {
      ...view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [404n]),
      direct: vi.fn(async () => {
        seen.push({ context: activeRpcRequestContext(), usage: captureRpcUsageIssuerContext() });
        return ROOT;
      }),
    };

    await withRpcUsageConsumer('vmReconcile', () => withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => h.batching.tryRead(reverting),
    ));

    expect(seen).toHaveLength(1);
    expect(seen[0]!.context.requestClass).toBe('background');
    expect(seen[0]!.context.signal).toBe(controller.signal);
    expect(seen[0]!.usage).toEqual({ consumer: 'vmReconcile' });
  });

  it('ends a caller\'s wait on either of its signals', async () => {
    const h = await primed(harness());
    const ambient = new AbortController();
    const own = new AbortController();

    const byAmbient = withRpcRequestContext(
      { requestClass: 'background', signal: ambient.signal },
      () => h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]))!,
    );
    const byOwn = background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [2n], { signal: own.signal }),
    )!);
    ambient.abort(new Error('pass ended'));
    own.abort(new Error('read cancelled'));

    await expect(byAmbient).rejects.toThrow('pass ended');
    await expect(byOwn).rejects.toThrow('read cancelled');
  });

  it('notifies the caller\'s progress observer once for a read answered from a batch', async () => {
    const h = await primed(harness());
    const onProgress = vi.fn();

    await withRpcRequestContext({ requestClass: 'background', onProgress }, () => Promise.all([
      h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n])),
      h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [2n])),
    ]));

    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('does not notify a caller whose own signal already ended', async () => {
    const h = await primed(harness());
    const onProgress = vi.fn();
    const controller = new AbortController();

    const pending = withRpcRequestContext(
      { requestClass: 'background', onProgress, signal: controller.signal },
      () => h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]))!,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await turn();
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('an aggregate request a caller sends for itself', () => {
  const calls = [
    { target: CG_STORAGE, callData: cgStorage.interface.encodeFunctionData('kaToContextGraph', [7n]) },
    { target: KAS, callData: kas.interface.encodeFunctionData('getLatestMerkleRoot', [404n]) },
  ];
  const expectedResults = calls.map(({ target, callData }) => answer(target, callData));

  /** A sender that records the request context and usage attribution it ran under. */
  function sender(h: Harness) {
    const sent: Array<{ context: RpcRequestContext; usage: ReturnType<typeof captureRpcUsageIssuerContext> }> = [];
    const send = vi.fn(async (
      multicall3: Contract,
      request: (multicall3: Contract) => Promise<readonly { success: boolean; returnData: string }[]>,
    ) => {
      expect(multicall3.target).toBe(MULTICALL3_ADDRESS);
      sent.push({ context: activeRpcRequestContext(), usage: captureRpcUsageIssuerContext() });
      return request({
        aggregate3: {
          staticCall: async (
            inner: Array<{ target: string; allowFailure: boolean; callData: string }>,
            overrides?: { blockTag?: number },
          ) => {
            h.aggregates.push({
              descriptor: { label: 'caller', consumer: 'caller' },
              opts: undefined,
              calls: inner,
              overrides,
              context: activeRpcRequestContext(),
              usage: captureRpcUsageIssuerContext(),
            });
            return inner.map(({ target, callData }) => answer(target, callData));
          },
        },
      } as unknown as Contract);
    });
    return { send, sent };
  }

  it('evaluates the calls at the given block, each allowed to fail on its own', async () => {
    const h = await primed(harness());
    const { send } = sender(h);

    const results = await background(() => h.batching.aggregateAtBlock(() => calls, 4_242, send));

    expect(results).toEqual(expectedResults);
    expect(results!.map(({ success }) => success)).toEqual([true, false]);
    expect(h.aggregates).toHaveLength(1);
    expect(h.aggregates[0]!.overrides).toEqual({ blockTag: 4_242 });
    expect(h.aggregates[0]!.calls).toEqual(calls.map((call) => ({ ...call, allowFailure: true })));
  });

  it('leaves a shared batch unpinned, as before', async () => {
    const h = await primed(harness());

    await background(() => h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n])));

    expect(h.aggregates).toHaveLength(1);
    expect(h.aggregates[0]!.overrides).toBeUndefined();
  });

  it('waits for the bytecode check instead of turning the first caller away', async () => {
    const h = harness();
    const release = h.holdCodeReads();
    const first = sender(h);
    const second = sender(h);

    const pending = background(() => Promise.all([
      h.batching.aggregateAtBlock(() => calls, 1, first.send),
      h.batching.aggregateAtBlock(() => calls, 1, second.send),
    ]));
    await turn();
    // Nothing is sent, and no second check starts, while the answer is out.
    expect(first.send).not.toHaveBeenCalled();
    expect(h.codeReads).toEqual(['multicall3.getCode']);
    // A batchable view arriving meanwhile goes out directly, as it always did.
    expect(background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]),
    ))).toBeUndefined();

    release();
    await expect(pending).resolves.toEqual([expectedResults, expectedResults]);
    expect(h.codeReads).toEqual(['multicall3.getCode']);
  });

  it('reads the bytecode under a cap that outlasts the closed background budget at start', async () => {
    const h = await primed(harness());

    expect(h.codeReadOpts).toEqual([{ policy: 'watchdogWideLogScan' }]);
  });

  it('sends the request in the caller\'s own request context and attribution', async () => {
    const h = await primed(harness());
    const { send, sent } = sender(h);
    const controller = new AbortController();

    await withRpcUsageConsumer('listContextGraphsFromChain', () => withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => h.batching.aggregateAtBlock(() => calls, 1, send),
    ));

    expect(sent).toHaveLength(1);
    expect(sent[0]!.context.requestClass).toBe('background');
    expect(sent[0]!.context.signal).toBe(controller.signal);
    expect(sent[0]!.usage).toEqual({ consumer: 'listContextGraphsFromChain' });
  });

  it('is not offered outside the background class, and starts no bytecode check there', async () => {
    const h = harness();
    const { send } = sender(h);

    await expect(h.batching.aggregateAtBlock(() => calls, 1, send)).resolves.toBeUndefined();
    await expect(withRpcRequestContext(
      { requestClass: 'foreground' },
      () => h.batching.aggregateAtBlock(() => calls, 1, send),
    )).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
    expect(h.codeReads).toEqual([]);
  });

  it('honours the kill switch on every request', async () => {
    const h = harness();
    const { send } = sender(h);

    h.setEnabled(false);
    await expect(background(() => h.batching.aggregateAtBlock(() => calls, 1, send))).resolves.toBeUndefined();
    expect(h.codeReads).toEqual([]);

    h.setEnabled(true);
    await expect(background(() => h.batching.aggregateAtBlock(() => calls, 1, send))).resolves.toEqual(expectedResults);
  });

  it.each([
    ['no code at the address', '0x', 10 * 60_000],
    ['a bytecode check that could not be read', new Error('endpoint unavailable'), 60_000],
  ])('is not offered on a chain with %s, until the next check is due', async (_name, code, recheckMs) => {
    const h = harness(code);
    const { send } = sender(h);
    const request = () => background(() => h.batching.aggregateAtBlock(() => calls, 1, send));

    await expect(request()).resolves.toBeUndefined();
    h.advance(recheckMs - 1);
    await expect(request()).resolves.toBeUndefined();
    expect(h.codeReads).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();

    h.setCode(MULTICALL3_RUNTIME_CODE);
    h.advance(1);
    await expect(request()).resolves.toEqual(expectedResults);
    expect(h.codeReads).toHaveLength(2);
  });

  it('builds the calls only when the request is going to be sent', async () => {
    const h = harness();
    const { send } = sender(h);
    const buildCalls = vi.fn(() => calls);

    await h.batching.aggregateAtBlock(buildCalls, 1, send);
    h.setEnabled(false);
    await background(() => h.batching.aggregateAtBlock(buildCalls, 1, send));
    expect(buildCalls).not.toHaveBeenCalled();

    h.setEnabled(true);
    await background(() => h.batching.aggregateAtBlock(buildCalls, 1, send));
    expect(buildCalls).toHaveBeenCalledTimes(1);
  });

  it('asks again at once after a check the node itself refused to send', async () => {
    const h = harness(new RpcRequestGovernorQueueFullError(256));
    const { send } = sender(h);
    const request = () => background(() => h.batching.aggregateAtBlock(() => calls, 1, send));

    await expect(request()).resolves.toBeUndefined();
    expect(h.codeReads).toHaveLength(1);

    // Nothing reached an endpoint, so there is nothing to wait a minute for.
    h.setCode(MULTICALL3_RUNTIME_CODE);
    await expect(request()).resolves.toEqual(expectedResults);
    expect(h.codeReads).toHaveLength(2);
  });

  it('lets a caller stop waiting for the bytecode check without cancelling it', async () => {
    const h = harness();
    const release = h.holdCodeReads();
    const { send } = sender(h);
    const controller = new AbortController();

    const cancelled = withRpcRequestContext(
      { requestClass: 'background', signal: controller.signal },
      () => h.batching.aggregateAtBlock(() => calls, 1, send),
    );
    await turn();
    controller.abort(new Error('pass ended'));
    await expect(cancelled).rejects.toThrow('pass ended');
    expect(send).not.toHaveBeenCalled();

    // The check went on and its answer serves the next caller.
    release();
    await turn();
    await expect(background(() => h.batching.aggregateAtBlock(() => calls, 1, send))).resolves.toEqual(expectedResults);
    expect(h.codeReads).toEqual(['multicall3.getCode']);
  });

  it('rejects with the request\'s own error, and when the answer does not cover every call', async () => {
    const h = await primed(harness());
    const refusal = new RpcRequestGovernorQueueFullError(256);

    await expect(background(() => h.batching.aggregateAtBlock(() => calls, 1, async () => { throw refusal; })))
      .rejects.toBe(refusal);
    await expect(background(() => h.batching.aggregateAtBlock(() => calls, 1, async () => expectedResults.slice(1))))
      .rejects.toThrow('Aggregate call answered 1 of 2 calls');
  });

  it('is not counted in the shared read batching window', async () => {
    const h = await primed(harness());
    drainRpcReadBatchingWindow();

    await background(() => h.batching.aggregateAtBlock(() => calls, 1, sender(h).send));

    expect(drainRpcReadBatchingWindow()).toEqual({
      batches: 0, failedBatches: 0, refusedBatches: 0, calls: 0, directReads: 0, readsByLabel: {},
    });
  });
});

describe('the read batching window', () => {
  it('reports requests, inner calls and reads by label since the previous drain', async () => {
    const h = await primed(harness());
    drainRpcReadBatchingWindow();

    await Promise.allSettled(background(() => [
      h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]))!,
      h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [1n]))!,
      h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [404n]))!,
      h.batching.tryRead(view(cgStorage, 'cgStorage.kaToContextGraph', 'kaToContextGraph', [1n]))!,
    ]));
    h.failAggregateWith(new Error('endpoint rejected the call'));
    await background(() => h.batching.tryRead(view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [2n])));
    h.failAggregateWith(new RpcRequestGovernorQueueFullError(256));
    await expect(background(() => h.batching.tryRead(
      view(kas, 'kas.getLatestMerkleRoot', 'getLatestMerkleRoot', [3n]),
    ))).rejects.toBeInstanceOf(RpcRequestGovernorQueueFullError);

    expect(drainRpcReadBatchingWindow()).toEqual({
      batches: 1,
      failedBatches: 1,
      refusedBatches: 1,
      calls: 3,
      directReads: 2,
      readsByLabel: { 'kas.getLatestMerkleRoot': 5, 'cgStorage.kaToContextGraph': 1 },
    });
    expect(drainRpcReadBatchingWindow()).toEqual({
      batches: 0, failedBatches: 0, refusedBatches: 0, calls: 0, directReads: 0, readsByLabel: {},
    });
  });
});
