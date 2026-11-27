import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryLayer, readGraphIri, readScope } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore, CURRENT_READ_GRAPH_VERSIONS, OxigraphStore, workingMemoryIdentityRule,
  type Quad, type ReadGraphStateRow, type TripleStore,
} from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import type { QueryOptions } from '../src/query-engine.js';
import type { ViewReadGraphs } from '../src/view-dataset-plan.js';

// The working-memory rows of the qualification matrix, merged against per asset. CI's
// tornado-blazegraph lane runs this file on a live server; elsewhere it runs on Oxigraph.
const endpoint = process.env.BLAZEGRAPH_TEST_URL;
if (process.env.DKG_REQUIRE_BLAZEGRAPH === '1' && !endpoint) throw new Error('Blazegraph CI endpoint is required');

const id = `qualification-wm-${randomUUID()}`;
const ROOT = `did:dkg:context-graph:${id}`;
const AGENT = '0x' + 'a1'.repeat(20);
const PEER = '12D3KooWQualificationWm';
const OTHER = '0x' + 'b2'.repeat(20);
const NOTE = 'urn:note';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const draft = (address: string, n: number) => `${ROOT}/_working_memory/${address}/${n}`;
const readGraph = (agentAddress: string) =>
  readGraphIri({ scope: readScope(id), layer: MemoryLayer.WorkingMemory, agentAddress });
const READ_AGENT = readGraph(AGENT);
const READ_OTHER = readGraph(OTHER);

const quad = (subject: string, predicate: string, object: string, graph: string): Quad => ({ subject, predicate, object, graph });
const AGENT_DRAFTS = [
  // A product typed in one draft and priced in another; an older note under the node's peer ID,
  // and a note the agent holds in two drafts.
  quad('urn:p1', RDF_TYPE, 'urn:Product', draft(AGENT, 1)), quad('urn:p1', 'urn:price', '"5"', draft(AGENT, 2)),
  quad('urn:old', NOTE, '"peer era"', draft(PEER, 3)),
  quad('urn:twice', NOTE, '"held twice"', draft(AGENT, 1)), quad('urn:twice', NOTE, '"held twice"', draft(PEER, 3)),
];
const OTHER_DRAFTS = [quad('urn:p1', 'urn:price', '"999"', draft(OTHER, 1)), quad('urn:theirs', NOTE, '"theirs"', draft(OTHER, 1))];
const merge = (rows: readonly Quad[], graph: string) =>
  [...new Map(rows.map(row => [`${row.subject} ${row.predicate} ${row.object}`, { ...row, graph }])).values()];

class ReadyReadGraphs implements ViewReadGraphs {
  readonly identity = workingMemoryIdentityRule({ defaultAgentAddress: AGENT, peerId: PEER });
  keeps(): boolean { return true; }
  state(graph: string): ReadGraphStateRow | undefined {
    return graph === READ_AGENT || graph === READ_OTHER
      ? { readGraph: graph, state: 'ready', generation: 2, ...CURRENT_READ_GRAPH_VERSIONS } : undefined;
  }
}

const wm = (agentAddress: string, semantics: 'merged' | 'per-asset'): QueryOptions =>
  ({ contextGraphId: id, view: 'working-memory', agentAddress, semantics });
const values = (result: { bindings: Array<Record<string, string>> }, name: string) => result.bindings.map(row => row[name]).sort();

describe(`working memory, merged and per asset, on ${endpoint ? 'Blazegraph' : 'Oxigraph'}`, () => {
  let store: TripleStore;
  let engine: DKGQueryEngine;

  beforeAll(async () => {
    store = endpoint ? new BlazegraphStore(endpoint) : new OxigraphStore();
    await store.insert([...AGENT_DRAFTS, ...OTHER_DRAFTS, ...merge(AGENT_DRAFTS, READ_AGENT), ...merge(OTHER_DRAFTS, READ_OTHER)]);
    engine = new DKGQueryEngine(store, { readGraphs: new ReadyReadGraphs() });
  }, 60_000);

  afterAll(async () => {
    if (endpoint) {
      const graphs = [draft(AGENT, 1), draft(AGENT, 2), draft(PEER, 3), draft(OTHER, 1), READ_AGENT, READ_OTHER];
      await store.update(graphs.map(graph => `DROP SILENT GRAPH <${graph}>`).join('; '));
    }
    await store.close();
  }, 60_000);

  const JOIN = 'SELECT ?x WHERE { ?p a <urn:Product> . ?p <urn:price> ?x }';

  it("joins across one agent's drafts when merged, and never reads another agent's", async () => {
    expect(values(await engine.query(JOIN, wm(AGENT, 'merged')), 'x')).toEqual(['"5"']);
    expect((await engine.query(JOIN, wm(AGENT, 'per-asset'))).bindings).toEqual([]);
    expect((await engine.query(JOIN, wm(OTHER, 'merged'))).bindings).toEqual([]);
  });

  it("reads the default agent's peer-ID drafts through either address, and each triple once", async () => {
    for (const address of [AGENT, PEER, `0x${AGENT.slice(2).toUpperCase()}`]) {
      const notes = await engine.query(`SELECT ?n WHERE { ?s <${NOTE}> ?n }`, wm(address, 'merged'));
      expect(values(notes, 'n'), address).toEqual(['"held twice"', '"peer era"']);
    }
    const counted = await engine.query('SELECT (COUNT(*) AS ?c) WHERE { <urn:twice> ?p ?o }', wm(AGENT, 'merged'));
    expect(Number.parseInt(String(counted.bindings[0]?.c).replace(/^"?(\d+).*$/, '$1'), 10)).toBe(1);
  });

  it("gives another agent only its own drafts", async () => {
    expect(values(await engine.query(`SELECT ?n WHERE { ?s <${NOTE}> ?n }`, wm(OTHER, 'merged')), 'n')).toEqual(['"theirs"']);
  });
});
