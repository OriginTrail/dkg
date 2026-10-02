import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import { PromoteJobLeaseError, type PromoteAttemptError } from '@origintrail-official/dkg-publisher';
import {
  createPromoteWorkerSupervisor,
  type PromoteWorkerLogger,
  type PromoteWorkerSupervisor,
} from '../src/daemon/worker/async-promote-worker.js';
import {
  createAsyncPromoteWorkerFixture,
  retryableBookkeepingFailure,
  retryableSchedulerBusyFailure,
  type AsyncPromoteWorkerFixture,
} from './_helpers/async-promote-worker-fixture.js';

const EVENT = 'async_promote_failure_bookkeeping_uncertain';
const SECRET = 'private-bookkeeping-payload-token';
const fixtures: AsyncPromoteWorkerFixture[] = [];
const supervisors: PromoteWorkerSupervisor[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.store.close()));
});

async function setup(log?: PromoteWorkerLogger) {
  const fixture = createAsyncPromoteWorkerFixture({ maxRetries: 5, leaseMs: 1_000 });
  fixtures.push(fixture);
  const { queue, clock, logs } = fixture;
  // Keep authoritative reads available when injecting failure into the worker's observation.
  const read = queue.getStatus.bind(queue);
  const fail = queue.fail.bind(queue);
  const promote = vi.fn<() => Promise<{ promotedCount: number }>>()
    .mockRejectedValueOnce(retryableBookkeepingFailure())
    .mockResolvedValue({ promotedCount: 1 });
  const supervisor = createPromoteWorkerSupervisor({
    agent: { promoteQueue: queue, assertion: { promote } } as unknown as DKGAgent,
    workerConcurrency: 1,
    pollIntervalMs: 1_000_000,
    postCommitRecoveryIntervalMs: 0,
    heartbeatIntervalMs: 0,
    bookkeepingRetryIntervalMs: 5,
    bookkeepingRetryBudgetMs: 10,
    shutdownTimeoutMs: 1_000,
    now: clock.now,
    sleep: clock.sleep,
    workerIdPrefix: 'bookkeeping-test',
    log: (message) => {
      logs.push(message);
      return log?.(message);
    },
  });
  supervisors.push(supervisor);
  // Enqueue before attaching wake scheduling, then drive the actual supervisor explicitly.
  const jobId = await queue.enqueue(fixture.makeRequest());
  await supervisor.start();
  const run = async () => {
    expect(await supervisor.tickOnce()).toBe(1);
    // stop() drains the real attempt and its supervisor catch/finally.
    await supervisor.stop();
  };
  return { ...fixture, read, fail, promote, supervisor, jobId, run };
}

function diagnostic(logs: string[], stage: string) {
  const events = logs.filter((line) => line.includes(EVENT)).map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ event: EVENT, stage });
  expect(logs.join('\n')).not.toContain(SECRET);
}

