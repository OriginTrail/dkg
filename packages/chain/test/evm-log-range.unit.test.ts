// SPDX-License-Identifier: Apache-2.0

/**
 * eth_getLogs range limits, pinned against what the default Base RPC set
 * actually said on 2026-09-23:
 *
 *  - mainnet.base.org  `{"code":-32614,"message":"eth_getLogs is limited to a 2,000 range"}`
 *  - publicnode        `{"code":-32602,"message":"Archive requests require a personal token. ..."}`
 *  - base.drpc.org     HTTP 400 `{"code":35,"message":"ranges over 10000 blocks are not supported on free plan"}`
 *                      — for 9,000-, 5,000- AND 2,000-block requests alike.
 *
 * The first is a span cap (split). The other two are depth/plan limits:
 * splitting only multiplies the refusals, so the provider loop must move on.
 */

import { ethers } from 'ethers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EVM_LOG_RANGE_MAX_REQUESTS_PER_READ,
  EVM_LOG_SPAN_CAP_TTL_MS,
  EvmLogRangeUnavailableError,
  classifyEvmLogRangeLimitError,
  learnedEvmLogSpanCap,
  readAdaptiveEvmLogRange,
} from '../src/evm-log-range.js';
import {
  classifyRpcRetryDisposition,
  isRpcEndpointFailoverEligible,
  isThrottleRpcError,
} from '../src/evm-adapter-rpc.js';
import { errorRetryAfterMs } from '../src/evm-adapter-errors.js';
import {
  BASE_SPAN_CAP_REFUSAL,
  DRPC_FREE_PLAN_REFUSAL,
  PUBLICNODE_ARCHIVE_REFUSAL,
  fakeLogRpc,
  type FakeLogRpcRefusal,
} from './helpers/fake-log-rpc.js';

const HEAD = 51_689_638;

/** Alchemy's result-size refusal: it states a 2K span beside a log-count cap. */
const ALCHEMY_RESPONSE_SIZE = 'Log response size exceeded. You can make eth_getLogs requests with up to a 2K '
  + 'block range and no limit on the response size, or you can request any block range with a cap of 10K logs '
  + 'in the response.';

