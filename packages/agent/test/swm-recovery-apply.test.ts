import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  applySwmRecovery,
  applyVerifiedSwmRecoveryPlan,
  type SwmRecoveryStore,
  type VerifiedSwmRecoveryApplyPorts,
  type VerifiedSwmRecoveryApplyPlan,
} from '../src/sync/requester/swm-recovery-apply.js';
import { createRecoveryExecutionAdmission } from
  '../src/sync/requester/recovery-execution-guard.js';

/**
 * Recovery must REPLACE per root, not blind-union.
 * Pins the corruption (a blind insert leaves `{v1, v2}`) and proves the fix
 * (per-root replace leaves only the source's `v2`), while never deleting roots
 * the source did not provide.
 */
const G = 'did:dkg:context-graph:ws00/_shared_memory';
const SUBJ = 'urn:ws00:shipment';
const CHILD = `${SUBJ}/.well-known/genid/leg`;
const STATUS = 'http://schema.org/status';
const VALUE = 'http://schema.org/value';

async function values(store: OxigraphStore, subject: string, predicate: string): Promise<string[]> {
  const r = await store.query(`SELECT ?o WHERE { GRAPH <${G}> { <${subject}> <${predicate}> ?o } }`);
  return r.type === 'bindings' ? r.bindings.map((b) => b['o']) : [];
}

