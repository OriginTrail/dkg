import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BlazegraphStore,
  OxigraphStore,
  SparqlHttpStore,
  createManagedOxigraphRuntimeStoreConfigV1,
  createTripleStore,
  tryReplaceGraphAtomically,
  tryReplaceSubjectAtomically,
  tryRfc64AuthorCommitCasV1,
  UnsupportedTripleStoreCapabilityError,
  type TripleStore,
} from '../src/index.js';

import {
  HEAD_GRAPH,
  PROJECTION_GRAPH,
  authorCommitInput,
  overrideStore,
} from './rfc64-author-commit-cas-harness.js';

describe('RFC-64 author commit remote adapters', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves the deprecated atomicUpdates capability in direct and factory construction', async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      requests.push(String(init?.body ?? ''));
      return new Response(null, { status: 200 });
    });
    const quads = [{
      subject: 'urn:test:rfc64:legacy-subject',
      predicate: 'urn:test:rfc64:legacy-predicate',
      object: '"legacy"',
      graph: 'urn:test:rfc64:legacy-graph',
    }];

    const direct = new SparqlHttpStore({
      queryEndpoint: 'http://legacy-direct.test/sparql',
      atomicUpdates: true,
    });
    await expect(tryReplaceSubjectAtomically(
      direct,
      quads[0]!.graph,
      quads[0]!.subject,
      quads,
    )).resolves.toBe(true);

    const factory = await createTripleStore({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://legacy-factory.test/sparql',
        atomicUpdates: true,
      },
    });
    try {
      await expect(tryReplaceSubjectAtomically(
        factory,
        quads[0]!.graph,
        quads[0]!.subject,
        quads,
      )).resolves.toBe(true);
    } finally {
      await direct.close();
      await factory.close();
    }

    expect(requests).toHaveLength(2);
    expect(() => new SparqlHttpStore({
      queryEndpoint: 'http://legacy-conflict.test/sparql',
      atomicUpdates: true,
      consistencyProfile: 'best-effort',
    })).toThrow(/atomicUpdates conflicts with consistencyProfile/u);
    expect(() => new SparqlHttpStore({
      queryEndpoint: 'http://legacy-compatible.test/sparql',
      atomicUpdates: true,
      consistencyProfile: 'atomic-readback',
    })).not.toThrow();
  });

  it('fails closed on unsupported and non-transactional endpoints before any request', async () => {
    const base = new OxigraphStore();
    const unsupported = overrideStore(base, { rfc64AuthorCommitCasV1: undefined });
    await expect(tryRfc64AuthorCommitCasV1(unsupported, authorCommitInput())).resolves.toBeNull();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const remote = new SparqlHttpStore({ queryEndpoint: 'http://unsupported.invalid/sparql' });
    await expect(tryRfc64AuthorCommitCasV1(remote, authorCommitInput())).resolves.toBeNull();
    const namespaceOwnedButUncertified = await createTripleStore({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://unsupported.invalid/namespace-owned-query',
        updateEndpoint: 'http://unsupported.invalid/namespace-owned-update',
        managedByDkg: true,
      },
    });
    await expect(tryRfc64AuthorCommitCasV1(
      namespaceOwnedButUncertified,
      authorCommitInput(),
    )).resolves.toBeNull();
    const unmanagedCapabilityQuad = {
      subject: 'urn:test:rfc64:uncertified-subject',
      predicate: 'urn:test:rfc64:uncertified-predicate',
      object: '"uncertified"',
      graph: 'urn:test:rfc64:uncertified-graph',
    };
    await expect(tryReplaceGraphAtomically(
      namespaceOwnedButUncertified,
      unmanagedCapabilityQuad.graph,
      [unmanagedCapabilityQuad],
    )).resolves.toBe(false);
    await expect(tryReplaceSubjectAtomically(
      namespaceOwnedButUncertified,
      unmanagedCapabilityQuad.graph,
      unmanagedCapabilityQuad.subject,
      [unmanagedCapabilityQuad],
    )).resolves.toBe(false);
    await namespaceOwnedButUncertified.close();
    const transactionalButReplicaUnsafe = new SparqlHttpStore({
      queryEndpoint: 'http://unsupported.invalid/query-replica',
      updateEndpoint: 'http://unsupported.invalid/update-primary',
      consistencyProfile: 'atomic-update',
    });
    await expect(tryRfc64AuthorCommitCasV1(
      transactionalButReplicaUnsafe,
      authorCommitInput(),
    )).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('propagates indeterminate and mismatched capability failures from the public CAS helper', async () => {
    const indeterminate = new Error('response lost after commit');
    const indeterminateStore = {
      rfc64AuthorCommitCasV1: async () => { throw indeterminate; },
    } as unknown as TripleStore;
    await expect(tryRfc64AuthorCommitCasV1(indeterminateStore, authorCommitInput()))
      .rejects.toBe(indeterminate);

    const mismatchedCapability = new UnsupportedTripleStoreCapabilityError(
      'replaceSubject',
      'TestDecorator',
    );
    const mismatchedStore = {
      rfc64AuthorCommitCasV1: async () => { throw mismatchedCapability; },
    } as unknown as TripleStore;
    await expect(tryRfc64AuthorCommitCasV1(mismatchedStore, authorCommitInput()))
      .rejects.toBe(mismatchedCapability);
  });

  it('preserves receipt certification through the managed factory decorator stack', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = String(init?.body ?? '');
      if (body.includes('ASK')) {
        return new Response(JSON.stringify({ boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = await createTripleStore(createManagedOxigraphRuntimeStoreConfigV1({
      backend: 'sparql-http',
      options: {
        queryEndpoint: 'http://127.0.0.1:7878/query',
        updateEndpoint: 'http://127.0.0.1:7878/update',
        managedByDkg: true,
      },
    }));
    try {
      await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput()))
        .resolves.toBe('committed');
    } finally {
      await store.close();
    }
  });

  it.each([
    ['Blazegraph', () => new BlazegraphStore('http://rfc64.test/sparql') as TripleStore],
    ['transactional SPARQL HTTP', () => new SparqlHttpStore({
      queryEndpoint: 'http://rfc64.test/query',
      updateEndpoint: 'http://rfc64.test/update',
      consistencyProfile: 'atomic-readback',
    }) as TripleStore],
  ])('uses the certified update and receipt protocol on %s', async (_name, createStore) => {
    const requests: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const body = String(init?.body ?? '');
      requests.push({ url: String(input), body });
      if (body.includes('ASK')) {
        return new Response(JSON.stringify({ boolean: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/sparql-results+json' },
        });
      }
      return new Response(null, { status: 200 });
    });
    const store = createStore();

    await expect(store.rfc64AuthorCommitCasV1!(authorCommitInput())).resolves.toBe('committed');

    expect(requests).toHaveLength(3);
    expect(requests[0]!.body).toContain('urn:dkg:sync:authorCommitApplied');
    expect(requests[0]!.body).toContain(`GRAPH <${PROJECTION_GRAPH}>`);
    expect(requests[0]!.body).toContain(`GRAPH <${HEAD_GRAPH}>`);
    expect(requests[1]!.body).toContain('ASK');
    expect(requests[2]!.body).toContain('DROP SILENT GRAPH');
  });

  it.each([
    ['Blazegraph', () => new BlazegraphStore('http://rfc64-abort.test/sparql') as TripleStore],
    ['transactional SPARQL HTTP', () => new SparqlHttpStore({
      queryEndpoint: 'http://rfc64-abort.test/query',
      updateEndpoint: 'http://rfc64-abort.test/update',
      consistencyProfile: 'atomic-readback',
    }) as TripleStore],
  ])('detaches %s receipt cleanup from caller cancellation after dispatch', async (
    _name,
    createStore,
  ) => {
    const requests: Array<{ body: string; signal: AbortSignal | null }> = [];
    let receiptStarted!: () => void;
    const receiptDispatched = new Promise<void>((resolve) => { receiptStarted = resolve; });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = String(init?.body ?? '');
      const signal = init?.signal ?? null;
      requests.push({ body, signal });
      if (!body.includes('ASK')) return new Response(null, { status: 200 });
      receiptStarted();
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error('receipt aborted'));
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    });
    const store = createStore();
    const controller = new AbortController();
    const commit = store.rfc64AuthorCommitCasV1!(authorCommitInput(), {
      signal: controller.signal,
    });
    await receiptDispatched;
    controller.abort(new Error('caller cancelled after CAS dispatch'));

    await expect(commit).rejects.toThrow('caller cancelled after CAS dispatch');
    expect(requests).toHaveLength(3);
    expect(requests[0]!.body).toContain('urn:dkg:sync:authorCommitApplied');
    expect(requests[1]!.body).toContain('ASK');
    expect(requests[2]!.body).toContain('DROP SILENT GRAPH');
    expect(requests[2]!.signal?.aborted).toBe(false);
  });
});