/** The error ethers raises for one refused eth_getLogs, built by ethers itself. */
async function ethersRefusal(refusal: FakeLogRpcRefusal, url = 'https://rpc.example'): Promise<unknown> {
  const rpc = fakeLogRpc({
    url,
    head: () => HEAD,
    refuse: () => refusal,
  });
  try {
    await rpc.provider.getLogs({ fromBlock: HEAD - 9_000, toBlock: HEAD - 1 });
  } catch (err) {
    return err;
  } finally {
    rpc.provider.destroy();
  }
  throw new Error('fake RPC served a request it was told to refuse');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Rows a reader returned as `from-to` strings, checked to tile [from, to] in order. */
function expectContiguous(rows: readonly unknown[], fromBlock: number, toBlock: number): void {
  const served = (rows as string[]).map((row) => row.split('-').map(Number) as [number, number]);
  expect(served[0]![0]).toBe(fromBlock);
  expect(served.at(-1)![1]).toBe(toBlock);
  for (let i = 1; i < served.length; i += 1) expect(served[i]![0]).toBe(served[i - 1]![1] + 1);
}

describe('classifyEvmLogRangeLimitError — the default Base RPC set', () => {
  it('reads mainnet.base.org\'s comma-grouped "limited to a 2,000 range" as a 2,000-block span cap', async () => {
    const err = await ethersRefusal(BASE_SPAN_CAP_REFUSAL);
    expect((err as { code?: string }).code).toBe('UNKNOWN_ERROR');
    expect(classifyEvmLogRangeLimitError(err, 9_000)).toEqual({ kind: 'span', maxBlocks: 2_000 });
    expect(classifyEvmLogRangeLimitError(err, 5_000)).toEqual({ kind: 'span', maxBlocks: 2_000 });
    // No request span to check against: the stated cap still stands.
    expect(classifyEvmLogRangeLimitError(err)).toEqual({ kind: 'span', maxBlocks: 2_000 });
  });

  it('reads the same refusal delivered as an HTTP 400 body', async () => {
    const err = await ethersRefusal({ ...BASE_SPAN_CAP_REFUSAL, httpStatus: 400 });
    expect((err as { code?: string }).code).toBe('SERVER_ERROR');
    expect(classifyEvmLogRangeLimitError(err, 9_000)).toEqual({ kind: 'span', maxBlocks: 2_000 });
  });

  it('ignores the request URL ethers embeds in an HTTP-level refusal', async () => {
    // An operator endpoint whose host happens to say "archive" or "free-tier"
    // must not turn a genuine span cap into a depth limit that is never split.
    for (const url of ['https://base-archive.example.org', 'https://free-tier.pruned.example.org']) {
      const rpc = fakeLogRpc({
        url,
        head: () => HEAD,
        refuse: () => ({ ...BASE_SPAN_CAP_REFUSAL, httpStatus: 400 }),
      });
      const err = await rpc.provider.getLogs({ fromBlock: HEAD - 9_000, toBlock: HEAD - 1 })
        .catch((e: unknown) => e);
      rpc.provider.destroy();
      expect((err as Error).message).toContain(url);
      expect(classifyEvmLogRangeLimitError(err, 9_000)).toEqual({ kind: 'span', maxBlocks: 2_000 });
    }
  });

  it('reads publicnode\'s archive-token refusal as a depth limit at every span', async () => {
    for (const httpStatus of [200, 400]) {
      const err = await ethersRefusal({ ...PUBLICNODE_ARCHIVE_REFUSAL, httpStatus });
      for (const span of [9_000, 5_000, 2_000]) {
        expect(classifyEvmLogRangeLimitError(err, span)).toEqual({ kind: 'depth' });
      }
      expect(classifyEvmLogRangeLimitError(err)).toEqual({ kind: 'depth' });
    }
  });

  it('reads dRPC\'s free-plan "ranges over 10000 blocks" as a depth limit, never a span to split', async () => {
    const err = await ethersRefusal(DRPC_FREE_PLAN_REFUSAL);
    expect((err as { code?: string }).code).toBe('SERVER_ERROR');
    for (const span of [9_000, 5_000, 2_000, 15_000]) {
      expect(classifyEvmLogRangeLimitError(err, span)).toEqual({ kind: 'depth' });
    }
    expect(classifyEvmLogRangeLimitError(err)).toEqual({ kind: 'depth' });
  });

  it('reads the exact error shape the live node logged for dRPC', () => {
    // Verbatim from the 2026-09-23 canary log (ids aside).
    const err = Object.assign(new Error('server response 400 Bad Request'), {
      code: 'SERVER_ERROR',
      request: {},
      response: {},
      error: null,
      info: {
        requestUrl: 'https://base.drpc.org',
        responseBody: '{"id":3,"jsonrpc":"2.0","error":{"message":"ranges over 10000 blocks are not supported on free plan","code":35}}',
        responseStatus: '400 Bad Request',
      },
    });
    expect(classifyEvmLogRangeLimitError(err, 15_000)).toEqual({ kind: 'depth' });
  });

  it('does not read dRPC\'s other free-plan failures as range limits', async () => {
    // Also in the canary log: plan wording alone is not a range limit.
    const timeout = await ethersRefusal({
      httpStatus: 408,
      rpcError: { code: 30, message: 'Request timeout on the free plan, please upgrade to paid plan' },
    });
    const internal = await ethersRefusal({
      httpStatus: 500,
      rpcError: { code: 19, message: 'Temporary internal error. Please retry, trace-id: 209ae775d2c7d51be5edd8d35a94ab99' },
    });
    const network = await ethersRefusal({ networkError: 'fetch failed' });
    for (const err of [timeout, internal, network]) {
      expect(classifyEvmLogRangeLimitError(err, 2_000)).toBeUndefined();
    }
  });
});

describe('classifyEvmLogRangeLimitError — provider phrasings', () => {
  const nested = (message: string) => ({ cause: { info: { error: { message } } } });

  it.each([
    ['eth_getLogs is limited to 50 blocks', 50],
    ['Block range too large: maximum allowed is 50 blocks', 50],
    ['eth_getLogs is limited to a 10,000 range', 10_000],
    ['eth_getLogs is limited to a 1000 block range', 1_000],
    ['exceed maximum block range: 5000', 5_000],
    ['ranges over 10000 blocks are not supported', 10_000],
    [ALCHEMY_RESPONSE_SIZE, 2_000],
    ['requested too many blocks from 0 to 20000, maximum is set to 2048', 2_048],
    ['max block range is 800', 800],
    ['block range limit of 10_000 exceeded', 10_000],
  ])('states the cap: %s', (message, cap) => {
    expect(classifyEvmLogRangeLimitError(nested(message))).toEqual({ kind: 'span', maxBlocks: cap });
    expect(classifyEvmLogRangeLimitError(new Error(message), cap * 3))
      .toEqual({ kind: 'span', maxBlocks: cap });
  });

  it.each([
    'block range too large',
    'block range is too wide',
    'query returned more than 10000 results',
    'Log response size exceeded.',
    'exceeds the maximum block range',
    'block range limit exceeded',
  ])('names no cap, so the reader halves: %s', (message) => {
    expect(classifyEvmLogRangeLimitError(new Error(message), 9_000)).toEqual({ kind: 'span' });
  });

  it.each([
    'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Upgrade to PAYG for expanded block range.',
    'missing trie node: history has been pruned',
    'historical logs are not available on this node',
    'only the last 128 blocks are available',
  ])('is a depth limit: %s', (message) => {
    expect(classifyEvmLogRangeLimitError(new Error(message), 9_000)).toEqual({ kind: 'depth' });
  });

  it.each([
    'execution reverted',
    'header not found',
    'too many requests',
    'RPC fetch failed: fetch failed',
    'Request timeout on the free plan, please upgrade to paid plan',
  ])('is not a range limit: %s', (message) => {
    expect(classifyEvmLogRangeLimitError(new Error(message), 9_000)).toBeUndefined();
  });

  it('checks a stated cap against the span that was actually refused', () => {
    const refusal = new Error('eth_getLogs is limited to a 2,000 range');
    // Above the cap: a span cap.
    expect(classifyEvmLogRangeLimitError(refusal, 2_001)).toEqual({ kind: 'span', maxBlocks: 2_000 });
    // AT the cap: the provider counts it exclusively, so fit one block less.
    expect(classifyEvmLogRangeLimitError(refusal, 2_000)).toEqual({ kind: 'span', maxBlocks: 1_999 });
    // Strictly below its own cap: not what the provider enforces.
    expect(classifyEvmLogRangeLimitError(refusal, 1_999)).toEqual({ kind: 'depth' });
    // A one-block refusal leaves nothing to fit.
    expect(classifyEvmLogRangeLimitError(new Error('limited to 1 blocks'), 1)).toEqual({ kind: 'span' });
  });

  it('narrows a result-size refusal even below the cap its own message states', () => {
    const alchemy = new Error(ALCHEMY_RESPONSE_SIZE);
    expect(classifyEvmLogRangeLimitError(alchemy, 9_000)).toEqual({ kind: 'span', maxBlocks: 2_000 });
    expect(classifyEvmLogRangeLimitError(alchemy, 2_000)).toEqual({ kind: 'span', maxBlocks: 1_999 });
    // Too many logs, not too many blocks: fewer blocks still fix it, so it is
    // a span to halve, never a history limit.
    expect(classifyEvmLogRangeLimitError(alchemy, 1_999)).toEqual({ kind: 'span' });
    expect(classifyEvmLogRangeLimitError(alchemy, 10)).toEqual({ kind: 'span' });
    expect(classifyEvmLogRangeLimitError(new Error('query returned more than 10000 results'), 10))
      .toEqual({ kind: 'span' });
  });

  it('reads a bare string refusal and ignores an empty error', () => {
    expect(classifyEvmLogRangeLimitError(undefined)).toBeUndefined();
    expect(classifyEvmLogRangeLimitError('block range too large')).toEqual({ kind: 'span' });
  });
});

describe('readAdaptiveEvmLogRange', () => {
  function cappedReader(options: {
    cap?: number;
    message?: (cap: number) => string;
    refuseDepthBelow?: number;
    rows?: (from: number, to: number) => unknown[];
  }) {
    const calls: Array<[number, number]> = [];
    const read = async (from: number, to: number): Promise<unknown[]> => {
      calls.push([from, to]);
      if (options.refuseDepthBelow !== undefined && from < options.refuseDepthBelow) {
        throw new Error('Archive requests require a personal token');
      }
      if (options.cap !== undefined && to - from + 1 > options.cap) {
        throw new Error(options.message?.(options.cap) ?? `eth_getLogs is limited to a ${options.cap} range`);
      }
      return options.rows?.(from, to) ?? [`${from}-${to}`];
    };
    return { calls, read };
  }

  it('learns a provider\'s stated span cap once and starts every later read there', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rpc = fakeLogRpc({
      url: 'https://mainnet.base.org/some/key',
      head: () => HEAD,
      refuse: ({ fromBlock, toBlock }) => (toBlock - fromBlock + 1 > 2_000 ? BASE_SPAN_CAP_REFUSAL : undefined),
    });
    const provider = rpc.provider;
    const read = (from: number, to: number) => provider.getLogs({ fromBlock: from, toBlock: to });
    try {
      await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 9_000 });
      expect(rpc.logRanges()).toEqual([
        [1, 9_000],
        [1, 2_000], [2_001, 4_000], [4_001, 6_000], [6_001, 8_000], [8_001, 9_000],
      ]);
      expect(learnedEvmLogSpanCap(provider)).toBe(2_000);
      // Host only — the configured URL's path (an API key) never reaches the log.
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toContain('mainnet.base.org: 2000 blocks (stated by the provider)');
      expect(String(log.mock.calls[0]![0])).not.toContain('some/key');

      rpc.requests.length = 0;
      await readAdaptiveEvmLogRange({ provider, read, fromBlock: 9_001, toBlock: 18_000 });
      expect(rpc.logRanges()).toEqual([
        [9_001, 11_000], [11_001, 13_000], [13_001, 15_000], [15_001, 17_000], [17_001, 18_000],
      ]);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      provider.destroy();
    }
  });

  it('never splits a depth refusal, and never narrows the provider for recent blocks', async () => {
    const provider = {};
    const { calls, read } = cappedReader({ refuseDepthBelow: 50_000 });

    const err = await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 9_000 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((err as EvmLogRangeUnavailableError).limit).toEqual({ kind: 'depth' });
    expect((err as Error).message).toContain('Archive requests require a personal token');
    expect(calls).toEqual([[1, 9_000]]);
    expect(learnedEvmLogSpanCap(provider)).toBeUndefined();

    // The live tail on the same provider still goes out as one request.
    await expect(readAdaptiveEvmLogRange({ provider, read, fromBlock: 60_000, toBlock: 69_000 }))
      .resolves.toEqual(['60000-69000']);
    expect(calls).toEqual([[1, 9_000], [60_000, 69_000]]);
  });

  it('fails a depth refusal over whatever code the provider used', async () => {
    // Raw, this shape would stop the provider loop: an invalid-argument code
    // reads as a deterministic failure, not an endpoint problem.
    const pruned = Object.assign(new Error('invalid argument 0: pruned history unavailable'), {
      code: 'INVALID_ARGUMENT',
    });
    expect(isRpcEndpointFailoverEligible(pruned)).toBe(false);
    const err = await readAdaptiveEvmLogRange({
      provider: {},
      read: async () => { throw pruned; },
      fromBlock: 1,
      toBlock: 2_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((err as Error).cause).toBe(pruned);
    expect(classifyRpcRetryDisposition(err)).toBe('failover');
    expect(isRpcEndpointFailoverEligible(err)).toBe(true);
  });

  it('halves an unstated span limit and keeps the span that worked', async () => {
    const provider = {};
    const { calls, read } = cappedReader({ cap: 1_500, message: () => 'block range too large' });

    await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 4_000 });
    expect(calls).toEqual([
      [1, 4_000],
      [1, 2_000],
      [1, 1_000], [1_001, 2_000],
      [2_001, 3_000], [3_001, 4_000],
    ]);
    expect(learnedEvmLogSpanCap(provider)).toBe(1_000);

    calls.length = 0;
    await readAdaptiveEvmLogRange({ provider, read, fromBlock: 4_001, toBlock: 6_000 });
    expect(calls).toEqual([[4_001, 5_000], [5_001, 6_000]]);
  });

  it('keeps narrowing a response-size refusal instead of reading it as a history limit', async () => {
    const provider = {};
    // A dense range: only 1,000 blocks at a time fit under the log cap.
    const { calls, read } = cappedReader({ cap: 1_000, message: () => ALCHEMY_RESPONSE_SIZE });

    const rows = await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 9_000 });

    // The stated 2K, then one less at the cap, then halving below it.
    expect(calls.slice(0, 4)).toEqual([[1, 9_000], [1, 2_000], [1, 1_999], [1, 999]]);
    expect(learnedEvmLogSpanCap(provider)).toBe(999);
    // Every block exactly once, in chain order.
    expectContiguous(rows, 1, 9_000);
  });

  it('stays bounded when a provider refuses every multi-block span', async () => {
    const calls: Array<[number, number]> = [];
    const err = await readAdaptiveEvmLogRange({
      provider: {},
      read: async (from, to) => {
        calls.push([from, to]);
        if (to > from) throw new Error('block range too large');
        return [];
      },
      fromBlock: 1,
      toBlock: 9_000,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((err as Error).message).toContain(`(budget ${EVM_LOG_RANGE_MAX_REQUESTS_PER_READ})`);
    // Halving stopped where the remaining range no longer fit the budget —
    // eight refusals, no single-block storm.
    expect(calls).toEqual([
      [1, 9_000], [1, 4_500], [1, 2_250], [1, 1_125], [1, 562], [1, 281], [1, 140], [1, 70],
    ]);
  });

  it.each([
    ['Block range too large: maximum allowed is 50 blocks', 50],
    ['eth_getLogs is limited to a 100 block range', 100],
  ])('serves a 9,000-block page at a small stated cap in one read: %s', async (message, cap) => {
    const provider = {};
    const { calls, read } = cappedReader({ cap, message: () => message });

    const rows = await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 9_000 });

    // One refusal teaches the cap; every later request fits it.
    expect(calls).toHaveLength(1 + 9_000 / cap);
    expect(calls.slice(1).every(([from, to]) => to - from + 1 === cap)).toBe(true);
    expectContiguous(rows, 1, 9_000);
    expect(learnedEvmLogSpanCap(provider)).toBe(cap);
  });

  it('lets a learned cap expire, so a stale narrow cap stops holding the provider down', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = {};
    let cap: number | undefined = 100;
    const calls: Array<[number, number]> = [];
    const read = async (from: number, to: number): Promise<string[]> => {
      calls.push([from, to]);
      if (cap !== undefined && to - from + 1 > cap) throw new Error(`eth_getLogs is limited to a ${cap} range`);
      return [`${from}-${to}`];
    };

    await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 1_000 });
    expect(learnedEvmLogSpanCap(provider)).toBe(100);

    // The limit is gone (a lifted cap, or the dense range that taught it has
    // passed), but until the cap expires reads still start at it.
    cap = undefined;
    vi.setSystemTime(Date.now() + EVM_LOG_SPAN_CAP_TTL_MS - 1);
    calls.length = 0;
    await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1_001, toBlock: 2_000 });
    expect(calls).toHaveLength(10);

    vi.setSystemTime(Date.now() + 1);
    expect(learnedEvmLogSpanCap(provider)).toBeUndefined();
    calls.length = 0;
    await expect(readAdaptiveEvmLogRange({ provider, read, fromBlock: 2_001, toBlock: 3_000 }))
      .resolves.toEqual(['2001-3000']);
    expect(calls).toEqual([[2_001, 3_000]]);
  });

  it('relearns a cap that still holds after it expires, with one refusal and no new log line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const provider = {};
    const { calls, read } = cappedReader({ cap: 2_000 });

    await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 9_000 });
    expect(log).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + EVM_LOG_SPAN_CAP_TTL_MS);
    calls.length = 0;
    await readAdaptiveEvmLogRange({ provider, read, fromBlock: 9_001, toBlock: 18_000 });
    expect(calls).toEqual([
      [9_001, 18_000],
      [9_001, 11_000], [11_001, 13_000], [13_001, 15_000], [15_001, 17_000], [17_001, 18_000],
    ]);
    expect(learnedEvmLogSpanCap(provider)).toBe(2_000);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('refuses a range a tiny stated cap cannot cover within the budget, then refuses up front', async () => {
    const provider = {};
    const { calls, read } = cappedReader({ cap: 10, message: () => 'eth_getLogs is limited to a 10 range' });

    const first = await readAdaptiveEvmLogRange({ provider, read, fromBlock: 1, toBlock: 9_000 })
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((first as EvmLogRangeUnavailableError).limit).toEqual({ kind: 'span', maxBlocks: 10 });
    expect((first as Error).message).toContain('needs 900 more requests at a 10-block span');
    expect(calls).toEqual([[1, 9_000]]);

    const second = await readAdaptiveEvmLogRange({ provider, read, fromBlock: 9_001, toBlock: 18_000 })
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((second as Error).cause).toBeUndefined();
    expect(calls).toHaveLength(1);
    // A read the cap covers is still served.
    await expect(readAdaptiveEvmLogRange({ provider, read, fromBlock: 20_001, toBlock: 20_020 }))
      .resolves.toEqual(['20001-20010', '20011-20020']);
  });

  it('refuses a range that even a single block cannot satisfy', async () => {
    const err = await readAdaptiveEvmLogRange({
      provider: {},
      read: async () => { throw new Error('block range too large'); },
      fromBlock: 7,
      toBlock: 7,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((err as Error).message).toContain('refused even as a single block');
  });

  it('returns rows in chain order, exactly as each request returned them', async () => {
    const log = (blockNumber: number, index: number) => ({ blockNumber, index });
    const { calls, read } = cappedReader({
      cap: 100,
      rows: (from, to) => [log(from, 0), log(to, 0), log(to, 1)],
    });
    const rows = await readAdaptiveEvmLogRange({ provider: {}, read, fromBlock: 1, toBlock: 200 });
    expect(calls).toEqual([[1, 200], [1, 100], [101, 200]]);
    // The refused request contributes nothing; the two that fit, in order.
    expect(rows).toEqual([
      log(1, 0), log(100, 0), log(100, 1),
      log(101, 0), log(200, 0), log(200, 1),
    ]);
  });

  it('keeps each provider\'s cap to that provider', async () => {
    const narrow = {};
    const wide = {};
    const narrowReader = cappedReader({ cap: 1_000 });
    const wideReader = cappedReader({ cap: 5_000 });
    await readAdaptiveEvmLogRange({ provider: narrow, read: narrowReader.read, fromBlock: 1, toBlock: 3_000 });
    await readAdaptiveEvmLogRange({ provider: wide, read: wideReader.read, fromBlock: 1, toBlock: 3_000 });
    expect(learnedEvmLogSpanCap(narrow)).toBe(1_000);
    expect(learnedEvmLogSpanCap(wide)).toBeUndefined();
    expect(wideReader.calls).toEqual([[1, 3_000]]);
  });

  it('rethrows an error that is not a range limit unchanged', async () => {
    const outage = Object.assign(new Error('RPC fetch failed: fetch failed'), { code: 'NETWORK_ERROR' });
    await expect(readAdaptiveEvmLogRange({
      provider: {},
      read: async () => { throw outage; },
      fromBlock: 1,
      toBlock: 10,
    })).rejects.toBe(outage);
  });

  it('stops between requests once aborted', async () => {
    const controller = new AbortController();
    const { calls, read } = cappedReader({ cap: 10 });
    const aborting = async (from: number, to: number) => {
      const rows = await read(from, to);
      if (calls.length === 2) controller.abort(new Error('poller stopping'));
      return rows;
    };
    await expect(readAdaptiveEvmLogRange({
      provider: {},
      read: aborting,
      fromBlock: 1,
      toBlock: 100,
      signal: controller.signal,
    })).rejects.toThrow('poller stopping');
    expect(calls).toEqual([[1, 100], [1, 10]]);
  });

  it('passes an empty or inverted range straight through', async () => {
    const { calls, read } = cappedReader({ cap: 10 });
    await expect(readAdaptiveEvmLogRange({ provider: {}, read, fromBlock: 10, toBlock: 9 }))
      .resolves.toEqual(['10-9']);
    expect(calls).toEqual([[10, 9]]);
  });

  it('names the endpoint host only when the key is a real provider', async () => {
    const provider = new ethers.JsonRpcProvider('https://base.drpc.org/secret', 8453, { staticNetwork: true });
    try {
      const err = await readAdaptiveEvmLogRange({
        provider,
        read: async () => { throw new Error('ranges over 10000 blocks are not supported on free plan'); },
        fromBlock: 1,
        toBlock: 2_000,
      }).catch((e: unknown) => e);
      expect((err as Error).message).toBe(
        'eth_getLogs [1, 2000] is beyond the history, archive or plan limit at base.drpc.org: '
          + 'ranges over 10000 blocks are not supported on free plan',
      );
    } finally {
      provider.destroy();
    }
    const brokenProvider = { _getConnection: () => { throw new Error('destroyed'); } };
    const err = await readAdaptiveEvmLogRange({
      provider: brokenProvider,
      read: async () => { throw { error: { code: -32602, message: 'Archive requests require a personal token' } }; },
      fromBlock: 1,
      toBlock: 2,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'eth_getLogs [1, 2] is beyond the history, archive or plan limit at the provider: '
        + 'Archive requests require a personal token',
    );
  });
});

describe('readAdaptiveEvmLogRange keeps configured RPC URLs out of its errors and logs', () => {
  // A configured endpoint with a key in its path and its query. Fake values
  // only; the shape is what operators paste from a provider dashboard.
  const KEYED_URL = 'https://base-mainnet.rpc-provider.test/v2/FAKE-KEY-0123456789abcdef'
    + '?apikey=FAKE-QUERY-KEY-fedcba';
  const HOST = 'base-mainnet.rpc-provider.test';
  const LEAK = /FAKE-KEY|FAKE-QUERY|\/v2\/|apikey=/;

  /** The raw ethers error for one refused request, and the reader's error for the same range. */
  async function refusedRead(refusal: FakeLogRpcRefusal, fromBlock: number, toBlock: number) {
    const rpc = fakeLogRpc({ url: KEYED_URL, head: () => HEAD, refuse: () => refusal });
    const read = (from: number, to: number) => rpc.provider.getLogs({ fromBlock: from, toBlock: to });
    try {
      const raw = await read(fromBlock, toBlock).catch((e: unknown) => e);
      const err = await readAdaptiveEvmLogRange({ provider: rpc.provider, read, fromBlock, toBlock })
        .catch((e: unknown) => e);
      return { raw, err };
    } finally {
      rpc.provider.destroy();
    }
  }

  it.each([
    [
      'an HTML 403 page refusing archive blocks',
      {
        httpStatus: 403,
        contentType: 'text/html',
        rawBody: '<html><head><title>403 Forbidden</title></head><body><h1>Forbidden</h1>'
          + '<p>Archive requests require an API key on this endpoint.</p></body></html>',
      },
      1,
      2_000,
      'is beyond the history, archive or plan limit',
    ],
    [
      'a text 400 refusing even one block',
      { httpStatus: 400, rawBody: 'block range too large' },
      7,
      7,
      'is refused even as a single block',
    ],
  ] as const)('reduces the request URL in %s to its host', async (_name, refusal, from, to, detail) => {
    const { raw, err } = await refusedRead(refusal, from, to);

    // The shape that leaked: for a body that is not JSON, ethers puts the full
    // request URL (key included) in its own message, which the reader quoted.
    expect((raw as Error).message).toContain(KEYED_URL);
    expect(err).toBeInstanceOf(EvmLogRangeUnavailableError);
    const message = (err as Error).message;
    expect(message).not.toMatch(LEAK);
    expect(message).toContain(
      `eth_getLogs [${from}, ${to}] ${detail} at ${HOST}: server response ${refusal.httpStatus}`,
    );
    expect(message).toContain(`"requestUrl": "${HOST}"`);
    // The provider's own error stays attached, unchanged, for diagnosis.
    expect((err as { cause?: { code?: unknown } }).cause?.code).toBe('SERVER_ERROR');
  });

  it('logs a span cap learned from a non-JSON refusal by host only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const rpc = fakeLogRpc({
      url: KEYED_URL,
      head: () => HEAD,
      refuse: ({ fromBlock, toBlock }) => (
        toBlock - fromBlock + 1 > 2_000
          ? { httpStatus: 400, rawBody: 'eth_getLogs is limited to a 2,000 range' }
          : undefined
      ),
    });
    try {
      await readAdaptiveEvmLogRange({
        provider: rpc.provider,
        read: (from, to) => rpc.provider.getLogs({ fromBlock: from, toBlock: to }),
        fromBlock: 1,
        toBlock: 4_000,
      });
      expect(rpc.logRanges()).toEqual([[1, 4_000], [1, 2_000], [2_001, 4_000]]);
      expect(log.mock.calls.map((call) => call.map(String).join(' '))).toEqual([
        `[chain] eth_getLogs span cap for ${HOST}: 2000 blocks (stated by the provider); `
          + 'later log reads start at this span',
      ]);
    } finally {
      rpc.provider.destroy();
    }
  });

  it('classifies JSON-RPC refusals from a key-bearing endpoint exactly as before', async () => {
    const cases: ReadonlyArray<readonly [FakeLogRpcRefusal, unknown]> = [
      [BASE_SPAN_CAP_REFUSAL, { kind: 'span', maxBlocks: 2_000 }],
      [{ ...BASE_SPAN_CAP_REFUSAL, httpStatus: 400 }, { kind: 'span', maxBlocks: 2_000 }],
      [PUBLICNODE_ARCHIVE_REFUSAL, { kind: 'depth' }],
      [{ ...PUBLICNODE_ARCHIVE_REFUSAL, httpStatus: 400 }, { kind: 'depth' }],
      [DRPC_FREE_PLAN_REFUSAL, { kind: 'depth' }],
    ];
    for (const [refusal, expected] of cases) {
      const err = await ethersRefusal(refusal, KEYED_URL);
      expect(classifyEvmLogRangeLimitError(err, 9_000)).toEqual(expected);
    }
  });

  it('quotes a JSON-RPC refusal in the provider\'s words, with any URL in them reduced to its host', async () => {
    const drpc = await refusedRead(DRPC_FREE_PLAN_REFUSAL, 1, 2_000);
    expect((drpc.err as Error).message).toBe(
      `eth_getLogs [1, 2000] is beyond the history, archive or plan limit at ${HOST}: `
        + 'ranges over 10000 blocks are not supported on free plan',
    );

    const publicnode = await refusedRead(PUBLICNODE_ARCHIVE_REFUSAL, 1, 2_000);
    expect((publicnode.err as Error).message).toBe(
      `eth_getLogs [1, 2000] is beyond the history, archive or plan limit at ${HOST}: `
        + 'Archive requests require a personal token. Get one at: www.allnodes.com',
    );
  });
});

