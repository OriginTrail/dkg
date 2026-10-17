import { describe, expect, it, vi } from 'vitest';
import { StorageACKAdmission, type StorageACKAdmissionEvent } from '../src/storage-ack-admission.js';
import { AgentWorkLifetime } from '../src/agent-work-lifetime.js';
import { runStorageACKOperation, StorageACKDiagnostics } from '../src/storage-ack-diagnostics.js';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe('StorageACK admission lifecycle and pressure', () => {
  it('retains FIFO and physical ownership through active cancellation', async () => {
    const gate = new StorageACKAdmission(() => 1);
    const blocker = deferred(); const controller = new AbortController(); const order: number[] = [];
    const first = gate.run(async () => { order.push(1); await blocker.promise; }, controller.signal).catch(error => error);
    const second = gate.run(async () => { order.push(2); });
    const third = gate.run(async () => { order.push(3); });
    await vi.waitFor(() => expect(order).toEqual([1]));
    controller.abort(new Error('stop active caller'));
    await Promise.resolve(); expect(order).toEqual([1]);
    blocker.resolve(); await Promise.all([first, second, third]);
    expect(order).toEqual([1, 2, 3]); expect(await first).toMatchObject({ message: 'stop active caller' });
  });
  it('removes a cancelled waiter without blocking or overtaking its surviving successor', async () => {
    const gate = new StorageACKAdmission(() => 1); const blocker = deferred(); const controller = new AbortController();
    const order: number[] = []; const first = gate.run(async () => { await blocker.promise; });
    const cancelled = gate.run(async () => { order.push(2); }, controller.signal).catch(error => error);
    const third = gate.run(async () => { order.push(3); });
    controller.abort(new Error('cancelled')); expect(await cancelled).toMatchObject({ message: 'cancelled' });
    blocker.resolve(); await Promise.all([first, third]); expect(order).toEqual([3]);
  });
  it('reserves immediate capacity before a queued observer re-enters', async () => {
    const gate = new StorageACKAdmission(() => 1); const blocker = deferred(); const order: number[] = [];
    let reentrant: Promise<void> | undefined;
    const first = gate.run(async () => { order.push(1); await blocker.promise; }, undefined, event => {
      if (event.stage === 'queued') reentrant = gate.run(async () => { order.push(2); });
    });
    await vi.waitFor(() => expect(order).toEqual([1]));
    blocker.resolve(); await first; await reentrant; expect(order).toEqual([1, 2]);
  });
  it('transfers ownership before a released observer re-enters', async () => {
    const gate = new StorageACKAdmission(() => 1); const blocker = deferred(); const order: number[] = [];
    let reentrant: Promise<void> | undefined;
    const first = gate.run(async () => { order.push(1); await blocker.promise; }, undefined, event => {
      if (event.stage === 'released') reentrant = gate.run(async () => { order.push(3); });
    });
    const second = gate.run(async () => { order.push(2); });
    blocker.resolve(); await Promise.all([first, second]); await reentrant;
    expect(order).toEqual([1, 2, 3]);
  });
  it('does not let a throwing observer strand the slot', async () => {
    const gate = new StorageACKAdmission(() => 1);
    await expect(gate.run(async () => 1, undefined, () => { throw new Error('log failed'); })).resolves.toBe(1);
    await expect(gate.run(async () => 2)).resolves.toBe(2);
  });
  it('fences a preflight captured before shutdown even if the lifetime reopens', async () => {
    const lifetime = new AgentWorkLifetime(); const gate = new StorageACKAdmission(() => 1);
    const blocker = deferred(); const collect = vi.fn(async () => 3); const logs: string[] = [];
    const old = runStorageACKOperation(lifetime, gate, 'publish', m => logs.push(m), async admit => {
      await blocker.promise; return admit(collect);
    }).catch(error => error);
    lifetime.close(new Error('shutdown')); lifetime.open(); blocker.resolve();
    expect(await old).toMatchObject({ message: 'shutdown' }); expect(collect).not.toHaveBeenCalled();
    await lifetime.drain(); expect(lifetime.physicalRuns.size).toBe(0);
    expect(logs).toHaveLength(1); expect(logs[0]).toContain('"outcome":"cancelled"');
  });
  it('keeps shutdown retirement pending until an active dependency settles', async () => {
    const lifetime = new AgentWorkLifetime(); const gate = new StorageACKAdmission(() => 1); const blocker = deferred();
    let entered = false;
    const run = runStorageACKOperation(lifetime, gate, 'update', () => {}, admit => admit(async () => {
      entered = true; await blocker.promise; return 3;
    })).catch(error => error);
    await vi.waitFor(() => expect(entered).toBe(true)); lifetime.close(new Error('shutdown'));
    let drained = false; const drain = lifetime.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false);
    blocker.resolve(); await drain; expect(await run).toMatchObject({ message: 'shutdown' });
  });
  it('separates monotonic preflight, wait and collector spans in one bounded summary', () => {
    let now = 10; const logs: string[] = []; const diag = new StorageACKDiagnostics('publish', m => logs.push(m), () => now);
    now = 20; diag.preflightComplete();
    diag.collector({ completedPeerAttempts: 3, perRoundPeakPeerRequests: 2, peerAttemptMs: 12.3456,
      backoffs: 2, backoffMs: 7.8901, transportBackoffs: 1, transientDeclineBackoffs: 1,
      candidates: { total: 3, ack: 2, declined: 1, invalid: 0, unsupported: 0, transport: 0, pending: 0 } });
    const event = (stage: StorageACKAdmissionEvent['stage'], waitMs = 0, workMs = 0) => diag.admission({ stage, waitMs, workMs, active: 1, queued: 2 });
    event('queued'); now = 50; event('acquired', 30); now = 100; event('released', 30, 50); diag.succeeded(); diag.finish();
    const summary = JSON.parse(logs[0].slice('[StorageACKAdmission] '.length));
    expect(summary).toMatchObject({ preflightMs: 10, gateWaitMs: 30, collectorMs: 50, totalMs: 90,
      gateQueuedAfterMs: 10, gateAcquiredAfterMs: 40, gateReleasedAfterMs: 90, outcome: 'succeeded',
      completedPeerAttempts: 3, perRoundPeakPeerRequests: 2, peerAttemptMs: 12.346,
      backoffs: 2, backoffMs: 7.89, transportBackoffs: 1, transientDeclineBackoffs: 1,
      candidates: { total: 3, ack: 2, declined: 1, invalid: 0, unsupported: 0, transport: 0, pending: 0 } });
    expect(logs).toHaveLength(1); expect(logs[0].length).toBeLessThan(1024);
  });
});
