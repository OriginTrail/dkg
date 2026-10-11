/**
 * `runLabeledFlows`, proven without a devnet: the flows run side by side, every
 * one is awaited to its end even after another failed, and every failure is
 * reported under its own label.
 */
import { describe, expect, it } from 'vitest';
import { runLabeledFlows } from './flows.js';

/** A promise settled from outside. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Fail with a readable message, instead of hanging to the test timeout, if `promise` does not settle in time. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref(); }),
  ]);
}

describe('runLabeledFlows', () => {
  it('returns the values in the order the flows were given, whichever finishes first', async () => {
    const slow = deferred<string>();
    const done = runLabeledFlows([
      { label: 'first', run: () => slow.promise },
      { label: 'second', run: async () => 'b' },
    ]);
    slow.resolve('a');
    await expect(done).resolves.toEqual(['a', 'b']);
  });

  it('runs the flows side by side: the first only finishes once the second has started', async () => {
    const secondStarted = deferred();
    const result = runLabeledFlows([
      { label: 'first', run: async () => { await secondStarted.promise; return 'first'; } },
      { label: 'second', run: async () => { secondStarted.resolve(); return 'second'; } },
    ]);
    // Run one after the other, the first flow would wait for a start that never comes.
    await expect(within(result, 2_000, 'both flows to finish')).resolves.toEqual(['first', 'second']);
  });

  it('waits for the surviving flow before it reports a failure, so nothing keeps running unobserved', async () => {
    const release = deferred();
    let survivorFinished = false;
    const result = runLabeledFlows([
      { label: 'fails at once', run: async () => { throw new Error('boom'); } },
      { label: 'survivor', run: async () => { await release.promise; survivorFinished = true; } },
    ]);
    let settledEarly = false;
    void result.then(() => { settledEarly = true; }, () => { settledEarly = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settledEarly, 'the failure is held back while the other flow still runs').toBe(false);
    release.resolve();
    await expect(result).rejects.toThrow('[fails at once] boom');
    expect(survivorFinished, 'the surviving flow ran to its end before the failure surfaced').toBe(true);
  });

  it('reports every failed flow under its own label and keeps the first failure as the cause', async () => {
    const first = new Error('adoption never happened');
    const outcome = await runLabeledFlows([
      { label: 'name-hash subscribe', run: async () => { throw first; } },
      { label: 'numeric-id subscribe', run: async () => { throw new TypeError('no job id'); } },
      { label: 'fine', run: async () => 1 },
    ]).then(() => undefined, (err: unknown) => err);
    expect(outcome).toBeInstanceOf(AggregateError);
    const error = outcome as AggregateError;
    expect(error.message).toContain('2 of 3 flow(s) failed');
    expect(error.message).toContain('[name-hash subscribe] adoption never happened');
    expect(error.message).toContain('[numeric-id subscribe] no job id');
    expect(error.message).not.toContain('[fine]');
    expect(error.cause).toBe(first);
    expect(error.errors).toHaveLength(2);
  });

  it('turns a synchronous throw in a flow into a labeled failure and still awaits the others', async () => {
    let finished = false;
    const result = runLabeledFlows([
      { label: 'throws while starting', run: (() => { throw new Error('sync boom'); }) as () => Promise<void> },
      { label: 'other', run: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); finished = true; } },
    ]);
    await expect(result).rejects.toThrow('[throws while starting] sync boom');
    expect(finished).toBe(true);
  });

  it('accepts no flows', async () => {
    await expect(runLabeledFlows([])).resolves.toEqual([]);
  });
});
