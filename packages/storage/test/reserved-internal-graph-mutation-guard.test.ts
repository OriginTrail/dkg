import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ATOMIC_GRAPH_REPLACE_STAGING_PREFIX } from '../src/atomic-graph-replace.js';
import {
  ReservedInternalGraphWriteError,
  SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH,
  SYSTEM_RECORD_V1_STATE_GRAPH,
} from '../src/internal-graph-policy.js';
import { SparqlHttpStore } from '../src/adapters/sparql-http.js';
import {
  attachManagedOxigraphLeaseV1,
  createManagedOxigraphOwnershipControllerV1,
} from '../src/managed-oxigraph-ownership-v1-internal.js';
import { createTripleStore, type Quad, type TripleStore } from '../src/triple-store.js';
import { supportsTripleStoreCapability } from '../src/unsupported-capability-error.js';

/**
 * The endpoint is never contacted: every refusal below must be raised BEFORE
 * dispatch, and the pass-through cases stub `fetch` instead of opening a
 * socket.
 *
 * An earlier revision of this file let the pass-through cases make real
 * connections to an unbound port. That was measurably harmful — running
 * alongside the worker-thread suites it pushed `oxigraph-worker-*` and
 * `storage.test.ts` into timeout failures that did not occur without this file.
 * A test that destabilizes its neighbours is a defect in the test, so the
 * pass-through cases now assert on a stubbed dispatch, which is both faster and
 * a stronger claim: it proves the request was actually ISSUED rather than
 * merely that some unrelated error was thrown.
 */
const UNREACHABLE = 'http://127.0.0.1:1/query';
const MANAGED_QUERY_ENDPOINT = 'http://127.0.0.1:7909/query';
const MANAGED_UPDATE_ENDPOINT = 'http://127.0.0.1:7909/update';

/** Stub `fetch` so a permitted mutation is observable without a real socket. */
const stubFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
  );

const stubQueryFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = String(init?.body ?? '');
    if (/\b(?:CONSTRUCT|DESCRIBE)\b/iu.test(body)) {
      return new Response('', {
        status: 200,
        headers: { 'Content-Type': 'application/n-quads' },
      });
    }
    const payload = /\bASK\b/iu.test(body)
      ? { boolean: false }
      : { head: { vars: [] }, results: { bindings: [] } };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/sparql-results+json' },
    });
  });

afterEach(() => {
  vi.restoreAllMocks();
});

const newStore = (): SparqlHttpStore =>
  new SparqlHttpStore({ queryEndpoint: UNREACHABLE, atomicUpdates: true });

const newLeasedStore = (): SparqlHttpStore => {
  const ownership = createManagedOxigraphOwnershipControllerV1(
    MANAGED_QUERY_ENDPOINT,
    MANAGED_UPDATE_ENDPOINT,
  );
  ownership.bindReadyGeneration();
  return new SparqlHttpStore(attachManagedOxigraphLeaseV1(
    {
      queryEndpoint: MANAGED_QUERY_ENDPOINT,
      updateEndpoint: MANAGED_UPDATE_ENDPOINT,
      atomicUpdates: true,
    },
    ownership.lease,
  ));
};

const quad = (graph: string): Quad => ({
  subject: 'urn:s',
  predicate: 'urn:p',
  object: '"o"',
  graph,
});

const RESERVED = [SYSTEM_RECORD_V1_STATE_GRAPH, SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH];

