import { describe, expect, it, vi } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

import { DKGAgent } from '../src/index.js';
import type { SyncPhase } from '../src/sync/auth/request-build.js';
import { getSyncBackpressureSnapshot } from '../src/sync/backpressure.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';
import { stubLifecycleFetch } from './_helpers/sync-fetch-coalescing.js';

const PEER_A = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const DEFAULT_DEADLINE = Date.UTC(2100, 0, 1);

interface FetchArgs {
  deadline?: number;
  signal?: AbortSignal;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function emptySyncPage(phase: string): SyncPageResult {
  return {
    quads: [],
    bytesReceived: 0,
    resumedFromOffset: 0,
    nextOffset: 0,
    checkpointKey: `checkpoint:${phase}`,
    completed: true,
    timedOut: false,
  };
}

async function createAgentWithSend(
  sendToPeer: (...args: unknown[]) => Promise<Uint8Array>,
  syncGlobalMaxInflight = 2,
): Promise<DKGAgent> {
  const agent = await DKGAgent.create({
    name: 'BoundedSyncFetchCoalescing',
    listenHost: '127.0.0.1',
    chainAdapter: new MockChainAdapter(),
    syncGlobalMaxInflight,
    syncGlobalQueueLimit: 2,
  });
  (agent as any).messenger = { sendToPeer };
  (agent as any).buildSyncRequest = async () => new Uint8Array([1, 2, 3]);
  return agent;
}

function fetchPages(agent: DKGAgent, args: FetchArgs): Promise<SyncPageResult> {
  return (agent as any).fetchSyncPages(
    createOperationContext('sync'),
    PEER_A,
    'coalesced-cg',
    false,
    'data' satisfies SyncPhase,
    'did:dkg:context-graph:coalesced-cg',
    args.deadline ?? DEFAULT_DEADLINE,
    undefined,
    undefined,
    args.signal,
  );
}

describe('signal-bounded durable fetch coalescing', () => {
  it('does not coalesce same-deadline page fetches with distinct operation signals', async () => {
    const response = deferred<Uint8Array>();
    let sends = 0;
    const agent = await createAgentWithSend(async () => {
      sends++;
      return response.promise;
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    try {
      const first = fetchPages(agent, {
        deadline: DEFAULT_DEADLINE,
        signal: firstController.signal,
      });
      await flushMicrotasks();
      const second = fetchPages(agent, {
        deadline: DEFAULT_DEADLINE,
        signal: secondController.signal,
      });
      await flushMicrotasks();

      expect(sends).toBe(2);
      response.resolve(new Uint8Array(0));
      await Promise.all([first, second]);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not single-flight direct durable syncs', async () => {
    let fetchCalls = 0;
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    stubLifecycleFetch(agent, async ({ phase, signal }) => {
      fetchCalls++;
      if (fetchCalls !== 1) return emptySyncPage(phase);

      if (!signal) throw new Error('signal-bounded durable fetch received no abort signal');
      return new Promise<SyncPageResult>((_resolve, reject) => {
        const rejectAbort = () => reject(signal.reason);
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener('abort', rejectAbort, { once: true });
      });
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    try {
      const first = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { signal: firstController.signal },
      );
      const second = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { signal: secondController.signal },
      );
      let secondSettled = false;
      void second.then(
        () => { secondSettled = true; },
        () => { secondSettled = true; },
      );

      await waitFor(() => fetchCalls === 1);
      expect(secondSettled).toBe(false);

      firstController.abort(new Error('first durable sync expired'));
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).not.toBe(secondResult);
      expect(fetchCalls).toBe(3);
      expect(secondController.signal.aborted).toBe(false);
      expect(secondResult).toMatchObject({ failedPeers: 0 });
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('does not single-flight totalTimeoutMs-only durable syncs', async () => {
    let fetchCalls = 0;
    const firstFetch = deferred<SyncPageResult>();
    const operationSignals: AbortSignal[] = [];
    const agent = await createAgentWithSend(async () => new Uint8Array(0));
    stubLifecycleFetch(agent, async ({ phase, signal }) => {
      fetchCalls++;
      if (!signal) throw new Error('totalTimeoutMs durable fetch received no operation signal');
      operationSignals.push(signal);
      if (fetchCalls === 1) return firstFetch.promise;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      const first = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs: 30_000 },
      );
      await waitFor(() => fetchCalls === 1);

      const second = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['coalesced-cg'],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs: 30_000 },
      );
      let secondSettled = false;
      void second.then(
        () => { secondSettled = true; },
        () => { secondSettled = true; },
      );
      await flushMicrotasks();
      expect(secondSettled).toBe(false);

      firstFetch.resolve(emptySyncPage('meta'));
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult).not.toBe(secondResult);
      expect(fetchCalls).toBe(4);
      expect(operationSignals[0]).toBe(operationSignals[1]);
      expect(operationSignals[0]).not.toBe(operationSignals[2]);
      expect(operationSignals[2]).toBe(operationSignals[3]);
      expect(secondResult).toMatchObject({ complete: true, failedPeers: 0 });
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('settles totalTimeoutMs while queued behind global admission', async () => {
    const blocker = deferred<void>();
    let blockingRun: Promise<void> | undefined;
    let queuedRun: Promise<unknown> | undefined;
    let fetchCalls = 0;
    let queuedResult: any;
    let queuedError: unknown;
    let queuedSettled = false;
    const agent = await createAgentWithSend(async () => new Uint8Array(0), 1);
    stubLifecycleFetch(agent, async ({ phase }) => {
      fetchCalls++;
      return emptySyncPage(phase);
    });
    (agent as any).processDurableBatchInWorker = async () => ({
      verifiedData: [],
      verifiedMeta: [],
      totalFetchedDataQuads: 0,
      totalFetchedMetaQuads: 0,
      rejectedKcs: 0,
      emptyResponses: 1,
      metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    });

    try {
      blockingRun = (agent as any).runContextGraphSyncWithBackpressure(
        createOperationContext('sync'),
        'admission-blocker',
        'durable',
        'admission-blocker',
        () => blocker.promise,
      );
      await waitFor(() => getSyncBackpressureSnapshot().inflight === 1);
      vi.useFakeTimers();

      queuedRun = (agent as any).syncFromPeerDetailed(
        PEER_A,
        ['queued-timeout-cg'],
        undefined,
        undefined,
        undefined,
        { totalTimeoutMs: 10_000 },
      );
      void queuedRun.then(
        (result) => {
          queuedResult = result;
          queuedSettled = true;
        },
        (error) => {
          queuedError = error;
          queuedSettled = true;
        },
      );
      for (let attempt = 0; attempt < 20 && getSyncBackpressureSnapshot().queued === 0; attempt++) {
        await flushMicrotasks();
      }
      expect(getSyncBackpressureSnapshot().queued).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      for (let attempt = 0; attempt < 20 && !queuedSettled; attempt++) {
        await flushMicrotasks();
      }

      expect(queuedSettled).toBe(true);
      expect(queuedError).toBeUndefined();
      expect(queuedResult).toMatchObject({ complete: false });
      expect(fetchCalls).toBe(0);
      expect(getSyncBackpressureSnapshot()).toMatchObject({ inflight: 1, queued: 0 });
    } finally {
      vi.useRealTimers();
      blocker.resolve();
      await blockingRun?.catch(() => {});
      await queuedRun?.catch(() => {});
      await agent.stop().catch(() => {});
    }
  });
});
