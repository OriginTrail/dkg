import { afterEach, expect, it, vi } from 'vitest';
import { Logger, createAsyncAdmissionDiagnosticTrace } from '@origintrail-official/dkg-core';
import { withPromoteControlLock } from '../src/promote-control-lock.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function latch() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}

it('attributes only overlapping hold time, across successive owners and an independent graph', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  let now = 10;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const log = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
  const ownerStarted = latch(), finishOwner = latch();
  const owner = withPromoteControlLock('one', async () => {
    ownerStarted.open();
    await finishOwner.promise;
    now = 35;
    throw new Error('failed owner');
  }, 'claimNext');
  await ownerStarted.promise;
  now = 20;
  const second = withPromoteControlLock('one', async () => { now = 55; }, 'getStats');
  const trace = createAsyncAdmissionDiagnosticTrace('share_async');
  const share = trace.run('enqueue', () => withPromoteControlLock('one', async () => 'accepted', 'enqueue'));
  await withPromoteControlLock('another', async () => {}, 'retention');
  finishOwner.open();
  await expect(owner).rejects.toThrow('failed owner');
  await second;
  await expect(share).resolves.toBe('accepted');
  const events = log.mock.calls.map(([, message]) => JSON.parse(message));
  expect(events.filter(e => e.phase === 'released').map(e => e.operation)).toEqual(['claimNext','getStats','enqueue']);
  const chainId = events[0].chainId;
  expect(events.filter(e => e.phase !== 'released')).toEqual([
    { event: 'async_share_lock_timing', requestId: trace.requestId, phase: 'queued', chainId, ticket: 3, ownerTicket: 1, owner: 'claimNext', ownerHeldMs: 10 },
    { event: 'async_share_lock_timing', requestId: trace.requestId, phase: 'acquired', chainId, ticket: 3, waitedMs: 35,
      blockedByMs: { claimNext: 15, getStats: 20 }, betweenOwnersMs: 0 },
  ]);
});

it('keeps the lock usable when logging throws and emits nothing with tracing disabled', async () => {
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '1');
  const log = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => { throw new Error('sink'); });
  const run = () => createAsyncAdmissionDiagnosticTrace('share_async').run('enqueue',
    () => withPromoteControlLock('one', async () => 1, 'enqueue'));
  await expect(run()).resolves.toBe(1);
  expect(log).toHaveBeenCalledTimes(3);
  vi.stubEnv('DKG_ASYNC_PROMOTE_ADMISSION_TRACE', '0');
  log.mockClear();
  await expect(run()).resolves.toBe(1);
  expect(log).not.toHaveBeenCalled();
});