/** Every generic graph-targeted mutation on the TripleStore surface. */
const mutations: ReadonlyArray<{
  name: string;
  run: (store: TripleStore, graph: string) => Promise<unknown>;
}> = [
  { name: 'insert', run: (s, g) => s.insert([quad(g)]) },
  { name: 'delete', run: (s, g) => s.delete([quad(g)]) },
  { name: 'deleteByPattern', run: (s, g) => s.deleteByPattern({ graph: g }) },
  { name: 'deleteBySubjectPrefix', run: (s, g) => s.deleteBySubjectPrefix(g, 'urn:') },
  { name: 'dropGraph', run: (s, g) => s.dropGraph(g) },
  { name: 'replaceGraph', run: (s, g) => s.replaceGraph!(g, [quad(g)]) },
  {
    name: 'replaceGraphAndSubject(data)',
    run: (s, g) => s.replaceGraphAndSubject!(g, [quad(g)], 'urn:meta', 'urn:s', []),
  },
  {
    name: 'replaceGraphAndSubject(meta)',
    run: (s, g) => s.replaceGraphAndSubject!('urn:data', [], g, 'urn:s', []),
  },
  { name: 'replaceSubject', run: (s, g) => s.replaceSubject!(g, 'urn:s', []) },
  { name: 'deleteSubjects', run: (s, g) => s.structuredMutation!({
    kind: 'delete-subjects', input: { graphUri: g, subjects: [] },
  }) },
  {
    name: 'pruneTerminalSubjects',
    run: (s, g) => s.structuredMutation!({ kind: 'prune-ranked-subjects', input: {
      graphUri: g,
      subjectPrefix: 'urn:request:',
      eligibilityPredicate: 'urn:status',
      eligibleObjects: ['done'],
      primaryRankPredicate: 'urn:decided',
      secondaryRankPredicate: 'urn:requested',
      retainNewest: 1,
      maxDelete: 1,
    } }),
  },
  {
    name: 'pruneRecordClosures',
    run: (s, g) => s.structuredMutation!({ kind: 'prune-linked-record-closures', input: {
      graphUri: g,
      matchObjectIris: ['urn:root'],
      linkPredicates: ['urn:member'],
      recordParentPredicate: 'urn:parent',
      descendantSeparator: '/',
    } }),
  },
  {
    name: 'replaceSubjectPredicates',
    run: (s, g) => s.structuredMutation!({ kind: 'replace-subject-predicates', input: {
      graphUri: g,
      subject: 'urn:s',
      predicates: ['urn:p'],
      replacementQuads: [],
    } }),
  },
  {
    name: 'replaceProjectionFromGraph(target)',
    run: (s, g) => s.structuredMutation!({ kind: 'replace-projection-from-graph', input: {
      targetGraphUri: g,
      stagingGraphUri: 'urn:staging',
      targetSubject: 'urn:s',
      preservedTargetPredicates: [],
      targetSubjectPrefixes: [],
    } }),
  },
  {
    name: 'copySubjectProjection(target)',
    run: (s, g) => s.structuredMutation!({ kind: 'copy-subject-projection', input: {
      sourceGraphUris: ['urn:source'],
      targetGraphUri: g,
      roots: ['urn:s'],
      descendantSuffix: '/',
      excludedPredicates: [],
    } }),
  },
];

