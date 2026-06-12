import { describe, expect, it } from 'vitest';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { QueryOptions, QueryResult, TripleStore } from '@origintrail-official/dkg-storage';
import { SYNC_BUSY_RESPONSE } from '../src/dkg-agent-constants.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

const REMOTE_A = '12D3KooWResponderCapPeerA';
const REMOTE_B = '12D3KooWResponderCapPeerB';
const REMOTE_C = '12D3KooWResponderCapPeerC';
const REMOTE_D = '12D3KooWResponderCapPeerD';

const noopLog = (_ctx: OperationContext, _message: string) => {};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeEnvelope(): SyncRequestEnvelope {
  return {
    contextGraphId: 'sync-protection',
    includeSharedMemory: false,
    phase: 'data',
    offset: 0,
    limit: 1,
  };
}

function captureHandler(store: TripleStore) {
  let captured: ((
    data: Uint8Array,
    peerId: string,
    options?: { signal?: AbortSignal },
  ) => Promise<Uint8Array>) | null = null;

  registerSyncHandler({
    register: (_proto, handler) => { captured = handler; },
    protocolSync: '/origintrail/dkg/sync/1.0.0',
    syncDeniedResponse: 'sync-denied',
    syncPageSize: 500,
    sharedMemoryTtlMs: 0,
    store,
    peerId: 'self-peer',
    parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
    authorizeSyncRequest: async () => true,
    logWarn: noopLog,
    logDebug: noopLog,
  });

  return {
    invoke(envelope: SyncRequestEnvelope, peerId = REMOTE_A, signal?: AbortSignal): Promise<Uint8Array> {
      if (!captured) throw new Error('handler not registered');
      return captured(new TextEncoder().encode(JSON.stringify(envelope)), peerId, { signal });
    },
  };
}

describe('sync responder protection', () => {
  it('caps durable page computation at three globally and one per peer', async () => {
    const releases: Array<() => void> = [];
    let completed = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const store = {
      query: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const gate = deferred<void>();
        releases.push(() => {
          inFlight -= 1;
          gate.resolve();
        });
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    } as unknown as TripleStore;
    const cap = captureHandler(store);
    const envelope = makeEnvelope();

    const requests = [
      cap.invoke(envelope, REMOTE_A),
      cap.invoke(envelope, REMOTE_A),
      cap.invoke(envelope, REMOTE_B),
      cap.invoke(envelope, REMOTE_C),
      cap.invoke(envelope, REMOTE_D),
    ].map((request) => request.finally(() => { completed += 1; }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inFlight).toBe(3);
    expect(maxInFlight).toBe(3);

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inFlight).toBe(3);
    expect(maxInFlight).toBe(3);

    while (completed < requests.length) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(requests);
  });

  it('returns an explicit busy sentinel for requests beyond the bounded responder queue', async () => {
    const releases: Array<() => void> = [];
    const store = {
      query: async () => {
        const gate = deferred<void>();
        releases.push(() => gate.resolve());
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    } as unknown as TripleStore;
    const cap = captureHandler(store);
    const envelope = makeEnvelope();

    let completed = 0;
    const requests: Array<Promise<Uint8Array>> = [];
    for (let i = 0; i < 33; i++) {
      requests.push(cap.invoke(envelope, REMOTE_A).finally(() => { completed += 1; }));
    }
    await expect(cap.invoke(envelope, REMOTE_A).then((bytes) => new TextDecoder().decode(bytes))).resolves.toBe(SYNC_BUSY_RESPONSE);

    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    while (completed < requests.length) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(requests);
  });

  it('removes aborted queued requests and lets later work proceed', async () => {
    const releases: Array<() => void> = [];
    const store = {
      query: async () => {
        const gate = deferred<void>();
        releases.push(() => gate.resolve());
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    } as unknown as TripleStore;
    const cap = captureHandler(store);
    const envelope = makeEnvelope();
    const queuedController = new AbortController();

    const first = cap.invoke(envelope, REMOTE_A);
    const queued = cap.invoke(envelope, REMOTE_A, queuedController.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    queuedController.abort(new Error('queued aborted'));
    await expect(queued).rejects.toThrow(/queued aborted/);

    const later = cap.invoke(envelope, REMOTE_A);
    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    await first;
    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    await later;
  });

  it('passes the stream abort signal to store queries and releases capacity on abort', async () => {
    const controller = new AbortController();
    let querySignal: AbortSignal | undefined;
    const store = {
      query: async (_sparql: string, options?: QueryOptions) => {
        querySignal = options?.signal;
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
        });
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    } as unknown as TripleStore;
    const cap = captureHandler(store);

    const request = cap.invoke(makeEnvelope(), REMOTE_A, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('stream closed'));

    await expect(request).rejects.toThrow(/aborted by test/);
    expect(querySignal?.aborted).toBe(true);
  });
});