describe('readAdaptiveEvmLogRange keeps configured RPC URLs out of the errors it does not classify', () => {
  // A fake key in both the path and the query.
  const KEYED_URL = 'https://rpc.example.invalid/v2/FAKEKEY123?apikey=FAKEKEY123';
  const HOST = 'rpc.example.invalid';
  const LEAK = /FAKEKEY123|\/v2\/|apikey=/;

  /**
   * One read of [1, 2000] from a keyed endpoint that refuses it. Returns the
   * raw ethers error for the same request, the reader's error, the ranges the
   * reader asked for, and everything printed while it ran.
   */
  async function unclassifiedRead(refusal: FakeLogRpcRefusal) {
    const printers = (['log', 'warn', 'error'] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const rpc = fakeLogRpc({ url: KEYED_URL, head: () => HEAD, refuse: () => refusal });
    const read = (from: number, to: number) => rpc.provider.getLogs({ fromBlock: from, toBlock: to });
    try {
      const raw = await read(1, 2_000).catch((e: unknown) => e);
      rpc.requests.length = 0;
      const err = await readAdaptiveEvmLogRange({ provider: rpc.provider, read, fromBlock: 1, toBlock: 2_000 })
        .catch((e: unknown) => e);
      const printed = printers
        .flatMap((printer) => printer.mock.calls.map((call) => call.map(String).join(' ')))
        .join('\n');
      return { raw, err, ranges: rpc.logRanges(), printed };
    } finally {
      rpc.provider.destroy();
    }
  }

  it.each([
    [
      'an HTML 401 page',
      {
        httpStatus: 401,
        contentType: 'text/html',
        rawBody: '<html><body><h1>401 Unauthorized</h1><p>Invalid API key.</p></body></html>',
      },
    ],
    [
      'an HTML 403 page with no archive wording',
      {
        httpStatus: 403,
        contentType: 'text/html',
        rawBody: '<html><body><h1>403 Forbidden</h1><p>Access denied.</p></body></html>',
      },
    ],
    ['a text 429', { httpStatus: 429, rawBody: 'Too Many Requests' }],
    // A JSON-RPC body does not help: any HTTP error status puts the URL in
    // ethers' message.
    ['a JSON-RPC 401', { httpStatus: 401, rpcError: { code: -32001, message: 'invalid API key' } }],
    [
      'an HTML 502 page',
      {
        httpStatus: 502,
        contentType: 'text/html',
        rawBody: '<html><body><h1>502 Bad Gateway</h1></body></html>',
      },
    ],
  ] as const)('rethrows %s by host only, and it still fails over', async (_name, refusal) => {
    const { raw, err, ranges, printed } = await unclassifiedRead(refusal);

    // ethers' own message quotes the full request URL, key included, and the
    // classifier does not recognise the page: this is the rethrow path.
    expect((raw as Error).message).toContain(KEYED_URL);
    expect(classifyEvmLogRangeLimitError(raw, 2_000)).toBeUndefined();

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EvmLogRangeUnavailableError);
    const message = (err as Error).message;
    expect(message).not.toMatch(LEAK);
    expect(message).toMatch(new RegExp(`^server response ${refusal.httpStatus} `));
    expect(message).toContain(`"requestUrl": "${HOST}"`);
    expect(printed).not.toMatch(LEAK);
    // Every failover and retry classifier reads it as it read the provider's error.
    expect((err as { code?: unknown }).code).toBe('SERVER_ERROR');
    expect(classifyRpcRetryDisposition(err)).toBe('failover');
    expect(classifyRpcRetryDisposition(err)).toBe(classifyRpcRetryDisposition(raw));
    expect(isThrottleRpcError(err)).toBe(refusal.httpStatus === 429);
    // The provider's own error stays attached for diagnosis.
    const cause = (err as { cause?: unknown }).cause as { code?: unknown; message?: unknown };
    expect(cause.code).toBe('SERVER_ERROR');
    expect(cause.message).toContain(KEYED_URL);
    // An unclassified refusal costs one request: never split, never repeated.
    expect(ranges).toEqual([[1, 2_000]]);
  });

  it('keeps a throttled refusal\'s Retry-After readable through the rethrown error', async () => {
    const { err } = await unclassifiedRead({ httpStatus: 429, rawBody: 'Too Many Requests', retryAfterSeconds: 7 });
    expect((err as Error).message).not.toMatch(LEAK);
    expect(isThrottleRpcError(err)).toBe(true);
    expect(errorRetryAfterMs(err)).toBe(7_000);
  });

  it('rethrows a JSON-RPC error whose own words quote the configured URL by host only', async () => {
    const { raw, err, ranges, printed } = await unclassifiedRead({
      rpcError: { code: -32000, message: `invalid API key for ${KEYED_URL}` },
    });
    expect((raw as Error).message).toContain(KEYED_URL);
    const message = (err as Error).message;
    expect(message).not.toMatch(LEAK);
    expect(message).toContain(`invalid API key for ${HOST}`);
    expect(printed).not.toMatch(LEAK);
    expect((err as { code?: unknown }).code).toBe((raw as { code?: unknown }).code);
    expect(classifyRpcRetryDisposition(err)).toBe(classifyRpcRetryDisposition(raw));
    expect(ranges).toEqual([[1, 2_000]]);
  });

  it('keeps the name and code of a transport error it rewrites', async () => {
    const reset = Object.assign(new TypeError(`fetch failed: socket closed by ${KEYED_URL}`), { code: 'ECONNRESET' });
    const err = await readAdaptiveEvmLogRange({
      provider: {},
      read: async () => { throw reset; },
      fromBlock: 1,
      toBlock: 2_000,
    }).catch((e: unknown) => e);
    expect((err as Error).message).toBe(`fetch failed: socket closed by ${HOST}`);
    expect((err as Error).name).toBe('TypeError');
    expect((err as { code?: unknown }).code).toBe('ECONNRESET');
    expect((err as { cause?: unknown }).cause).toBe(reset);
    expect(classifyRpcRetryDisposition(err)).toBe('failover');
  });

  it('rethrows an error with no URL in it as the very same object', async () => {
    const timeout = Object.assign(new Error('eth_getLogs [1, 2000] timed out after 30000ms'), { code: 'RPC_TIMEOUT' });
    const aborted = new DOMException('This operation was aborted', 'AbortError');
    for (const failure of [timeout, aborted]) {
      await expect(readAdaptiveEvmLogRange({
        provider: {},
        read: async () => { throw failure; },
        fromBlock: 1,
        toBlock: 2_000,
      })).rejects.toBe(failure);
    }
  });
});
