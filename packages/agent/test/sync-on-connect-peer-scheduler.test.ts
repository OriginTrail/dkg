import { describe, expect, it, vi } from 'vitest';

import { SyncOnConnectPeerScheduler } from
  '../src/sync/on-connect/peer-scheduler.js';

const PEER = '12D3KooWSchedulerPeer';

function createScheduler(callbacks: Readonly<{
  runOrdinary: () => Promise<void>;
  runSelected: (plan?: string) => Promise<void>;
  cancel?: () => void;
  finish?: () => void | Promise<void>;
  onInternalError?: (
    peer: string,
    error: unknown,
    stage: 'lane-error-handler' | 'runner-finalizer' | 'scheduler-drain',
  ) => void;
}>): SyncOnConnectPeerScheduler<string> {
  return new SyncOnConnectPeerScheduler<string>({
    createJob: () => ({
      runAutomaticSelectedThenOrdinary: async () => callbacks.runOrdinary(),
      runSelected: async (plan) => callbacks.runSelected(plan),
      cancel: callbacks.cancel ?? (() => undefined),
      finish: callbacks.finish ?? (() => undefined),
    }),
    onInternalError: callbacks.onInternalError ?? (() => undefined),
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

  it('does not allocate a peer-job runner when cleared before the timer drains', () => {
    const finish = vi.fn();
    const createJob = vi.fn(() => ({
      runAutomaticSelectedThenOrdinary: async () => undefined,
      runSelected: async () => undefined,
      cancel: () => undefined,
      finish,
    }));
    const scheduler = new SyncOnConnectPeerScheduler<string>({
      createJob,
      onInternalError: () => undefined,
    });

    expect(scheduler.enqueueOrdinary(PEER, () => undefined, 60_000)).toBe(true);
    scheduler.clear(PEER);

    expect(scheduler.size).toBe(0);
    expect(createJob).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });

  it('cleans up a construction failure, reports every accepted lane, and re-enqueues', async () => {
    const constructionFailure = new Error('runner construction failed');
    const ordinaryError = vi.fn();
    const selectedError = vi.fn();
    const runOrdinary = vi.fn(async () => undefined);
    let createAttempts = 0;
    const scheduler = new SyncOnConnectPeerScheduler<string>({
      createJob: () => {
        createAttempts += 1;
        if (createAttempts === 1) throw constructionFailure;
        return {
          runAutomaticSelectedThenOrdinary: runOrdinary,
          runSelected: async () => undefined,
          cancel: () => undefined,
          finish: () => undefined,
        };
      },
      onInternalError: () => undefined,
    });

    expect(scheduler.enqueueOrdinary(PEER, ordinaryError, 0)).toBe(true);
    expect(scheduler.enqueueSelected(PEER, selectedError, 0, 'exact-plan')).toBe(true);

    await vi.waitFor(() => expect(selectedError).toHaveBeenCalledWith(
      PEER,
      constructionFailure,
    ));
    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(ordinaryError).toHaveBeenCalledWith(PEER, constructionFailure);
    expect(ordinaryError).toHaveBeenCalledOnce();
    expect(selectedError).toHaveBeenCalledOnce();

    expect(scheduler.enqueueOrdinary(PEER, ordinaryError, 0)).toBe(true);
    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(createAttempts).toBe(2);
    expect(runOrdinary).toHaveBeenCalledOnce();
  });

  it('contains an error-handler rejection after timer ownership ends', async () => {
    const phaseFailure = new Error('ordinary phase failed');
    const consumerFailure = new Error('error consumer failed');
    const diagnosticFailure = new Error('diagnostic sink failed');
    const finish = vi.fn();
    const onInternalError = vi.fn(async () => { throw diagnosticFailure; });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const scheduler = createScheduler({
        runSelected: async () => undefined,
        runOrdinary: async () => { throw phaseFailure; },
        finish,
        onInternalError,
      });

      expect(scheduler.enqueueOrdinary(
        PEER,
        async () => { throw consumerFailure; },
        0,
      )).toBe(true);
      await vi.waitFor(() => expect(scheduler.size).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(finish).toHaveBeenCalledOnce();
      expect(onInternalError).toHaveBeenCalledWith(
        PEER,
        consumerFailure,
        'lane-error-handler',
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('drains accepted follow-up work after a lane error handler throws', async () => {
    const ordinary = deferred();
    const ordinaryStarted = deferred();
    const phaseFailure = new Error('ordinary phase failed');
    const consumerFailure = new Error('ordinary error handler failed');
    const selectedPlans: string[] = [];
    const selectedError = vi.fn();
    const onInternalError = vi.fn();
    const scheduler = createScheduler({
      runOrdinary: async () => {
        ordinaryStarted.resolve();
        await ordinary.promise;
        throw phaseFailure;
      },
      runSelected: async (plan) => {
        if (plan !== undefined) selectedPlans.push(plan);
      },
      onInternalError,
    });

    expect(scheduler.enqueueOrdinary(
      PEER,
      () => { throw consumerFailure; },
      0,
    )).toBe(true);
    await ordinaryStarted.promise;
    expect(scheduler.enqueueSelected(
      PEER,
      selectedError,
      0,
      'late-plan',
    )).toBe(true);
    ordinary.resolve();

    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(selectedPlans).toEqual(['late-plan']);
    expect(selectedError).not.toHaveBeenCalled();
    expect(onInternalError).toHaveBeenCalledWith(
      PEER,
      consumerFailure,
      'lane-error-handler',
    );
  });

  it('contains a finalizer rejection after cleaning up the peer job', async () => {
    const finalizerFailure = new Error('runner finalizer failed');
    const onInternalError = vi.fn();
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const scheduler = createScheduler({
        runSelected: async () => undefined,
        runOrdinary: async () => undefined,
        finish: async () => { throw finalizerFailure; },
        onInternalError,
      });

      expect(scheduler.enqueueOrdinary(PEER, () => undefined, 0)).toBe(true);
      await vi.waitFor(() => expect(scheduler.size).toBe(0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(onInternalError).toHaveBeenCalledWith(
        PEER,
        finalizerFailure,
        'runner-finalizer',
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('runs work accepted while an earlier job is finalizing', async () => {
    const firstFinishStarted = deferred();
    const releaseFirstFinish = deferred();
    const selectedPlans: string[] = [];
    let jobCount = 0;
    const scheduler = new SyncOnConnectPeerScheduler<string>({
      createJob: () => {
        jobCount += 1;
        const currentJob = jobCount;
        return {
          runAutomaticSelectedThenOrdinary: async () => 'synced',
          runSelected: async (plan) => {
            if (plan !== undefined) selectedPlans.push(plan);
            return 'synced';
          },
          cancel: () => undefined,
          finish: currentJob === 1
            ? async () => {
              firstFinishStarted.resolve();
              await releaseFirstFinish.promise;
            }
            : () => undefined,
        };
      },
      onInternalError: () => undefined,
    });

    expect(scheduler.enqueueOrdinary(PEER, () => undefined, 0)).toBe(true);
    await firstFinishStarted.promise;

    expect(scheduler.has(PEER)).toBe(false);
    expect(scheduler.enqueueSelected(
      PEER,
      () => undefined,
      0,
      'during-finalize',
    )).toBe(true);
    await vi.waitFor(() => expect(selectedPlans).toEqual(['during-finalize']));

    releaseFirstFinish.resolve();
    await vi.waitFor(() => expect(scheduler.size).toBe(0));
    expect(jobCount).toBe(2);
  });

  it('finalizes an active peer job once when it is cleared during a phase', async () => {
    const ordinary = deferred();
    const ordinaryStarted = deferred();
    const cancel = vi.fn();
    const finish = vi.fn();
    const scheduler = createScheduler({
      runOrdinary: async () => {
        ordinaryStarted.resolve();
        await ordinary.promise;
      },
      runSelected: async () => undefined,
      cancel,
      finish,
    });

    expect(scheduler.enqueueOrdinary(PEER, () => undefined, 0)).toBe(true);
    await ordinaryStarted.promise;
    scheduler.clear(PEER);
    ordinary.resolve();

    await vi.waitFor(() => expect(finish).toHaveBeenCalledOnce());
    expect(cancel).toHaveBeenCalledOnce();
    expect(scheduler.size).toBe(0);
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
    const finish = vi.fn();
    const scheduler = createScheduler({
      runSelected: async (plan) => {
        if (plan !== undefined) selectedPlans.push(plan);
      },
      runOrdinary: async () => {
        ordinaryStarted.resolve();
        await ordinary.promise;
        throw ordinaryFailure;
      },
      finish,
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
    expect(finish).toHaveBeenCalledOnce();
  });
});
