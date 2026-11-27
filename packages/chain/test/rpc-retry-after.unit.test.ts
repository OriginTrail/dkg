// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { errorRetryAfterMs, errorStatus } from '../src/evm-adapter-errors.js';

describe('RPC Retry-After extraction', () => {
  it('reads delta-seconds from the nested ethers FetchResponse shape', () => {
    const error = {
      code: 'SERVER_ERROR',
      info: {
        response: {
          statusCode: 429,
          headers: { 'retry-after': '17' },
        },
      },
    };

    expect(errorStatus(error)).toBe(429);
    expect(errorRetryAfterMs(error)).toBe(17_000);
  });

  it('reads an HTTP date from a Headers-like wrapper', () => {
    const now = Date.UTC(2026, 8, 10, 12, 0, 0);
    const retryAt = new Date(now + 42_000).toUTCString();
    const error = {
      cause: {
        response: {
          headers: {
            get(name: string) {
              return name.toLowerCase() === 'retry-after' ? retryAt : null;
            },
          },
        },
      },
    };

    expect(errorRetryAfterMs(error, now)).toBe(42_000);
  });

  it('ignores malformed and unsafe values without throwing', () => {
    const cyclic: Record<string, unknown> = {
      headers: { 'Retry-After': 'not-a-date' },
    };
    cyclic.cause = cyclic;

    expect(errorRetryAfterMs(cyclic)).toBeUndefined();
    expect(errorRetryAfterMs({
      response: { headers: { 'retry-after': '999999999999999999999' } },
    })).toBeUndefined();
  });
});
