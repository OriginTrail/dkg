import { describe, expect, it } from 'vitest';
import { GraphSetIndexStore, OxigraphStore, type Quad, type TripleStore } from '@origintrail-official/dkg-storage';
import { contextGraphAssertionUri, contextGraphLayerUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryMaterializationBudget } from '../src/query-store-read-context.js';

const ID = 'per-request', ROOT = `did:dkg:context-graph:${ID}`, NAME = 'http://schema.org/name';
const AGENT = '0xAbCdEf0000000000000000000000000000000001';
const PEER = '12D3KooWPerRequestPeerAlias';
const OTHER = '0x00000000000000000000000000000000000000B2';
const QUERY = `SELECT ?name WHERE { ?s <${NAME}> ?name }`;
const SUB_GRAPH_TYPE = 'http://dkg.io/ontology/SubGraph';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const quad = (graph: string, subject: string, object: string, predicate = NAME): Quad =>
  ({ graph, subject, predicate, object });
const wm = (address: string, number: number, sub?: string) =>
  contextGraphLayerUri(ID, MemoryLayer.WorkingMemory, address, number, sub);
const registration = (sub: string): Quad[] => [
  quad(`${ROOT}/_meta`, `${ROOT}/${sub}`, SUB_GRAPH_TYPE, RDF_TYPE),
  quad(`${ROOT}/_meta`, `${ROOT}/${sub}`, `"${sub}"`),
];
const names = (result: { bindings: Array<Record<string, string>> }) =>
  result.bindings.map(row => row.name).sort();

