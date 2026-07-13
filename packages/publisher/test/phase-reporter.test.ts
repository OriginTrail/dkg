import { describe, expect, it, vi } from 'vitest';
import { PhaseReporter } from '../src/publisher.js';

describe('PhaseReporter', () => {
  it('awaits start, work and end in order with their respective contexts', async () => {
    const events: string[] = [];
    const reporter = new PhaseReporter(async (_phase, status, context) => {
      await Promise.resolve();
      events.push(`${status}:${context?.txHash ?? 'none'}`);
    });

    const value = await reporter.scope(
      'chain:test',
      async () => {
        events.push('work');
        return 42;
      },
      {
        startContext: { txHash: '0xstart' },
        endContext: { txHash: '0xend' },
      },
    );

    expect(value).toBe(42);
    expect(events).toEqual(['start:0xstart', 'work', 'end:0xend']);
  });

  it('closes a phase when its work rejects', async () => {
    const events: string[] = [];
    const reporter = new PhaseReporter((_phase, status) => { events.push(status); });

    await expect(reporter.scope('test', async () => {
      events.push('work');
      throw new Error('body failed');
    })).rejects.toThrow('body failed');

    expect(events).toEqual(['start', 'work', 'end']);
  });

  it('preserves both errors when work and end reject', async () => {
    const workFailure = new Error('work failed');
    const endFailure = new Error('end failed');
    const reporter = new PhaseReporter((_phase, status) => {
      if (status === 'end') throw endFailure;
    });

    const result = reporter.scope('test', async () => { throw workFailure; });
    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [workFailure, endFailure],
    });
  });

  it('propagates an end rejection when work succeeds', async () => {
    const endFailure = new Error('end failed');
    const reporter = new PhaseReporter((_phase, status) => {
      if (status === 'end') throw endFailure;
    });

    await expect(reporter.scope('test', async () => 'ok')).rejects.toBe(endFailure);
  });

  it('does not run work or emit end when start rejects', async () => {
    const work = vi.fn(async () => undefined);
    const events: string[] = [];
    const reporter = new PhaseReporter((_phase, status) => {
      events.push(status);
      if (status === 'start') throw new Error('start failed');
    });

    await expect(reporter.scope('test', work)).rejects.toThrow('start failed');
    expect(work).not.toHaveBeenCalled();
    expect(events).toEqual(['start']);
  });

  it('emits end once and returns the same rejection to concurrent close callers', async () => {
    let endCalls = 0;
    const endFailure = new Error('end failed');
    const reporter = new PhaseReporter((_phase, status) => {
      if (status === 'end') {
        endCalls += 1;
        throw endFailure;
      }
    });
    const scope = await reporter.open('test');

    const [first, second] = await Promise.allSettled([scope.close(), scope.close()]);

    expect(endCalls).toBe(1);
    expect(first).toMatchObject({ status: 'rejected', reason: endFailure });
    expect(second).toMatchObject({ status: 'rejected', reason: endFailure });
  });
});
