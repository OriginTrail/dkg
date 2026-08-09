/**
 * RS-heal — runs through the PRODUCTION store decorator stack.
 *
 * Regression for the review finding: `healStrandedScopedKCs` bails unless
 * the structured copy capabilities are present, but the agent's store is NOT a bare
 * adapter. `createTripleStore` wraps it in `SharedMemoryLiteralBlobStore` /
 * `GraphSetIndexStore`, and `DKGAgent.create` wraps THAT in
 * `createListContextGraphsCacheInvalidatingStore`. If any layer fails to
 * forward the optional methods, the capability is `undefined`
 * in every normal daemon config → the guard silently returns → the heal never
 * runs and RS stays stuck. The bare-adapter gate tests cannot see this.
 *
 * This builds the production decorator order around a counted adapter and
 * proves: (1) the capabilities propagate to the top of the stack; (2) the heal
 * actually RELOCATES through it (byte-exact root equality — if `update` were
 * dropped the guard would no-op and scoped would stay empty); (3) the wrapper's
 * cache invalidation fires and the GraphSetIndex touched-graph maintenance keeps
 * the new scoped graph enumerable without a lazy full rebuild.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GraphSetIndexStore,
  OxigraphStore,
  supportsCopySubjectProjection,
  supportsReplaceSubjectPredicatesAtomically,
  supportsTripleStoreCapability,
  type QueryOptions,
  type Quad,
  type StructuredMutation,
  type TripleStore,
} from '@origintrail-official/dkg-storage';
import { V10MerkleTree, contextGraphDataUri, contextGraphMetaUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { extractV10KCFromStore } from '@origintrail-official/dkg-random-sampling';
import { writeMaterializedVersion } from '@origintrail-official/dkg-publisher';
import { SwmHostModeMethods } from '../src/dkg-agent-swm-host.js';
import { createListContextGraphsCacheInvalidatingStore } from '../src/dkg-agent-base.js';

const DKG = 'http://dkg.io/ontology/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const ONTOLOGY_GRAPH = 'did:dkg:context-graph:ontology';
const CONTEXT_GRAPH_ON_CHAIN_ID = 'https://dkg.network/ontology#ContextGraphOnChainId';

const ESCAPE_BEARING_VALUE = 'line1\nline2\\x';
const ROOT = 'urn:entity:strand-root';
const GENID = `${ROOT}/.well-known/genid/blank-1`;
const KA_ID = 42n;

function publicTriples(): { subject: string; predicate: string; object: string }[] {
  return [
    { subject: ROOT, predicate: 'urn:p:name', object: '"strand"' },
    { subject: ROOT, predicate: 'urn:p:payload', object: `"${ESCAPE_BEARING_VALUE.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}"` },
    { subject: ROOT, predicate: 'urn:p:has', object: GENID },
    { subject: GENID, predicate: 'urn:p:value', object: '"42"' },
  ];
}
function metaQuads(ual: string, metaGraph: string): Quad[] {
  return [
    { subject: ual, predicate: `${RDF}type`, object: `${DKG}KnowledgeCollection`, graph: metaGraph },
    { subject: ual, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}partOf`, object: ual, graph: metaGraph },
    { subject: `${ual}/1`, predicate: `${DKG}rootEntity`, object: ROOT, graph: metaGraph },
  ];
}

type ListGraphsCountingStore = TripleStore & { readonly listGraphsCalls: number };

function countListGraphs(inner: TripleStore): ListGraphsCountingStore {
  let listGraphsCalls = 0;
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'listGraphsCalls') return listGraphsCalls;
      if (prop === 'listGraphs') {
        return async (options?: QueryOptions) => {
          listGraphsCalls += 1;
          return target.listGraphs(options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as ListGraphsCountingStore;
}

describe('healStrandedScopedKCs — through the production store decorator stack', () => {
  let store: TripleStore;
  let invalidateCount: number;
  let countedAdapter: ListGraphsCountingStore;

  const TEST_CG = 'stranded-cg';
  const TEST_ONCHAIN = '7';
  const TEST_UAL = 'did:dkg:hardhat:31337/0xpub/42';
  const CTRL_CG = 'control-cg';
  const CTRL_ONCHAIN = '8';
  const CTRL_UAL = 'did:dkg:hardhat:31337/0xctrl/42';

  beforeEach(async () => {
    invalidateCount = 0;
    // Production wrapping order: adapter → GraphSetIndexStore → the agent's
    // listContextGraphs cache-invalidating wrapper (DKGAgent.create).
    countedAdapter = countListGraphs(new OxigraphStore());
    const inner = new GraphSetIndexStore(countedAdapter);
    store = createListContextGraphsCacheInvalidatingStore(
      inner,
      () => { invalidateCount += 1; },
      () => undefined,
    );

    const seedOntology = (cg: string, onChainId: string): Promise<void> => store.insert([{
      subject: `did:dkg:context-graph:${cg}`, predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${onChainId}"`, graph: ONTOLOGY_GRAPH,
    }]);

    await seedOntology(CTRL_CG, CTRL_ONCHAIN);
    await store.insert([
      ...metaQuads(CTRL_UAL, contextGraphMetaUri(CTRL_CG, CTRL_ONCHAIN)),
      ...publicTriples().map((t) => ({ ...t, graph: contextGraphDataUri(CTRL_CG, CTRL_ONCHAIN) })),
    ]);

    await seedOntology(TEST_CG, TEST_ONCHAIN);
    const legacyMeta = contextGraphMetaUri(TEST_CG);
    await store.insert([
      ...metaQuads(TEST_UAL, legacyMeta),
      ...publicTriples().map((t) => ({ ...t, graph: contextGraphDataUri(TEST_CG) })),
    ]);
    await writeMaterializedVersion(store, legacyMeta, TEST_UAL, { blockNumber: 100, txIndex: 0 });
  });

  async function runHeal(localCgId: string, onChainId: string): Promise<void> {
    await SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      { store, log: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
      localCgId,
      { subscribed: true, synced: true, onChainId } as never,
    );
  }

  it('exposes structured RS-heal capabilities at the top of the decorator stack', () => {
    expect(typeof store.structuredMutation).toBe('function');
    expect(supportsTripleStoreCapability(store, 'structuredMutation')).toBe(true);
  });

  it('preserves update-only RS-heal compatibility through the full decorator stack', async () => {
    const adapter = new Proxy(new OxigraphStore(), {
      get(target, prop, receiver) {
        if (prop === 'structuredMutation') return undefined;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      new GraphSetIndexStore(adapter),
      () => undefined,
    );

    expect(typeof wrapped.structuredMutation).toBe('function');
    expect(supportsTripleStoreCapability(wrapped, 'structuredMutation')).toBe(false);
    expect(supportsCopySubjectProjection(wrapped)).toBe(true);
    expect(supportsReplaceSubjectPredicatesAtomically(wrapped)).toBe(true);
    await expect(SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      { store: wrapped, rsHealCursorByCg: new Map() } as never,
      TEST_CG,
      { subscribed: true, synced: true, onChainId: TEST_ONCHAIN } as never,
    )).resolves.toEqual({ status: 'skipped', reason: 'no-work' });

    await wrapped.close();
  });

  it('snapshots structured-mutation cache bookkeeping before async dispatch', async () => {
    let release!: () => void;
    const structuredMutation = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const adapter = new Proxy(new OxigraphStore(), {
      get(target, prop, receiver) {
        if (prop === 'structuredMutation') return structuredMutation;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const dirtiedGraphs: string[] = [];
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      adapter,
      () => undefined,
      (_quads, targetGraph) => {
        if (targetGraph) dirtiedGraphs.push(targetGraph);
      },
    );
    const input = {
      sourceGraphUris: ['urn:test:source'],
      targetGraphUri: 'urn:test:target',
      roots: ['urn:test:root'],
      descendantSuffix: '/',
      excludedPredicates: [],
    };

    const pending = wrapped.structuredMutation!({ kind: 'copy-subject-projection', input });
    input.targetGraphUri = 'urn:test:mutated-after-dispatch';
    release();
    await pending;

    expect(structuredMutation).toHaveBeenCalledTimes(1);
    expect(dirtiedGraphs).toEqual(['urn:test:target']);
    await wrapped.close();
  });

  it('forwards atomic graph-and-subject replacement through the agent decorator', async () => {
    const replaceGraphAndSubject = vi.fn(async () => undefined);
    const adapter = new Proxy(new OxigraphStore(), {
      get(target, prop, receiver) {
        if (prop === 'replaceGraphAndSubject') return replaceGraphAndSubject;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    let invalidations = 0;
    const dirtyQuads: Quad[][] = [];
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      adapter,
      () => { invalidations += 1; },
      (quads) => { dirtyQuads.push([...(quads ?? [])]); },
    );
    const graphQuads: Quad[] = [{
      subject: 'urn:data:s', predicate: 'urn:data:p', object: '"data"', graph: 'urn:data',
    }];
    const metadataQuads: Quad[] = [{
      subject: 'urn:ual', predicate: 'urn:meta:p', object: '"meta"', graph: 'urn:meta',
    }];
    const options: QueryOptions = { source: 'test.atomic-replace', priority: 'background' };

    await expect(wrapped.replaceGraphAndSubject?.(
      'urn:data',
      graphQuads,
      'urn:meta',
      'urn:ual',
      metadataQuads,
      options,
    )).resolves.toBeUndefined();
    expect(replaceGraphAndSubject).toHaveBeenCalledWith(
      'urn:data',
      graphQuads,
      'urn:meta',
      'urn:ual',
      metadataQuads,
      options,
    );
    expect(invalidations).toBe(1);
    expect(dirtyQuads).toEqual([[...graphQuads, ...metadataQuads]]);

    await wrapped.close();
  });

  it('does not advertise graph-and-subject replacement when the inner store lacks it', () => {
    const adapter = new Proxy(new OxigraphStore(), {
      get(target, prop, receiver) {
        if (prop === 'replaceGraphAndSubject') return undefined;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const wrapped = createListContextGraphsCacheInvalidatingStore(adapter, () => undefined);

    expect(wrapped.replaceGraphAndSubject).toBeUndefined();
    return wrapped.close();
  });

  it('forwards pressure telemetry and hasGraph admission options through the agent decorator', async () => {
    const pressure = {
      ackInflight: 1,
      normalInflight: 2,
      backgroundInflight: 3,
      ackQueued: 4,
      normalQueued: 5,
      backgroundQueued: 6,
      maxConcurrent: 8,
      ackReservedSlots: 2,
    };
    const hasGraph = vi.fn(async () => true);
    const adapter = new Proxy(new OxigraphStore(), {
      get(target, prop, receiver) {
        if (prop === 'getPressureSnapshot') return () => pressure;
        if (prop === 'hasGraph') return hasGraph;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    const wrapped = createListContextGraphsCacheInvalidatingStore(adapter, () => undefined);
    const controller = new AbortController();
    const options: QueryOptions = {
      source: 'test.ack-read',
      priority: 'ack',
      signal: controller.signal,
    };

    expect(wrapped.getPressureSnapshot?.()).toBe(pressure);
    await expect(wrapped.hasGraph('urn:test:graph', options)).resolves.toBe(true);
    expect(hasGraph).toHaveBeenCalledWith('urn:test:graph', options);

    await wrapped.close();
  });

  it('invalidates caches for query updates with dotted PREFIX labels', async () => {
    const adapter = new OxigraphStore();
    const queryStore = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          return async () => ({ type: 'bindings' as const, bindings: [] });
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as TripleStore;
    let invalidations = 0;
    let projectionInvalidations = 0;
    const wrapped = createListContextGraphsCacheInvalidatingStore(
      queryStore,
      () => { invalidations += 1; },
      () => { projectionInvalidations += 1; },
    );

    await wrapped.query(
      'PREFIX foaf.core: <http://xmlns.com/foaf/0.1/> ' +
      'INSERT DATA { GRAPH <urn:g> { <urn:s> foaf.core:name "v" } }',
    );

    expect(invalidations).toBe(1);
    expect(projectionInvalidations).toBe(1);
    await wrapped.close();
  });

  it('relocates the stranded KC through the full stack (heal does NOT silently no-op)', async () => {
    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const expectedRoot = new V10MerkleTree(ctrl.leaves).root;
    await expect(extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID)).rejects.toBeTruthy();

    // Seed the GraphSetIndex BEFORE the heal so touchedGraphs must maintain an
    // already-populated graph index without a full rebuild.
    const graphsBefore = await store.listGraphs();
    expect(graphsBefore).not.toContain(contextGraphMetaUri(TEST_CG, TEST_ONCHAIN));
    expect(countedAdapter.listGraphsCalls).toBe(1);
    const invalidatesBefore = invalidateCount;

    await runHeal(TEST_CG, TEST_ONCHAIN);

    // (1) byte-exact relocation through the stack — if update() were dropped by
    // any layer, the heal's guard would no-op and this would reject/empty.
    const healed = await extractV10KCFromStore(store, BigInt(TEST_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(expectedRoot);

    // (2) the cache-invalidating wrapper's update() ran (graph-creating mutation).
    expect(invalidateCount).toBeGreaterThan(invalidatesBefore);

    // (3) GraphSetIndexStore.update() used the declared touchedGraphs to keep the
    //     index warm, so the new scoped graphs are enumerable without a rescan.
    const graphsAfter = await store.listGraphs();
    expect(graphsAfter).toContain(contextGraphMetaUri(TEST_CG, TEST_ONCHAIN));
    expect(graphsAfter).toContain(contextGraphDataUri(TEST_CG, TEST_ONCHAIN));
    expect(countedAdapter.listGraphsCalls).toBe(1);

    // copies, never moves.
    const legacyStill = await store.query(
      `ASK { GRAPH <${contextGraphMetaUri(TEST_CG)}> { <${TEST_UAL}> <${DKG}batchId> "${KA_ID}"^^<${XSD}integer> } }`,
    );
    expect(legacyStill.type === 'boolean' && legacyStill.value).toBe(true);
  });

  it('relocates every root of a multi-root KC with byte-identical proof data', async () => {
    const cg = 'multi-root-strand';
    const onChainId = '19';
    const controlCg = 'multi-root-control';
    const controlOnChainId = '20';
    const ual = 'did:dkg:hardhat:31337/0xmulti/42';
    const controlUal = 'did:dkg:hardhat:31337/0xmulticontrol/42';
    const roots = ['urn:entity:multi-a', 'urn:entity:multi-b'];
    const data = roots.flatMap((root, index) => [
      { subject: root, predicate: 'urn:p:value', object: `"${index}"` },
      {
        subject: `${root}/.well-known/genid/child`,
        predicate: 'urn:p:child',
        object: `"child-${index}"`,
      },
    ]);
    const metadata = (subject: string, graph: string): Quad[] => [
      { subject, predicate: `${RDF}type`, object: `${DKG}KnowledgeCollection`, graph },
      { subject, predicate: `${DKG}batchId`, object: `"${KA_ID}"^^<${XSD}integer>`, graph },
      ...roots.flatMap((root, index) => [
        { subject: `${subject}/${index + 1}`, predicate: `${DKG}partOf`, object: subject, graph },
        { subject: `${subject}/${index + 1}`, predicate: `${DKG}rootEntity`, object: root, graph },
      ]),
    ];
    await store.insert([
      {
        subject: `did:dkg:context-graph:${cg}`,
        predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
        object: `"${onChainId}"`,
        graph: ONTOLOGY_GRAPH,
      },
      {
        subject: `did:dkg:context-graph:${controlCg}`,
        predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
        object: `"${controlOnChainId}"`,
        graph: ONTOLOGY_GRAPH,
      },
      ...metadata(ual, contextGraphMetaUri(cg)),
      ...data.map((quad) => ({ ...quad, graph: contextGraphDataUri(cg) })),
      ...metadata(controlUal, contextGraphMetaUri(controlCg, controlOnChainId)),
      ...data.map((quad) => ({ ...quad, graph: contextGraphDataUri(controlCg, controlOnChainId) })),
    ]);
    await writeMaterializedVersion(store, contextGraphMetaUri(cg), ual, {
      blockNumber: 100,
      txIndex: 0,
    });

    const control = await extractV10KCFromStore(store, BigInt(controlOnChainId), KA_ID);
    await runHeal(cg, onChainId);
    const healed = await extractV10KCFromStore(store, BigInt(onChainId), KA_ID);

    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(control.leaves).root);
    for (const root of roots) {
      const present = await store.query(
        `ASK { GRAPH <${contextGraphDataUri(cg, onChainId)}> { <${root}> ?p ?o } }`,
      );
      expect(present.type === 'boolean' && present.value).toBe(true);
    }
  });

  it('chunks an over-budget root set and stamps completion after every data chunk', async () => {
    const cg = 'oversized-root-set';
    const onChainId = '21';
    const ual = 'did:dkg:hardhat:31337/0xoversized/42';
    const roots = Array.from(
      { length: 10 },
      (_, index) => `urn:entity:oversized:${index}:${'x'.repeat(500_000)}`,
    );
    const mutations: StructuredMutation[] = [];
    const fakeStore = {
      query: vi.fn(async (sparql: string) => {
        if (sparql.includes('SELECT ?ual ?b')) {
          return { type: 'bindings' as const, bindings: [{ ual, b: String(KA_ID) }] };
        }
        if (sparql.includes('SELECT ?root')) {
          return {
            type: 'bindings' as const,
            bindings: roots.map((root) => ({ root })),
          };
        }
        if (sparql.includes('ASK')) return { type: 'boolean' as const, value: true };
        return { type: 'bindings' as const, bindings: [] };
      }),
      structuredMutation: vi.fn(async (mutation: StructuredMutation) => {
        mutations.push(mutation);
      }),
    } as unknown as TripleStore;

    await expect(SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      {
        store: fakeStore,
        rsHealCursorByCg: new Map<string, string>(),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      } as never,
      cg,
      { subscribed: true, synced: true, onChainId } as never,
    )).resolves.toEqual({ status: 'completed', inspected: 1 });

    const scopedData = contextGraphDataUri(cg, onChainId);
    const dataCopies = mutations.filter((mutation) => mutation.kind === 'copy-subject-projection'
      && mutation.input.targetGraphUri === scopedData);
    expect(dataCopies.length).toBeGreaterThan(1);
    expect(dataCopies.flatMap((mutation) => mutation.kind === 'copy-subject-projection'
      ? mutation.input.roots
      : [])).toEqual(roots);

    const firstDataIndex = mutations.indexOf(dataCopies[0]);
    const lastDataIndex = mutations.indexOf(dataCopies[dataCopies.length - 1]);
    const completionResetIndex = mutations.findIndex((mutation) => (
      mutation.kind === 'replace-subject-predicates'
      && mutation.input.replacementQuads.length === 0
    ));
    const completionStampIndex = mutations.findIndex((mutation) => (
      mutation.kind === 'replace-subject-predicates'
      && mutation.input.replacementQuads.some((quad) => quad.predicate === `${DKG}materializedVersion`)
    ));
    expect(completionResetIndex).toBeGreaterThanOrEqual(0);
    expect(completionResetIndex).toBeLessThan(firstDataIndex);
    expect(completionStampIndex).toBeGreaterThan(lastDataIndex);
  });

  it('rejects an individually over-budget root before clearing completion', async () => {
    const cg = 'unrepresentable-root';
    const onChainId = '22';
    const ual = 'did:dkg:hardhat:31337/0xunrepresentable/42';
    const root = `urn:entity:unrepresentable:${'x'.repeat(4 * 1024 * 1024)}`;
    const mutations: StructuredMutation[] = [];
    const fakeStore = {
      query: vi.fn(async (sparql: string) => {
        if (sparql.includes('SELECT ?ual ?b')) {
          return { type: 'bindings' as const, bindings: [{ ual, b: String(KA_ID) }] };
        }
        if (sparql.includes('SELECT ?root')) {
          return { type: 'bindings' as const, bindings: [{ root }] };
        }
        if (sparql.includes('ASK')) return { type: 'boolean' as const, value: true };
        return { type: 'bindings' as const, bindings: [] };
      }),
      structuredMutation: vi.fn(async (mutation: StructuredMutation) => {
        mutations.push(mutation);
      }),
    } as unknown as TripleStore;

    await expect(SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      {
        store: fakeStore,
        rsHealCursorByCg: new Map<string, string>(),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      } as never,
      cg,
      { subscribed: true, synced: true, onChainId } as never,
    )).resolves.toEqual({ status: 'completed', inspected: 1 });

    expect(mutations).toEqual([]);
  });

  it('(#1549) RS-heal INSERTs declare touchedGraphs through the decorator stack', async () => {
    // Guard the #1549 warm-index behaviour at the call site: a regression reverting
    // either INSERT to a plain `store.update(sparql)` would still relocate the KC
    // (the graphsAfter/merkle assertions above stay green) but would re-dirty the
    // graph-set index and force a full rebuild scan. Capture the structured
    // operations the heal sends through the top of the production stack and
    // assert each declares its scoped target graph + source tag.
    const copyCalls: Array<{ targetGraphUri: string; options?: QueryOptions }> = [];
    const replaceCalls: Array<{ graphUri: string; options?: QueryOptions }> = [];
    const operationOptions: Array<{ method: string; options?: QueryOptions }> = [];
    const capturing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          const orig = Reflect.get(target, prop, receiver) as TripleStore['query'];
          return (sparql: string, options?: QueryOptions) => {
            operationOptions.push({ method: 'query', options });
            return orig.call(target, sparql, options);
          };
        }
        if (prop === 'insert') {
          const orig = Reflect.get(target, prop, receiver) as TripleStore['insert'];
          return (quads: Quad[], options?: QueryOptions) => {
            operationOptions.push({ method: 'insert', options });
            return orig.call(target, quads, options);
          };
        }
        if (prop === 'deleteByPattern') {
          const orig = Reflect.get(target, prop, receiver) as TripleStore['deleteByPattern'];
          return (pattern: Partial<Quad>, options?: QueryOptions) => {
            operationOptions.push({ method: 'deleteByPattern', options });
            return orig.call(target, pattern, options);
          };
        }
        if (prop === 'structuredMutation') {
          const orig = Reflect.get(target, prop, receiver) as NonNullable<TripleStore['structuredMutation']>;
          return (mutation: Parameters<NonNullable<TripleStore['structuredMutation']>>[0], options?: QueryOptions) => {
            if (mutation.kind === 'copy-subject-projection') {
              copyCalls.push({ targetGraphUri: mutation.input.targetGraphUri, options });
            }
            if (mutation.kind === 'replace-subject-predicates') {
              replaceCalls.push({ graphUri: mutation.input.graphUri, options });
            }
            operationOptions.push({ method: `structuredMutation:${mutation.kind}`, options });
            return orig.call(target, mutation, options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TripleStore;

    await SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      {
        store: capturing,
        rsHealCursorByCg: new Map<string, string>(),
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      } as never,
      TEST_CG,
      { subscribed: true, synced: true, onChainId: TEST_ONCHAIN } as never,
    );

    const scopedData = contextGraphDataUri(TEST_CG, TEST_ONCHAIN);
    const scopedMeta = contextGraphMetaUri(TEST_CG, TEST_ONCHAIN);
    const dataCopy = copyCalls.find((call) => call.targetGraphUri === scopedData);
    const metaCopy = copyCalls.find((call) => call.targetGraphUri === scopedMeta);
    expect(dataCopy?.options).toMatchObject({
      priority: 'background',
      source: 'agent.swm.rsHeal.materialize.copy',
    });
    expect(metaCopy?.options).toMatchObject({
      priority: 'background',
      source: 'agent.swm.rsHeal.materialize.copy',
    });
    expect(replaceCalls.filter((call) => call.graphUri === scopedMeta)).toHaveLength(2);
    expect(operationOptions.length).toBeGreaterThan(0);
    expect(operationOptions.every(({ options }) => options?.priority === 'background')).toBe(true);
    expect(operationOptions.every(({ options }) => options?.source?.startsWith('agent.swm.rsHeal.'))).toBe(true);
  });

  it('labels RS-heal reads by caller operation through the decorator stack', async () => {
    const querySources: Array<string | undefined> = [];
    const capturing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === 'query') {
          const orig = Reflect.get(target, prop, receiver) as TripleStore['query'];
          return (
            sparql: Parameters<TripleStore['query']>[0],
            options?: Parameters<TripleStore['query']>[1],
          ) => {
            querySources.push(options?.source);
            return orig.call(target, sparql, options);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as TripleStore;

    await SwmHostModeMethods.prototype.healStrandedScopedKCs.call(
      {
        store: capturing,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      } as never,
      TEST_CG,
      { subscribed: true, synced: true, onChainId: TEST_ONCHAIN } as never,
    );

    expect(new Set(querySources.filter((source) => source?.startsWith('agent.swm.rsHeal.'))))
      .toEqual(new Set([
        'agent.swm.rsHeal.guard',
        'agent.swm.rsHeal.enumerate',
        'agent.swm.rsHeal.version.readLegacy',
        'agent.swm.rsHeal.version.checkScoped',
        'agent.swm.rsHeal.roots',
        'agent.swm.rsHeal.rootPresent',
      ]));
  });

  it('relocates a VM-graph-only one-shot strand through the full stack (read-both)', async () => {
    // The publisher's own one-shot publish() lands public data in the per-KA VM
    // graph, not legacy root data. The read-both heal must recover it through the
    // full production decorator stack (the UNION-in-UPDATE forwarded by every layer).
    const VM_CG = 'vmstrand-cg';
    const VM_ONCHAIN = '17';
    const VM_UAL = 'did:dkg:hardhat:31337/0xvm/42';
    await store.insert([{
      subject: `did:dkg:context-graph:${VM_CG}`, predicate: CONTEXT_GRAPH_ON_CHAIN_ID,
      object: `"${VM_ONCHAIN}"`, graph: ONTOLOGY_GRAPH,
    }]);
    await store.insert(metaQuads(VM_UAL, contextGraphMetaUri(VM_CG)));
    const vmNumber = KA_ID & ((1n << 96n) - 1n);
    const vmAuthor = '0x' + (KA_ID >> 96n).toString(16).padStart(40, '0');
    const vmGraph = contextGraphLayerUri(VM_CG, MemoryLayer.VerifiableMemory, vmAuthor, vmNumber);
    await store.insert(publicTriples().map((t) => ({ ...t, graph: vmGraph })));

    await expect(extractV10KCFromStore(store, BigInt(VM_ONCHAIN), KA_ID)).rejects.toBeTruthy();
    const rootEmpty = await store.query(`ASK { GRAPH <${contextGraphDataUri(VM_CG)}> { ?s ?p ?o } }`);
    expect(rootEmpty.type === 'boolean' && rootEmpty.value).toBe(false);

    await runHeal(VM_CG, VM_ONCHAIN);

    const ctrl = await extractV10KCFromStore(store, BigInt(CTRL_ONCHAIN), KA_ID);
    const healed = await extractV10KCFromStore(store, BigInt(VM_ONCHAIN), KA_ID);
    expect(new V10MerkleTree(healed.leaves).root).toEqual(new V10MerkleTree(ctrl.leaves).root);
  });
});
