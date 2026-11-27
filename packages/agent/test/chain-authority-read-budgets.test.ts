import { describe, expect, it } from 'vitest';
import {
  CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_ENV,
  CHAIN_AUTHORITY_READ_TIMEOUT_ENV,
  DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS,
  resolveChainAuthorityReadBudgets,
  resolveChainAuthorityTimeoutMs,
} from '../src/chain-authority-read-budgets.js';
import {
  CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS,
  CHAIN_POLICY_READ_TIMEOUT_MS,
} from '../src/dkg-agent-constants.js';

describe('chain authority read budgets', () => {
  it('keeps the 2.5s request deadline and a longer cold budget by default', () => {
    expect(resolveChainAuthorityReadBudgets(undefined, {})).toEqual({
      requestTimeoutMs: CHAIN_POLICY_READ_TIMEOUT_MS,
      coldResolutionTimeoutMs: CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_MS,
    });
    expect(DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS.requestTimeoutMs).toBe(2_500);
    expect(DEFAULT_CHAIN_AUTHORITY_READ_BUDGETS.coldResolutionTimeoutMs).toBe(20_000);
  });

  it('honors explicit chain config values', () => {
    expect(resolveChainAuthorityReadBudgets({
      authorityReadTimeoutMs: 6_000,
      authorityColdResolutionTimeoutMs: 45_000,
    }, {})).toEqual({ requestTimeoutMs: 6_000, coldResolutionTimeoutMs: 45_000 });
  });

  it('never resolves the cold budget below the request deadline', () => {
    expect(resolveChainAuthorityReadBudgets({
      authorityReadTimeoutMs: 30_000,
      authorityColdResolutionTimeoutMs: 5_000,
    }, {})).toEqual({ requestTimeoutMs: 30_000, coldResolutionTimeoutMs: 30_000 });
    expect(resolveChainAuthorityReadBudgets({ authorityReadTimeoutMs: 25_000 }, {}))
      .toEqual({ requestTimeoutMs: 25_000, coldResolutionTimeoutMs: 25_000 });
  });

  it('lets the environment override both config and defaults', () => {
    expect(resolveChainAuthorityReadBudgets({
      authorityReadTimeoutMs: 6_000,
      authorityColdResolutionTimeoutMs: 45_000,
    }, {
      [CHAIN_AUTHORITY_READ_TIMEOUT_ENV]: ' 4000 ',
      [CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_ENV]: '60000',
    })).toEqual({ requestTimeoutMs: 4_000, coldResolutionTimeoutMs: 60_000 });
    expect(resolveChainAuthorityReadBudgets(undefined, {
      [CHAIN_AUTHORITY_READ_TIMEOUT_ENV]: '7500',
    })).toEqual({ requestTimeoutMs: 7_500, coldResolutionTimeoutMs: 20_000 });
  });

  it.each(['', '  ', '0', '-1', '2.5', 'abc', 'NaN'])(
    'ignores the unusable environment value %j instead of disabling the deadline',
    (raw) => {
      expect(resolveChainAuthorityReadBudgets({ authorityReadTimeoutMs: 3_000 }, {
        [CHAIN_AUTHORITY_READ_TIMEOUT_ENV]: raw,
        [CHAIN_AUTHORITY_COLD_RESOLUTION_TIMEOUT_ENV]: raw,
      })).toEqual({ requestTimeoutMs: 3_000, coldResolutionTimeoutMs: 20_000 });
    },
  );

  it.each([null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '2500'])(
    'fails fast on the explicit config value %j',
    (value) => {
      expect(() => resolveChainAuthorityReadBudgets({
        authorityReadTimeoutMs: value as unknown as number,
      }, {})).toThrow(/chainConfig\.authorityReadTimeoutMs must be a positive integer/);
      expect(() => resolveChainAuthorityReadBudgets({
        authorityColdResolutionTimeoutMs: value as unknown as number,
      }, {})).toThrow(/chainConfig\.authorityColdResolutionTimeoutMs must be a positive integer/);
      expect(() => resolveChainAuthorityTimeoutMs(value, 'chain.authorityReadTimeoutMs'))
        .toThrow(/chain\.authorityReadTimeoutMs must be a positive integer/);
    },
  );

  it('returns a frozen result so hot-path readers cannot drift the deadlines', () => {
    expect(Object.isFrozen(resolveChainAuthorityReadBudgets(undefined, {}))).toBe(true);
  });
});
