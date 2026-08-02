import { describe, expect, it } from 'vitest';
import {
  privateDataOnlyResult,
  publicDurableAndSharedMemoryResult,
} from './helpers/context-graph-catchup-fixtures.js';
import { ContextGraphSubscribeRouteHarness } from './helpers/context-graph-subscribe-route-harness.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('context graph catch-up route coalescing', () => {
  it('makes a reused broad job latest after broad, narrow, broad requests', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      runner: async () => {
        firstRunStarted.resolve();
        await releaseFirstRun.promise;
        return publicDurableAndSharedMemoryResult();
      },
    });

    try {
      const broad = await harness.postSubscribe({ includeSharedMemory: true });
      await firstRunStarted.promise;
      const narrow = await harness.postSubscribe({ includeSharedMemory: false });
      await expect(harness.getStatusByContextGraph()).resolves.toMatchObject({
        jobId: narrow.body.catchup.jobId,
        includeSharedMemory: false,
      });

      const reusedBroad = await harness.postSubscribe({ includeSharedMemory: true });
      expect(reusedBroad.body.catchup.jobId).toBe(broad.body.catchup.jobId);
      await expect(harness.getStatusByContextGraph()).resolves.toMatchObject({
        jobId: broad.body.catchup.jobId,
        includeSharedMemory: true,
      });
    } finally {
      releaseFirstRun.resolve();
      await harness.close();
    }
  });

  it('makes a reused narrow job latest after narrow, upgrade, narrow requests', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      runner: async (_request, callNumber) => {
        if (callNumber === 1) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
          return privateDataOnlyResult();
        }
        return publicDurableAndSharedMemoryResult();
      },
    });

    try {
      const narrow = await harness.postSubscribe({ includeSharedMemory: false });
      await firstRunStarted.promise;
      const broad = await harness.postSubscribe({ includeSharedMemory: true });
      await expect(harness.getStatusByContextGraph()).resolves.toMatchObject({
        jobId: broad.body.catchup.jobId,
        includeSharedMemory: true,
      });

      const reusedNarrow = await harness.postSubscribe({ includeSharedMemory: false });
      expect(reusedNarrow.body.catchup.jobId).toBe(narrow.body.catchup.jobId);
      await expect(harness.getStatusByContextGraph()).resolves.toMatchObject({
        jobId: narrow.body.catchup.jobId,
        includeSharedMemory: false,
      });
    } finally {
      releaseFirstRun.resolve();
      await harness.close();
    }
  });

  it('serially upgrades an active VM-only request with a distinct VM plus SWM job', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      runner: async (_request, callNumber) => {
        if (callNumber === 1) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
          return privateDataOnlyResult();
        }
        return publicDurableAndSharedMemoryResult();
      },
    });

    try {
      const base = await harness.postSubscribe({ includeSharedMemory: false });
      await firstRunStarted.promise;
      const upgrade = await harness.postSubscribe({ includeSharedMemory: true });

      expect(upgrade.body.catchup).toMatchObject({
        status: 'queued',
        includeWorkspace: true,
      });
      expect(upgrade.body.catchup.jobId).not.toBe(base.body.catchup.jobId);
      expect(harness.runCalls).toBe(1);
      expect(harness.getJob(upgrade.body.catchup.jobId)?.status).toBe('queued');
      await expect(harness.getStatusByContextGraph()).resolves.toMatchObject({
        jobId: upgrade.body.catchup.jobId,
        status: 'queued',
        includeWorkspace: true,
        includeSharedMemory: true,
      });

      releaseFirstRun.resolve();
      const baseJob = await harness.waitForJob(base.body.catchup.jobId);
      const upgradeJob = await harness.waitForJob(upgrade.body.catchup.jobId);

      expect(harness.runRequests).toEqual([
        {
          contextGraphId: harness.contextGraphId,
          includeSharedMemory: false,
        },
        {
          contextGraphId: harness.contextGraphId,
          includeSharedMemory: true,
        },
      ]);
      expect(baseJob).toMatchObject({ includeWorkspace: false, status: 'done' });
      expect(upgradeJob).toMatchObject({ includeWorkspace: true, status: 'done' });
      await expect(harness.getStatus(base.body.catchup.jobId)).resolves.toMatchObject({
        status: 'done',
        convergence: {
          state: 'complete',
          required: { sharedMemory: false },
          missing: [],
        },
      });
      await expect(harness.getStatus(upgrade.body.catchup.jobId)).resolves.toMatchObject({
        status: 'done',
        convergence: {
          state: 'complete',
          required: { sharedMemory: true },
          missing: [],
        },
      });
    } finally {
      releaseFirstRun.resolve();
      await harness.close();
    }
  });

  it('projects broad in-flight work onto a distinct VM-only contract', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      runner: async () => {
        firstRunStarted.resolve();
        await releaseFirstRun.promise;
        return privateDataOnlyResult();
      },
    });

    try {
      const broad = await harness.postSubscribe({ includeSharedMemory: true });
      await firstRunStarted.promise;
      const narrow = await harness.postSubscribe({ includeSharedMemory: false });

      expect(narrow.body.catchup).toMatchObject({
        status: 'queued',
        includeWorkspace: false,
      });
      expect(narrow.body.catchup.jobId).not.toBe(broad.body.catchup.jobId);
      expect(harness.runCalls).toBe(1);

      releaseFirstRun.resolve();
      const broadJob = await harness.waitForJob(broad.body.catchup.jobId);
      const narrowJob = await harness.waitForJob(narrow.body.catchup.jobId);

      expect(harness.runCalls).toBe(1);
      expect(broadJob).toMatchObject({
        includeWorkspace: true,
        status: 'unreachable',
      });
      expect(narrowJob).toMatchObject({
        includeWorkspace: false,
        status: 'done',
      });
      await expect(harness.getStatus(narrow.body.catchup.jobId)).resolves.toMatchObject({
        status: 'done',
        convergence: {
          state: 'complete',
          required: { sharedMemory: false },
          missing: [],
        },
      });
      await expect(harness.getStatus(broad.body.catchup.jobId)).resolves.toMatchObject({
        status: 'unreachable',
        convergence: {
          state: 'partial',
          required: { sharedMemory: true },
          missing: ['sharedMemory'],
        },
      });
    } finally {
      releaseFirstRun.resolve();
      await harness.close();
    }
  });

  it('keeps VM-only success stable when the serialized SWM upgrade fails', async () => {
    const firstRunStarted = deferred();
    const releaseFirstRun = deferred();
    const harness = await ContextGraphSubscribeRouteHarness.create({
      hasConfirmedMeta: true,
      initial: {
        subscribed: false,
        synced: false,
        sharedMemorySynced: false,
        metaSynced: true,
      },
      runner: async (_request, callNumber) => {
        if (callNumber === 1) {
          firstRunStarted.resolve();
          await releaseFirstRun.promise;
        }
        return privateDataOnlyResult();
      },
    });

    try {
      const base = await harness.postSubscribe({ includeSharedMemory: false });
      await firstRunStarted.promise;
      const upgrade = await harness.postSubscribe({ includeSharedMemory: true });
      releaseFirstRun.resolve();

      const baseJob = await harness.waitForJob(base.body.catchup.jobId);
      const upgradeJob = await harness.waitForJob(upgrade.body.catchup.jobId);
      expect(baseJob).toMatchObject({ includeWorkspace: false, status: 'done' });
      expect(upgradeJob).toMatchObject({
        includeWorkspace: true,
        status: 'unreachable',
        error: expect.stringContaining('requested data plane'),
      });
      await expect(harness.getStatus(base.body.catchup.jobId)).resolves.toMatchObject({
        status: 'done',
        convergence: {
          state: 'complete',
          required: { sharedMemory: false },
          missing: [],
        },
      });
      await expect(harness.getStatus(upgrade.body.catchup.jobId)).resolves.toMatchObject({
        status: 'unreachable',
        convergence: {
          state: 'partial',
          required: { sharedMemory: true },
          missing: ['sharedMemory'],
        },
      });
    } finally {
      releaseFirstRun.resolve();
      await harness.close();
    }
  });
});