describe('reserved internal graph mutation guard', () => {
  describe('SparqlHttpStore', () => {
    for (const mutation of mutations) {
      for (const graph of RESERVED) {
        it(`refuses ${mutation.name} against ${graph.split(':').pop()}`, async () => {
          await expect(mutation.run(newStore(), graph)).rejects.toThrow(
            ReservedInternalGraphWriteError,
          );
        });
      }
    }

    it('reports a typed, machine-readable refusal', async () => {
      const error = await newStore()
        .dropGraph(SYSTEM_RECORD_V1_STATE_GRAPH)
        .then(
          () => null,
          (e: unknown) => e as ReservedInternalGraphWriteError,
        );

      expect(error).toBeInstanceOf(ReservedInternalGraphWriteError);
      expect(error?.code).toBe('RESERVED_INTERNAL_GRAPH_WRITE');
      expect(error?.graphUri).toBe(SYSTEM_RECORD_V1_STATE_GRAPH);
      expect(error?.operation).toBe('dropGraph');
      expect(error?.storeName).toBe('SparqlHttpStore');
    });

    it('refuses before dispatch regardless of the atomicUpdates capability', async () => {
      // `atomicUpdates` is SYNTHESIZED by resolveAdapterOptions from plain
      // config, so the reserved refusal must not be ordered behind it.
      const nonAtomic = new SparqlHttpStore({ queryEndpoint: UNREACHABLE });
      await expect(
        nonAtomic.replaceGraph!(SYSTEM_RECORD_V1_STATE_GRAPH, []),
      ).rejects.toThrow(ReservedInternalGraphWriteError);
      await expect(
        nonAtomic.replaceSubject!(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH, 'urn:s', []),
      ).rejects.toThrow(ReservedInternalGraphWriteError);
    });

    for (const graph of RESERVED) {
      it(`refuses replaceProjectionFromGraph source ${graph.split(':').pop()} before I/O`, async () => {
        const fetchSpy = stubFetch();
        await expect(newStore().structuredMutation!({ kind: 'replace-projection-from-graph', input: {
          targetGraphUri: 'urn:target',
          stagingGraphUri: graph,
          targetSubject: 'urn:s',
          preservedTargetPredicates: [],
          targetSubjectPrefixes: [],
        } })).rejects.toThrow(ReservedInternalGraphWriteError);
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it(`refuses copySubjectProjection source ${graph.split(':').pop()} before I/O`, async () => {
        const fetchSpy = stubFetch();
        await expect(newStore().structuredMutation!({ kind: 'copy-subject-projection', input: {
          sourceGraphUris: [graph],
          targetGraphUri: 'urn:target',
          roots: ['urn:s'],
          descendantSuffix: '/',
          excludedPredicates: [],
        } })).rejects.toThrow(ReservedInternalGraphWriteError);
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    describe('ownership-leased raw SPARQL channels', () => {
      const routes: ReadonlyArray<{ name: string; sparql: string }> = [
        {
          name: 'the literal IRI form',
          sparql: `DROP SILENT GRAPH <${SYSTEM_RECORD_V1_STATE_GRAPH}>`,
        },
        {
          name: 'the split prefix/local form, which no substring scan can see',
          sparql:
            `PREFIX dkg: <${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}>\n` +
            'DROP SILENT GRAPH dkg:system-record-v1:state',
        },
      ];

      for (const route of routes) {
        it(`refuses update() ${route.name} before I/O`, async () => {
          const fetchSpy = stubFetch();
          await expect(newLeasedStore().update(route.sparql)).rejects.toMatchObject({
            code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
          });
          expect(fetchSpy).not.toHaveBeenCalled();
        });
      }

      it('reports raw update as unavailable while preserving structured mutation', () => {
        const leased = newLeasedStore();
        const unleased = newStore();

        expect(supportsTripleStoreCapability(leased, 'update')).toBe(false);
        expect(supportsTripleStoreCapability(leased, 'structuredMutation')).toBe(true);
        expect(supportsTripleStoreCapability(unleased, 'update')).toBe(true);
        expect(supportsTripleStoreCapability(unleased, 'structuredMutation')).toBe(true);
      });

      it('the split-prefix form does not contain the reserved graph IRI at all', () => {
        // The load-bearing fact behind the revert. If this ever becomes true,
        // a lexical scan would have been sufficient after all — it is not.
        const { sparql } = routes[1]!;
        expect(sparql).not.toContain(SYSTEM_RECORD_V1_STATE_GRAPH);
        expect(sparql).not.toContain('system-record-v1:state>');
      });

      it.each([
        ['BASE-prefixed update', 'BASE <urn:test:> DROP ALL'],
        ['VALUES-first text', 'VALUES ?operation { ("INSERT") }'],
        ['WITH update', 'WITH <urn:test:g> DELETE { ?s <urn:p> ?o } WHERE { ?s <urn:p> ?o }'],
        ['USING-first text', 'USING <urn:test:g> DELETE { ?s <urn:p> ?o } WHERE { ?s <urn:p> ?o }'],
        ['CLEAR ALL', 'CLEAR ALL'],
        ['DROP ALL', 'DROP ALL'],
        ['COPY', 'COPY <urn:a> TO <urn:b>'],
        ['MOVE', 'MOVE <urn:a> TO <urn:b>'],
        ['ADD', 'ADD <urn:a> TO <urn:b>'],
        ['LOAD', 'LOAD <https://example.test/data>'],
        ['multi-operation update', 'INSERT DATA { <urn:s> <urn:p> "o" }; CLEAR ALL'],
        ['ordinary-graph update', 'INSERT DATA { GRAPH <urn:ordinary> { <urn:s> <urn:p> "o" } }'],
      ])('refuses %s through update() before I/O', async (_name, sparql) => {
        const fetchSpy = stubFetch();
        await expect(newLeasedStore().update(sparql)).rejects.toMatchObject({
          code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it.each([
        ['update syntax', 'INSERT DATA { <urn:s> <urn:p> "o" }'],
        ['unknown syntax', 'VALUES ?s { <urn:s> }'],
        ['BASE-prefixed update', 'BASE <urn:test:> CLEAR ALL'],
        ['multi-operation update', 'DELETE WHERE { ?s <urn:p> ?o }; INSERT DATA { <urn:s> <urn:p> "o" }'],
        ['read-then-update text', 'SELECT ?s WHERE { GRAPH <urn:test:g> { ?s ?p ?o } }; DROP ALL'],
      ])('refuses %s through query() before I/O', async (_name, sparql) => {
        const fetchSpy = stubFetch();
        await expect(newLeasedStore().query(sparql)).rejects.toMatchObject({
          code: 'MANAGED_OXIGRAPH_MUTATION_UNAVAILABLE',
        });
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it.each([
        ['SELECT', 'PREFIX ex: <urn:test:>\nSELECT ?s WHERE { ?s ex:p ?o }'],
        ['ASK', '# read\nBASE <urn:test:>\nASK { ?s <predicate> ?o }'],
        ['CONSTRUCT', 'PREFIX ex: <urn:test:>\nCONSTRUCT { ?s ex:p ?o } WHERE { ?s ex:p ?o }'],
        ['DESCRIBE', 'BASE <urn:test:>\nDESCRIBE <subject>'],
        ['update-word variable', 'SELECT ?delete WHERE { ?s ?p ?delete }'],
        ['update-word prefix label', 'PREFIX insert: <urn:test:> SELECT ?s WHERE { ?s insert:p ?o }'],
        ['update-word prefixed local name', 'PREFIX ex: <urn:test:> SELECT ?s WHERE { ?s ex:drop ?o }'],
      ])('keeps recognized %s reads available on a leased store', async (_name, sparql) => {
        const fetchSpy = stubQueryFetch();
        await expect(newLeasedStore().query(sparql)).resolves.toBeDefined();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it('does not treat forgeable option booleans as an ownership lease', async () => {
        const fetchSpy = stubQueryFetch();
        const forged = new SparqlHttpStore({
          queryEndpoint: UNREACHABLE,
          managedByDkg: true,
          atomicUpdates: true,
        });

        await expect(forged.update(
          'INSERT DATA { GRAPH <urn:ordinary> { <urn:s> <urn:p> "o" } }',
        )).resolves.toBeUndefined();
        await expect(forged.query(
          'INSERT DATA { GRAPH <urn:ordinary> { <urn:s> <urn:p> "o" } }',
        )).resolves.toBeDefined();
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('still allows ephemeral staging graphs so atomic-replace cleanup works', async () => {
      const fetchSpy = stubFetch();
      const staging = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;

      await expect(newStore().dropGraph(staging)).resolves.toBeUndefined();

      // Positive control: the DROP was actually issued, so the guard permitted
      // it rather than the assertion passing for an unrelated reason.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain(staging);
    });

    it('keeps staging cleanup available through the leased structured channel', async () => {
      const fetchSpy = stubFetch();
      const staging = `${ATOMIC_GRAPH_REPLACE_STAGING_PREFIX}${randomUUID()}`;

      await expect(newLeasedStore().dropGraph(staging)).resolves.toBeUndefined();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toContain(staging);
    });

    it('leaves ordinary graphs untouched', async () => {
      const fetchSpy = stubFetch();
      await expect(
        newStore().dropGraph('did:dkg:context-graph:example'),
      ).resolves.toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('ignores an empty quad batch without reaching the guard', async () => {
      await expect(newStore().insert([])).resolves.toBeUndefined();
      await expect(newStore().delete([])).resolves.toBeUndefined();
    });

    it('refuses a mixed batch where only one quad targets reserved state', async () => {
      await expect(
        newStore().insert([quad('did:dkg:context-graph:ok'), quad(SYSTEM_RECORD_V1_STATE_GRAPH)]),
      ).rejects.toThrow(ReservedInternalGraphWriteError);
    });
  });

  describe('through the full production decorator stack', () => {
    /**
     * ChangelogStore -> GraphSetIndexStore -> SharedMemoryLiteralBlobStore ->
     * SparqlHttpStore. The guard lives on the adapter precisely so that every
     * composition inherits it, including the default one where the changelog
     * is absent.
     */
    const compositions: ReadonlyArray<{ name: string; build: () => Promise<TripleStore> }> = [
      {
        name: 'adapter only',
        build: () =>
          createTripleStore({
            backend: 'sparql-http',
            options: { queryEndpoint: UNREACHABLE, atomicUpdates: true },
            graphSetIndex: false,
          }),
      },
      {
        name: 'graph-set index',
        build: () =>
          createTripleStore({
            backend: 'sparql-http',
            options: { queryEndpoint: UNREACHABLE, atomicUpdates: true },
            graphSetIndex: true,
          }),
      },
      {
        name: 'graph-set index + changelog',
        build: () =>
          createTripleStore({
            backend: 'sparql-http',
            options: { queryEndpoint: UNREACHABLE, atomicUpdates: true },
            graphSetIndex: true,
            changelog: true,
          }),
      },
    ];

    for (const composition of compositions) {
      it(`refuses a reserved dropGraph through ${composition.name}`, async () => {
        const store = await composition.build();
        try {
          await expect(store.dropGraph(SYSTEM_RECORD_V1_STATE_GRAPH)).rejects.toThrow(
            /reserved|RESERVED/,
          );
        } finally {
          await store.close().catch(() => undefined);
        }
      });

      it(`refuses a reserved insert through ${composition.name}`, async () => {
        const store = await composition.build();
        try {
          await expect(
            store.insert([quad(SYSTEM_RECORD_V1_SHADOW_AGENTS_GRAPH)]),
          ).rejects.toThrow(/reserved|RESERVED/);
        } finally {
          await store.close().catch(() => undefined);
        }
      });
    }
  });
});
