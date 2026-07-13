import { describe, it, expect, vi } from 'vitest';
import {
  SignerWriteLane,
  SignerWriteLaneAdmissionTimeoutError,
  SignerWriteOperation,
  SignerWritePlan,
} from '../src/signer-write-lane.js';

const plan = (admissionBudgetMs: number) =>
  new SignerWritePlan(admissionBudgetMs).describePhase('test signer-write phase');

describe('SignerWriteLane', () => {
  it('covers every executable operation phase with one coarse admission budget', async () => {
    const events: string[] = [];
    const operation = new SignerWriteOperation<{ prefix: string }, { value: string }, string>(
      50,
      () => ({ value: '' }),
      (state) => state.value,
    )
      .phase('prepare', async (context, state) => {
        events.push('prepare');
        state.value = context.prefix;
      })
      .phase('submit', async (_context, state) => {
        events.push('submit');
        state.value += '-sent';
      });

    expect(operation.plan.admissionBudgetMs).toBe(50);
    expect(operation.plan.phaseLabels).toEqual(['prepare', 'submit']);
    await expect(operation.execute({ prefix: 'tx' })).resolves.toBe('tx-sent');
    expect(events).toEqual(['prepare', 'submit']);
    expect(() => operation.phase('unplanned late work', async () => undefined))
      .toThrow('Cannot add a signer write phase after execution has started');
    await expect(operation.execute({ prefix: 'again' }))
      .rejects.toThrow('Signer write operation can only execute once');
  });

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

  it('uses the predecessor operation-wide admission budget while retaining phase labels', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane();
      const predecessorPlan = new SignerWritePlan(30_000)
        .describePhase('populate and sign')
        .describePhase('broadcast and receipt');
      expect(predecessorPlan.admissionBudgetMs).toBe(30_000);
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

  it('immediately excludes a timed-out entry budget from later admission deadlines', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('abandoned-budget-wallet', plan(15), async () => gate);
      const second = lane.run(
        'abandoned-budget-wallet',
        plan(100),
        async () => 'must not run',
      );
      const secondExpectation = expect(second).rejects.toMatchObject({
        waitMs: 15,
        queueDepth: 2,
      });
      await vi.advanceTimersByTimeAsync(15);
      await secondExpectation;

      // Entry #2 has timed out but its FIFO tail still sits behind #1. A new
      // caller must wait for #1's advertised 15ms only, not the abandoned
      // 100ms budget from #2. Keep #1 held so the diagnostic deadline proves
      // both properties: the barrier remains, while the stale budget is gone.
      const third = lane.run(
        'abandoned-budget-wallet',
        plan(10),
        async () => 'third',
      );
      const thirdExpectation = expect(third).rejects.toMatchObject({
        waitMs: 15,
        queueDepth: 3,
      });
      await vi.advanceTimersByTimeAsync(15);
      await thirdExpectation;

      release();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(lane.isActive('abandoned-budget-wallet')).toBe(false);
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
