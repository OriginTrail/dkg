// Scoped queries on a store whose graph catalog is larger than any per-caller
// limit. One engine per run: Blazegraph when BLAZEGRAPH_TEST_URL is set (or
// DKG_LARGE_CATALOG_ENGINE=blazegraph), embedded Oxigraph otherwise.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BlazegraphNamespaceManager,
  BlazegraphStore,
  GraphSetIndexStore,
  OxigraphStore,
  blazegraphNamespaceApiUrlFromSparqlEndpoint,
  isStoreResponseTooLargeError,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryMaterializationBudget } from '../src/query-store-read-context.js';
import { isQueryMaterializationTooLargeError } from '../src/query-materialization-error.js';
import type { QueryResult } from '../src/query-engine.js';
import {
  AGENT, FIXTURE_QUERIES, FIXTURE_READS, SMALL_CONTEXT_GRAPH, UNRELATED_GRAPH_PREFIXES, expectedSubjects, jsonBytes,
  loadLargeCatalog, type FixtureRead, type LargeCatalogFixture, type View,
} from './large-catalog-fixture.js';

const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');
const engine = process.env.DKG_LARGE_CATALOG_ENGINE ?? (endpoint ? 'blazegraph' : 'oxigraph');
if (engine !== 'blazegraph' && engine !== 'oxigraph') throw new Error(`Unknown DKG_LARGE_CATALOG_ENGINE: ${engine}`);
if (engine === 'blazegraph' && !endpoint) throw new Error('A Blazegraph run needs BLAZEGRAPH_TEST_URL');

// The HTTP query route's one limit for a request: each store response, and all the request retains.
const REQUEST_LIMIT_BYTES = 10 * 1024 * 1024;
// A request also reads its own context graph's registry (sub-graph names, child authority).
const REGISTRY_ALLOWANCE_BYTES = 16 * 1024;
// The node-side ceiling on a full catalog read, and the name a failure reports it by.
const CEILING_ENV = 'DKG_STORE_GRAPH_CATALOG_MAX_BYTES';
const CEILING_NAME = 'STORE_GRAPH_CATALOG_MAX_BYTES';
const VIEWS: readonly View[] = ['working-memory', 'shared-working-memory', 'verifiable-memory'];

type Form = keyof typeof FIXTURE_QUERIES;
const FORMS = Object.keys(FIXTURE_QUERIES) as Form[];
const describeRead = ({ view, subGraphName, minTrust }: FixtureRead) => [view ?? 'the legacy route',
  subGraphName && `in sub-graph ${subGraphName}`, minTrust !== undefined && `with minTrust ${minTrust}`].filter(Boolean).join(' ');
const MATRIX = FIXTURE_READS.flatMap(read => FORMS.map(form => ({ read, form, name: `${form} on ${describeRead(read)}` })));

/** Records every byte a request is charged, on top of enforcing its limit. */
class ChargeMeter extends QueryMaterializationBudget {
  charged = 0;

  override consumeBytes(bytes: number): void {
    this.charged += bytes;
    super.consumeBytes(bytes);
  }
}

const CATALOG_READS = new Set(['readGraphInventory', 'listGraphs', 'listGraphsByPrefix', 'listGraphsSorted']);

/** The store unchanged, except that it counts the graph-list reads made through it. */
function countingCatalogReads(store: TripleStore) {
  const counter = { reads: 0 };
  const counted = new Proxy(store, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && CATALOG_READS.has(property)) {
        return (...args: unknown[]) => { counter.reads++; return value.apply(target, args); };
      }
      return value.bind(target);
    },
  });
  return { store: counted, counter };
}

type Stack = 'managed' | 'revalidating' | 'unindexed';
const STACKS: Record<Stack, string> = {
  managed: 'a catalog index, as on a store the node manages',
  revalidating: 'a catalog index that revalidates on every read',
  unindexed: 'no catalog index, as on a store configured by hand',
};

