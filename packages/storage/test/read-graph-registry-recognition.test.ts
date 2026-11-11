import { describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { READ_GRAPH_REGISTRY_PREDICATES as R, readReadGraphRegistry } from '../src/read-graph/registry.js';
import {
  isExactRegistryWrite,
  readReadGraphRegistryFacts,
  registryFactsAfter,
  registryOwnersOfGraph,
  registrySnapshotOfFacts,
  type ReadGraphRegistryFact,
} from '../src/read-graph/registry-recognition.js';
import {
  parseReadGraphStateRows,
  readGraphStateCompareAndSet,
  readGraphStateRowsQuery,
} from '../src/read-graph/state.js';
import type { Quad } from '../src/triple-store.js';
import { ReadGraphMaintenanceError } from '../src/read-graph/read-graph-store.js';
import { isStoreOperationNotStarted } from '../src/store-operation-outcome.js';
import { isStoreSchedulerBusyError, StoreSchedulerBusyError } from '../src/store-priority-scheduler.js';
import { layerFixture, layeredStore, readyRow } from './helpers/read-graph-layer-conformance.js';
import { PlanningOxigraphStore } from './helpers/read-graph-planning-store.js';

const fact = (graph: string, subject: string, predicate: string, object: string): Quad => ({ subject, predicate, object, graph });

describe('registry facts', () => {
  it('give the registry that the view route reads', async () => {
    const store = new OxigraphStore();
    const root = 'did:dkg:context-graph:facts';
    const meta = `${root}/_meta`;
    await store.insert([
      fact(meta, 'urn:sg:1', R.type, R.subGraphClass), fact(meta, 'urn:sg:1', R.name, '"code"'),
      fact(meta, 'urn:sg:2', R.name, '"untyped"'),
      fact(meta, 'urn:asset:1', R.authenticatedSubGraphName, '"docs"@en'),
      fact(`${root}/kid/_meta`, `${root}/kid`, R.type, R.contextGraphClass),
      fact(`${root}/kid2/_meta`, `${root}/kid2`, R.registrationStatus, '"registered"'),
      fact(meta, `${root}/kid3`, R.type, R.contextGraphClass),
      fact(meta, 'urn:asset:2', 'urn:other', '"not a fact"'),
    ]);
    const facts = await readReadGraphRegistryFacts(store, 'facts');
    expect(registrySnapshotOfFacts('facts', facts)).toEqual(await readReadGraphRegistry(store, 'facts'));
    expect(registrySnapshotOfFacts('facts', facts)).toEqual({
      contextGraphId: 'facts', subGraphNames: ['code', 'docs'], childContextGraphRoots: [`${root}/kid`, `${root}/kid2`],
    });
  });

  it('name the context graphs whose registry a graph can change', () => {
    expect(registryOwnersOfGraph('did:dkg:context-graph:a/b/_meta')).toEqual(['a/b', 'a']);
    expect(registryOwnersOfGraph('did:dkg:context-graph:a/_shared_memory')).toEqual([]);
    expect(registryOwnersOfGraph('did:dkg:context-graph:/_meta')).toEqual([]);
    expect(registryOwnersOfGraph('urn:x/_meta')).toEqual([]);
  });

  it('follow every kind of write, and leave an opaque one to the store', () => {
    const root = 'did:dkg:context-graph:w';
    const meta = `${root}/_meta`;
    const code: ReadGraphRegistryFact[] = [
      { graph: meta, subject: 'urn:sg:1', predicate: R.type, object: R.subGraphClass },
      { graph: meta, subject: 'urn:sg:1', predicate: R.name, object: '"code"' },
    ];
    // A predictable write must give facts: undefined would mean the layer could not mark before it.
    const names = (facts: ReadGraphRegistryFact[] | undefined) => {
      expect(facts).toBeDefined();
      return registrySnapshotOfFacts('w', facts!).subGraphNames;
    };
    expect(names(registryFactsAfter('w', [], { kind: 'quads', added: code.map(({ graph, subject, predicate, object }) => fact(graph, subject, predicate, object)), removed: [] })))
      .toEqual(['code']);
    // A literal matches whichever form the store gave it in, and never an IRI with the same text.
    const typedCode = '"code"^^<http://www.w3.org/2001/XMLSchema#string>';
    expect(names(registryFactsAfter('w', code, { kind: 'quads', added: [], removed: [fact(meta, 'urn:sg:1', R.name, typedCode)] }))).toEqual([]);
    expect(names(registryFactsAfter('w', code, { kind: 'quads', added: [], removed: [fact(meta, 'urn:sg:1', R.name, 'code')] }))).toEqual(['code']);
    // An IRI in angle brackets is the same IRI.
    expect(names(registryFactsAfter('w', [], { kind: 'quads', added: [fact(meta, '<urn:sg:2>', `<${R.type}>`, `<${R.subGraphClass}>`),
      fact(meta, 'urn:sg:2', R.name, '"two"')], removed: [] }))).toEqual(['two']);
    // A removal named by a literal or a blank node is read again after the write.
    expect(isExactRegistryWrite('w', { kind: 'quads', added: [], removed: [fact(meta, 'urn:sg:1', R.name, '"code"')] })).toBe(false);
    expect(isExactRegistryWrite('w', { kind: 'quads', added: [], removed: [fact(meta, 'urn:sg:1', R.type, R.subGraphClass)] })).toBe(true);
    expect(isExactRegistryWrite('w', { kind: 'match', graph: meta, predicate: R.name, object: '"code"' })).toBe(false);
    expect(isExactRegistryWrite('w', { kind: 'match', graph: meta, object: 'urn:x' })).toBe(true);
    expect(isExactRegistryWrite('w', { kind: 'subject', graph: meta, subject: '_:b1', quads: [] })).toBe(false);
    expect(names(registryFactsAfter('w', code, { kind: 'match', graph: meta, predicate: R.name }))).toEqual([]);
    expect(names(registryFactsAfter('w', code, { kind: 'match', graph: meta, subject: 'urn:other' }))).toEqual(['code']);
    expect(names(registryFactsAfter('w', code, { kind: 'prefix', graph: meta, prefix: 'urn:sg' }))).toEqual([]);
    // No blank node passes a subject-prefix delete, not even an empty prefix.
    const blank: ReadGraphRegistryFact[] = [
      { graph: meta, subject: '_:sg', predicate: R.type, object: R.subGraphClass },
      { graph: meta, subject: '_:sg', predicate: R.name, object: '"docs"' },
    ];
    expect(names(registryFactsAfter('w', [...code, ...blank], { kind: 'prefix', graph: meta, prefix: '' }))).toEqual(['docs']);
    expect(names(registryFactsAfter('w', code, { kind: 'graph', graph: meta, quads: [] }))).toEqual([]);
    expect(names(registryFactsAfter('w', code, {
      kind: 'subject', graph: meta, subject: 'urn:sg:1', quads: [fact(meta, 'urn:sg:1', R.type, R.subGraphClass), fact(meta, 'urn:sg:1', R.name, '"code2"')],
    }))).toEqual(['code2']);
    expect(names(registryFactsAfter('w', code, {
      kind: 'all', parts: [{ kind: 'graph', graph: `${root}/x`, quads: [] }, { kind: 'quads', added: [fact(meta, 'urn:a', R.authenticatedSubGraphName, '"notes"')], removed: [] }],
    }))).toEqual(['code', 'notes']);
    // Facts outside this context graph's registry are not kept.
    expect(registryFactsAfter('w', [], { kind: 'quads', added: [fact('did:dkg:context-graph:other/_meta', 'urn:sg', R.name, '"x"')], removed: [] }))
      .toEqual([]);
    expect(registryFactsAfter('w', code, { kind: 'opaque', graphs: [meta] })).toBeUndefined();
    expect(registryFactsAfter('w', code, { kind: 'opaque', graphs: [`${root}/_shared_memory`] })).toEqual(code);
  });

  it('keep one fact per quad however often a write inserts it, and literals that differ in datatype or language apart', () => {
    const meta = 'did:dkg:context-graph:w/_meta';
    const named = (object: string) => ({ kind: 'quads' as const, added: [fact(meta, 'urn:asset:1', R.authenticatedSubGraphName, object)], removed: [] as Quad[] });
    let facts: ReadGraphRegistryFact[] = [];
    for (let round = 0; round < 3; round += 1) facts = registryFactsAfter('w', facts, named('"docs"'))!;
    expect(facts).toHaveLength(1);
    for (const object of ['"docs"@en', '"docs"@de', '"docs"^^<urn:test:type>', '"docs"@en']) facts = registryFactsAfter('w', facts, named(object))!;
    expect(facts).toHaveLength(4);
    expect(new Set(facts.map((each) => each.object)).size).toBe(4);
  });
});

describe('registry recognition in the read-graph layer', () => {
  let sequence = 0;
  async function layered() {
    const adapter = new PlanningOxigraphStore();
    const fixture = layerFixture(`recognition-${sequence += 1}`);
    const { layer, store } = await layeredStore(adapter, { backend: 'oxigraph' }, fixture);
    const meta = `${fixture.root}/_meta`;
    const states = () => Object.fromEntries(Object.entries(fixture.readGraphs).map(([name, readGraph]) => {
      const row = layer.runtime.mirror.get(readGraph)!;
      return [name, `${row.state}@${row.generation}`];
    }));
    return { adapter, fixture, layer, store, meta, states };
  }

  it('marks the read graphs whose members a new sub-graph changes dirty, before the write is sent', async () => {
    const { adapter, fixture, layer, store, meta, states } = await layered();
    // The stored row of the whole-graph VM read graph follows the mirror.
    await adapter.update(readGraphStateCompareAndSet(undefined, readyRow(fixture.readGraphs.wholeVm)));
    const seen: string[] = [];
    const insert = adapter.insert.bind(adapter);
    adapter.insert = async (quads, options) => {
      seen.push(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)!.state);
      return insert(quads, options);
    };
    await store.insert([fact(meta, `${fixture.root}/docs`, R.type, R.subGraphClass), fact(meta, `${fixture.root}/docs`, R.name, '"docs"')]);
    expect(seen).toEqual(['dirty']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    const stored = await adapter.query(readGraphStateRowsQuery());
    expect(parseReadGraphStateRows(stored.type === 'bindings' ? stored.bindings : []).rows)
      .toEqual([{ ...readyRow(fixture.readGraphs.wholeVm, 2), state: 'dirty' }]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
  });

  it('refuses a write that changes membership while the store does not take the dirty mark, and marks again on the next attempt', async () => {
    const { adapter, fixture, layer, store, meta, states } = await layered();
    const wholeVm = fixture.readGraphs.wholeVm;
    await adapter.update(readGraphStateCompareAndSet(undefined, readyRow(wholeVm)));
    const storedRows = async () => {
      const result = await adapter.query(readGraphStateRowsQuery());
      return parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows;
    };
    const update = adapter.update.bind(adapter);
    let unreachable = true;
    adapter.update = async (sparql, options) => {
      if (unreachable && options?.source === 'storage.readGraphDirtyMark') throw new Error('connection reset');
      return update(sparql, options);
    };
    const registration = [fact(meta, `${fixture.root}/docs`, R.type, R.subGraphClass), fact(meta, `${fixture.root}/docs`, R.name, '"docs"')];
    const refused = await store.insert(registration).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'READ_GRAPH_WRITE_REFUSED', outcome: 'not_started', storeOperation: 'insert' });
    // Nothing was sent, and the mirror says dirty for every read graph the change touches.
    const held = await adapter.query(`ASK { GRAPH <${meta}> { <${fixture.root}/docs> <${R.name}> "docs" } }`);
    expect(held.type === 'boolean' && held.value).toBe(false);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    expect(await storedRows()).toEqual([readyRow(wholeVm)]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code']);
    // The mirror already says dirty, yet the next attempt sends the mark again before the write.
    unreachable = false;
    await store.insert(registration);
    expect(await storedRows()).toEqual([{ ...readyRow(wholeVm, 2), state: 'dirty' }]);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
  });

  it('takes an IRI with angle brackets as the same IRI, as the stores do', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const docs = `${fixture.root}/docs`;
    await store.insert([fact(meta, `<${docs}>`, `<${R.type}>`, `<${R.subGraphClass}>`), fact(meta, docs, `<${R.name}>`, '"docs"')]);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'docs']);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
  });

  it('never takes an IRI for a literal with the same text', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const named = `${fixture.root}/named`;
    await store.insert([fact(meta, named, R.type, R.subGraphClass), fact(meta, named, R.name, '"urn:docs"')]);
    for (const readGraph of Object.values(fixture.readGraphs)) layer.runtime.mirror.set({ ...layer.runtime.mirror.get(readGraph)!, state: 'ready' });
    // The stored name is a literal: deleting the IRI with the same text removes nothing.
    await store.delete([fact(meta, named, R.name, 'urn:docs')]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'urn:docs']);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'urn:docs']);
    expect(states()).toEqual({ wholeVm: 'ready@2', wholeSwm: 'ready@2', codeVm: 'ready@1', agentWm: 'ready@2' });
  });

  it('keeps the registry a write installed when an older read of it returns later', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    layer.runtime.registries.clear();
    const query = adapter.query.bind(adapter);
    let reads = 0;
    let release!: () => void;
    const late = new Promise<void>((resolve) => { release = resolve; });
    adapter.query = async (sparql, options) => {
      const result = await query(sparql, options);
      // The first registry read runs now but answers only after the second write has registered `docs`.
      if (options?.source === 'storage.readGraphRegistry' && (reads += 1) === 1) await late;
      return result;
    };
    const first = store.insert([fact(meta, 'urn:asset:1', 'urn:test:p', '"m"')]);
    await new Promise((resolve) => setImmediate(resolve));
    await store.insert([fact(meta, `${fixture.root}/docs`, R.type, R.subGraphClass), fact(meta, `${fixture.root}/docs`, R.name, '"docs"')]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    release();
    await first;
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
  });

  it('settles every context graph whose registry a write may change, even when one cannot be read again', async () => {
    const { adapter, store, fixture, layer, states } = await layered();
    const kid = `${fixture.contextGraphId}/kid`;
    const kidVm = readGraphIri({ scope: readScope(kid), layer: MemoryLayer.VerifiableMemory });
    layer.runtime.mirror.set(readyRow(kidVm));
    const kidMeta = `${fixture.root}/kid/_meta`;
    const parentFacts = `<${fixture.root}/_meta>`;
    const query = adapter.query.bind(adapter);
    const update = adapter.update.bind(adapter);
    let written = false;
    adapter.update = async (sparql, options) => {
      await update(sparql, options);
      if (sparql.includes('/kid/docs')) written = true;
    };
    adapter.query = async (sparql, options) => {
      if (written && options?.source === 'storage.readGraphRegistry' && sparql.includes(parentFacts)) throw new Error('connection reset');
      return query(sparql, options);
    };
    const registration = `INSERT DATA { GRAPH <${kidMeta}> { <${fixture.root}/kid/docs> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "docs" } }`;
    await expect(store.update!(registration, { writtenGraphs: [kidMeta] })).rejects.toThrow('connection reset');
    // The parent could not be read again, so all its read graphs are dirty; the child was read again all the same.
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' });
    expect(layer.runtime.mirror.get(kidVm)).toMatchObject({ state: 'dirty', generation: 2 });
    expect(layer.runtime.registries.get(kid)?.subGraphNames).toEqual(['docs']);
    expect(layer.runtime.registries.facts(fixture.contextGraphId)).toBeUndefined();
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code']);
  });

  it('puts back what it fenced for one context graph when another\'s registry cannot be read before the write, and sends nothing', async () => {
    const { adapter, store, fixture, layer, states } = await layered();
    const kid = `${fixture.contextGraphId}/kid`;
    const kidVm = readGraphIri({ scope: readScope(kid), layer: MemoryLayer.VerifiableMemory });
    layer.runtime.mirror.set(readyRow(kidVm));
    const kidMeta = `${fixture.root}/kid/_meta`;
    // The child's registry is known without its facts, as after a write that could not be settled.
    layer.runtime.registries.set({ contextGraphId: kid, subGraphNames: [], childContextGraphRoots: [] });
    // In the write, the parent's facts are read and its read graphs fenced; then reading the child's facts fails once.
    const query = adapter.query.bind(adapter);
    let failures = 1;
    let during: Record<string, string> | undefined;
    adapter.query = async (sparql, options) => {
      if (failures > 0 && options?.source === 'storage.readGraphRegistry' && sparql.includes(`<${kidMeta}>`)) {
        failures -= 1;
        during = states();
        throw new Error('connection reset');
      }
      return query(sparql, options);
    };
    const update = adapter.update.bind(adapter);
    let sent = 0;
    adapter.update = async (sparql, options) => {
      if (sparql.includes('urn:test:p')) sent += 1;
      return update(sparql, options);
    };
    const write = `INSERT DATA { GRAPH <${kidMeta}> { <urn:asset:1> <urn:test:p> "m" } }`;
    await expect(store.update!(write, { writtenGraphs: [kidMeta] })).rejects.toThrow('connection reset');
    expect(sent).toBe(0);
    expect(during).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' });
    const ready = { wholeVm: 'ready@1', wholeSwm: 'ready@1', codeVm: 'ready@1', agentWm: 'ready@1' };
    expect(states()).toEqual(ready);
    expect(layer.runtime.mirror.get(kidVm)).toMatchObject({ state: 'ready', generation: 1 });
    // The next attempt is sent, and leaves them in service as well.
    await store.update!(write, { writtenGraphs: [kidMeta] });
    expect(sent).toBe(1);
    expect(states()).toEqual(ready);
  });

  it('follows a registration in an asset group\'s metadata, in and out', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    // The asset's data graph is in no read graph, so only its metadata matters here.
    const graphUri = `${fixture.root}/_private/assets/9`;
    const asset = (metadataQuads: Quad[]) => ({ graphUri, graphQuads: [fact(graphUri, 'urn:s:9', 'urn:test:p', '"v"')], metaGraphUri: meta,
      metadataSubject: 'urn:asset:9', metadataQuads });
    await store.replaceAssetGroup!([asset([fact(meta, 'urn:asset:9', R.authenticatedSubGraphName, '"notes"')])]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'notes']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    for (const readGraph of Object.values(fixture.readGraphs)) layer.runtime.mirror.set({ ...layer.runtime.mirror.get(readGraph)!, state: 'ready' });
    await store.replaceAssetGroup!([asset([fact(meta, 'urn:asset:9', 'urn:test:p', '"m"')])]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code']);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code']);
    expect(states()).toEqual({ wholeVm: 'dirty@3', wholeSwm: 'dirty@3', codeVm: 'ready@1', agentWm: 'dirty@3' });
  });

  it('reads the registry again after a write that ran but whose response was lost', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const insert = adapter.insert.bind(adapter);
    adapter.insert = async (quads, options) => {
      await insert(quads, options);
      throw new Error('connection reset');
    };
    await expect(store.insert([fact(meta, `${fixture.root}/docs`, R.type, R.subGraphClass), fact(meta, `${fixture.root}/docs`, R.name, '"docs"')]))
      .rejects.toThrow('connection reset');
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    // An update whose registry effect is only known from the store, the same.
    for (const readGraph of Object.values(fixture.readGraphs)) layer.runtime.mirror.set({ ...layer.runtime.mirror.get(readGraph)!, state: 'ready' });
    const update = adapter.update.bind(adapter);
    adapter.update = async (sparql, options) => {
      await update(sparql, options);
      if (sparql.includes('/notes')) throw new Error('connection reset');
    };
    const notes = `INSERT DATA { GRAPH <${meta}> { <${fixture.root}/notes> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "notes" } }`;
    await expect(store.update!(notes, { writtenGraphs: [meta] })).rejects.toThrow('connection reset');
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs', 'notes']);
    expect(states()).toEqual({ wholeVm: 'dirty@3', wholeSwm: 'dirty@3', codeVm: 'ready@1', agentWm: 'dirty@3' });
  });

  it('reports a write that ran but whose registry cannot be read again as indeterminate, never as not started', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    // The registry's read after the write is refused by a full queue, as a not-started update would be.
    const busy = new StoreSchedulerBusyError('queue_full', 'background', 'storage.readGraphRegistry', { storeOperation: 'update' });
    expect(isStoreSchedulerBusyError(busy)).toBe(true);
    let written = false;
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      if (written && options?.source === 'storage.readGraphRegistry') throw busy;
      return query(sparql, options);
    };
    const update = adapter.update.bind(adapter);
    adapter.update = async (sparql, options) => {
      await update(sparql, options);
      if (sparql.includes('/notes')) written = true;
    };
    const notes = `INSERT DATA { GRAPH <${meta}> { <${fixture.root}/notes> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "notes" } }`;
    const error = await store.update!(notes, { writtenGraphs: [meta] }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ReadGraphMaintenanceError);
    expect(error).toMatchObject({ code: 'READ_GRAPH_MAINTENANCE_FAILED', storeOperation: 'update', outcome: 'indeterminate', cause: busy });
    expect(isStoreOperationNotStarted(error, 'update')).toBe(false);
    expect(isStoreSchedulerBusyError(error)).toBe(false);
    // The write ran, and the read graphs of the context graph are out of service until the registry is read again.
    written = false;
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'notes']);
    expect(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)?.state).toBe('dirty');
    expect(layer.runtime.registries.facts(fixture.contextGraphId)).toBeUndefined();
  });

  it('reads the registry again after a write naming an IRI the grammar refuses, which an adapter may rewrite', async () => {
    // An adapter that drops the characters that break an IRI before it deletes, as a renderer without validation does.
    class Rewriting extends PlanningOxigraphStore {
      override async deleteByPattern(pattern: Partial<Quad>, options?: Parameters<PlanningOxigraphStore['deleteByPattern']>[1]): Promise<number> {
        const clean = (term: string | undefined) => (term === undefined || term.startsWith('"') ? term : term.replace(/[{}|^`\\<>"\s]/g, ''));
        return super.deleteByPattern({ ...pattern, subject: clean(pattern.subject), predicate: clean(pattern.predicate), object: clean(pattern.object) }, options);
      }
    }
    const adapter = new Rewriting();
    const fixture = layerFixture(`recognition-${sequence += 1}`);
    const { layer, store } = await layeredStore(adapter, { backend: 'oxigraph' }, fixture);
    const meta = `${fixture.root}/_meta`;
    const states = () => Object.fromEntries(Object.entries(fixture.readGraphs).map(([name, readGraph]) => {
      const row = layer.runtime.mirror.get(readGraph)!;
      return [name, `${row.state}@${row.generation}`];
    }));
    const brokenType = `${R.type.slice(0, -2)}{${R.type.slice(-2)}`;
    expect(isExactRegistryWrite(fixture.contextGraphId, { kind: 'match', graph: meta, predicate: brokenType })).toBe(false);
    expect(isExactRegistryWrite(fixture.contextGraphId, { kind: 'quads', added: [fact(meta, `${fixture.root}/a{b`, R.name, '"ab"')], removed: [] })).toBe(false);
    // The adapter drops the `{`, so this removes the registration types: `code` is no longer a sub-graph.
    await store.deleteByPattern({ graph: meta, predicate: brokenType });
    const stored = (await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames;
    expect(stored).not.toContain('code');
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(stored);
    expect(states().wholeVm).toMatch(/^dirty@/);
  });

  it('takes a literal in the form the store reports, with its escapes decoded', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const seen: string[] = [];
    const insert = adapter.insert.bind(adapter);
    adapter.insert = async (quads, options) => {
      seen.push(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)!.state);
      return insert(quads, options);
    };
    // `c` is `c`: the store keeps the name `docs`.
    await store.insert([fact(meta, 'urn:asset:e', R.authenticatedSubGraphName, '"do\\u0063s"')]);
    expect(seen).toEqual(['dirty']);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'docs']);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
  });

  it('predicts a graph-and-subject replace of one graph as the adapters run it, with the graph last', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const docs = `${fixture.root}/docs`;
    // The whole `_meta` graph is replaced: `code` stays registered because the new graph holds it.
    const graphQuads = [...fixture.facts.filter((quad) => quad.graph === meta), fact(meta, docs, R.type, R.subGraphClass), fact(meta, docs, R.name, '"docs"')];
    await store.replaceGraphAndSubject!(meta, graphQuads, meta, docs, []);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'docs']);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
  });

  it('reads the registry again after a removal named by a blank node, which the adapter matches by shape', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    // `_:t` becomes a variable in the adapter's delete, so this removes the registration type of `code`.
    await store.delete([fact(meta, `${fixture.root}/code`, R.type, '_:t')]);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual([]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual([]);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' });
  });

  it('registers a sub-graph named by a blank node, marking before the insert and reading the registry after it', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const wholeVm = fixture.readGraphs.wholeVm;
    await adapter.update(readGraphStateCompareAndSet(undefined, readyRow(wholeVm)));
    const seen: string[] = [];
    const insert = adapter.insert.bind(adapter);
    adapter.insert = async (quads, options) => {
      const result = await adapter.query(readGraphStateRowsQuery());
      const row = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows.find((found) => found.readGraph === wholeVm);
      seen.push(`${row?.state}@${row?.generation}`);
      return insert(quads, options);
    };
    await store.insert([fact(meta, '_:sg', R.type, R.subGraphClass), fact(meta, '_:sg', R.name, '"docs"')]);
    // Stored dirty before the registration reached the adapter, not only after the registry was read again.
    expect(seen).toEqual(['dirty@2']);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'docs']);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
  });

  it('keeps a sub-graph registered on a blank node through a subject-prefix delete, as the store does', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    await store.insert([fact(meta, '_:sg', R.type, R.subGraphClass), fact(meta, '_:sg', R.name, '"docs"')]);
    await store.deleteBySubjectPrefix(meta, '_:');
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['code', 'docs']);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
  });

  it('reads the registry again after an insert on a blank node, which the store makes a fresh node', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    await store.insert([fact(meta, '_:b', R.type, R.subGraphClass), fact(meta, '_:b', R.name, '"blank"')]);
    // The label the store reports for that sub-graph's subject, as the cached facts hold it.
    const label = layer.runtime.registries.facts(fixture.contextGraphId)!.find((cached) => cached.subject.startsWith('_:'))!.subject;
    await store.insert([fact(meta, label, R.name, '"docs"')]);
    expect((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames).toEqual(['blank', 'code']);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['blank', 'code']);
  });

  it('reads the registry again after a removal that names an IRI in angle brackets, which the adapters delete differently', async () => {
    // The embedded engine's own delete skips a quad written with `<…>`, where a SPARQL adapter deletes it.
    const adapter = new OxigraphStore();
    const fixture = layerFixture(`recognition-native-${sequence += 1}`);
    const { layer, store } = await layeredStore(adapter, { backend: 'oxigraph' }, fixture);
    const meta = `${fixture.root}/_meta`;
    await store.delete([fact(meta, `<${fixture.root}/code>`, R.type, R.subGraphClass)]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames)
      .toEqual((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames);
  });

  it('sends a dirty mark the store did not take again, although the mirror already says dirty', async () => {
    const { adapter, fixture, store, meta } = await layered();
    const wholeVm = fixture.readGraphs.wholeVm;
    await adapter.update(readGraphStateCompareAndSet(undefined, readyRow(wholeVm)));
    const storedState = async () => {
      const result = await adapter.query(readGraphStateRowsQuery());
      const row = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows.find((found) => found.readGraph === wholeVm);
      return `${row?.state}@${row?.generation}`;
    };
    const update = adapter.update.bind(adapter);
    let unreachable = true;
    adapter.update = async (sparql, options) => {
      if (unreachable && options?.source === 'storage.readGraphDirtyMark') throw new Error('connection reset');
      return update(sparql, options);
    };
    const docs = `${fixture.root}/docs`;
    await expect(store.insert([fact(meta, docs, R.type, R.subGraphClass), fact(meta, docs, R.name, '"docs"')]))
      .rejects.toMatchObject({ code: 'READ_GRAPH_WRITE_REFUSED' });
    expect(await storedState()).toBe('ready@1');
    // The same registration through an update: the mark after it reaches the store this time.
    unreachable = false;
    await store.update!(`INSERT DATA { GRAPH <${meta}> { <${docs}> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "docs" } }`, { writtenGraphs: [meta] });
    expect(await storedState()).toBe('dirty@2');
  });

  it('marks every read graph of the context graph dirty after a registry write with an unknown outcome, on an engine that may run it later', async () => {
    class Late extends PlanningOxigraphStore {
      override readonly readGraphCapabilities = { ...new PlanningOxigraphStore().readGraphCapabilities, serialUpdates: false };
    }
    const adapter = new Late();
    const fixture = layerFixture(`recognition-late-${sequence += 1}`);
    const { layer, store } = await layeredStore(adapter, { backend: 'oxigraph' }, fixture);
    const meta = `${fixture.root}/_meta`;
    await store.insert([fact(meta, 'urn:asset:1', 'urn:test:p', '"m"')]);
    const update = adapter.update.bind(adapter);
    let late: Promise<void> | undefined;
    adapter.update = async (sparql, options) => {
      if (!sparql.includes('/docs')) return update(sparql, options);
      // The response is lost, and the request still runs after the layer has read the registry again.
      late = new Promise((resolve) => setTimeout(resolve, 20)).then(() => update(sparql, options));
      throw new Error('connection reset');
    };
    const registration = `INSERT DATA { GRAPH <${meta}> { <${fixture.root}/docs> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "docs" } }`;
    await expect(store.update!(registration, { writtenGraphs: [meta] })).rejects.toThrow('connection reset');
    const states = Object.fromEntries(Object.entries(fixture.readGraphs).map(([name, readGraph]) => [name, layer.runtime.mirror.get(readGraph)!.state]));
    expect(states).toEqual({ wholeVm: 'dirty', wholeSwm: 'dirty', codeVm: 'dirty', agentWm: 'dirty' });
    expect(layer.runtime.registries.facts(fixture.contextGraphId)).toBeUndefined();
    await late;
  });

  it('marks a registry deletion in the store before the delete reaches the adapter', async () => {
    const { adapter, fixture, store, meta } = await layered();
    const codeVm = fixture.readGraphs.codeVm;
    await adapter.update(readGraphStateCompareAndSet(undefined, readyRow(codeVm)));
    const storedState = async () => {
      const result = await adapter.query(readGraphStateRowsQuery());
      const row = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows.find((found) => found.readGraph === codeVm);
      return `${row?.state}@${row?.generation}`;
    };
    const seen: string[] = [];
    const remove = adapter.delete.bind(adapter);
    adapter.delete = async (quads, options) => {
      seen.push(await storedState());
      return remove(quads, options);
    };
    // Without its type, `code` is no longer registered, so its read graph has no members.
    await store.delete([fact(meta, `${fixture.root}/code`, R.type, R.subGraphClass)]);
    expect(seen).toEqual(['dirty@2']);
  });

  it('reads the registry again after a name with a datatype the store may write in another form', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    // The store keeps an integer in its canonical form: this registers `1`, not `01`.
    await store.insert([fact(meta, 'urn:asset:n', R.authenticatedSubGraphName, '"01"^^<http://www.w3.org/2001/XMLSchema#integer>')]);
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames)
      .toEqual((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames);
  });

  it('reports a dirty mark the store does not take after a registry write, and marks again on the next one', async () => {
    const { adapter, fixture, layer, store, meta } = await layered();
    const wholeVm = fixture.readGraphs.wholeVm;
    await adapter.update(readGraphStateCompareAndSet(undefined, readyRow(wholeVm)));
    const storedState = async () => {
      const result = await adapter.query(readGraphStateRowsQuery());
      const row = parseReadGraphStateRows(result.type === 'bindings' ? result.bindings : []).rows.find((found) => found.readGraph === wholeVm);
      return `${row?.state}@${row?.generation}`;
    };
    const update = adapter.update.bind(adapter);
    let unreachable = true;
    adapter.update = async (sparql, options) => {
      if (unreachable && options?.source === 'storage.readGraphDirtyMark') throw new Error('connection reset');
      return update(sparql, options);
    };
    const docs = `${fixture.root}/docs`;
    await expect(store.update!(`INSERT DATA { GRAPH <${meta}> { <${docs}> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "docs" } }`,
      { writtenGraphs: [meta] })).rejects.toThrow('connection reset');
    expect(await storedState()).toBe('ready@1');
    expect(layer.runtime.registries.facts(fixture.contextGraphId)).toBeUndefined();
    // The next write that may change the registry reads it again, finds the change and stores the mark.
    unreachable = false;
    await store.insert([fact(meta, 'urn:asset:1', 'urn:test:p', '"m"')]);
    expect(await storedState()).toBe('dirty@2');
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'docs']);
  });

  it('marks the read graphs a sub-graph leaves dirty when its name goes', async () => {
    const { store, meta, fixture, states } = await layered();
    await store.delete([fact(meta, `${fixture.root}/code`, R.name, '"code"')]);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' });
  });

  it('counts a child only from its own _meta graph', async () => {
    const { store, meta, fixture, states } = await layered();
    await store.insert([fact(meta, `${fixture.root}/kid3`, R.type, R.contextGraphClass)]);
    expect(states()).toEqual({ wholeVm: 'ready@1', wholeSwm: 'ready@1', codeVm: 'ready@1', agentWm: 'ready@1' });
    await store.insert([fact(`${fixture.root}/kid3/_meta`, `${fixture.root}/kid3`, R.type, R.contextGraphClass)]);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' });
  });

  it('changes nothing for metadata that is no registry fact', async () => {
    const { store, meta, states } = await layered();
    await store.insert([fact(meta, 'urn:asset:1', 'urn:test:p', '"m"')]);
    await store.replaceSubject!(meta, 'urn:asset:1', [fact(meta, 'urn:asset:1', 'urn:test:p', '"n"')]);
    await store.deleteByPattern({ graph: meta, subject: 'urn:asset:1' });
    expect(states()).toEqual({ wholeVm: 'ready@1', wholeSwm: 'ready@1', codeVm: 'ready@1', agentWm: 'ready@1' });
  });

  it('reads the registry again after an update that writes a _meta graph', async () => {
    const { store, meta, fixture, states } = await layered();
    const written = { writtenGraphs: [meta] };
    await store.update!(`INSERT DATA { GRAPH <${meta}> { <urn:asset:1> <urn:test:p> "m" } }`, written);
    expect(states()).toEqual({ wholeVm: 'ready@1', wholeSwm: 'ready@1', codeVm: 'ready@1', agentWm: 'ready@1' });
    await store.update!(`INSERT DATA { GRAPH <${meta}> { <${fixture.root}/notes> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "notes" } }`, written);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
  });

  it('keeps the read graphs out of service while an update of a _meta graph runs, and puts back those it left alone', async () => {
    const { adapter, store, meta, fixture, states } = await layered();
    const during: Array<Record<string, string>> = [];
    const update = adapter.update.bind(adapter);
    adapter.update = async (sparql, options) => {
      if (sparql.includes('urn:test:p') || sparql.includes('/notes>')) during.push(states());
      return update(sparql, options);
    };
    const written = { writtenGraphs: [meta] };
    const fencedAll = { wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' };
    // No registry fact: every read graph is out of service while the update runs, and back in service after it.
    await store.update!(`INSERT DATA { GRAPH <${meta}> { <urn:asset:1> <urn:test:p> "m" } }`, written);
    expect(during[0]).toEqual(fencedAll);
    expect(states()).toEqual({ wholeVm: 'ready@1', wholeSwm: 'ready@1', codeVm: 'ready@1', agentWm: 'ready@1' });
    // A new sub-graph: those whose members it changes stay dirty, and `code`'s read graph is back.
    await store.update!(`INSERT DATA { GRAPH <${meta}> { <${fixture.root}/notes> <${R.type}> <${R.subGraphClass}> ; <${R.name}> "notes" } }`, written);
    expect(during[1]).toEqual(fencedAll);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
  });

  it('follows an authenticated sub-graph name in a metadata subject replace, in and out', async () => {
    const { store, meta, states, layer, fixture } = await layered();
    await store.replaceSubject!(meta, 'urn:asset:x', [fact(meta, 'urn:asset:x', R.authenticatedSubGraphName, '"notes"')]);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    // Rebuilt under the new registry, they are ready again before the name goes.
    for (const readGraph of Object.values(fixture.readGraphs)) layer.runtime.mirror.set({ ...layer.runtime.mirror.get(readGraph)!, state: 'ready' });
    await store.replaceSubject!(meta, 'urn:asset:x', []);
    expect(states()).toEqual({ wholeVm: 'dirty@3', wholeSwm: 'dirty@3', codeVm: 'ready@1', agentWm: 'dirty@3' });
  });

  it('reads the registry again after a delete whose effect depends on how the store compares literals', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    const docs = `${fixture.root}/docs`;
    const cached = () => layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames;
    await store.insert([fact(meta, docs, R.type, R.subGraphClass), fact(meta, docs, R.name, '"docs"'), fact(meta, docs, R.name, '"manuals"'),
      fact(meta, 'urn:asset:t', R.authenticatedSubGraphName, '"tagged"@en')]);
    expect(cached()).toEqual(['code', 'docs', 'manuals', 'tagged']);
    // A pattern delete by object removes one name of the subject and keeps the other.
    await store.deleteByPattern({ graph: meta, subject: docs, predicate: R.name, object: '"docs"' });
    // An exact delete of a plain literal leaves the tagged one in the store.
    await store.delete([fact(meta, 'urn:asset:t', R.authenticatedSubGraphName, '"tagged"')]);
    expect(cached()).toEqual(['code', 'manuals', 'tagged']);
    expect(cached()).toEqual((await readReadGraphRegistry(adapter, fixture.contextGraphId)).subGraphNames);
  });

  it('reads the stored names of a subject that a write makes a sub-graph, and marks before the write', async () => {
    const { adapter, store, meta, fixture, layer, states } = await layered();
    const later = `${fixture.root}/later`;
    // The name is stored while the subject is no sub-graph, and the registry read again then leaves it out.
    await store.insert([fact(meta, later, R.name, '"later"')]);
    layer.runtime.registries.invalidate(fixture.contextGraphId);
    expect(states()).toEqual({ wholeVm: 'ready@1', wholeSwm: 'ready@1', codeVm: 'ready@1', agentWm: 'ready@1' });
    const seen: string[] = [];
    const insert = adapter.insert.bind(adapter);
    adapter.insert = async (quads, options) => {
      seen.push(layer.runtime.mirror.get(fixture.readGraphs.wholeVm)!.state);
      return insert(quads, options);
    };
    await store.insert([fact(meta, later, R.type, R.subGraphClass)]);
    expect(seen).toEqual(['dirty']);
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'ready@1', agentWm: 'dirty@2' });
    expect(layer.runtime.registries.get(fixture.contextGraphId)?.subGraphNames).toEqual(['code', 'later']);
  });

  it('marks every read graph of the context graph dirty when the registry cannot be read again after a write', async () => {
    const { adapter, store, meta, states } = await layered();
    await store.insert([fact(meta, 'urn:asset:1', 'urn:test:p', '"m"')]);
    const query = adapter.query.bind(adapter);
    adapter.query = async (sparql, options) => {
      if (options?.source === 'storage.readGraphRegistry') throw new Error('connection reset');
      return query(sparql, options);
    };
    await expect(store.update!(`INSERT DATA { GRAPH <${meta}> { <urn:asset:1> <urn:test:p> "n" } }`, { writtenGraphs: [meta] }))
      .rejects.toThrow('connection reset');
    expect(states()).toEqual({ wholeVm: 'dirty@2', wholeSwm: 'dirty@2', codeVm: 'dirty@2', agentWm: 'dirty@2' });
  });

  it('waits for the locks of the read graphs whose registry a write may change, though it writes no member graph', async () => {
    const { adapter, store, meta, fixture, layer } = await layered();
    await store.insert([fact(meta, 'urn:asset:1', 'urn:test:p', '"m"')]);
    const sent: string[] = [];
    const insert = adapter.insert.bind(adapter);
    adapter.insert = async (quads, options) => {
      sent.push('insert');
      return insert(quads, options);
    };
    let release!: () => void;
    const held = layer.runtime.locks.withLocks([fixture.readGraphs.codeVm], () => new Promise<void>((resolve) => { release = resolve; }));
    const write = store.insert([fact(meta, 'urn:asset:2', 'urn:test:p', '"m"')]);
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toEqual([]);
    release();
    await Promise.all([held, write]);
    expect(sent).toEqual(['insert']);
  });
});
