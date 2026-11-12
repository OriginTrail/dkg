import { expect, it } from 'vitest';
import {
  GraphSetIndexStore,
  OxigraphStore,
  type QueryOptions,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QUERY_CATALOG_MAX_RESPONSE_BYTES, QueryMaterializationBudget } from '../src/query-store-read-context.js';

const MiB = 1024 * 1024;

/** The real store, plus graph names of other context graphs that only the catalog sees. */
function withUnrelatedCatalog(inner: OxigraphStore, unrelated: readonly string[]): TripleStore {
  return new Proxy(inner, { get(target, key) {
    if (key === 'listGraphs') {
      return async (options?: QueryOptions) => [...await target.listGraphs(options), ...unrelated];
    }
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

it('answers a view read on a small context graph beside an unrelated catalog over the discovery limit', async () => {
  const id = 'small-view', root = `did:dkg:context-graph:${id}`, name = 'urn:name';
  const unrelated = Array.from({ length: 70_000 }, (_, n) =>
    `did:dkg:context-graph:large/_shared_memory/0x${'a'.repeat(40)}/${String(n).padStart(60, '0')}`);
  expect(Buffer.byteLength(JSON.stringify(unrelated))).toBeGreaterThan(QUERY_CATALOG_MAX_RESPONSE_BYTES);
  const inner = new OxigraphStore();
  const store = new GraphSetIndexStore(withUnrelatedCatalog(inner, unrelated));
  try {
    await inner.insert([
      { graph: `${root}/_verifiable_memory/0xabc/1`, subject: 'urn:item:1', predicate: name, object: '"one"' },
      { graph: `${root}/context/1`, subject: 'urn:item:2', predicate: name, object: '"two"' },
    ]);
    const charges: number[] = [];
    class RecordingBudget extends QueryMaterializationBudget {
      override consumeBytes(bytes: number): void { charges.push(bytes); super.consumeBytes(bytes); }
    }
    const result = await new DKGQueryEngine(store).query(`SELECT ?name WHERE { ?s <${name}> ?name }`, {
      contextGraphId: id, view: 'verifiable-memory', maxResponseBytes: 10 * MiB,
      materializationBudget: new RecordingBudget(10 * MiB),
    });
    expect(result.bindings.map(row => row.name).sort()).toEqual(['"one"', '"two"']);
    // Each discovery is charged for its own slice, never for the other context graph's names.
    expect(charges.length).toBeGreaterThanOrEqual(2);
    expect(charges.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(64 * 1024);
  } finally { await store.close(); }
});
