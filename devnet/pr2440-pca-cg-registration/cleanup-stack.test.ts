import { describe, expect, it } from 'vitest';
import { CleanupStack } from './live-pca-publisher-lifecycle.js';

describe('CleanupStack', () => {
  it('shares an in-flight attempt, retains failures, and skips completed actions on retry', async () => {
    const cleanup = new CleanupStack();
    let completedRuns = 0;
    let flakyRuns = 0;
    let releaseFlaky!: () => void;
    const flakyGate = new Promise<void>((resolve) => {
      releaseFlaky = resolve;
    });

    cleanup.defer('completed action', () => {
      completedRuns += 1;
    });
    cleanup.defer('flaky action', async () => {
      flakyRuns += 1;
      if (flakyRuns === 1) {
        await flakyGate;
        throw new Error('injected cleanup failure');
      }
    });

    const firstAttempt = cleanup.dispose();
    const concurrentAttempt = cleanup.dispose();
    expect(concurrentAttempt).toBe(firstAttempt);
    releaseFlaky();
    await expect(firstAttempt).rejects.toThrow('flaky action: injected cleanup failure');
    expect(flakyRuns).toBe(1);
    expect(completedRuns).toBe(1);

    const retryAttempt = cleanup.dispose();
    expect(retryAttempt).not.toBe(firstAttempt);
    await retryAttempt;
    expect(flakyRuns).toBe(2);
    expect(completedRuns).toBe(1);
    const completedAttempt = cleanup.dispose();
    expect(completedAttempt).not.toBe(retryAttempt);
    await completedAttempt;
    expect(flakyRuns).toBe(2);
    expect(completedRuns).toBe(1);
  });
});
