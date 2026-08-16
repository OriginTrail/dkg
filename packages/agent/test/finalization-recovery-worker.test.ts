import { describe, expect, it, vi } from 'vitest';
import {
  FINALIZATION_RECOVERY_WORKER_BATCH_SIZE,
  FinalizationRecoveryWorker,
} from '../src/finalization-recovery-worker.js';

describe('FinalizationRecoveryWorker', () => {
  it('yields between full batches and uses the configured SQLite batch size', async () => {
    vi.useFakeTimers();
    const processDueBatch = vi.fn()
      .mockResolvedValueOnce(FINALIZATION_RECOVERY_WORKER_BATCH_SIZE)
      .mockResolvedValueOnce(0);
    const worker = new FinalizationRecoveryWorker(
      processDueBatch,
      { info: () => {}, warn: () => {} },
      { pollIntervalMs: 25 },
    );
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(processDueBatch).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(24);
      expect(processDueBatch).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      expect(processDueBatch).toHaveBeenCalledTimes(2);
      expect(processDueBatch).toHaveBeenNthCalledWith(
        1,
        FINALIZATION_RECOVERY_WORKER_BATCH_SIZE,
      );
      expect(processDueBatch).toHaveBeenNthCalledWith(
        2,
        FINALIZATION_RECOVERY_WORKER_BATCH_SIZE,
      );
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });

  it('never overlaps batches and waits for the active batch during shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processDueBatch = vi.fn(async () => {
      await gate;
      return FINALIZATION_RECOVERY_WORKER_BATCH_SIZE;
    });
    const worker = new FinalizationRecoveryWorker(
      processDueBatch,
      { info: () => {}, warn: () => {} },
      { pollIntervalMs: 1 },
    );
    worker.start();
    await vi.waitFor(() => expect(processDueBatch).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(processDueBatch).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(worker.running).toBe(false);
    expect(processDueBatch).toHaveBeenCalledOnce();
  });

  it('logs a transient batch failure and continues polling', async () => {
    vi.useFakeTimers();
    const processDueBatch = vi.fn()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(0);
    const warn = vi.fn();
    const worker = new FinalizationRecoveryWorker(
      processDueBatch,
      { info: () => {}, warn },
      { pollIntervalMs: 25 },
    );
    try {
      worker.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(processDueBatch).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        'Finalization recovery worker batch failed: busy',
      );
      expect(worker.running).toBe(true);

      await vi.advanceTimersByTimeAsync(25);
      expect(processDueBatch).toHaveBeenCalledTimes(2);
    } finally {
      await worker.stop();
      vi.useRealTimers();
    }
  });
});
