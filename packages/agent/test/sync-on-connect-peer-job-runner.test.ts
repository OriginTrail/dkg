import { describe, expect, it, vi } from 'vitest';

import type { SyncOnConnectAttemptResult } from
  '../src/sync/on-connect/attempt-accounting.js';
import { ReconciledSyncOnConnectPeerJobRunner } from
  '../src/sync/on-connect/peer-job-runner.js';
import {
  SyncOnConnectPostSyncError,
  type SyncOnConnectPeerOutcome,
} from '../src/sync/on-connect/sync-on-connect.js';

const PROBE = Object.freeze({ id: 'peer-probe' });
const ACTIVE_SYNC_LIFETIME = new AbortController().signal;

function completed(accounting: SyncOnConnectPeerOutcome): SyncOnConnectAttemptResult {
  return { outcome: 'synced', accounting };
}

function createRunner(input: Readonly<{
  runSelected?: () => Promise<SyncOnConnectAttemptResult>;
  runAutomaticSelected?: () => Promise<SyncOnConnectAttemptResult>;
  runOrdinary: () => Promise<SyncOnConnectAttemptResult>;
}>) {
  const commitAccounting = vi.fn();
  const resetBackoffBeforeRetry = vi.fn();
  const runner = new ReconciledSyncOnConnectPeerJobRunner<undefined, typeof PROBE>({
    acquireProbe: async () => PROBE,
    runSelected: input.runSelected ?? (async () => ({
      outcome: 'not-started',
      accounting: null,
    })),
    ...(input.runAutomaticSelected === undefined
      ? {}
      : { runAutomaticSelected: input.runAutomaticSelected }),
    runOrdinary: input.runOrdinary,
    selectedRetryStillRequired: () => false,
    resetBackoffBeforeRetry,
    commitAccounting,
    logBackpressure: () => undefined,
  }, { signal: ACTIVE_SYNC_LIFETIME });
  return { runner, commitAccounting, resetBackoffBeforeRetry };
}

function nonBackoffOrdinaryFailure(): SyncOnConnectPostSyncError {
  return new SyncOnConnectPostSyncError(
    '12D3KooWPeerJobRunner',
    new Error('ordinary discovery failed'),
    { backoffEligible: false },
  );
}

describe('sync-on-connect peer-job phase accounting', () => {
  it('cancels an active selected phase without launching ordinary probes or committing late accounting', async () => {
    const lifecycle = new AbortController();
    let resolveSelected!: (result: SyncOnConnectAttemptResult) => void;
    const selected = new Promise<SyncOnConnectAttemptResult>((resolve) => { resolveSelected = resolve; });
    const acquireProbe = vi.fn(async () => PROBE);
    const runSelected = vi.fn(() => selected);
    const runOrdinary = vi.fn(async () => completed({ reconcilerDisposition: 'clear', fresh: true, progress: true }));
    const commitAccounting = vi.fn();
    const resetBackoffBeforeRetry = vi.fn();
    const runner = new ReconciledSyncOnConnectPeerJobRunner({
      acquireProbe, runSelected, runAutomaticSelected: runSelected, runOrdinary,
      selectedRetryStillRequired: () => false, commitAccounting, resetBackoffBeforeRetry, logBackpressure: vi.fn(),
    }, { signal: lifecycle.signal });
    const running = runner.runAutomaticSelectedThenOrdinary();
    await vi.waitFor(() => expect(runSelected).toHaveBeenCalledOnce());
    lifecycle.abort();
    resolveSelected(completed({ reconcilerDisposition: 'retry', fresh: true, progress: true }));
    await running;
    runner.finish();
    expect(acquireProbe).toHaveBeenCalledOnce();
    expect(runOrdinary).not.toHaveBeenCalled();
    expect(commitAccounting).not.toHaveBeenCalled();
    expect(resetBackoffBeforeRetry).not.toHaveBeenCalled();
  });

  it('continues ordinary after automatic selected rejection and commits retry', async () => {
    const selectedFailure = new Error('automatic selected failed');
    const { runner, commitAccounting } = createRunner({
      runAutomaticSelected: async () => { throw selectedFailure; },
      runOrdinary: async () => completed({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      }),
    });

    await expect(runner.runAutomaticSelectedThenOrdinary())
      .rejects.toBe(selectedFailure);
    runner.finish();

    expect(commitAccounting).toHaveBeenCalledOnce();
    expect(commitAccounting).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: true,
    }, PROBE);
  });

  it('preserves an undefined automatic selected rejection', async () => {
    const { runner, commitAccounting } = createRunner({
      runAutomaticSelected: () => Promise.reject(undefined),
      runOrdinary: async () => completed({
        reconcilerDisposition: 'clear',
        fresh: true,
        progress: true,
      }),
    });

    await expect(runner.runAutomaticSelectedThenOrdinary())
      .rejects.toBeUndefined();
    runner.finish();

    expect(commitAccounting).toHaveBeenCalledOnce();
    expect(commitAccounting).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: true,
    }, PROBE);
  });

  it('retains both automatic selected and ordinary failures and commits once', async () => {
    const selectedFailure = new Error('automatic selected failed');
    const ordinaryFailure = new Error('ordinary failed');
    const { runner, commitAccounting } = createRunner({
      runAutomaticSelected: async () => { throw selectedFailure; },
      runOrdinary: async () => { throw ordinaryFailure; },
    });

    let rejection: unknown;
    try {
      await runner.runAutomaticSelectedThenOrdinary();
    } catch (error: unknown) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(AggregateError);
    expect((rejection as AggregateError).errors).toEqual([
      selectedFailure,
      ordinaryFailure,
    ]);
    runner.finish();

    expect(commitAccounting).toHaveBeenCalledOnce();
    expect(commitAccounting).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: false,
    }, PROBE);
  });

  it('suppresses selected clear when ordinary fails without accounting', async () => {
    const ordinaryFailure = nonBackoffOrdinaryFailure();
    const { runner, commitAccounting } = createRunner({
      runSelected: async () => completed({
        reconcilerDisposition: 'clear',
        fresh: false,
        progress: true,
      }),
      runOrdinary: async () => { throw ordinaryFailure; },
    });

    await runner.runSelected();
    await expect(runner.runAutomaticSelectedThenOrdinary())
      .rejects.toBe(ordinaryFailure);
    runner.finish();

    expect(commitAccounting).not.toHaveBeenCalled();
  });

  it('preserves selected retry when ordinary fails without accounting', async () => {
    const ordinaryFailure = nonBackoffOrdinaryFailure();
    const { runner, commitAccounting, resetBackoffBeforeRetry } = createRunner({
      runSelected: async () => completed({
        reconcilerDisposition: 'retry',
        fresh: false,
        progress: true,
      }),
      runOrdinary: async () => { throw ordinaryFailure; },
    });

    await runner.runSelected();
    await expect(runner.runAutomaticSelectedThenOrdinary())
      .rejects.toBe(ordinaryFailure);
    runner.finish();

    expect(commitAccounting).toHaveBeenCalledOnce();
    expect(commitAccounting).toHaveBeenCalledWith({
      reconcilerDisposition: 'retry',
      fresh: false,
      progress: false,
    }, PROBE);
    expect(resetBackoffBeforeRetry).not.toHaveBeenCalled();
  });
});
