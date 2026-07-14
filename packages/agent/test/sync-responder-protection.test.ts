import { describe, expect, it } from 'vitest';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { OperationContext } from '@origintrail-official/dkg-core';
import type { QueryOptions, QueryResult, Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

const REMOTE_A = '12D3KooWResponderCapPeerA';
const REMOTE_B = '12D3KooWResponderCapPeerB';
const REMOTE_C = '12D3KooWResponderCapPeerC';
const REMOTE_D = '12D3KooWResponderCapPeerD';
const SYNC_PROTECTION_DATA_GRAPH = 'did:dkg:context-graph:sync-protection';

const noopLog = (_ctx: OperationContext, _message: string) => {};

function baseStore(overrides: Partial<TripleStore> = {}): TripleStore {
  return {
    query: async () => ({ type: 'bindings', bindings: [] }) satisfies QueryResult,
    insert: async () => {},
    delete: async () => {},
    deleteByPattern: async () => 0,
    hasGraph: async () => false,
    createGraph: async () => {},
    dropGraph: async () => {},
    listGraphs: async () => [],
    deleteBySubjectPrefix: async () => 0,
    countQuads: async () => 0,
    close: async () => {},
    ...overrides,
  };
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

function makeEnvelope(): SyncRequestEnvelope {
  return {
    contextGraphId: 'sync-protection',
    includeSharedMemory: false,
    phase: 'data',
    offset: 0,
    limit: 1,
  };
}

function abortDuringListenerRegistration(message: string): AbortSignal {
  let aborted = false;
  let reason: Error | undefined;
  return {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== 'abort') return;
      aborted = true;
      reason = new Error(message);
      if (typeof listener === 'function') listener(new Event('abort'));
      else listener.handleEvent(new Event('abort'));
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    onabort: null,
  } as unknown as AbortSignal;
}

function captureHandler(
  store: TripleStore,
  options: {
    authorizeSyncRequest?: (
      request: SyncRequestEnvelope,
      remotePeerId: string,
      options?: { signal?: AbortSignal },
    ) => Promise<boolean>;
    logWarn?: (ctx: OperationContext, message: string) => void;
    publicSnapshotStore?: WorkspacePublicSnapshotStore;
    contextGraphPriorities?: Record<string, number>;
  } = {},
) {
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
    publicSnapshotStore: options.publicSnapshotStore,
    peerId: 'self-peer',
    parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
    authorizeSyncRequest: options.authorizeSyncRequest ?? (async () => true),
    logWarn: options.logWarn ?? noopLog,
    logDebug: noopLog,
    contextGraphPriorities: options.contextGraphPriorities,
  });

  return {
    invoke(envelope: SyncRequestEnvelope, peerId = REMOTE_A, signal?: AbortSignal): Promise<Uint8Array> {
      if (!captured) throw new Error('handler not registered');
      return captured(new TextEncoder().encode(JSON.stringify(envelope)), peerId, { signal });
    },
  };
}

