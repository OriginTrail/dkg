import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/retry.js';

describe('withRetry', () => {
  it('returns on first success', async () => {
    let calls = 0;
    const fn = async () => { calls++; return 'ok'; };
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries on transient failure then succeeds', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 2) throw new Error(calls === 1 ? 'timeout' : 'reset');
      return 'ok';
    };

    const retries: number[] = [];
    const result = await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      onRetry: (attempt) => { retries.push(attempt); },
    });

    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(retries.length).toBe(2);
  });

  it('throws after exhausting all attempts', async () => {
    const fn = async () => { throw new Error('persistent'); };

    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 10 }))
      .rejects.toThrow('persistent');
  });

  it('throws immediately for non-retryable errors', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw new Error('fatal'); };

    await expect(withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      isRetryable: () => false,
    })).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('respects maxDelayMs cap', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 1) throw new Error('fail');
      return 'ok';
    };

    const delays: number[] = [];
    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 100_000,
      maxDelayMs: 50,
      jitter: 0,
      onRetry: (_attempt, delay) => { delays.push(delay); },
    });

    expect(delays[0]).toBeLessThanOrEqual(50);
  });

  it('exponential delay sequence doubles with jitter=0', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 3) throw new Error(`fail-${calls}`);
      return 'ok';
    };

    const delays: number[] = [];
    await withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 10_000,
      jitter: 0,
      onRetry: (_attempt, delay) => { delays.push(delay); },
    });

    expect(delays).toEqual([10, 20, 40]);
  });

  it('onRetry receives incrementing attempt numbers starting at 1', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 2) throw new Error(`fail-${calls}`);
      return 'ok';
    };

    const attempts: number[] = [];
    await withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 1,
      jitter: 0,
      onRetry: (attempt) => { attempts.push(attempt); },
    });

    expect(attempts).toEqual([1, 2]);
  });

  it('jitter adds randomness to delay', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 1) throw new Error('fail');
      return 'ok';
    };

    const delays: number[] = [];
    await withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      jitter: 1,
      onRetry: (_attempt, delay) => { delays.push(delay); },
    });

    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(200);
  });

  it('uses defaults when no options provided', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 1) throw new Error('retry');
      return 'ok';
    };

    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('onRetry receives the error that triggered the retry', async () => {
    const specificError = new Error('specific-error');
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls <= 1) throw specificError;
      return 'ok';
    };

    const errors: unknown[] = [];
    await withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 1,
      jitter: 0,
      onRetry: (_attempt, _delay, err) => { errors.push(err); },
    });

    expect(errors[0]).toBe(specificError);
  });
});