describe(`a graph catalog larger than any caller limit, on ${engine}`, () => {
  let inner: TripleStore;
  let fixture: LargeCatalogFixture;
  let sliceBytes = 0;
  let dispose: () => Promise<void> = async () => {};
  const engines = new Map<Stack, { reader: DKGQueryEngine; counter: { reads: number } }>();
  const durations: number[] = [];

  beforeAll(async () => {
    if (engine === 'blazegraph') {
      const manager = new BlazegraphNamespaceManager({
        namespaceApiUrl: blazegraphNamespaceApiUrlFromSparqlEndpoint(endpoint!),
      });
      const handles = await manager.acquireMany([`large-catalog-${randomUUID()}`]);
      const store = new BlazegraphStore(handles[0]!.sparqlUrl, { timeout: 120_000 });
      inner = store;
      dispose = async () => {
        await store.close();
        await manager.disposeAll(handles, { reconcileAttempts: 3 });
      };
    } else {
      inner = new OxigraphStore();
      dispose = () => inner.close();
    }
    fixture = await loadLargeCatalog(inner);
    sliceBytes = jsonBytes(fixture.smallGraphs);
    // Each stack wraps the same store the way the node builds it.
    const stacks: Record<Stack, TripleStore> = {
      managed: new GraphSetIndexStore(inner),
      revalidating: new GraphSetIndexStore(inner, { revalidateMs: 0 }),
      unindexed: inner,
    };
    for (const [stack, store] of Object.entries(stacks) as [Stack, TripleStore][]) {
      const { store: counted, counter } = countingCatalogReads(store);
      engines.set(stack, { reader: new DKGQueryEngine(counted), counter });
    }
  }, 600_000);

  afterAll(async () => {
    const sorted = [...durations].sort((a, b) => a - b);
    console.log(`[large-catalog] ${JSON.stringify({
      engine, graphs: fixture?.graphCount, catalogBytes: fixture?.catalogBytes, sliceBytes,
      loadSeconds: fixture && Math.round(fixture.loadMs / 100) / 10, queries: sorted.length,
      medianMs: Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0), maxMs: Math.round(sorted.at(-1) ?? 0),
    })}`);
    await dispose();
  }, 120_000);

  // What the HTTP query route passes, with the request's charges recorded.
  const requestOptions = (read: FixtureRead, meter = new ChargeMeter(REQUEST_LIMIT_BYTES)) => ({
    contextGraphId: SMALL_CONTEXT_GRAPH, view: read.view, subGraphName: read.subGraphName, minTrust: read.minTrust,
    agentAddress: read.view === 'working-memory' ? AGENT : undefined,
    maxResponseBytes: REQUEST_LIMIT_BYTES, maxMaterializedBytes: REQUEST_LIMIT_BYTES, materializationBudget: meter,
    priority: 'background' as const, source: 'large-catalog-fixture',
  });

  async function run(stack: Stack, form: Form, read: FixtureRead) {
    const meter = new ChargeMeter(REQUEST_LIMIT_BYTES);
    const { reader, counter } = engines.get(stack)!;
    const readsBefore = counter.reads;
    const started = performance.now();
    const result = await reader.query(FIXTURE_QUERIES[form], requestOptions(read, meter));
    durations.push(performance.now() - started);
    return { result, charged: meter.charged, catalogReads: counter.reads - readsBefore };
  }

  function expected(form: Form, read: FixtureRead): string[] | boolean {
    const subjects = expectedSubjects(fixture.assets, read);
    expect(subjects.length).toBeGreaterThan(0);
    return form === 'ASK' ? true : subjects;
  }

  function answer(form: Form, result: QueryResult): string[] | boolean {
    if (form === 'ASK') return result.bindings[0]?.result === 'true';
    if (form === 'CONSTRUCT') return (result.quads ?? []).map(quad => quad.subject).sort();
    return result.bindings.map(row => row.s!).sort();
  }

  // Each graph-list read charges the caller at most its own context graph's slice, never the
  // catalog; on top come the result and the context graph's registry.
  function chargedSliceAndResult({ result, charged, catalogReads }: Awaited<ReturnType<typeof run>>) {
    expect(catalogReads).toBeGreaterThan(0);
    expect(charged).toBeLessThanOrEqual(catalogReads * sliceBytes + jsonBytes(result) + REGISTRY_ALLOWANCE_BYTES);
  }

  it('holds about 100,000 graphs whose names exceed every caller limit', async () => {
    expect(fixture.graphCount).toBeGreaterThanOrEqual(100_000);
    expect(fixture.catalogBytes).toBeGreaterThan(REQUEST_LIMIT_BYTES);
    expect(sliceBytes * 100).toBeLessThan(fixture.catalogBytes);
    // Every batch landed: the store itself enumerates the whole catalog.
    expect((await inner.listGraphs()).length).toBe(fixture.graphCount);
  }, 300_000);

  it.each(MATRIX)(`answers $name with ${STACKS.managed}`, async ({ read, form }) => {
    const outcome = await run('managed', form, read);
    expect(answer(form, outcome.result)).toEqual(expected(form, read));
    chargedSliceAndResult(outcome);
  });

  describe.each(['revalidating', 'unindexed'] as const)('with %s', (stack) => {
    it.each(VIEWS)(`answers SELECT on %s with ${STACKS[stack]}`, async (view) => {
      const outcome = await run(stack, 'SELECT', { view });
      expect(answer('SELECT', outcome.result)).toEqual(expected('SELECT', { view }));
      chargedSliceAndResult(outcome);
    });
  });

  describe('with a node-side catalog ceiling', () => {
    // The ceiling is read at each use, so it can be lowered for one request.
    const withCeiling = async <T>(bytes: number, work: () => Promise<T>): Promise<T> => {
      const previous = process.env[CEILING_ENV];
      process.env[CEILING_ENV] = String(bytes);
      try { return await work(); } finally {
        if (previous === undefined) delete process.env[CEILING_ENV];
        else process.env[CEILING_ENV] = previous;
      }
    };
    const LOW_CEILING_BYTES = 1024 * 1024;
    const vm: FixtureRead = { view: 'verifiable-memory' };
    const failure = (read: Promise<unknown>) => read.then(() => undefined, (error: unknown) => error);
    // The node's limit, by name and size: never a caller-size error, which the route would answer 413.
    function expectNodeSideLimit(error: unknown, limitBytes: number) {
      expect(error).toMatchObject({ code: 'STORE_INTERNAL_LIMIT', limitName: CEILING_NAME, limitBytes });
      expect((error as { actualBytes: number }).actualBytes).toBeGreaterThan(limitBytes);
      expect(isStoreResponseTooLargeError(error)).toBe(false);
      expect(isQueryMaterializationTooLargeError(error)).toBe(false);
    }

    it.each([
      ['a cold catalog index', () => new GraphSetIndexStore(inner)],
      ['no catalog index', () => inner],
    ] as const)('fails a read with %s past the ceiling as a node-side limit, not the caller\'s size', async (_stack, store) => {
      const reader = new DKGQueryEngine(store());
      expectNodeSideLimit(await failure(withCeiling(LOW_CEILING_BYTES,
        () => reader.query(FIXTURE_QUERIES.SELECT, requestOptions(vm)))), LOW_CEILING_BYTES);
    });

    // Last: it adds graphs to the store.
    it('fails a read as a node-side limit when a warm catalog revalidates past the ceiling', async () => {
      const reader = new DKGQueryEngine(new GraphSetIndexStore(inner, { revalidateMs: 1 }));
      const read = () => reader.query(FIXTURE_QUERIES.SELECT, requestOptions(vm));
      expect(answer('SELECT', await read())).toEqual(expected('SELECT', vm));
      // The warm catalog is within the ceiling; its next revalidation is not, as on a node whose store grew past it.
      await inner.insert(Array.from({ length: 40 }, (_, n) => ({
        graph: `${UNRELATED_GRAPH_PREFIXES[0]}_shared_memory/0x00000000000000000000000000000000000000ff/${n}`,
        subject: `urn:fixture:growth:${n}`, predicate: 'http://schema.org/name', object: `"growth ${n}"`,
      })));
      await new Promise(resolve => setTimeout(resolve, 5));
      const ceiling = fixture.catalogBytes + 1024;
      expectNodeSideLimit(await failure(withCeiling(ceiling, read)), ceiling);
    });
  });
});
