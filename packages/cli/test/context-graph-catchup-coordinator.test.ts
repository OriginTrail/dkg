import type { ContextGraphReadinessProvenance } from '@origintrail-official/dkg-node-ui';
import { describe, expect, it, vi } from 'vitest';
import { ContextGraphCatchupCoordinatorService } from '../src/daemon/context-graph-catchup-coordinator.js';
import type { CatchupJob, CatchupTracker } from '../src/daemon/types.js';
import {
  cleanEmptyResult,
  privateDataOnlyResult,
  publicDurableAndSharedMemoryResult,
} from './helpers/context-graph-catchup-fixtures.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForJob(job: CatchupJob): Promise<void> {
  for (let attempt = 0; attempt < 50 && !job.finishedAt; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  if (!job.finishedAt) throw new Error(`catch-up job ${job.jobId} did not settle`);
}

function deniedResult() {
  const result = cleanEmptyResult();
  result.denied = true;
  result.deniedPeers = 1;
  result.peersSucceeded = 0;
  if (!result.cleanPlaneCompletions || !result.diagnostics) {
    throw new Error('completion evidence missing');
  }
  result.cleanPlaneCompletions.durable.emptyPeers = 0;
  result.cleanPlaneCompletions.sharedMemory.emptyPeers = 0;
  result.diagnostics.durable.emptyResponses = 0;
  result.diagnostics.sharedMemory.emptyResponses = 0;
  return result;
}

function coordinatorFixture(options: {
  failUpgrade?: boolean;
  baseOutcome?: 'success' | 'throw' | 'denied';
} = {}) {
  const tracker: CatchupTracker = {
    jobs: new Map(),
    latestByContextGraph: new Map(),
    inFlightByContextGraph: new Map(),
  };
  let readiness: ContextGraphReadinessProvenance = {
    version: 1,
    durableVerified: false,
    sharedMemoryVerified: false,
    updatedAt: 1,
  };
  let sequence = 0;
  const firstRunStarted = deferred();
  const releaseFirstRun = deferred();
  const run = vi.fn(async (request: { includeSharedMemory: boolean }) => {
    if (!request.includeSharedMemory) {
      firstRunStarted.resolve();
      await releaseFirstRun.promise;
      if (options.baseOutcome === 'throw') {
        throw new Error('base attempt failed');
      }
      if (options.baseOutcome === 'denied') return deniedResult();
      return privateDataOnlyResult();
    }
    return options.failUpgrade
      ? privateDataOnlyResult()
      : publicDurableAndSharedMemoryResult();
  });
  const service = new ContextGraphCatchupCoordinatorService(tracker, {
    runner: { run },
    readReadiness: () => readiness,
    hasConfirmedMeta: async () => true,
    isPrivate: async () => false,
    writeReadiness: (_contextGraphId, patch) => {
      readiness = { ...readiness, ...patch, updatedAt: readiness.updatedAt + 1 };
    },
    markSubscriptionState: vi.fn(),
    emitProjectSynced: vi.fn(),
    createJobId: () => `job-${++sequence}`,
  });
  return {
    tracker,
    service,
    run,
    firstRunStarted,
    releaseFirstRun,
  };
}

describe('ContextGraphCatchupCoordinatorService', () => {
  it('keeps job scopes immutable and serializes one wider upgrade', async () => {
    const fixture = coordinatorFixture();
    const base = fixture.service.start({
      contextGraphId: 'cg:one',
      includeSharedMemory: false,
      readinessBeforeCatchup: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
        updatedAt: 1,
      },
    });
    await fixture.firstRunStarted.promise;

    const upgrade = fixture.service.coalesceActive({
      contextGraphId: 'cg:one',
      includeSharedMemory: true,
    });
    const repeatedUpgrade = fixture.service.coalesceActive({
      contextGraphId: 'cg:one',
      includeSharedMemory: true,
    });

    expect(base).toMatchObject({ jobId: 'job-1', includeWorkspace: false });
    expect(upgrade).toMatchObject({ jobId: 'job-2', includeWorkspace: true });
    expect(repeatedUpgrade?.jobId).toBe(upgrade?.jobId);
    expect(fixture.run).toHaveBeenCalledTimes(1);

    fixture.releaseFirstRun.resolve();
    await waitForJob(base);
    if (!upgrade) throw new Error('upgrade job missing');
    await waitForJob(upgrade);

    expect(fixture.run.mock.calls.map(([request]) => request)).toEqual([
      { contextGraphId: 'cg:one', includeSharedMemory: false },
      { contextGraphId: 'cg:one', includeSharedMemory: true },
    ]);
    expect(base).toMatchObject({ includeWorkspace: false, status: 'done' });
    expect(upgrade).toMatchObject({ includeWorkspace: true, status: 'done' });
    expect(fixture.tracker.inFlightByContextGraph.has('cg:one')).toBe(false);
  });

  it('does not retroactively fail VM-only success when the wider upgrade is incomplete', async () => {
    const fixture = coordinatorFixture({ failUpgrade: true });
    const base = fixture.service.start({
      contextGraphId: 'cg:two',
      includeSharedMemory: false,
      readinessBeforeCatchup: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
        updatedAt: 1,
      },
    });
    await fixture.firstRunStarted.promise;
    const upgrade = fixture.service.coalesceActive({
      contextGraphId: 'cg:two',
      includeSharedMemory: true,
    });

    fixture.releaseFirstRun.resolve();
    await waitForJob(base);
    if (!upgrade) throw new Error('upgrade job missing');
    await waitForJob(upgrade);

    expect(base).toMatchObject({ includeWorkspace: false, status: 'done' });
    expect(upgrade).toMatchObject({
      includeWorkspace: true,
      status: 'unreachable',
      error: expect.stringContaining('requested data plane'),
    });
  });

  it('settles a queued wider job when the base attempt throws', async () => {
    const fixture = coordinatorFixture({ baseOutcome: 'throw' });
    const base = fixture.service.start({
      contextGraphId: 'cg:failed-base',
      includeSharedMemory: false,
      readinessBeforeCatchup: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
        updatedAt: 1,
      },
    });
    await fixture.firstRunStarted.promise;
    const upgrade = fixture.service.coalesceActive({
      contextGraphId: 'cg:failed-base',
      includeSharedMemory: true,
    });

    fixture.releaseFirstRun.resolve();
    await waitForJob(base);
    if (!upgrade) throw new Error('upgrade job missing');
    await waitForJob(upgrade);

    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(base).toMatchObject({ status: 'failed', error: 'base attempt failed' });
    expect(upgrade).toMatchObject({
      status: 'failed',
      error: 'base attempt failed',
      finishedAt: expect.any(Number),
    });
  });

  it('settles a queued wider job without a second run when the base is denied', async () => {
    const fixture = coordinatorFixture({ baseOutcome: 'denied' });
    const base = fixture.service.start({
      contextGraphId: 'cg:denied-base',
      includeSharedMemory: false,
      readinessBeforeCatchup: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
        updatedAt: 1,
      },
    });
    await fixture.firstRunStarted.promise;
    const upgrade = fixture.service.coalesceActive({
      contextGraphId: 'cg:denied-base',
      includeSharedMemory: true,
    });

    fixture.releaseFirstRun.resolve();
    await waitForJob(base);
    if (!upgrade) throw new Error('upgrade job missing');
    await waitForJob(upgrade);

    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect(base.status).toBe('denied');
    expect(upgrade).toMatchObject({
      status: 'denied',
      finishedAt: expect.any(Number),
    });
  });
});
