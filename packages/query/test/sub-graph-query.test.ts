import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG_ID = 'dkg-v10-dev';
const ROOT_GRAPH = `did:dkg:context-graph:${CG_ID}`;
const CODE_GRAPH = `did:dkg:context-graph:${CG_ID}/code`;
const DECISIONS_GRAPH = `did:dkg:context-graph:${CG_ID}/decisions`;

function q(s: string, p: string, o: string, g: string): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('sub-graph query scoping', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    await store.insert([
      q('urn:fn:main', 'http://ex.org/type', '"Function"', ROOT_GRAPH),
      q('urn:fn:main', 'http://ex.org/name', '"main"', ROOT_GRAPH),

      q('urn:fn:parse', 'http://ex.org/type', '"Function"', CODE_GRAPH),
      q('urn:fn:parse', 'http://ex.org/signature', '"parse(input: string)"', CODE_GRAPH),

      q('urn:decision:1', 'http://ex.org/type', '"Decision"', DECISIONS_GRAPH),
      q('urn:decision:1', 'http://ex.org/title', '"Use TypeScript"', DECISIONS_GRAPH),
    ]);
  });

  it('queries root data graph without subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://ex.org/name> ?name }',
      { contextGraphId: CG_ID },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"main"');
  });

  it('queries code sub-graph with subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?sig WHERE { ?s <http://ex.org/signature> ?sig }',
      { contextGraphId: CG_ID, subGraphName: 'code' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['sig']).toBe('"parse(input: string)"');
  });

  it('queries decisions sub-graph with subGraphName', async () => {
    const result = await engine.query(
      'SELECT ?s ?title WHERE { ?s <http://ex.org/title> ?title }',
      { contextGraphId: CG_ID, subGraphName: 'decisions' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['title']).toBe('"Use TypeScript"');
  });

  it('sub-graph isolation: code query does not see decisions', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'code' },
    );
    const subjects = result.bindings.map(b => b['s']);
    expect(subjects).toContain('urn:fn:parse');
    expect(subjects).not.toContain('urn:decision:1');
  });

  it('sub-graph isolation: decisions query does not see code', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'decisions' },
    );
    const subjects = result.bindings.map(b => b['s']);
    expect(subjects).toContain('urn:decision:1');
    expect(subjects).not.toContain('urn:fn:parse');
  });

  it('empty sub-graph returns no results', async () => {
    const result = await engine.query(
      'SELECT ?s ?p ?o WHERE { ?s ?p ?o }',
      { contextGraphId: CG_ID, subGraphName: 'nonexistent' },
    );
    expect(result.bindings).toHaveLength(0);
  });

  it('verified-memory view ignores subGraphName (deferred to V10.x)', async () => {
    // Sub-graph scoping within view-based routing is not yet implemented.
    // The query falls through to normal verified-memory resolution which
    // reads from _verified_memory/* graphs — those won't contain our test data.
    const result = await engine.query(
      'SELECT ?s ?sig WHERE { ?s <http://ex.org/signature> ?sig }',
      { contextGraphId: CG_ID, view: 'verified-memory', subGraphName: 'code' },
    );
    expect(result.bindings).toHaveLength(0);
  });
});
