import { describe, expect, it, vi } from 'vitest';
import {
  FINALIZATION_RECOVERY_WORKER_BATCH_SIZE,
  FinalizationRecoveryWorker,
} from '../src/finalization-recovery-worker.js';

describe('FinalizationRecoveryWorker', () => {
  it('continues full batches immediately and uses the configured SQLite batch size', async () => {
    const processDueBatch = vi.fn()
      .mockResolvedValueOnce(FINALIZATION_RECOVERY_WORKER_BATCH_SIZE)
      .mockResolvedValueOnce(0);
    const worker = new FinalizationRecoveryWorker(
      processDueBatch,
      { info: () => {}, warn: () => {} },
      { pollIntervalMs: 60_000 },
    );
    try {
      worker.start();
      await vi.waitFor(() => expect(processDueBatch).toHaveBeenCalledTimes(2));
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
});
