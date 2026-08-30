import { describe, expect, it, vi } from 'vitest';

import { SyncOnConnectPeerScheduler } from
  '../src/sync/on-connect/peer-scheduler.js';

const PEER = '12D3KooWSchedulerPeer';

function createScheduler(callbacks: Readonly<{
  runOrdinary: () => Promise<void>;
  runSelected: (plan?: string) => Promise<void>;
  finish?: () => void;
}>): SyncOnConnectPeerScheduler<string> {
  return new SyncOnConnectPeerScheduler<string>({
    createJob: () => ({
      runOrdinary: async () => callbacks.runOrdinary(),
      runSelected: async (plan) => callbacks.runSelected(plan),
      finish: callbacks.finish ?? (() => undefined),
    }),
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('sync-on-connect per-peer scheduler', () => {
  it('upgrades pending ordinary work and drains selected first', async () => {
    const ordering: string[] = [];
    const finish = vi.fn();
    const scheduler = createScheduler({
      runSelected: async (plan) => { ordering.push(`selected:${plan}`); },
      runOrdinary: async () => { ordering.push('ordinary'); },
      finish,
    });
    const onError = () => undefined;

    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(true);
    expect(scheduler.enqueueSelected(PEER, onError, 0, 'exact-plan')).toBe(true);

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(ordering).toEqual([
      'selected:exact-plan',
      'ordinary',
    ]);
    expect(finish).toHaveBeenCalledOnce();
  });

  it('retains an exact upgrade during ordinary work without reopening ordinary work', async () => {
    const ordinary = deferred();
    const selected = deferred();
    const ordering: string[] = [];
    const scheduler = createScheduler({
      runSelected: async () => {
        ordering.push('selected');
        await selected.promise;
      },
      runOrdinary: async () => {
        ordering.push('ordinary');
        await ordinary.promise;
      },
    });
    const onError = () => undefined;

    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(true);
    await vi.waitFor(() => expect(ordering).toEqual(['ordinary']));
    expect(scheduler.enqueueSelected(PEER, onError, 0, 'late-plan')).toBe(true);
    ordinary.resolve();
    await vi.waitFor(() => expect(ordering).toEqual(['ordinary', 'selected']));
    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(false);
    selected.resolve();

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
  });

  it('adds owed ordinary work while selected recovery is running', async () => {
    const selected = deferred();
    const ordering: string[] = [];
    const scheduler = createScheduler({
      runSelected: async () => {
        ordering.push('selected');
        await selected.promise;
      },
      runOrdinary: async () => { ordering.push('ordinary'); },
    });
    const onError = () => undefined;

    expect(scheduler.enqueueSelected(PEER, onError, 0, 'plan')).toBe(true);
    await vi.waitFor(() => expect(ordering).toEqual(['selected']));
    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(true);
    selected.resolve();

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(ordering).toEqual(['selected', 'ordinary']);
  });

  it('drains a selected upgrade during selected work before owed ordinary work', async () => {
    const firstSelected = deferred();
    const ordering: string[] = [];
    const scheduler = createScheduler({
      runSelected: async (plan) => {
        ordering.push(`selected:${plan}`);
        if (plan === 'plan-a') await firstSelected.promise;
      },
      runOrdinary: async () => { ordering.push('ordinary'); },
    });
    const onError = () => undefined;

    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(true);
    expect(scheduler.enqueueSelected(PEER, onError, 0, 'plan-a')).toBe(true);
    await vi.waitFor(() => expect(ordering).toEqual(['selected:plan-a']));
    expect(scheduler.enqueueSelected(PEER, onError, 0, 'plan-b')).toBe(true);
    firstSelected.resolve();

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(ordering).toEqual([
      'selected:plan-a',
      'selected:plan-b',
      'ordinary',
    ]);
  });

  it('routes a late rejection to the handler owned by the failing lane', async () => {
    const ordinary = deferred();
    const ordinaryStarted = deferred();
    const ordinaryFailure = new Error('ordinary lane failed');
    const firstErrors: unknown[] = [];
    const lateErrors: unknown[] = [];
    const selectedPlans: string[] = [];
    const scheduler = createScheduler({
      runSelected: async (plan) => {
        if (plan !== undefined) selectedPlans.push(plan);
      },
      runOrdinary: async () => {
        ordinaryStarted.resolve();
        await ordinary.promise;
        throw ordinaryFailure;
      },
    });

    expect(scheduler.enqueueOrdinary(
      PEER,
      (_peer, error) => firstErrors.push(error),
      0,
    )).toBe(true);
    await ordinaryStarted.promise;
    expect(scheduler.enqueueSelected(
      PEER,
      (_peer, error) => lateErrors.push(error),
      0,
      'late-plan',
    )).toBe(true);

    ordinary.resolve();
    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(firstErrors).toEqual([ordinaryFailure]);
    expect(lateErrors).toEqual([]);
    expect(selectedPlans).toEqual(['late-plan']);
  });
});
