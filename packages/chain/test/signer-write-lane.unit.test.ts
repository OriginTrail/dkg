import { describe, it, expect, vi } from 'vitest';
import {
  SignerWriteLane,
  SignerWriteLaneAdmissionTimeoutError,
} from '../src/signer-write-lane.js';

describe('SignerWriteLane', () => {
  it('accepts one lane-wide budget and a per-write diagnostic label', async () => {
    const lane = new SignerWriteLane(50);
    await expect(lane.run(
      '0xwallet',
      'publish direct sequence',
      async () => 'sent',
    )).resolves.toBe('sent');
    expect(lane.isActive('0xwallet')).toBe(false);
  });

  it('reports a queued signer write once with its admission horizon', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00.000Z'));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const onQueued = vi.fn();
      const lane = new SignerWriteLane(50, onQueued);
      const first = lane.run('diagnostic-wallet', 'first', async () => gate);
      const second = lane.run('diagnostic-wallet', 'second', async () => 'second');

      expect(onQueued).toHaveBeenCalledOnce();
      expect(onQueued).toHaveBeenCalledWith({
        signerAddress: 'diagnostic-wallet',
        label: 'second',
        queueDepth: 2,
        waitMs: 50,
        deadlineAt: Date.now() + 50,
      });

      release();
      await first;
      await expect(second).resolves.toBe('second');
      expect(onQueued).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the lane held after admission timeout and rejects late work behind the expired runner', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(15);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('0xwallet', 'test signer write', async () => gate);
      let timedOutWriteRan = false;
      const second = lane.run(
        '0xwallet',
        'test signer write',
        async () => { timedOutWriteRan = true; },
      );
      const secondExpectation = expect(second).rejects.toMatchObject({
        name: 'SignerWriteLaneAdmissionTimeoutError',
        code: 'SIGNER_WRITE_LANE_ADMISSION_TIMEOUT',
        signerAddress: '0xwallet',
        queueDepth: 2,
        label: 'test signer write',
      } satisfies Partial<SignerWriteLaneAdmissionTimeoutError>);
      await vi.advanceTimersByTimeAsync(15);
      await secondExpectation;

      let laterWriteStarted = false;
      const third = lane.run(
        '0xwallet',
        'test signer write',
        async () => { laterWriteStarted = true; return 'third'; },
      );
      const thirdExpectation = expect(third).rejects.toMatchObject({
        name: 'SignerWriteLaneAdmissionTimeoutError',
        waitMs: 0,
        queueDepth: 3,
      });
      expect(lane.isActive('0xwallet')).toBe(true);
      expect(laterWriteStarted).toBe(false);
      await thirdExpectation;

      release();
      await expect(first).resolves.toBeUndefined();
      expect(timedOutWriteRan).toBe(false);
      expect(laterWriteStarted).toBe(false);
      expect(lane.isActive('0xwallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the predecessor operation-wide admission budget', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(30_000);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('slow-wallet', 'publish direct sequence', async () => gate);
      let ran = false;
      const second = lane.run(
        'slow-wallet',
        'publish direct sequence',
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

  it('expires a successor before drain when the admission timer callback is delayed', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(15);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('blocked-loop-wallet', 'first', async () => gate);
      const callback = vi.fn(async () => 'must not run');
      const second = lane.run('blocked-loop-wallet', 'second', callback);
      const secondExpectation = expect(second).rejects.toMatchObject({
        name: 'SignerWriteLaneAdmissionTimeoutError',
        waitMs: 20,
        queueDepth: 2,
      });

      // Move wall time past the deadline without servicing timers, modelling a
      // blocked event loop whose runner settles before the overdue callback.
      vi.setSystemTime(Date.now() + 20);
      release();
      await first;
      await vi.advanceTimersByTimeAsync(0);

      await secondExpectation;
      expect(callback).not.toHaveBeenCalled();
      expect(lane.isActive('blocked-loop-wallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('immediately excludes a timed-out entry budget from later admission deadlines', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(15);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('abandoned-budget-wallet', 'first', async () => gate);
      const second = lane.run(
        'abandoned-budget-wallet',
        'second',
        async () => 'must not run',
      );
      const secondExpectation = expect(second).rejects.toMatchObject({
        waitMs: 15,
        queueDepth: 2,
      });
      await vi.advanceTimersByTimeAsync(15);
      await secondExpectation;

      // Entry #2 has timed out but its FIFO tail still sits behind #1. A new
      // caller must not receive a fresh budget after #1 has already consumed
      // its advertised 15ms. Entry #2 remains only as a FIFO barrier and does
      // not extend the already-expired occupancy window.
      const third = lane.run(
        'abandoned-budget-wallet',
        'third',
        async () => 'third',
      );
      const thirdExpectation = expect(third).rejects.toMatchObject({
        waitMs: 0,
        queueDepth: 3,
      });
      await thirdExpectation;

      release();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(lane.isActive('abandoned-budget-wallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebases a pre-enqueued burst when abandoned predecessor budgets disappear', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(15);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = lane.run('burst-wallet', 'first', async () => gate);
      const callbacks = [vi.fn(), vi.fn(), vi.fn()];
      const queued = callbacks.map((callback, index) => lane.run(
        'burst-wallet',
        `queued-${index + 2}`,
        async () => { callback(); },
      ));
      const settled = Promise.allSettled(queued);

      await vi.advanceTimersByTimeAsync(14);
      expect(callbacks.every((callback) => callback.mock.calls.length === 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      const results = await settled;
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: {
            name: 'SignerWriteLaneAdmissionTimeoutError',
            waitMs: 15,
          },
        });
      }
      expect(callbacks.every((callback) => callback.mock.calls.length === 0)).toBe(true);

      release();
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(lane.isActive('burst-wallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a later caller through the cumulative plans of every queued predecessor', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(30_000);
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const first = lane.run('mixed-wallet', 'first', async () => delay(29_999));
      const second = lane.run('mixed-wallet', 'second', async () => delay(29_999));
      let thirdStarted = false;
      let thirdSettled = false;
      let thirdError: unknown;
      const third = lane.run('mixed-wallet', 'third', async () => {
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
      // either individual predecessor budget. Only the cumulative 30s + 30s
      // admission budget keeps the third entry alive here.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(thirdStarted).toBe(false);
      expect(thirdSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(24_999);
      await Promise.all([first, second, third]);
      expect(thirdError).toBeUndefined();
      expect(thirdStarted).toBe(true);
      expect(lane.isActive('mixed-wallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('grants a successor its full budget after an earlier predecessor finishes early', async () => {
    vi.useFakeTimers();
    try {
      const lane = new SignerWriteLane(30);
      const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const first = lane.run('early-wallet', 'first', async () => delay(15));
      let releaseSecond!: () => void;
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const second = lane.run('early-wallet', 'second', async () => secondGate);
      const third = lane.run('early-wallet', 'third', async () => 'must not run');
      let thirdSettled = false;
      const thirdResult = third.catch((error: unknown) => {
        thirdSettled = true;
        return error;
      });

      await vi.advanceTimersByTimeAsync(15);
      await first;
      await vi.advanceTimersByTimeAsync(29);
      expect(thirdSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await expect(thirdResult).resolves.toMatchObject({
        name: 'SignerWriteLaneAdmissionTimeoutError',
        waitMs: 45,
        queueDepth: 3,
      });

      releaseSecond();
      await second;
      await vi.advanceTimersByTimeAsync(0);
      expect(lane.isActive('early-wallet')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