describe('GH#2892 supervisor failure bookkeeping boundaries', () => {
  it.each(['same-process claim', 'startup'] as const)(
    'preserves pre-write uncertainty until %s reconciles the expired started lease',
    async (recovery) => {
      const h = await setup();
      const transitions: PromoteAttemptError[] = [];
      const failSpy = vi.spyOn(h.queue, 'fail').mockImplementation(async (jobId, token, error) => {
        transitions.push(error);
        if (transitions.length === 1) throw new Error(SECRET);
        return h.fail(jobId, token, error);
      });
      await h.run();
      expect(failSpy).toHaveBeenCalledTimes(1);
      expect(transitions[0]).toMatchObject({ retryable: true, classification: 'transient' });
      const pending = await h.read(h.jobId);
      expect(pending).toMatchObject({
        state: 'running', attempt: { count: 1, maxRetries: 5 },
        commitMarker: { promoteStarted: true, swmInserted: false },
      });
      expect(pending?.lease).toBeDefined();
      expect(pending?.attempt.lastError).toBeUndefined();
      expect(h.promote).toHaveBeenCalledTimes(1);
      expect(h.supervisor.getCounters()).toMatchObject({ failedTerminal: 0, failedRetrying: 0 });
      diagnostic(h.logs, 'record_failure');
      expect(h.logs.join('\n')).not.toContain(pending!.lease!.claimToken);

      failSpy.mockRestore();
      h.clock.advance(1_001);
      if (recovery === 'startup') {
        await h.supervisor.start();
        expect(await h.supervisor.tickOnce()).toBe(0);
        await h.supervisor.stop();
      } else {
        expect(await h.queue.claimNext('later-worker')).toBeNull();
      }
      const held = await h.read(h.jobId);
      expect(held).toMatchObject({ state: 'failed', attempt: { count: 1, maxRetries: 5 } });
      expect(held?.reason).toMatch(/partial promote ambiguity.*operator inspection/i);
      expect(held?.lease).toBeUndefined();
      await expect(h.queue.recover(h.jobId)).rejects.toThrow(/partial promote ambiguity/i);
      expect(h.promote).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['write acknowledgement', 'outcome read'] as const)(
    'trusts the durable retrying row after a failed %s and retries only at its deadline',
    async (boundary) => {
      const h = await setup();
      let originalError: PromoteAttemptError | undefined;
      let oldToken = '';
      const failSpy = vi.spyOn(h.queue, 'fail').mockImplementation(async (jobId, token, error) => {
        originalError ??= error;
        oldToken ||= token;
        await h.fail(jobId, token, error);
        if (boundary === 'write acknowledgement') throw new Error(SECRET);
      });
      if (boundary === 'outcome read') {
        vi.spyOn(h.queue, 'getStatus').mockRejectedValueOnce(new Error(SECRET));
      }
      await h.run();
      expect(failSpy).toHaveBeenCalledTimes(1);
      const retrying = await h.read(h.jobId);
      expect(retrying).toMatchObject({
        state: 'failed_retrying', attempt: { count: 1, maxRetries: 5, lastError: originalError },
      });
      expect(retrying?.lease).toBeUndefined();
      expect(retrying?.attempt.nextRetryAt).toBe(h.clock.now() + 60_000);
      expect(h.promote).toHaveBeenCalledTimes(1);
      expect(h.supervisor.getCounters()).toMatchObject({ failedTerminal: 0, failedRetrying: 0 });
      diagnostic(h.logs, boundary === 'outcome read' ? 'read_failure_outcome' : 'record_failure');
      await expect(h.fail(h.jobId, oldToken, {
        message: 'stale worker', retryable: false, classification: 'fatal', recordedAt: h.clock.now(),
      })).rejects.toBeInstanceOf(PromoteJobLeaseError);
      expect((await h.read(h.jobId))?.attempt.lastError).toEqual(originalError);

      failSpy.mockRestore();
      await h.supervisor.start();
      expect(await h.supervisor.tickOnce()).toBe(0);
      expect(h.promote).toHaveBeenCalledTimes(1);
      h.clock.advance(60_000);
      await h.run();
      expect(await h.read(h.jobId)).toMatchObject({ state: 'succeeded', attempt: { count: 2, maxRetries: 5 } });
      expect(h.promote).toHaveBeenCalledTimes(2);
    },
  );

  it.each([retryableSchedulerBusyFailure, retryableBookkeepingFailure])(
    'hands off after the existing no-write bookkeeping budget without another promotion',
    async (makeFailure) => {
      const h = await setup();
      const startedAt = h.clock.now();
      const failSpy = vi.spyOn(h.queue, 'fail').mockRejectedValue(makeFailure());
      await h.run();
      expect(failSpy).toHaveBeenCalledTimes(3);
      expect(h.clock.now()).toBe(startedAt + 10);
      expect(failSpy.mock.calls.every((call) => call[2].retryable && call[2].classification === 'transient')).toBe(true);
      expect(h.promote).toHaveBeenCalledTimes(1);
      expect(await h.read(h.jobId)).toMatchObject({ state: 'running', attempt: { count: 1, maxRetries: 5 } });
      diagnostic(h.logs, 'record_failure');
    },
  );

  it('does not interpret another owner outcome after losing the failure-transition lease', async () => {
    const h = await setup();
    const failSpy = vi.spyOn(h.queue, 'fail').mockImplementation(async (jobId, token, error) => {
      await h.fail(jobId, token, error);
      throw new PromoteJobLeaseError(jobId, 'lease no longer held');
    });
    const observation = vi.spyOn(h.queue, 'getStatus');
    await h.run();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(observation).not.toHaveBeenCalled();
    expect(h.supervisor.getCounters()).toMatchObject({ failedTerminal: 0, failedRetrying: 0 });
    expect(await h.read(h.jobId)).toMatchObject({ state: 'failed_retrying', attempt: { count: 1 } });
    diagnostic(h.logs, 'record_failure');
  });

  it.each(['missing', 'running'] as const)('does not invent a terminal verdict from a %s outcome read', async (state) => {
    const h = await setup();
    const failSpy = vi.spyOn(h.queue, 'fail').mockResolvedValue(undefined);
    if (state === 'missing') vi.spyOn(h.queue, 'getStatus').mockResolvedValue(null);
    await h.run();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(h.supervisor.getCounters()).toMatchObject({ failedTerminal: 0, failedRetrying: 0 });
    expect(await h.read(h.jobId)).toMatchObject({ state: 'running', attempt: { count: 1 } });
    expect(h.promote).toHaveBeenCalledTimes(1);
    diagnostic(h.logs, 'read_failure_outcome');
  });

  it('does not attribute a newer attempt outcome to the previous worker', async () => {
    const h = await setup();
    const failSpy = vi.spyOn(h.queue, 'fail');
    vi.spyOn(h.queue, 'getStatus').mockImplementation(async (jobId) => {
      const current = await h.read(jobId);
      if (!current) return null;
      return { ...current, attempt: { ...current.attempt, count: current.attempt.count + 1 } };
    });
    await h.run();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(h.supervisor.getCounters()).toMatchObject({ failedTerminal: 0, failedRetrying: 0 });
    expect(await h.read(h.jobId)).toMatchObject({ state: 'failed_retrying', attempt: { count: 1 } });
    diagnostic(h.logs, 'read_failure_outcome');
  });

  it.each(['sync', 'async'] as const)('keeps uncertainty safe if its %s diagnostic sink fails', async (kind) => {
    const h = await setup((message) => {
      if (!message.includes(EVENT)) return;
      if (kind === 'sync') throw new Error(SECRET);
      return Promise.reject(new Error(SECRET));
    });
    const failSpy = vi.spyOn(h.queue, 'fail').mockRejectedValue(new Error(SECRET));
    await h.run();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(await h.read(h.jobId)).toMatchObject({ state: 'running', attempt: { count: 1 } });
    expect(h.promote).toHaveBeenCalledTimes(1);
    diagnostic(h.logs, 'record_failure');
  });

  it('retains genuine fatal operation outcomes', async () => {
    const h = await setup();
    h.promote.mockReset().mockRejectedValue(new Error('Unknown assertion'));
    const failSpy = vi.spyOn(h.queue, 'fail');
    await h.run();
    expect(failSpy).toHaveBeenCalledTimes(1);
    expect(await h.read(h.jobId)).toMatchObject({
      state: 'failed', attempt: { count: 1, maxRetries: 5, lastError: { retryable: false, classification: 'fatal' } },
    });
    expect(h.supervisor.getCounters().failedTerminal).toBe(1);
    expect(h.logs.some((line) => line.includes(EVENT))).toBe(false);
  });
});
