import { describe, expect, it, vi } from 'vitest';

import { SyncOnConnectPeerScheduler } from
  '../src/sync/on-connect/peer-scheduler.js';

const PEER = '12D3KooWSchedulerPeer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('sync-on-connect per-peer scheduler', () => {
  it('upgrades pending ordinary work and drains selected first', async () => {
    const ordering: string[] = [];
    const scheduler = new SyncOnConnectPeerScheduler<string>({
      runSelected: async (_peer, _onError, plan) => { ordering.push(`selected:${plan}`); },
      runOrdinary: async (_peer, _onError, mode) => { ordering.push(`ordinary:${mode}`); },
    });
    const onError = () => undefined;

    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(true);
    expect(scheduler.enqueueSelected(PEER, onError, 0, 'exact-plan')).toBe(true);

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(ordering).toEqual([
      'selected:exact-plan',
      'ordinary:ordinary-after-selected',
    ]);
  });

  it('retains an exact upgrade during ordinary work without reopening ordinary work', async () => {
    const ordinary = deferred();
    const selected = deferred();
    const ordering: string[] = [];
    const scheduler = new SyncOnConnectPeerScheduler<string>({
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
    const scheduler = new SyncOnConnectPeerScheduler<string>({
      runSelected: async () => {
        ordering.push('selected');
        await selected.promise;
      },
      runOrdinary: async (_peer, _onError, mode) => {
        ordering.push(`ordinary:${mode}`);
      },
    });
    const onError = () => undefined;

    expect(scheduler.enqueueSelected(PEER, onError, 0, 'plan')).toBe(true);
    await vi.waitFor(() => expect(ordering).toEqual(['selected']));
    expect(scheduler.enqueueOrdinary(PEER, onError, 0)).toBe(true);
    selected.resolve();

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(ordering).toEqual(['selected', 'ordinary:ordinary-after-selected']);
  });

  it('drains a selected upgrade during selected work before owed ordinary work', async () => {
    const firstSelected = deferred();
    const ordering: string[] = [];
    const scheduler = new SyncOnConnectPeerScheduler<string>({
      runSelected: async (_peer, _onError, plan) => {
        ordering.push(`selected:${plan}`);
        if (plan === 'plan-a') await firstSelected.promise;
      },
      runOrdinary: async (_peer, _onError, mode) => {
        ordering.push(`ordinary:${mode}`);
      },
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
      'ordinary:ordinary-after-selected',
    ]);
  });
});
