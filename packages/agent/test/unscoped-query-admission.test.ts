import { describe, expect, it, vi } from 'vitest';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import {
  canReadUnscopedQuery,
  type UnscopedQueryAdmissionDependencies,
} from '../src/unscoped-query-admission.js';

type ContextGraphQueryStore = Pick<TripleStore, 'query' | 'listGraphs' | 'listGraphsByPrefix'>;

const contextGraphIds = Array.from({ length: 10 }, (_, index) => `authority-candidate-${index}`);

function admissionDependencies(
  canReadContextGraph: UnscopedQueryAdmissionDependencies['canReadContextGraph'],
  knownContextGraphIds: Iterable<string> = contextGraphIds,
) {
  const store = {
    query: vi.fn<ContextGraphQueryStore['query']>(async () => ({ type: 'bindings', bindings: [] })),
    listGraphs: vi.fn<ContextGraphQueryStore['listGraphs']>(async () => []),
    listGraphsByPrefix: vi.fn<NonNullable<ContextGraphQueryStore['listGraphsByPrefix']>>(async () => []),
  } satisfies ContextGraphQueryStore;
  return {
    store: store as TripleStore,
    knownContextGraphIds,
    canReadContextGraph,
  } satisfies UnscopedQueryAdmissionDependencies;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('unscoped query admission', () => {
  it('starts independent discovery together and waits for the complete candidate union', async () => {
    const ontology = deferred<Awaited<ReturnType<ContextGraphQueryStore['query']>>>();
    const inventory = deferred<string[]>();
    const canRead = vi.fn<UnscopedQueryAdmissionDependencies['canReadContextGraph']>(async () => true);
    const deps = admissionDependencies(canRead, ['runtime']);
    deps.store.query.mockImplementation(() => ontology.promise);
    deps.store.listGraphsByPrefix.mockImplementation(() => inventory.promise);
    const pending = canReadUnscopedQuery(deps);
    try {
      await vi.waitFor(() => {
        expect(deps.store.query).toHaveBeenCalledOnce();
        expect(deps.store.listGraphsByPrefix).toHaveBeenCalledOnce();
      });
      ontology.resolve({ type: 'bindings', bindings: [{ cg: 'did:dkg:context-graph:ontology' }] });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(canRead).not.toHaveBeenCalled();
      inventory.resolve(['did:dkg:context-graph:stored']);
      expect(await pending).toBe(true);
      expect(new Set(canRead.mock.calls.map(([id]) => id))).toEqual(new Set(['ontology', 'runtime', 'stored']));
    } finally {
      ontology.resolve({ type: 'bindings', bindings: [] });
      inventory.resolve([]);
      await pending;
    }
  });

  it('checks at most four candidates together and allows all-readable owners after out-of-order completion', async () => {
    const gates = contextGraphIds.map(() => deferred<boolean>());
    let active = 0;
    let maximumActive = 0;
    const completed: string[] = [];
    const canReadContextGraph = vi.fn(async (id: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const allowed = await gates[contextGraphIds.indexOf(id)].promise;
      active -= 1;
      completed.push(id);
      return allowed;
    });
    const pending = canReadUnscopedQuery(admissionDependencies(canReadContextGraph));

    try {
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(4));
      expect(active).toBe(4);
      for (const index of [3, 2, 1, 0]) gates[index].resolve(true);
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(8));
      expect(active).toBe(4);
      for (const index of [7, 6, 5, 4]) gates[index].resolve(true);
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(10));
      for (const index of [9, 8]) gates[index].resolve(true);

      await expect(pending).resolves.toBe(true);
      expect(maximumActive).toBe(4);
      expect(active).toBe(0);
      expect(completed).not.toEqual(contextGraphIds);
    } finally {
      for (const gate of gates) gate.resolve(true);
      await pending;
    }
  });

  it('denies when any possible owner is unreadable', async () => {
    const canReadContextGraph = vi.fn(async (id: string) => id !== contextGraphIds[6]);
    await expect(canReadUnscopedQuery(admissionDependencies(canReadContextGraph)))
      .resolves.toBe(false);
  });

  it('returns on the first denial, aborts active siblings and leaves queued owners untouched', async () => {
    const gates = contextGraphIds.map(() => deferred<boolean>());
    const receivedSignals = new Map<string, AbortSignal>();
    const canReadContextGraph = vi.fn(async (id: string, signal: AbortSignal) => {
      receivedSignals.set(id, signal);
      if (id === contextGraphIds[0]) return false;
      return gates[contextGraphIds.indexOf(id)].promise;
    });
    const pending = canReadUnscopedQuery(admissionDependencies(canReadContextGraph));
    try {
      await expect(pending).resolves.toBe(false);
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
      expect([...receivedSignals.values()].every((signal) => signal.aborted)).toBe(true);
      for (const gate of gates) gate.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
    } finally {
      for (const gate of gates) gate.resolve(true);
    }
  });

  it('rejects promptly with the original authority failure and aborts pending siblings', async () => {
    const gates = contextGraphIds.map(() => deferred<boolean>());
    const receivedSignals = new Map<string, AbortSignal>();
    const observedAborts: string[] = [];
    const canReadContextGraph = vi.fn(async (id: string, signal: AbortSignal) => {
      receivedSignals.set(id, signal);
      signal.addEventListener('abort', () => { observedAborts.push(id); }, { once: true });
      return gates[contextGraphIds.indexOf(id)].promise;
    });
    const pending = canReadUnscopedQuery(admissionDependencies(canReadContextGraph));
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });
    const authorityFailure = new Error('authority lookup failed');

    try {
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(4));
      gates[1].reject(authorityFailure);
      // Three callbacks deliberately keep hanging after their signals abort.
      // The failed request must settle before they return, preserving its cause.
      await vi.waitFor(() => expect(failure).toBe(authorityFailure));
      const siblingIds = [contextGraphIds[0], contextGraphIds[2], contextGraphIds[3]];
      expect(observedAborts).toEqual(expect.arrayContaining(siblingIds));
      for (const id of siblingIds) expect(receivedSignals.get(id)?.aborted).toBe(true);
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
      for (const gate of gates) gate.resolve(true);
      await observed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
    } finally {
      for (const gate of gates) gate.resolve(true);
      await observed;
    }
  });

  it('authorizes the complete public inventory after 1000 ordinary KA partitions', async () => {
    const canReadContextGraph = vi.fn(async () => true);
    const deps = admissionDependencies(canReadContextGraph, ['public-cg']);
    const author = '0x00000000000000000000000000000000000000ff';
    deps.store.listGraphsByPrefix.mockResolvedValue(Array.from({ length: 1000 }, (_, index) => (
      `did:dkg:context-graph:public-cg/_verifiable_memory/${author}/${index + 1}`
    )));

    await expect(canReadUnscopedQuery(deps)).resolves.toBe(true);
    expect(canReadContextGraph).toHaveBeenCalledTimes(1002);
    expect(canReadContextGraph).toHaveBeenCalledWith(
      `public-cg/_verifiable_memory/${author}/1000`, expect.any(AbortSignal),
    );
  });

  it('prepares the complete deduplicated union of ontology, runtime and stored owners', async () => {
    const fallback = vi.fn(async () => true);
    const ids = Array.from({ length: 750 }, (_, index) => `candidate-${index}`);
    const deps = admissionDependencies(fallback, ids.slice(0, 300));
    deps.store.listGraphsByPrefix.mockResolvedValue(ids.slice(250, 600).map((id) => `did:dkg:context-graph:${id}`));
    deps.store.query.mockResolvedValue({
      type: 'bindings', bindings: ids.slice(550).map((id) => ({ cg: `did:dkg:context-graph:${id}` })),
    });
    const prepared = vi.fn(async (id: string, _signal: AbortSignal) => id !== ids[749]);
    const prepareReadChecks = vi.fn<NonNullable<UnscopedQueryAdmissionDependencies['prepareReadChecks']>>(async () => prepared);

    await expect(canReadUnscopedQuery({ ...deps, prepareReadChecks })).resolves.toBe(false);
    expect(prepareReadChecks).toHaveBeenCalledTimes(1);
    const [candidates, signal] = prepareReadChecks.mock.calls[0];
    expect(new Set(candidates)).toEqual(new Set(ids));
    expect(candidates).toHaveLength(ids.length);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(prepared.mock.calls.length).toBeLessThan(ids.length);
    const deniedSignal = prepared.mock.calls.find(([id]) => id === ids[749])?.[1];
    expect(deniedSignal).toBeInstanceOf(AbortSignal);
    expect(deniedSignal).not.toBe(signal);
    expect(deniedSignal?.aborted).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('rejects incomplete preparation instead of falling back to optimistic reads', async () => {
    const canReadContextGraph = vi.fn(async () => true);
    const prepareReadChecks = vi.fn(async () => { throw new Error('incomplete registration snapshot'); });
    await expect(canReadUnscopedQuery({ ...admissionDependencies(canReadContextGraph), prepareReadChecks }))
      .rejects.toThrow('incomplete registration snapshot');
    expect(canReadContextGraph).not.toHaveBeenCalled();
  });

  it('includes prepared authority discovery in the deadline and ignores its late result', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const canReadContextGraph = vi.fn(async () => true);
    const prepared = vi.fn(async () => true);
    let preparationSignal: AbortSignal | undefined;
    const prepareReadChecks: NonNullable<UnscopedQueryAdmissionDependencies['prepareReadChecks']> = async (_ids, signal) => {
      preparationSignal = signal;
      await gate.promise;
      return prepared;
    };
    const pending = canReadUnscopedQuery({ ...admissionDependencies(canReadContextGraph), prepareReadChecks });
    const observed = pending.catch((error: unknown) => error);
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(await observed).toMatchObject({ code: 'BOUNDED_OPERATION_TIMEOUT' });
      expect(preparationSignal?.aborted).toBe(true);
      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(prepared).not.toHaveBeenCalled();
      expect(canReadContextGraph).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await observed;
      vi.useRealTimers();
    }
  });

  it('does no discovery when the caller is already aborted', async () => {
    const canReadContextGraph = vi.fn(async () => true);
    const deps = admissionDependencies(canReadContextGraph);
    const controller = new AbortController();
    controller.abort(new Error('caller disconnected'));

    await expect(canReadUnscopedQuery(deps, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', message: 'caller disconnected' });
    expect(deps.store.query).not.toHaveBeenCalled();
    expect(deps.store.listGraphsByPrefix).not.toHaveBeenCalled();
    expect(deps.store.listGraphs).not.toHaveBeenCalled();
    expect(canReadContextGraph).not.toHaveBeenCalled();
  });

  it('signals all four active checks on caller abort and schedules no more after late success', async () => {
    const gates = contextGraphIds.map(() => deferred<boolean>());
    const receivedSignals: AbortSignal[] = [];
    const observedAborts: string[] = [];
    const canReadContextGraph = vi.fn(async (id: string, signal: AbortSignal) => {
      receivedSignals.push(signal);
      signal.addEventListener('abort', () => { observedAborts.push(id); }, { once: true });
      // The outer admission boundary must also handle non-cooperative callbacks.
      return gates[contextGraphIds.indexOf(id)].promise;
    });
    const controller = new AbortController();
    const pending = canReadUnscopedQuery(admissionDependencies(canReadContextGraph), { signal: controller.signal });
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });

    try {
      await vi.waitFor(() => expect(canReadContextGraph).toHaveBeenCalledTimes(4));
      expect(receivedSignals).toHaveLength(4);
      controller.abort(new Error('caller disconnected'));
      await vi.waitFor(() => expect(failure).toMatchObject({ name: 'AbortError', message: 'caller disconnected' }));
      expect(observedAborts).toEqual(contextGraphIds.slice(0, 4));
      expect(receivedSignals.every((signal) => signal.aborted)).toBe(true);
      for (const gate of gates) gate.resolve(true);
      await observed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
    } finally {
      for (const gate of gates) gate.resolve(true);
      await observed;
    }
  });

  it('bounds the entire authority admission to five seconds and stops checks after late success', async () => {
    vi.useFakeTimers();
    const gates = contextGraphIds.map(() => deferred<boolean>());
    const receivedSignals: AbortSignal[] = [];
    const canReadContextGraph = vi.fn(async (id: string, signal: AbortSignal) => {
      receivedSignals.push(signal);
      return gates[contextGraphIds.indexOf(id)].promise;
    });
    const pending = canReadUnscopedQuery(admissionDependencies(canReadContextGraph));
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });

    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(4999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toMatchObject({ code: 'BOUNDED_OPERATION_TIMEOUT', timeoutMs: 5000 });
      expect(receivedSignals).toHaveLength(4);
      expect(receivedSignals.every((signal) => signal.aborted)).toBe(true);
      for (const gate of gates) gate.resolve(true);
      await observed;
      await vi.advanceTimersByTimeAsync(0);
      expect(canReadContextGraph).toHaveBeenCalledTimes(4);
    } finally {
      for (const gate of gates) gate.resolve(true);
      await observed;
      vi.useRealTimers();
    }
  });

  it.each(['ontology', 'inventory'] as const)('includes blocked %s discovery in the five-second admission deadline', async (stage) => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const canReadContextGraph = vi.fn(async () => true);
    const deps = admissionDependencies(canReadContextGraph);
    let discoverySignal: AbortSignal | undefined;
    if (stage === 'ontology') {
      deps.store.query.mockImplementation(async (_sparql, options) => {
        discoverySignal = options?.signal;
        await gate.promise;
        return { type: 'bindings', bindings: [] };
      });
    } else {
      deps.store.listGraphsByPrefix.mockImplementation(async (_prefix, options) => {
        discoverySignal = options?.signal;
        await gate.promise;
        return [];
      });
    }
    const pending = canReadUnscopedQuery(deps);
    let failure: unknown;
    const observed = pending.catch((error: unknown) => { failure = error; });

    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(failure).toMatchObject({ code: 'BOUNDED_OPERATION_TIMEOUT', timeoutMs: 5000 });
      expect(discoverySignal?.aborted).toBe(true);
      expect(canReadContextGraph).not.toHaveBeenCalled();
      gate.resolve();
      await observed;
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.store.query).toHaveBeenCalledOnce();
      expect(deps.store.listGraphsByPrefix).toHaveBeenCalledOnce();
      expect(deps.store.query.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(deps.store.listGraphsByPrefix.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(canReadContextGraph).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      await observed;
      vi.useRealTimers();
    }
  });
});