describe('sync responder protection', () => {
  it.each([
    ['omitted priorities', undefined],
    ['all-zero priorities', { 'sync-protection': 0 }],
  ])('preserves one continuous same-peer admission with %s', async (_label, priorities) => {
    const queryGates: Array<ReturnType<typeof deferred<QueryResult>>> = [];
    let authStarted = 0;
    const cap = captureHandler(baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async () => {
        const gate = deferred<QueryResult>();
        queryGates.push(gate);
        return gate.promise;
      },
    }), {
      contextGraphPriorities: priorities,
      authorizeSyncRequest: async () => {
        authStarted += 1;
        return true;
      },
    });

    const first = cap.invoke(makeEnvelope(), REMOTE_A);
    while (queryGates.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    const second = cap.invoke(makeEnvelope(), REMOTE_A);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authStarted).toBe(1);

    queryGates.shift()?.resolve({ type: 'bindings', bindings: [] });
    await first;
    while (authStarted < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    while (queryGates.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    queryGates.shift()?.resolve({ type: 'bindings', bindings: [] });
    await second;
  });

  it('prioritizes only authorized responder work while keeping pre-authorization FIFO', async () => {
    const queryGates: Array<ReturnType<typeof deferred<QueryResult>>> = [];
    const queryOrder: string[] = [];
    const authOrder: string[] = [];
    const store = baseStore({
      listGraphs: async () => [
        'did:dkg:context-graph:block-a',
        'did:dkg:context-graph:block-b',
        'did:dkg:context-graph:block-c',
        'did:dkg:context-graph:low',
        'did:dkg:context-graph:high',
      ],
      query: async (sparql: string) => {
        const contextGraphId = ['block-a', 'block-b', 'block-c', 'low', 'high']
          .find((id) => sparql.includes(`context-graph:${id}`)) ?? 'unknown';
        queryOrder.push(contextGraphId);
        const gate = deferred<QueryResult>();
        queryGates.push(gate);
        return gate.promise;
      },
    });
    const cap = captureHandler(store, {
      contextGraphPriorities: { high: 100, low: -10 },
      authorizeSyncRequest: async (request) => {
        authOrder.push(request.contextGraphId);
        return true;
      },
    });
    const request = (contextGraphId: string, peerId: string) => cap.invoke({
      ...makeEnvelope(),
      contextGraphId,
    }, peerId);

    const blockers = [
      request('block-a', REMOTE_A),
      request('block-b', REMOTE_B),
      request('block-c', REMOTE_C),
    ];
    for (let i = 0; i < 100 && queryGates.length < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(queryGates).toHaveLength(3);
    const low = request('low', REMOTE_D);
    const high = request('high', '12D3KooWResponderCapPeerE');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authOrder.slice(0, 3)).toEqual(['block-a', 'block-b', 'block-c']);

    queryGates.shift()?.resolve({ type: 'bindings', bindings: [] });
    for (let i = 0; i < 100 && !queryOrder.includes('high'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(queryOrder).toContain('high');
    expect(queryOrder).not.toContain('low');

    for (const gate of queryGates.splice(0)) gate.resolve({ type: 'bindings', bindings: [] });
    for (let i = 0; i < 100 && !queryOrder.includes('low'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(queryOrder).toContain('low');
    for (const gate of queryGates.splice(0)) gate.resolve({ type: 'bindings', bindings: [] });
    await Promise.all([...blockers, low, high]);
  });

  it('does not give an unauthorized elevated-CG claim priority before authorization', async () => {
    const authOrder: string[] = [];
    const queryOrder: string[] = [];
    const queryGates = new Map<string, ReturnType<typeof deferred<QueryResult>>>();
    const graphIds = ['block-a', 'block-b', 'block-c', 'default', 'elevated'];
    const cap = captureHandler(baseStore({
      listGraphs: async () => graphIds.map((id) => `did:dkg:context-graph:${id}`),
      query: async (sparql: string) => {
        const contextGraphId = graphIds.find((id) => sparql.includes(`context-graph:${id}`)) ?? 'unknown';
        queryOrder.push(contextGraphId);
        const gate = deferred<QueryResult>();
        queryGates.set(contextGraphId, gate);
        return gate.promise;
      },
    }), {
      contextGraphPriorities: { elevated: 1_000 },
      authorizeSyncRequest: async (request) => {
        authOrder.push(request.contextGraphId);
        return request.contextGraphId !== 'elevated';
      },
    });

    const invoke = (contextGraphId: string, peerId: string) => cap.invoke({
      ...makeEnvelope(),
      contextGraphId,
    }, peerId);
    const blockers = [
      invoke('block-a', REMOTE_A),
      invoke('block-b', REMOTE_B),
      invoke('block-c', REMOTE_C),
    ];
    for (let i = 0; i < 100 && queryGates.size < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(queryGates.size).toBe(3);

    const defaultRequest = invoke('default', REMOTE_D);
    const elevatedClaim = invoke('elevated', '12D3KooWResponderCapPeerE');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authOrder).toEqual(['block-a', 'block-b', 'block-c']);

    queryGates.get('block-a')?.resolve({ type: 'bindings', bindings: [] });
    for (let i = 0; i < 100 && !queryOrder.includes('default'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(authOrder).toContain('default');
    expect(authOrder).not.toContain('elevated');
    expect(queryOrder).toContain('default');

    queryGates.get('block-b')?.resolve({ type: 'bindings', bindings: [] });
    for (let i = 0; i < 100 && !authOrder.includes('elevated'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const denied = await elevatedClaim;
    expect(authOrder.slice(-2)).toEqual(['default', 'elevated']);
    expect(queryOrder).not.toContain('elevated');
    expect(new TextDecoder().decode(denied)).toBe('sync-denied');

    queryGates.get('block-c')?.resolve({ type: 'bindings', bindings: [] });
    queryGates.get('default')?.resolve({ type: 'bindings', bindings: [] });
    await Promise.all([...blockers, defaultRequest]);
  });

  it('caps durable page computation at three globally and one per peer', async () => {
    const releases: Array<() => void> = [];
    let completed = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const store = baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
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
    });
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

  it('applies per-peer backpressure before authorization work starts', async () => {
    const authGates: Array<ReturnType<typeof deferred<boolean>>> = [];
    let authStarted = 0;
    let inAuth = 0;
    let maxInAuth = 0;
    const cap = captureHandler(baseStore({
      query: async () => {
        throw new Error('denied requests should not query');
      },
    }), {
      authorizeSyncRequest: async () => {
        authStarted += 1;
        inAuth += 1;
        maxInAuth = Math.max(maxInAuth, inAuth);
        const gate = deferred<boolean>();
        authGates.push(gate);
        try {
          return await gate.promise;
        } finally {
          inAuth -= 1;
        }
      },
    });
    const envelope = makeEnvelope();

    const first = cap.invoke(envelope, REMOTE_A);
    const second = cap.invoke(envelope, REMOTE_A);
    while (authStarted < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(authStarted).toBe(1);
    expect(maxInAuth).toBe(1);

    authGates.shift()?.resolve(false);
    await first;
    while (authStarted < 2) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxInAuth).toBe(1);

    authGates.shift()?.resolve(false);
    await second;
  });

  it('passes the stream abort signal to authorization and releases capacity on abort', async () => {
    let authStarted = 0;
    let firstAuthSignal: AbortSignal | undefined;
    const cap = captureHandler(baseStore(), {
      authorizeSyncRequest: async (_request, _peerId, options) => {
        authStarted += 1;
        if (authStarted === 1) {
          if (!options?.signal) throw new Error('missing auth signal');
          firstAuthSignal = options.signal;
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('auth aborted by test')), { once: true });
          });
        }
        return false;
      },
    });
    const controller = new AbortController();
    const envelope = makeEnvelope();

    const first = cap.invoke(envelope, REMOTE_A, controller.signal);
    while (authStarted < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('stream closed'));

    await expect(first).rejects.toThrow(/auth aborted by test/);
    expect(firstAuthSignal?.aborted).toBe(true);

    const later = await cap.invoke(envelope, REMOTE_A);
    expect(new TextDecoder().decode(later)).toBe('sync-denied');
    expect(authStarted).toBe(2);
  });

  it('keeps non-abortable authorization work counted until it settles', async () => {
    const authGate = deferred<boolean>();
    let authStarted = 0;
    const cap = captureHandler(baseStore(), {
      authorizeSyncRequest: async () => {
        authStarted += 1;
        if (authStarted === 1) {
          return authGate.promise;
        }
        return false;
      },
    });
    const controller = new AbortController();
    const envelope = makeEnvelope();

    const first = cap.invoke(envelope, REMOTE_A, controller.signal);
    while (authStarted < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('stream closed'));

    const later = cap.invoke(envelope, REMOTE_A);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authStarted).toBe(1);

    authGate.resolve(false);
    await expect(first).rejects.toThrow(/stream closed/);

    const denied = await later;
    expect(new TextDecoder().decode(denied)).toBe('sync-denied');
    expect(authStarted).toBe(2);
  });

  it('keeps graph-list cache-miss owners counted until the shared load settles', async () => {
    const listGate = deferred<readonly string[]>();
    let listSignal: AbortSignal | undefined;
    let listCalls = 0;
    let authStarted = 0;
    const cap = captureHandler(baseStore({
      listGraphs: async (options?: QueryOptions) => {
        listSignal = options?.signal;
        listCalls += 1;
        return listGate.promise;
      },
    }), {
      authorizeSyncRequest: async () => {
        authStarted += 1;
        return true;
      },
    });
    const controller = new AbortController();
    const envelope = makeEnvelope();

    const first = cap.invoke(envelope, REMOTE_A, controller.signal);
    while (listCalls < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(listSignal).toBeUndefined();
    controller.abort(new Error('memo wait aborted'));

    const later = cap.invoke(envelope, REMOTE_A);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authStarted).toBe(1);

    listGate.resolve([]);

    await expect(first).rejects.toThrow(/memo wait aborted/);
    await later;
    expect(authStarted).toBe(2);
  });

  it('keeps subgraph-name cache-miss owners counted until the shared load settles', async () => {
    const queryGate = deferred<QueryResult>();
    let querySignal: AbortSignal | undefined;
    let queryCalls = 0;
    let authStarted = 0;
    const cap = captureHandler(baseStore({
      query: async (_sparql: string, options?: QueryOptions) => {
        querySignal = options?.signal;
        queryCalls += 1;
        return queryGate.promise;
      },
    }), {
      authorizeSyncRequest: async () => {
        authStarted += 1;
        return true;
      },
    });
    const controller = new AbortController();
    const envelope = { ...makeEnvelope(), phase: 'meta' as const };

    const first = cap.invoke(envelope, REMOTE_A, controller.signal);
    while (queryCalls < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(querySignal).toBeUndefined();
    controller.abort(new Error('subgraph memo aborted'));

    const later = cap.invoke(makeEnvelope(), REMOTE_A);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authStarted).toBe(1);

    queryGate.resolve({ type: 'bindings', bindings: [] });

    await expect(first).rejects.toThrow(/subgraph memo aborted/);
    await later;
    expect(authStarted).toBe(2);
  });

  it('keeps row-list cache-miss owners counted until the shared snapshot settles', async () => {
    const rowGate = deferred<QueryResult>();
    let querySignal: AbortSignal | undefined;
    let queryCalls = 0;
    let authStarted = 0;
    const cap = captureHandler(baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async (_sparql: string, options?: QueryOptions) => {
        querySignal = options?.signal;
        queryCalls += 1;
        return rowGate.promise;
      },
    }), {
      authorizeSyncRequest: async () => {
        authStarted += 1;
        return true;
      },
    });
    const envelope = { ...makeEnvelope(), syncSessionId: 'row-list-session' };
    const firstController = new AbortController();

    const first = cap.invoke(envelope, REMOTE_A, firstController.signal);
    while (queryCalls < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(querySignal).toBeUndefined();
    firstController.abort(new Error('row snapshot aborted'));

    const later = cap.invoke(envelope, REMOTE_A);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authStarted).toBe(1);
    expect(queryCalls).toBe(1);

    rowGate.resolve({
      type: 'bindings',
      bindings: [{
        g: SYNC_PROTECTION_DATA_GRAPH,
        s: '<urn:test:s>',
        p: 'http://schema.org/name',
        o: '"name"',
      }],
    });

    await expect(first).rejects.toThrow(/row snapshot aborted/);
    while (authStarted < 2) await new Promise((resolve) => setTimeout(resolve, 0));

    await later;
    expect(queryCalls).toBe(1);
    expect(authStarted).toBe(2);
  });

  it('races public snapshot loads against stream abort and releases capacity', async () => {
    const snapshotGate = deferred<Quad[] | null>();
    let snapshotCalls = 0;
    let authStarted = 0;
    const publicSnapshotStore: WorkspacePublicSnapshotStore = {
      putSnapshot: async () => ({ ref: 'unused', byteLength: 0 }),
      getSnapshot: async () => {
        snapshotCalls += 1;
        return snapshotGate.promise;
      },
    };
    const cap = captureHandler(baseStore(), {
      publicSnapshotStore,
      authorizeSyncRequest: async () => {
        authStarted += 1;
        return true;
      },
    });
    const controller = new AbortController();
    const snapshotEnvelope: SyncRequestEnvelope = {
      contextGraphId: 'sync-protection',
      includeSharedMemory: true,
      phase: 'snapshot',
      snapshotRef: 'snapshot-ref',
      offset: 0,
      limit: 1,
    };

    const first = cap.invoke(snapshotEnvelope, REMOTE_A, controller.signal);
    while (snapshotCalls < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('snapshot load aborted'));

    await expect(first).rejects.toThrow(/snapshot load aborted/);

    const later = await cap.invoke(makeEnvelope(), REMOTE_A);
    expect(new TextDecoder().decode(later)).toBe('');
    expect(authStarted).toBe(2);
    snapshotGate.resolve([]);
  });

  it('removes queued requests that abort while registering the abort listener', async () => {
    const releases: Array<() => void> = [];
    const store = baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async () => {
        const gate = deferred<void>();
        releases.push(() => gate.resolve());
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    });
    const cap = captureHandler(store);
    const envelope = makeEnvelope();

    const first = cap.invoke(envelope, REMOTE_A);
    const raced = cap.invoke(envelope, REMOTE_A, abortDuringListenerRegistration('listener registration aborted'));

    await expect(raced).rejects.toThrow(/listener registration aborted/);

    const later = cap.invoke(envelope, REMOTE_A);
    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    await first;
    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    await later;
  });

  it('rejects requests beyond the per-peer responder queue as transport failures', async () => {
    const releases: Array<() => void> = [];
    const store = baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async () => {
        const gate = deferred<void>();
        releases.push(() => gate.resolve());
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    });
    const cap = captureHandler(store);
    const envelope = makeEnvelope();

    let completed = 0;
    const requests: Array<Promise<Uint8Array>> = [];
    for (let i = 0; i < 5; i++) {
      requests.push(cap.invoke(envelope, REMOTE_A).finally(() => { completed += 1; }));
    }
    await expect(cap.invoke(envelope, REMOTE_A)).rejects.toThrow(/sync responder peer queue full/);

    while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
    while (completed < requests.length) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(requests);
  });

  it('keeps a noisy peer from consuming every shared queue slot', async () => {
    const releases: Array<() => void> = [];
    const store = baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async () => {
        const gate = deferred<void>();
        releases.push(() => gate.resolve());
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    });
    const cap = captureHandler(store);
    const envelope = makeEnvelope();

    let noisyCompleted = 0;
    const noisyRequests: Array<Promise<Uint8Array>> = [];
    for (let i = 0; i < 5; i++) {
      noisyRequests.push(cap.invoke(envelope, REMOTE_A).finally(() => { noisyCompleted += 1; }));
    }
    await expect(cap.invoke(envelope, REMOTE_A)).rejects.toThrow(/sync responder peer queue full/);

    const otherPeer = cap.invoke(envelope, REMOTE_B);
    while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    releases.shift()?.();
    releases.shift()?.();
    await otherPeer;

    while (noisyCompleted < noisyRequests.length) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all(noisyRequests);
  });

  it('removes aborted queued requests and lets later work proceed', async () => {
    const releases: Array<() => void> = [];
    const store = baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async () => {
        const gate = deferred<void>();
        releases.push(() => gate.resolve());
        await gate.promise;
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    });
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
    const store = baseStore({
      listGraphs: async () => [SYNC_PROTECTION_DATA_GRAPH],
      query: async (_sparql: string, options?: QueryOptions) => {
        querySignal = options?.signal;
        await new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
        });
        return { type: 'bindings', bindings: [] } satisfies QueryResult;
      },
    });
    const cap = captureHandler(store);

    const request = cap.invoke(makeEnvelope(), REMOTE_A, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('stream closed'));

    await expect(request).rejects.toThrow(/aborted by test/);
    expect(querySignal?.aborted).toBe(true);
  });

  it('warns once when the store cannot interrupt in-flight sync queries', async () => {
    const warnings: string[] = [];
    const cap = captureHandler(baseStore({ queryCancellation: 'pre-dispatch' }), {
      logWarn: (_ctx, message) => warnings.push(message),
    });

    await cap.invoke(makeEnvelope(), REMOTE_A);
    await cap.invoke(makeEnvelope(), REMOTE_B);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('pre-dispatch only');
  });
});
