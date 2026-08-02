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
  blockBroadBase?: boolean;
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
  let runNumber = 0;
  const run = vi.fn(async (request: { includeSharedMemory: boolean }) => {
    runNumber += 1;
    if (runNumber === 1 && (!request.includeSharedMemory || options.blockBroadBase)) {
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
  it('provisions orchestration state for the historical two-map tracker shape', () => {
    const tracker = {
      jobs: new Map(),
      latestByContextGraph: new Map(),
    } as CatchupTracker;
    const service = new ContextGraphCatchupCoordinatorService(tracker, {
      runner: { run: vi.fn() },
      readReadiness: vi.fn(),
      hasConfirmedMeta: vi.fn(),
      isPrivate: vi.fn(),
      writeReadiness: vi.fn(),
      markSubscriptionState: vi.fn(),
      emitProjectSynced: vi.fn(),
    });

    expect(service.coalesceActive({
      contextGraphId: 'cg:legacy-tracker',
      includeSharedMemory: true,
    })).toBeUndefined();
    expect(tracker.inFlightByContextGraph).toBeInstanceOf(Map);
  });

  it('refreshes latest status when broad, narrow, then broad reuses existing views', async () => {
    const fixture = coordinatorFixture({ blockBroadBase: true });
    const broad = fixture.service.start({
      contextGraphId: 'cg:broad-narrow-broad',
      includeSharedMemory: true,
      readinessBeforeCatchup: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
        updatedAt: 1,
      },
    });
    await fixture.firstRunStarted.promise;

    const narrow = fixture.service.coalesceActive({
      contextGraphId: 'cg:broad-narrow-broad',
      includeSharedMemory: false,
    });
    expect(fixture.tracker.latestByContextGraph.get('cg:broad-narrow-broad'))
      .toBe(narrow?.jobId);

    const reusedBroad = fixture.service.coalesceActive({
      contextGraphId: 'cg:broad-narrow-broad',
      includeSharedMemory: true,
    });
    expect(reusedBroad?.jobId).toBe(broad.jobId);
    expect(fixture.tracker.latestByContextGraph.get('cg:broad-narrow-broad'))
      .toBe(broad.jobId);

    fixture.releaseFirstRun.resolve();
    await waitForJob(broad);
    if (!narrow) throw new Error('narrow view missing');
    await waitForJob(narrow);
  });

  it('refreshes latest status when narrow, upgrade, then narrow reuses the base view', async () => {
    const fixture = coordinatorFixture();
    const narrow = fixture.service.start({
      contextGraphId: 'cg:narrow-broad-narrow',
      includeSharedMemory: false,
      readinessBeforeCatchup: {
        version: 1,
        durableVerified: false,
        sharedMemoryVerified: false,
        updatedAt: 1,
      },
    });
    await fixture.firstRunStarted.promise;

    const broad = fixture.service.coalesceActive({
      contextGraphId: 'cg:narrow-broad-narrow',
      includeSharedMemory: true,
    });
    expect(fixture.tracker.latestByContextGraph.get('cg:narrow-broad-narrow'))
      .toBe(broad?.jobId);

    const reusedNarrow = fixture.service.coalesceActive({
      contextGraphId: 'cg:narrow-broad-narrow',
      includeSharedMemory: false,
    });
    expect(reusedNarrow?.jobId).toBe(narrow.jobId);
    expect(fixture.tracker.latestByContextGraph.get('cg:narrow-broad-narrow'))
      .toBe(narrow.jobId);

    fixture.releaseFirstRun.resolve();
    await waitForJob(narrow);
    if (!broad) throw new Error('broad upgrade missing');
    await waitForJob(broad);
  });

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
