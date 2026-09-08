import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrivateSwmRecoveryWindow, resolvePrivateSwmRecoveryBudgetMs } from '../src/sync/requester/private-swm-recovery-budget.js';
import { recoverContextGraphSwmWithProgressRetries, type RecoverContextGraphSwmResult } from '../src/sync/requester/swm-recovery.js';

function recoveryResult(
  readySnapshots: number,
  totalSnapshots: number,
  completed = false,
): RecoverContextGraphSwmResult {
  return {
    replacedRoots: 0,
    replacedGraphs: completed ? totalSnapshots : 0,
    insertedDataQuads: completed ? totalSnapshots : 0,
    insertedMetaQuads: completed ? totalSnapshots : 0,
    droppedDataTriples: 0,
    readySnapshots,
    totalSnapshots,
    completed,
  };
}

describe('private SWM recovery budget', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each(['', ' ', '-1', 'NaN', 'Infinity', '0.1', '1e20'])('defaults invalid or blank value %j', (raw) => {
    expect(resolvePrivateSwmRecoveryBudgetMs(raw)).toBe(600_000);
  });
  it.each(['0', ' 15 ', '600000'])('accepts the configured duration %j', (raw) => {
    expect(resolvePrivateSwmRecoveryBudgetMs(raw)).toBe(Number(raw));
  });
  it('shares one frozen monotonic allowance and caps each transport deadline', () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const budget = createPrivateSwmRecoveryWindow(50)!;
    expect(Object.isFrozen(budget)).toBe(true);
    expect(budget.capTimeout(Infinity)).toBe(50);
    expect(budget.capDeadline(2_000)).toBe(1_050);
    expect(budget.capDeadline(1_020)).toBe(1_020);
    expect(createPrivateSwmRecoveryWindow(0).capDeadline(2_000)).toBe(2_000);
    now = 160;
    expect(budget.capTimeout(Infinity)).toBe(0);
    expect(createPrivateSwmRecoveryWindow(0)).toMatchObject({ kind: 'initial-round-only' });
  });
});

describe('recoverContextGraphSwmWithProgressRetries', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it('stops progressing retries at one job budget despite a wall-clock rollback', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '100');
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - elapsed);
    let calls = 0;
    const onRetry = vi.fn();
    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover: async () => { elapsed += 40; return recoveryResult(++calls, 100); },
      onRetry,
    });
    expect(result).toMatchObject({ completed: false, readySnapshots: 3 });
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('rechecks the fixed job budget after a slow retry observer', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '10');
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const recover = vi.fn(async () => recoveryResult(1, 20));
    await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover,
      onRetry: () => { elapsed = 10; vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '1000'); },
    });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('uses zero to disable extra rounds while preserving the initial recovery', async () => {
    vi.stubEnv('DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS', '0');
    const recover = vi.fn(async () => recoveryResult(1, 20));
    await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()), recover });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('consumes monotonic immutable-snapshot progress inside one bounded catch-up job', async () => {
    const outcomes = [
      recoveryResult(5, 20),
      recoveryResult(10, 20),
      recoveryResult(15, 20),
      recoveryResult(20, 20, true),
    ];
    const retries: string[] = [];
    let calls = 0;

    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover: async () => outcomes[calls++]!,
      onRetry: ({ completedRound, readySnapshots, totalSnapshots }) => {
        retries.push(`${completedRound}:${readySnapshots}/${totalSnapshots}`);
      },
    });

    expect(result).toMatchObject({ completed: true, readySnapshots: 20, totalSnapshots: 20 });
    expect(calls).toBe(4);
    expect(retries).toEqual(['1:5/20', '2:10/20', '3:15/20']);
  });

  it('stops after one transient retry when snapshot progress is flat', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover: async () => {
        calls += 1;
        return recoveryResult(0, 20);
      },
    });

    expect(result.completed).toBe(false);
    expect(calls).toBe(3);
  });

  it('continues after one flat transport window when snapshot progress resumes', async () => {
    const outcomes = [
      recoveryResult(5, 20),
      recoveryResult(5, 20),
      recoveryResult(10, 20),
      recoveryResult(20, 20, true),
    ];
    const retries: string[] = [];
    let calls = 0;

    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover: async () => outcomes[calls++]!,
      onRetry: ({ completedRound, readySnapshots, totalSnapshots }) => {
        retries.push(`${completedRound}:${readySnapshots}/${totalSnapshots}`);
      },
    });

    expect(result).toMatchObject({ completed: true, readySnapshots: 20, totalSnapshots: 20 });
    expect(calls).toBe(4);
    expect(retries).toEqual(['1:5/20', '2:5/20', '3:10/20']);
  });

  it('extends the default cap while declared snapshots keep making progress', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover: async () => {
        calls += 1;
        return recoveryResult(calls, 20, calls === 20);
      },
    });

    expect(result).toMatchObject({ completed: true, readySnapshots: 20, totalSnapshots: 20 });
    expect(calls).toBe(20);
  });

  it('keeps snapshot-aware progress retries under an absolute ceiling', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      recover: async () => {
        calls += 1;
        return recoveryResult(calls, 100);
      },
    });

    expect(result).toMatchObject({ completed: false, readySnapshots: 24, totalSnapshots: 100 });
    expect(calls).toBe(24);
  });

  it('honours the hard recovery-round cap while progress continues', async () => {
    let calls = 0;
    const result = await recoverContextGraphSwmWithProgressRetries({
      window: createPrivateSwmRecoveryWindow(resolvePrivateSwmRecoveryBudgetMs()),
      maxRounds: 3,
      recover: async () => {
        calls += 1;
        return recoveryResult(calls, 100);
      },
    });

    expect(result).toMatchObject({ completed: false, readySnapshots: 3, totalSnapshots: 100 });
    expect(calls).toBe(3);
  });
});