describe('applySwmRecovery (per-root replace, not union)', () => {
  const stores: OxigraphStore[] = [];
  afterEach(async () => { await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {}))); });

  function seedStale(): OxigraphStore {
    const store = new OxigraphStore();
    stores.push(store);
    return store;
  }

  it('replaces a stale single-valued root with the source value (no {v1,v2} union)', async () => {
    const store = seedStale();
    await store.insert([
      { subject: SUBJ, predicate: STATUS, object: '"v1"', graph: G },
      { subject: CHILD, predicate: VALUE, object: '"old-leg"', graph: G },
      // an unrelated root the source does NOT provide — must survive untouched
      { subject: 'urn:ws00:other', predicate: STATUS, object: '"keep"', graph: G },
    ]);

    const result = await applySwmRecovery({
      store,
      verifiedData: [
        { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G },
        { subject: CHILD, predicate: VALUE, object: '"new-leg"', graph: G },
      ],
      roots: [{ dataGraph: G, entity: SUBJ }],
    });

    expect(result.replacedRoots).toBe(1);
    // the single-valued status is now ONLY v2 — the bug would leave both
    expect(await values(store, SUBJ, STATUS)).toEqual(['"v2"']);
    // the skolemized child was replaced too, not unioned
    expect(await values(store, CHILD, VALUE)).toEqual(['"new-leg"']);
    // the unrelated root the source didn't provide is untouched (no collateral loss)
    expect(await values(store, 'urn:ws00:other', STATUS)).toEqual(['"keep"']);
  });

  it('NEGATIVE CONTROL: a blind insert (today\'s sync path) corrupts into a multi-value union', async () => {
    const store = seedStale();
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: G }]);
    // simulate the current blind-union apply
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G }]);
    expect((await values(store, SUBJ, STATUS)).sort()).toEqual(['"v1"', '"v2"']); // corruption
  });

  it('clears each root exactly once even when a root repeats in the roots list (paging-safe)', async () => {
    const store = seedStale();
    await store.insert([{ subject: SUBJ, predicate: STATUS, object: '"v1"', graph: G }]);
    const result = await applySwmRecovery({
      store,
      verifiedData: [{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G }],
      // entityCreators can list the same (graph, entity) more than once
      roots: [{ dataGraph: G, entity: SUBJ }, { dataGraph: G, entity: SUBJ }],
    });
    expect(result.replacedRoots).toBe(1);
    expect(await values(store, SUBJ, STATUS)).toEqual(['"v2"']);
  });

  it('is a clean insert when the target is empty (cold-start parity)', async () => {
    const store = seedStale();
    const result = await applySwmRecovery({
      store,
      verifiedData: [{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G }],
      roots: [{ dataGraph: G, entity: SUBJ }],
    });
    expect(result.insertedQuads).toBe(1);
    expect(await values(store, SUBJ, STATUS)).toEqual(['"v2"']);
  });

  it('finishes the admitted root replacement when authority is revoked after deletion starts', async () => {
    const revoked = new Error('recovery revoked');
    const controller = new AbortController();
    let current = true;
    let rows: Quad[] = [
      { subject: SUBJ, predicate: STATUS, object: '"v1"', graph: G },
      { subject: CHILD, predicate: VALUE, object: '"old-leg"', graph: G },
    ];
    const operations: string[] = [];
    const store: SwmRecoveryStore = {
      insert: async (quads) => {
        operations.push('insert');
        rows.push(...quads);
      },
      replaceGraph: async () => undefined,
      deleteByPattern: async (pattern) => {
        operations.push('delete-root');
        rows = rows.filter((quad) => !(
          quad.graph === pattern.graph && quad.subject === pattern.subject
        ));
        // Simulate unsubscribe after the backend committed the first delete.
        current = false;
        controller.abort(revoked);
      },
      deleteBySubjectPrefix: async (graph, prefix) => {
        operations.push('delete-children');
        rows = rows.filter((quad) => !(
          quad.graph === graph && quad.subject.startsWith(prefix)
        ));
        return 1;
      },
    };
    const executionBoundary = createRecoveryExecutionAdmission({
      signal: controller.signal,
      assertCurrent: () => {
        if (!current) throw revoked;
      },
    });

    await expect(applySwmRecovery({
      store,
      verifiedData: [
        { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G },
        { subject: CHILD, predicate: VALUE, object: '"new-leg"', graph: G },
      ],
      roots: [{ dataGraph: G, entity: SUBJ }],
      executionBoundary,
    })).resolves.toEqual({ replacedRoots: 1, insertedQuads: 2 });

    expect(operations).toEqual(['delete-root', 'delete-children', 'insert']);
    expect(rows.filter((quad) => quad.subject === SUBJ)).toEqual([
      { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G },
    ]);
    expect(rows.filter((quad) => quad.subject === CHILD)).toEqual([
      { subject: CHILD, predicate: VALUE, object: '"new-leg"', graph: G },
    ]);
  });

  it('rejects a revoked lease before the root replacement mutates anything', async () => {
    const revoked = new Error('recovery revoked');
    const controller = new AbortController();
    controller.abort(revoked);
    const operations: string[] = [];
    const store: SwmRecoveryStore = {
      insert: async () => { operations.push('insert'); },
      replaceGraph: async () => undefined,
      deleteByPattern: async () => { operations.push('delete-root'); },
      deleteBySubjectPrefix: async () => {
        operations.push('delete-children');
        return 0;
      },
    };
    const executionBoundary = createRecoveryExecutionAdmission({
      signal: controller.signal,
      assertCurrent: () => { throw revoked; },
    });

    await expect(applySwmRecovery({
      store,
      verifiedData: [{ subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G }],
      roots: [{ dataGraph: G, entity: SUBJ }],
      executionBoundary,
    })).rejects.toBe(revoked);
    expect(operations).toEqual([]);
  });

  const PLAN_MUTATIONS = [
    'ensure-context-graph',
    'delete-root',
    'delete-children',
    'insert-root-data',
    'replace-graph',
    'replace-graph-meta',
    'replace-root-meta',
    'insert-verified-meta',
  ] as const;

  it.each(PLAN_MUTATIONS)(
    'resumes the exact plan after %s commits and then rejects',
    async (failurePoint) => {
      const assertionGraph = `${G}/asset`;
      const metaGraph = `${G}_meta`;
      const rootData: Quad[] = [
        { subject: SUBJ, predicate: STATUS, object: '"v2"', graph: G },
        { subject: CHILD, predicate: VALUE, object: '"new-leg"', graph: G },
      ];
      const graphData: Quad[] = [{
        subject: 'urn:asset', predicate: STATUS, object: '"current"', graph: assertionGraph,
      }];
      const verifiedMeta: Quad[] = [{
        subject: 'urn:head', predicate: STATUS, object: '"current"', graph: metaGraph,
      }];
      const descriptor = {
        metaGraph,
        headSubject: 'urn:head',
        operationSubject: 'urn:operation',
        kaUal: 'did:dkg:ka:retry',
        assertionVersion: '1',
        assertionGraph,
        shareOperationId: 'retry-operation',
        publicQuadsDigest: `sha256:${'a'.repeat(64)}`,
        publicQuadsCount: graphData.length,
        privateTripleCount: 0,
        publisherPeerId: '12D3KooWRecoveryRetryProvider',
        metadataQuads: [],
      };
      const plan: VerifiedSwmRecoveryApplyPlan = {
        contextGraphId: 'retry-cg',
        rootData,
        roots: [{ dataGraph: G, entity: SUBJ, creator: 'did:example:creator' }],
        graphAssets: [{ kind: 'replace', descriptor, replacementQuads: graphData }],
        verifiedMeta,
        rootMetaGraphs: [metaGraph],
        ownershipUpdates: [{
          ownershipKey: 'retry-cg', entity: SUBJ, creator: 'did:example:creator',
        }],
      };

      let rows: Quad[] = [
        { subject: SUBJ, predicate: STATUS, object: '"stale"', graph: G },
        { subject: CHILD, predicate: VALUE, object: '"stale-leg"', graph: G },
      ];
      let graphRows: Quad[] = [{
        subject: 'urn:asset', predicate: STATUS, object: '"stale"', graph: assertionGraph,
      }];
      let contextGraphReady = false;
      let graphMetaCurrent = false;
      let rootMetaCurrent = false;
      let failed = false;
      const owned = new Map<string, Map<string, string>>();
      const failAfter = (point: string): void => {
        if (!failed && point === failurePoint) {
          failed = true;
          throw new Error(`post-commit failure: ${point}`);
        }
      };
      const store: SwmRecoveryStore = {
        insert: async (quads) => {
          const point = quads.every((quad) => quad.graph === G)
            ? 'insert-root-data'
            : 'insert-verified-meta';
          const existing = new Set(rows.map((quad) => JSON.stringify(quad)));
          for (const quad of quads) {
            if (!existing.has(JSON.stringify(quad))) rows.push(quad);
          }
          failAfter(point);
        },
        replaceGraph: async (_graph, quads) => {
          graphRows = [...quads];
          failAfter('replace-graph');
        },
        deleteByPattern: async (pattern) => {
          if (pattern.graph === G && pattern.subject === SUBJ) {
            rows = rows.filter((quad) => !(
              quad.graph === pattern.graph && quad.subject === pattern.subject
            ));
            failAfter('delete-root');
          }
        },
        deleteBySubjectPrefix: async (graph, prefix) => {
          rows = rows.filter((quad) => !(
            quad.graph === graph && quad.subject.startsWith(prefix)
          ));
          failAfter('delete-children');
          return 1;
        },
      };
      const ports: VerifiedSwmRecoveryApplyPorts = {
        store,
        ensureContextGraph: async () => {
          contextGraphReady = true;
          failAfter('ensure-context-graph');
        },
        replaceMetaForRoots: async () => {
          rootMetaCurrent = true;
          failAfter('replace-root-meta');
        },
        replaceMetaForGraphAssets: async () => {
          graphMetaCurrent = true;
          failAfter('replace-graph-meta');
        },
        snapshotMaterializer: {} as never,
        ensureOwnedMap: (key) => {
          let map = owned.get(key);
          if (map === undefined) {
            map = new Map();
            owned.set(key, map);
          }
          return map;
        },
      };
      const executionBoundary = createRecoveryExecutionAdmission();

      await expect(applyVerifiedSwmRecoveryPlan({
        plan, ports, executionBoundary,
      })).rejects.toThrow(`post-commit failure: ${failurePoint}`);
      await expect(applyVerifiedSwmRecoveryPlan({
        plan, ports, executionBoundary,
      })).resolves.toEqual({
        replacedRoots: 1,
        replacedGraphs: 1,
        insertedRootQuads: rootData.length,
        insertedGraphQuads: graphData.length,
        insertedMetaQuads: verifiedMeta.length,
      });

      expect(contextGraphReady).toBe(true);
      expect(graphMetaCurrent).toBe(true);
      expect(rootMetaCurrent).toBe(true);
      expect(rows.filter((quad) => quad.graph === G)).toEqual(rootData);
      expect(rows.filter((quad) => quad.graph === metaGraph)).toEqual(verifiedMeta);
      expect(graphRows).toEqual(graphData);
      expect(owned.get('retry-cg')?.get(SUBJ)).toBe('did:example:creator');
    },
  );

  it('keeps witness invalidation best-effort after an atomic graph replacement', async () => {
    const assertionGraph = `${G}/asset`;
    const graphData: Quad[] = [{
      subject: 'urn:asset', predicate: STATUS, object: '"current"', graph: assertionGraph,
    }];
    let graphRows: Quad[] = [];
    const ports: VerifiedSwmRecoveryApplyPorts = {
      store: {
        insert: async () => undefined,
        replaceGraph: async (_graph, quads) => { graphRows = [...quads]; },
        deleteByPattern: async () => { throw new Error('witness backend unavailable'); },
        deleteBySubjectPrefix: async () => 0,
      },
      ensureContextGraph: async () => undefined,
      replaceMetaForRoots: async () => undefined,
      replaceMetaForGraphAssets: async () => undefined,
      snapshotMaterializer: {} as never,
      ensureOwnedMap: () => new Map(),
    };
    const descriptor = {
      metaGraph: `${G}_meta`,
      headSubject: 'urn:head',
      operationSubject: 'urn:operation',
      kaUal: 'did:dkg:ka:witness',
      assertionVersion: '1',
      assertionGraph,
      shareOperationId: 'witness-operation',
      publicQuadsDigest: `sha256:${'b'.repeat(64)}`,
      publicQuadsCount: 1,
      privateTripleCount: 0,
      publisherPeerId: '12D3KooWWitnessProvider',
      metadataQuads: [],
    };

    await expect(applyVerifiedSwmRecoveryPlan({
      plan: {
        contextGraphId: 'witness-cg',
        rootData: [],
        roots: [],
        graphAssets: [{ kind: 'replace', descriptor, replacementQuads: graphData }],
        verifiedMeta: [],
        rootMetaGraphs: [],
        ownershipUpdates: [],
      },
      ports,
      executionBoundary: createRecoveryExecutionAdmission(),
    })).resolves.toMatchObject({ replacedGraphs: 1, insertedGraphQuads: 1 });
    expect(graphRows).toEqual(graphData);
  });
});
