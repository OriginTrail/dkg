import { describe, expect, it, vi } from 'vitest';
import { raceAgainstAbort, throwIfAborted } from '../src/abort-utils.js';

describe('abort utilities', () => {
  it('preserves an already-aborted signal reason', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    controller.abort(reason);

    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
    await expect(raceAgainstAbort(Promise.resolve('late'), controller.signal)).rejects.toBe(reason);
  });

  it('removes its listener when the signal wins the race', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const reason = new Error('caller cancelled in flight');
    const raced = raceAgainstAbort(new Promise<void>(() => {}), controller.signal);

    controller.abort(reason);

    await expect(raced).rejects.toBe(reason);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('removes its listener when the work wins the race', async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(raceAgainstAbort(Promise.resolve('done'), controller.signal)).resolves.toBe('done');
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});
