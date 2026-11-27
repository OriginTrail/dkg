import { describe, expect, it, vi } from 'vitest';
import { raceAgainstCallerAbort } from '../src/caller-abort.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('raceAgainstCallerAbort', () => {
  it('preserves Error abort-reason identity and normalizes other reasons', async () => {
    const errorController = new AbortController();
    const reason = new Error('caller stopped');
    errorController.abort(reason);
    const rejection = await raceAgainstCallerAbort(
      Promise.resolve('unused'),
      errorController.signal,
    ).catch((error) => error);
    expect(rejection).toBe(reason);

    const stringController = new AbortController();
    stringController.abort('string reason');
    await expect(raceAgainstCallerAbort(
      Promise.resolve('unused'),
      stringController.signal,
    )).rejects.toThrow('string reason');
  });

  it('leaves no failure of the work unhandled when the caller has already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller stopped'));
    let fail!: (error: Error) => void;
    const work = new Promise<string>((_, reject) => { fail = reject; });
    const caught = vi.spyOn(work, 'catch');
    await expect(raceAgainstCallerAbort(work, controller.signal)).rejects.toThrow('caller stopped');
    expect(caught).toHaveBeenCalled();
    fail(new Error('store read aborted'));
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('removes its abort listener when shared work settles', async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const work = deferred<string>();
    const raced = raceAgainstCallerAbort(work.promise, controller.signal);

    work.resolve('done');
    await expect(raced).resolves.toBe('done');
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
