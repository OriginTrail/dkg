/**
 * Unit tests for PR-8: the filter-not-found log-spam silencer.
 *
 * Two surfaces:
 *   - `isFilterNotFoundError` — pure classifier; table-driven.
 *   - `createFilterErrorSilencer` — stateful dedup; injectable clock
 *     and log target make the time-based suppression deterministic.
 */

import { describe, it, expect } from 'vitest';
import {
  isFilterNotFoundError,
  formatProviderError,
  createFilterErrorSilencer,
  DEFAULT_DEDUP_WINDOW_MS,
} from '../src/filter-error-silencer.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

function filterNotFoundError(): Error {
  return Object.assign(new Error('could not coalesce error'), {
    info: {
      error: { code: -32602, message: 'filter not found' },
      payload: { method: 'eth_getFilterChanges' },
    },
  });
}

describe('isFilterNotFoundError', () => {
  it('matches outer ethers messages only when they identify eth_getFilterChanges', () => {
    expect(isFilterNotFoundError(new Error('filter not found'))).toBe(false);
    expect(isFilterNotFoundError(new Error('Filter Not Found'))).toBe(false);
    expect(isFilterNotFoundError(new Error('JSON-RPC response: -32602 filter not found'))).toBe(false);
    expect(
      isFilterNotFoundError(
        new Error(
          'could not coalesce error eth_getFilterChanges("0x4e58f53e...") filter not found',
        ),
      ),
    ).toBe(true);
  });

  it('matches ethers-wrapped errors with structured RPC code on err.info', () => {
    const wrapped = Object.assign(new Error('could not coalesce error'), {
      info: { error: { code: -32602, message: 'filter not found' } },
    });
    expect(isFilterNotFoundError(wrapped)).toBe(true);
  });

  it('matches when err.code is set directly to -32602 with a filter message', () => {
    const err = Object.assign(new Error('rpc failure'), {
      code: -32602,
      info: { error: { code: -32602, message: 'filter expired' } },
    });
    expect(isFilterNotFoundError(err)).toBe(true);
  });

  it('matches -32000 provider filter-expiration payloads', () => {
    const nested = Object.assign(new Error('could not coalesce error'), {
      info: { error: { code: -32000, message: 'filter expired' } },
    });
    const direct = Object.assign(new Error('rpc failure'), {
      code: -32000,
      info: { error: { code: -32000, message: 'filter not found' } },
    });
    expect(isFilterNotFoundError(nested)).toBe(true);
    expect(isFilterNotFoundError(direct)).toBe(true);
  });

  it('does NOT match other -32602 messages (invalid params, etc.)', () => {
    const err = Object.assign(new Error('rpc failure'), {
      info: { error: { code: -32602, message: 'invalid params: from must be hex' } },
    });
    expect(isFilterNotFoundError(err)).toBe(false);
    const invalidFilter = Object.assign(new Error('rpc failure'), {
      info: { error: { code: -32602, message: 'invalid filter object' } },
    });
    expect(isFilterNotFoundError(invalidFilter)).toBe(false);
    const unsupportedFilter = Object.assign(new Error('rpc failure'), {
      info: { error: { code: -32000, message: 'filter type not supported' } },
    });
    expect(isFilterNotFoundError(unsupportedFilter)).toBe(false);
    const serverErr = Object.assign(new Error('rpc failure'), {
      info: { error: { code: -32000, message: 'rate limited' } },
    });
    expect(isFilterNotFoundError(serverErr)).toBe(false);
  });

  it('does NOT match structured filter expiry errors from other RPC methods', () => {
    const err = Object.assign(new Error('could not coalesce error'), {
      info: {
        error: { code: -32602, message: 'filter not found' },
        payload: { method: 'eth_getLogs' },
      },
    });
    expect(isFilterNotFoundError(err)).toBe(false);
  });

  it('does NOT match unrelated provider errors', () => {
    expect(isFilterNotFoundError(new Error('ECONNRESET'))).toBe(false);
    expect(isFilterNotFoundError(new Error('rate limited'))).toBe(false);
    expect(isFilterNotFoundError(new Error('execution reverted: foo'))).toBe(false);
    expect(isFilterNotFoundError(undefined)).toBe(false);
    expect(isFilterNotFoundError(null)).toBe(false);
  });

  it('handles non-Error inputs gracefully', () => {
    expect(isFilterNotFoundError('filter not found')).toBe(false);
    expect(isFilterNotFoundError({ message: 'no match here' })).toBe(false);
  });
});

describe('formatProviderError', () => {
  it('includes stack/message plus nested ethers JSON-RPC fields', () => {
    const err = Object.assign(new Error('could not coalesce error'), {
      code: 'UNKNOWN_ERROR',
      info: { error: { code: -32000, message: 'rate limited' } },
      data: { request: { method: 'eth_getFilterChanges' } },
    });
    const formatted = formatProviderError(err);
    expect(formatted).toContain('could not coalesce error');
    expect(formatted).toContain('UNKNOWN_ERROR');
    expect(formatted).toContain('"code":-32000');
    expect(formatted).toContain('eth_getFilterChanges');
  });

  it('Codex #670 — preserves bigint payload fields instead of falling back to "[object Object]"', () => {
    // Codex (#670#discussion_r3301775310): ethers error payloads commonly
    // carry `bigint` fields (transaction values, chain ids, gas) inside
    // the nested `info.error` / `data` blocks. The previous `JSON.stringify`
    // call threw on these and the catch-fallback returned `String(value)`,
    // which yields `"[object Object]"` for typical error objects —
    // discarding the structured diagnostics this path is trying to
    // preserve. The serializer now stringifies bigints in a replacer.
    const err = Object.assign(new Error('insufficient funds for gas'), {
      code: 'CALL_EXCEPTION',
      info: {
        error: {
          code: -32000,
          message: 'insufficient funds',
          data: {
            value: 12345678901234567890n,
            chainId: 84532n,
            gasLimit: 5_000_000n,
          },
        },
      },
    });
    const formatted = formatProviderError(err);
    expect(formatted).not.toContain('[object Object]');
    expect(formatted).toContain('insufficient funds for gas');
    expect(formatted).toContain('CALL_EXCEPTION');
    expect(formatted).toContain('"value":"12345678901234567890"');
    expect(formatted).toContain('"chainId":"84532"');
    expect(formatted).toContain('"gasLimit":"5000000"');
  });
});

