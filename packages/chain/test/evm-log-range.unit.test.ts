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
  EvmLogRangeUnavailableError,
  classifyEvmLogRangeLimitError,
  learnedEvmLogSpanCap,
  readAdaptiveEvmLogRange,
} from '../src/evm-log-range.js';
import {
  classifyRpcRetryDisposition,
  isRpcEndpointFailoverEligible,
} from '../src/evm-adapter-rpc.js';
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
async function ethersRefusal(refusal: FakeLogRpcRefusal): Promise<unknown> {
  const rpc = fakeLogRpc({
    url: 'https://rpc.example',
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
  vi.restoreAllMocks();
});

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
    const served = (rows as string[]).map((row) => row.split('-').map(Number) as [number, number]);
    expect(served[0]![0]).toBe(1);
    expect(served.at(-1)![1]).toBe(9_000);
    for (let i = 1; i < served.length; i += 1) expect(served[i]![0]).toBe(served[i - 1]![1] + 1);
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
    expect((err as Error).message).toContain('(budget 32)');
    // Halving stopped where the remaining range no longer fit the budget —
    // no single-block storm.
    expect(calls.length).toBeLessThanOrEqual(EVM_LOG_RANGE_MAX_REQUESTS_PER_READ);
    expect(calls.every(([from, to]) => to - from + 1 >= 128)).toBe(true);
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
      read: async () => { throw new Error('block range too large'); },
      fromBlock: 7,
      toBlock: 7,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvmLogRangeUnavailableError);
    expect((err as Error).message).toContain('refused even as a single block');
  });

  it('returns rows in chain order and drops a log a provider returned twice', async () => {
    const log = (blockNumber: number, index: number, blockHash = `0x${blockNumber.toString(16).padStart(64, '0')}`) => ({
      blockNumber,
      blockHash,
      index,
    });
    const { read } = cappedReader({
      cap: 100,
      // The provider leaks the last log of each chunk into the next chunk.
      rows: (from, to) => [
        ...(from > 1 ? [log(from - 1, 0)] : []),
        log(from, 0),
        log(to, 0),
        log(to, 1),
        { note: 'a row without log identity is kept' },
      ],
    });
    const rows = await readAdaptiveEvmLogRange({ read, fromBlock: 1, toBlock: 200 });
    expect(rows).toEqual([
      log(1, 0), log(100, 0), log(100, 1), { note: 'a row without log identity is kept' },
      log(101, 0), log(200, 0), log(200, 1), { note: 'a row without log identity is kept' },
    ]);
    // Legacy `logIndex` rows and hash-less rows dedupe too.
    const legacy = await readAdaptiveEvmLogRange({
      read: async () => [
        { blockNumber: 5, logIndex: 2 },
        { blockNumber: 5, logIndex: 2 },
        { blockHash: 7, logIndex: 1 },
      ],
      fromBlock: 1,
      toBlock: 10,
    });
    expect(legacy).toEqual([{ blockNumber: 5, logIndex: 2 }, { blockHash: 7, logIndex: 1 }]);
  });

  it('keeps a cap learned without a provider to the one read', async () => {
    const { calls, read } = cappedReader({ cap: 50 });
    await readAdaptiveEvmLogRange({ read, fromBlock: 1, toBlock: 100 });
    await readAdaptiveEvmLogRange({ read, fromBlock: 101, toBlock: 200 });
    expect(calls).toEqual([
      [1, 100], [1, 50], [51, 100],
      [101, 200], [101, 150], [151, 200],
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
