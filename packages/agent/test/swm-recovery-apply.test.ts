import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  applySwmRecovery,
  type SwmRecoveryStore,
} from '../src/sync/requester/swm-recovery-apply.js';
import { createRecoveryExecutionBoundary } from
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
    const executionBoundary = createRecoveryExecutionBoundary({
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
    const executionBoundary = createRecoveryExecutionBoundary({
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
});