/** The store as the engine sees it, counting discoveries by prefix and recording every query. */
function recordingStore(inner: TripleStore, onDiscovery?: (prefix: string) => Promise<void>) {
  const discoveries = new Map<string, number>();
  const events: string[] = [];
  const discovered = async (prefix: string) => {
    discoveries.set(prefix, (discoveries.get(prefix) ?? 0) + 1);
    events.push(`discover ${prefix}`);
    await onDiscovery?.(prefix);
  };
  const store = new Proxy(inner, { get(target, key) {
    if (key === 'readGraphInventory') {
      const read = target.readGraphInventory;
      return read && (async (prefix: string, ...rest: unknown[]) => {
        await discovered(prefix);
        return (read as (...args: unknown[]) => unknown).call(target, prefix, ...rest);
      });
    }
    if (key === 'listGraphsByPrefix') return async (prefix: string) => {
      await discovered(prefix);
      return (await target.listGraphs()).filter(graph => graph.startsWith(prefix));
    };
    if (key === 'query') return (sparql: string, options: Parameters<TripleStore['query']>[1]) => {
      events.push(`query ${sparql}`);
      return target.query(sparql, options);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { store, discoveries, events };
}

/** Every prefix the request discovered, each with its count. */
const counts = (discoveries: Map<string, number>) => Object.fromEntries([...discoveries].sort());

describe.each([false, true])('one discovery per prefix per request (index %s)', indexed => {
  it('reads each prefix of a scoped read once and charges its slice once', async () => {
    const inner = new OxigraphStore();
    const vm = `${ROOT}/_verifiable_memory/0xabc/1`, swm = `${ROOT}/_shared_memory/0xabc/1`;
    await inner.insert([quad(vm, 'urn:item:1', '"vm"'), quad(swm, 'urn:item:2', '"swm"')]);
    const { store, discoveries } = recordingStore(indexed ? new GraphSetIndexStore(inner) : inner);
    const charges: number[] = [];
    class RecordingBudget extends QueryMaterializationBudget {
      override consumeBytes(bytes: number): void { charges.push(bytes); super.consumeBytes(bytes); }
    }
    try {
      const result = await new DKGQueryEngine(store).query(QUERY, {
        contextGraphId: ID, includeSharedMemory: true, materializationBudget: new RecordingBudget(1024 * 1024),
      });
      expect(names(result)).toEqual(['"swm"', '"vm"']);
      expect(counts(discoveries)).toEqual({
        [`${ROOT}/_shared_memory/`]: 1,
        [`${ROOT}/_verifiable_memory/`]: 1,
      });
      // Two slices, then the two results: a prefix read again in the request is not charged again.
      const slice = (graph: string) => Buffer.byteLength(JSON.stringify([graph]), 'utf8');
      expect(charges).toHaveLength(4);
      expect(charges.slice(0, 2)).toEqual([slice(vm), slice(swm)]);
    } finally { await inner.close(); }
  });

  it('reads each working-memory prefix and the sub-graph registry once, across aliases and sub-graphs', async () => {
    const inner = new OxigraphStore();
    await inner.insert([
      ...registration('code'), ...registration('docs'),
      quad(wm(AGENT, 1), 'urn:a:1', '"canonical"'),
      quad(`${ROOT}/_working_memory/${AGENT}/2`, 'urn:a:2', '"checksum-cased"'),
      quad(wm(PEER, 1), 'urn:a:3', '"peer-id"'),
      quad(contextGraphAssertionUri(ID, AGENT.toLowerCase(), 'draft'), 'urn:a:4', '"named"'),
      quad(wm(AGENT, 1, 'code'), 'urn:a:5', '"code"'),
      quad(wm(AGENT, 1, 'docs'), 'urn:a:6', '"docs"'),
      quad(wm(OTHER, 1), 'urn:b:1', '"other"'),
    ]);
    const { store, discoveries, events } = recordingStore(indexed ? new GraphSetIndexStore(inner) : inner);
    try {
      const result = await new DKGQueryEngine(store).query(QUERY, {
        contextGraphId: ID, view: 'working-memory', agentAddress: AGENT, agentAddressAliases: [PEER],
      });
      expect(names(result)).toEqual(['"canonical"', '"checksum-cased"', '"code"', '"docs"', '"named"', '"peer-id"']);
      expect(Object.values(counts(discoveries)).every(count => count === 1)).toBe(true);
      expect(Object.keys(counts(discoveries))).toHaveLength(14);
      expect(events.filter(event => event.startsWith('query') && event.includes(SUB_GRAPH_TYPE))).toHaveLength(1);
    } finally { await inner.close(); }
  });
});

describe('working-memory discovery within and across requests', () => {
  it('answers the same from a cold and from a warm catalog, and sees a draft written between requests', async () => {
    const inner = new OxigraphStore(), index = new GraphSetIndexStore(inner);
    await inner.insert([quad(wm(AGENT, 1), 'urn:a:1', '"first"')]);
    const { store, discoveries } = recordingStore(index);
    const engine = new DKGQueryEngine(store);
    const options = { contextGraphId: ID, view: 'working-memory' as const, agentAddress: AGENT };
    try {
      expect(names(await engine.query(QUERY, options))).toEqual(['"first"']);
      const cold = counts(discoveries);
      discoveries.clear();
      expect(names(await engine.query(QUERY, options))).toEqual(['"first"']);
      expect(counts(discoveries)).toEqual(cold);
      await index.insert([quad(wm(AGENT, 2), 'urn:a:2', '"second"')]);
      expect(names(await engine.query(QUERY, options))).toEqual(['"first"', '"second"']);
    } finally { await index.close(); }
  });

  it('keeps owners and their aliases apart from one request to the next', async () => {
    const inner = new OxigraphStore();
    await inner.insert([
      quad(wm(AGENT, 1), 'urn:a:1', '"agent"'),
      quad(wm(PEER, 1), 'urn:a:2', '"agent-peer-id"'),
      quad(wm(OTHER, 1), 'urn:b:1', '"other"'),
    ]);
    const engine = new DKGQueryEngine(new GraphSetIndexStore(inner));
    try {
      const read = (agentAddress: string, agentAddressAliases?: string[]) => engine.query(QUERY,
        { contextGraphId: ID, view: 'working-memory', agentAddress, agentAddressAliases }).then(names);
      expect(await read(AGENT, [PEER])).toEqual(['"agent"', '"agent-peer-id"']);
      expect(await read(OTHER)).toEqual(['"other"']);
      expect(await read(AGENT)).toEqual(['"agent"']);
    } finally { await inner.close(); }
  });

  it('stops reading a sub-graph in the request after its registration is removed', async () => {
    const inner = new OxigraphStore();
    await inner.insert([...registration('code'), quad(wm(AGENT, 1), 'urn:a:1', '"root"'),
      quad(wm(AGENT, 1, 'code'), 'urn:a:2', '"code"')]);
    const engine = new DKGQueryEngine(new GraphSetIndexStore(inner));
    const options = { contextGraphId: ID, view: 'working-memory' as const, agentAddress: AGENT };
    try {
      expect(names(await engine.query(QUERY, options))).toEqual(['"code"', '"root"']);
      await inner.delete(registration('code'));
      expect(names(await engine.query(QUERY, options))).toEqual(['"root"']);
    } finally { await inner.close(); }
  });

  it('fences a child context graph registered while the request discovers its sub-graphs', async () => {
    const inner = new OxigraphStore(), child = `${ROOT}/code`;
    let registered = false;
    const { store, events } = recordingStore(inner, async prefix => {
      if (registered || !prefix.startsWith(`${child}/`)) return;
      registered = true;
      await inner.insert([quad(`${child}/_meta`, child, 'https://dkg.network/ontology#ContextGraph', RDF_TYPE)]);
    });
    await inner.insert([...registration('code'), quad(wm(AGENT, 1), 'urn:a:1', '"root"'),
      quad(wm(AGENT, 1, 'code'), 'urn:a:2', '"child"')]);
    try {
      const result = await new DKGQueryEngine(store).query(QUERY,
        { contextGraphId: ID, view: 'working-memory', agentAddress: AGENT });
      expect(registered).toBe(true);
      expect(names(result)).toEqual(['"root"']);
      // The child fence is read after every discovery of the request, never from an earlier read.
      const fence = events.findIndex(event => event.startsWith('query') && event.includes('?ctxGraph'));
      const lastDiscovery = events.reduce((last, event, index) => event.startsWith('discover') ? index : last, -1);
      expect(lastDiscovery).toBeGreaterThan(0);
      expect(fence).toBeGreaterThan(lastDiscovery);
    } finally { await inner.close(); }
  });

  it('matches each working-memory asset on its own, so a join across two assets finds nothing', async () => {
    const inner = new OxigraphStore(), knows = 'urn:knows';
    await inner.insert([
      quad(wm(AGENT, 1), 'urn:p', 'urn:q', knows), quad(wm(AGENT, 2), 'urn:q', '"across"'),
      quad(wm(AGENT, 3), 'urn:r', 'urn:s', knows), quad(wm(AGENT, 3), 'urn:s', '"within"'),
    ]);
    try {
      const result = await new DKGQueryEngine(new GraphSetIndexStore(inner)).query(
        `SELECT ?name WHERE { ?x <${knows}> ?y . ?y <${NAME}> ?name }`,
        { contextGraphId: ID, view: 'working-memory', agentAddress: AGENT });
      expect(names(result)).toEqual(['"within"']);
    } finally { await inner.close(); }
  });
});