describe('createFilterErrorSilencer', () => {
  it('returns false (does NOT handle) for non-filter errors', () => {
    const log = recorder((_msg: string) => undefined);
    const silencer = createFilterErrorSilencer({ log });
    expect(silencer.handle(new Error('ECONNRESET'))).toBe(false);
    expect(log.calls).toEqual([]);
    expect(silencer.stats().filterErrorsTotal).toBe(0);
  });

  it('emits the first filter error immediately', () => {
    const log = recorder((_msg: string) => undefined);
    const silencer = createFilterErrorSilencer({ log, now: () => 1_000 });
    expect(silencer.handle(filterNotFoundError())).toBe(true);
    expect(log.calls).toHaveLength(1);
    expect(log.calls[0][0]).toContain('RPC filter expired');
    expect(log.calls[0][0]).toContain('RandomSampling/RandomSamplingStorage have a TTL fallback');
    expect(log.calls[0][0]).toContain('other Hub-resolved contract handles may stay stale');
    expect(silencer.stats().filterErrorsTotal).toBe(1);
    expect(silencer.stats().filterErrorsSuppressedInWindow).toBe(0);
  });

  it('suppresses subsequent errors within the dedup window', () => {
    const log = recorder((_msg: string) => undefined);
    let clock = 1_000;
    const silencer = createFilterErrorSilencer({
      log,
      dedupWindowMs: 60_000,
      now: () => clock,
    });
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(1);
    clock = 30_000;
    silencer.handle(filterNotFoundError());
    silencer.handle(filterNotFoundError());
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(1);
    expect(silencer.stats().filterErrorsTotal).toBe(4);
    expect(silencer.stats().filterErrorsSuppressedInWindow).toBe(3);
  });

  it('re-emits after the dedup window elapses with the suppressed count', () => {
    const log = recorder((_msg: string) => undefined);
    let clock = 1_000;
    const silencer = createFilterErrorSilencer({
      log,
      dedupWindowMs: 60_000,
      now: () => clock,
    });
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(1);
    clock = 30_000;
    silencer.handle(filterNotFoundError());
    silencer.handle(filterNotFoundError());
    clock = 70_000;
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(2);
    expect(log.calls[1][0]).toContain('2 similar errors suppressed');
    expect(silencer.stats().filterErrorsTotal).toBe(4);
    expect(silencer.stats().filterErrorsSuppressedInWindow).toBe(0);
  });

  it('omits the suppressed-suffix when no errors were suppressed since the last emit', () => {
    const log = recorder((_msg: string) => undefined);
    let clock = 1_000;
    const silencer = createFilterErrorSilencer({
      log,
      dedupWindowMs: 1_000,
      now: () => clock,
    });
    silencer.handle(filterNotFoundError());
    clock = 5_000;
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(2);
    expect(log.calls[0][0]).not.toContain('similar errors suppressed');
    expect(log.calls[1][0]).not.toContain('similar errors suppressed');
  });

  it('uses the default 5-minute window when not overridden', () => {
    const log = recorder((_msg: string) => undefined);
    let clock = 1_000;
    const silencer = createFilterErrorSilencer({ log, now: () => clock });
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(1);
    clock = 1_000 + DEFAULT_DEDUP_WINDOW_MS - 1;
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(1);
    clock = 1_000 + DEFAULT_DEDUP_WINDOW_MS;
    silencer.handle(filterNotFoundError());
    expect(log.calls).toHaveLength(2);
  });

  it('resetForTest clears all internal state', () => {
    const log = recorder((_msg: string) => undefined);
    const silencer = createFilterErrorSilencer({ log, now: () => 1_000 });
    silencer.handle(filterNotFoundError());
    silencer.handle(filterNotFoundError());
    expect(silencer.stats().filterErrorsTotal).toBe(2);
    silencer.resetForTest();
    expect(silencer.stats()).toEqual({
      filterErrorsTotal: 0,
      filterErrorsSuppressedInWindow: 0,
      lastEmitAt: null,
    });
  });

  it('non-filter errors don\'t bump the counter or affect the dedup window', () => {
    const log = recorder((_msg: string) => undefined);
    let clock = 1_000;
    const silencer = createFilterErrorSilencer({
      log,
      dedupWindowMs: 60_000,
      now: () => clock,
    });
    silencer.handle(filterNotFoundError());
    silencer.handle(new Error('ECONNRESET'));
    silencer.handle(new Error('rate limited'));
    expect(silencer.stats().filterErrorsTotal).toBe(1);
    expect(log.calls).toHaveLength(1);
  });
});

describe('production wiring shape (sanity)', () => {
  it('createFilterErrorSilencer with no args returns a working silencer using console.warn', () => {
    const silencer = createFilterErrorSilencer();
    const originalWarn = console.warn;
    const warnSpy = recorder((..._args: unknown[]) => undefined);
    (console as { warn: unknown }).warn = warnSpy;
    try {
      silencer.handle(filterNotFoundError());
      expect(warnSpy.calls).toHaveLength(1);
      expect(warnSpy.calls[0][0]).not.toContain('recreate');
    } finally {
      console.warn = originalWarn;
    }
  });
});
