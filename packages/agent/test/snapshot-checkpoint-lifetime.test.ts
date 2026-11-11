import { afterEach, expect, it, vi } from 'vitest';
import { checkpointLifetime } from '../src/snapshot-checkpoint-lifetime.js';
import { CHECKPOINT_PROFILE } from '../src/snapshot-checkpoint-profile.js';

afterEach(() => vi.useRealTimers());
it('retains the exact deadline and forwards the original cancellation reason', () => {
  vi.useFakeTimers();
  const parent = new AbortController(), scope = checkpointLifetime(parent.signal, Date.now() + 100);
  vi.advanceTimersByTime(99); expect(scope.signal.aborted).toBe(false);
  const reason = new Error('caller cancelled'); parent.abort(reason);
  expect(scope.signal.reason).toBe(reason);
  vi.advanceTimersByTime(1); expect(scope.signal.reason).toBe(reason); scope.dispose();
});
it('expires at the original deadline with the stage-specific reason', () => {
  vi.useFakeTimers();
  const scope = checkpointLifetime(new AbortController().signal, Date.now() + 100, 'catch-up expired');
  vi.advanceTimersByTime(99); expect(scope.signal.aborted).toBe(false);
  vi.advanceTimersByTime(1); expect(scope.signal.reason).toMatchObject({ message: 'catch-up expired' }); scope.dispose();
});
it('disposes the timer and forwarding listener without cancelling transferred ownership', () => {
  vi.useFakeTimers();
  const parent = new AbortController(), remove = vi.spyOn(parent.signal, 'removeEventListener');
  const scope = checkpointLifetime(parent.signal, Date.now() + 100);
  scope.dispose(); scope.dispose(); expect(vi.getTimerCount()).toBe(0);
  parent.abort(new Error('caller ended')); vi.advanceTimersByTime(200);
  expect(scope.signal.aborted).toBe(false); expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
it('refuses expired, excessive and already-cancelled scopes without scheduling work', () => {
  vi.useFakeTimers(); const parent = new AbortController();
  for (const duration of [0, -1, CHECKPOINT_PROFILE.jobTimeoutMs + 1])
    expect(() => checkpointLifetime(parent.signal, Date.now() + duration)).toThrow('deadline');
  const reason = new Error('already cancelled'); parent.abort(reason);
  expect(() => checkpointLifetime(parent.signal, Date.now() + 100)).toThrow(reason);
  expect(vi.getTimerCount()).toBe(0);
});
