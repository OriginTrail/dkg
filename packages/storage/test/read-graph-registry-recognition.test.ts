import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '../src/adapters/oxigraph.js';
import { READ_GRAPH_REGISTRY_PREDICATES as R, readReadGraphRegistry } from '../src/read-graph/registry.js';
import {
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
    const names = (facts: ReadGraphRegistryFact[] | undefined) => registrySnapshotOfFacts('w', facts ?? []).subGraphNames;
    expect(names(registryFactsAfter('w', [], { kind: 'quads', added: code.map(({ graph, subject, predicate, object }) => fact(graph, subject, predicate, object)), removed: [] })))
      .toEqual(['code']);
    // A literal matches whichever form the store gave it in.
    expect(names(registryFactsAfter('w', code, { kind: 'quads', added: [], removed: [fact(meta, 'urn:sg:1', R.name, 'code')] }))).toEqual([]);
    expect(names(registryFactsAfter('w', code, { kind: 'match', graph: meta, predicate: R.name }))).toEqual([]);
    expect(names(registryFactsAfter('w', code, { kind: 'match', graph: meta, subject: 'urn:other' }))).toEqual(['code']);
    expect(names(registryFactsAfter('w', code, { kind: 'prefix', graph: meta, prefix: 'urn:sg' }))).toEqual([]);
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
