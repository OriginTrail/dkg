import { describe, it, expect, vi } from 'vitest';
import {
  SignerWriteLane,
  SignerWriteLaneAdmissionTimeoutError,
  SignerWritePlan,
} from '../src/signer-write-lane.js';

const plan = (executionBudgetMs: number) =>
  new SignerWritePlan().reserve('test signer-write phase', executionBudgetMs);

describe('SignerWriteLane', () => {
  it('keeps the lane held after an admission timeout, skips that write, then runs later work', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('0xwallet', plan(15), async () => gate);
      let timedOutWriteRan = false;
      const second = lane.run(
        '0xwallet',
        plan(15),
        async () => { timedOutWriteRan = true; },
      );
      const secondExpectation = expect(second).rejects.toMatchObject({
        name: 'SignerWriteLaneAdmissionTimeoutError',
        code: 'SIGNER_WRITE_LANE_ADMISSION_TIMEOUT',
        signerAddress: '0xwallet',
        queueDepth: 2,
      } satisfies Partial<SignerWriteLaneAdmissionTimeoutError>);
      await vi.advanceTimersByTimeAsync(15);
      await secondExpectation;

      let laterWriteStarted = false;
      const third = lane.run(
        '0xwallet',
        plan(15),
        async () => { laterWriteStarted = true; return 'third'; },
      );
      expect(lane.isActive('0xwallet')).toBe(true);
      expect(laterWriteStarted).toBe(false);

      release();
      await expect(first).resolves.toBeUndefined();
      await expect(third).resolves.toBe('third');
      expect(timedOutWriteRan).toBe(false);
      expect(laterWriteStarted).toBe(true);
      expect(lane.isActive('0xwallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives admission from the predecessor write plan phases', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane();
      const predecessorPlan = new SignerWritePlan()
        .reserve('populate and sign', 20_000)
        .reserve('broadcast and receipt', 10_000);
      expect(predecessorPlan.executionBudgetMs).toBe(30_000);
      expect(predecessorPlan.phaseLabels).toEqual([
        'populate and sign',
        'broadcast and receipt',
      ]);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('slow-wallet', predecessorPlan, async () => gate);
      let ran = false;
      const second = lane.run(
        'slow-wallet',
        plan(10_000),
        async () => { ran = true; return 'sent'; },
      );

      await vi.advanceTimersByTimeAsync(20_000);
      expect(ran).toBe(false);
      expect(lane.isActive('slow-wallet')).toBe(true);
      release();
      await first;
      await expect(second).resolves.toBe('sent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a later caller through the cumulative plans of every queued predecessor', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane();
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const first = lane.run('mixed-wallet', plan(30_000), async () => delay(29_999));
      const second = lane.run('mixed-wallet', plan(20_000), async () => delay(19_999));
      let thirdStarted = false;
      let thirdSettled = false;
      let thirdError: unknown;
      const third = lane.run('mixed-wallet', plan(5_000), async () => {
        thirdStarted = true;
        return 'third';
      }).then(
        (value) => { thirdSettled = true; return value; },
        (error: unknown) => {
          thirdSettled = true;
          thirdError = error;
          return undefined;
        },
      );

      // The second predecessor has started, but the total lane hold has passed
      // either individual predecessor budget. Only the cumulative 30s + 20s
      // admission budget keeps the third entry alive here.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(thirdStarted).toBe(false);
      expect(thirdSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all([first, second, third]);
      expect(thirdError).toBeUndefined();
      expect(thirdStarted).toBe(true);
      expect(lane.isActive('mixed-wallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
