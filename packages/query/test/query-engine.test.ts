import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { validateReadOnlySparql } from '../src/sparql-guard.js';

const CONTEXT_GRAPH = 'agent-registry';
const GRAPH = `did:dkg:context-graph:${CONTEXT_GRAPH}`;
const META = `${GRAPH}/_meta`;
const ENTITY = 'did:dkg:agent:QmImageBot';

function q(s: string, p: string, o: string, g = GRAPH): Quad {
  return { subject: s, predicate: p, object: o, graph: g };
}

describe('DKGQueryEngine', () => {
  let store: OxigraphStore;
  let engine: DKGQueryEngine;

  beforeEach(async () => {
    store = new OxigraphStore();
    engine = new DKGQueryEngine(store);

    // Seed data
    await store.insert([
      q(ENTITY, 'http://schema.org/name', '"ImageBot"'),
      q(ENTITY, 'http://schema.org/description', '"Analyzes images"'),
      q(
        `${ENTITY}/.well-known/genid/o1`,
        'http://ex.org/type',
        '"ImageAnalysis"',
      ),
    ]);
  });

  it('queries context-graph-scoped data', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"ImageBot"');
  });

  it('returns all triples for entity', async () => {
    const result = await engine.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o }`,
      { contextGraphId: CONTEXT_GRAPH },
    );
    expect(result.bindings).toHaveLength(3);
  });

  it('resolveKA returns entity data', async () => {
    const ual = 'did:dkg:mock:31337/1';
    // Need metadata in meta graph
    await store.insert([
      {
        subject: `${ual}/1`,
        predicate: 'http://dkg.io/ontology/rootEntity',
        object: ENTITY,
        graph: META,
      },
      {
        subject: `${ual}/1`,
        predicate: 'http://dkg.io/ontology/partOf',
        object: ual,
        graph: META,
      },
      {
        subject: ual,
        predicate: 'http://dkg.io/ontology/paranet',
        object: `did:dkg:context-graph:${CONTEXT_GRAPH}`,
        graph: META,
      },
    ]);

    const result = await engine.resolveKA(ual);
    expect(result.rootEntity).toBe(ENTITY);
    expect(result.contextGraphId).toBe(CONTEXT_GRAPH);
    expect(result.quads.length).toBeGreaterThanOrEqual(2);
  });

  it('throws on unknown UAL', async () => {
    await expect(engine.resolveKA('did:dkg:mock:9999/99')).rejects.toThrow(
      'KA not found',
    );
  });

  it('queries across all contextGraphs', async () => {
    // Add data to another context graph
    await store.insert([
      q('did:dkg:agent:QmTextBot', 'http://schema.org/name', '"TextBot"', 'did:dkg:context-graph:text-tools'),
    ]);

    const result = await engine.queryAllContextGraphs(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );
    expect(result.bindings.length).toBe(2);
  });

  // the multi-graph wrapper used to
  // inject `VALUES ?_viewGraph { ... } GRAPH ?_viewGraph { inner }` into
  // the caller's WHERE block, which leaked an extra `_viewGraph` column
  // into every `SELECT *` result and collided with user queries that
  // legitimately bound `?_viewGraph`. The fix is to use explicit UNION
  // branches per graph, so no helper variable ever enters the user's
  // variable scope.
  it('multi-graph views do NOT leak a helper _viewGraph variable into SELECT * results', async () => {
    await store.insert([
      q('did:dkg:agent:QmTextBot', 'http://schema.org/name', '"TextBot"', 'did:dkg:context-graph:text-tools'),
    ]);

    const result = await engine.queryAllContextGraphs(
      'SELECT * WHERE { ?s <http://schema.org/name> ?name }',
    );
    expect(result.bindings.length).toBe(2);
    // The bindings must NOT include a `_viewGraph` (or any `view*`)
    // variable — only the user's ?s and ?name.
    for (const row of result.bindings) {
      expect(Object.keys(row).sort()).toEqual(['name', 's']);
    }
  });

  it('does not collide with user queries that bind a ?_viewGraph variable of their own', async () => {
    await store.insert([
      q('did:dkg:agent:QmTextBot', 'http://schema.org/name', '"TextBot"', 'did:dkg:context-graph:text-tools'),
    ]);

    // If the old implementation had been retained, the caller's
    // ?_viewGraph binding would be silently clamped to the wrapper's
    // VALUES list. With the UNION-based fix the caller's variable is
    // independent and the wrapper introduces none of its own.
    const result = await engine.queryAllContextGraphs(
      'SELECT ?name ?_viewGraph WHERE { ?s <http://schema.org/name> ?name . BIND(<http://example.org/g> AS ?_viewGraph) }',
    );
    // Everyone gets the same user-supplied bind.
    for (const row of result.bindings) {
      expect(row['_viewGraph']).toBe('http://example.org/g');
    }
  });

  it('queries shared memory graph when graphSuffix is _shared_memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, graphSuffix: '_shared_memory' },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['name']).toBe('"Workspace Only"');
  });

  it('queries union of data and shared memory when includeSharedMemory is true', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:ws:entity:union', 'http://schema.org/name', '"In Workspace"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );
    const names = result.bindings.map((r) => String(r['name']));
    expect(names.some((n) => n.includes('ImageBot'))).toBe(true);
    expect(names.some((n) => n.includes('In Workspace'))).toBe(true);
    expect(result.bindings.length).toBe(2);
  });

  it('dedupes duplicate rows when includeSharedMemory returns same binding from data and shared memory', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', GRAPH),
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    const duplicates = result.bindings.filter((row) =>
      row['s'] === 'urn:dup:entity:1' && String(row['name']).includes('Duplicate'),
    );
    expect(duplicates.length).toBe(1);
  });

  it('dedupes duplicate quads for includeSharedMemory CONSTRUCT queries', async () => {
    const sharedMemoryGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_shared_memory`;
    await store.insert([
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', GRAPH),
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', sharedMemoryGraph),
    ]);

    const result = await engine.query(
      'CONSTRUCT { ?s <http://schema.org/name> ?name } WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, includeSharedMemory: true },
    );

    const matches = (result.quads ?? []).filter((row) =>
      row.subject === 'urn:dup:quad:1'
        && row.predicate === 'http://schema.org/name'
        && String(row.object).includes('QuadDup'),
    );
    expect(matches.length).toBe(1);
  });

  it('rejects INSERT queries', async () => {
    await expect(
      engine.query('INSERT DATA { <s> <p> <o> }'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('rejects DELETE queries', async () => {
    await expect(
      engine.query('DELETE WHERE { ?s ?p ?o }'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('rejects DROP queries', async () => {
    await expect(
      engine.query('DROP GRAPH <http://example.org>'),
    ).rejects.toThrow('SPARQL rejected');
  });

  it('view=verified-memory queries the root content graph (§16.1)', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"ImageBot"');
  });

  it('view=verified-memory unions root content graph with _verified_memory/ graphs', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/quorum-1`;
    await store.insert([
      q('urn:vm:entity:1', 'http://schema.org/name', '"Quorum Verified"', vmGraph),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    expect(names).toContain('"ImageBot"');
    expect(names).toContain('"Quorum Verified"');
  });

  it('view=verified-memory with verifiedGraph scopes to that graph only', async () => {
    const vmGraph = `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/team-a`;
    await store.insert([
      q('urn:vm:scoped:1', 'http://schema.org/name', '"Scoped Data"', vmGraph),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory', verifiedGraph: 'team-a' },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toBe('"Scoped Data"');
  });

  it('view=verified-memory excludes _meta and staging graphs', async () => {
    await store.insert([
      q('urn:vm:meta', 'http://schema.org/name', '"Meta Only"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/q1/_meta`),
      q('urn:vm:staging', 'http://schema.org/name', '"Staging Only"', `did:dkg:context-graph:${CONTEXT_GRAPH}/_verified_memory/staging/draft`),
    ]);
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'verified-memory' },
    );
    const names = result.bindings.map(r => r['name']);
    expect(names).not.toContain('"Meta Only"');
    expect(names).not.toContain('"Staging Only"');
  });

  it('view=shared-working-memory does NOT include root content graph', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { contextGraphId: CONTEXT_GRAPH, view: 'shared-working-memory' },
    );
    expect(result.bindings).toHaveLength(0);
  });

  it('view requires contextGraphId', async () => {
    await expect(
      engine.query('SELECT ?s WHERE { ?s ?p ?o }', { view: 'verified-memory' }),
    ).rejects.toThrow('requires a contextGraphId');
  });
});

describe('validateReadOnlySparql', () => {
  it('allows SELECT', () => {
    expect(validateReadOnlySparql('SELECT ?s WHERE { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows CONSTRUCT', () => {
    expect(validateReadOnlySparql('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows ASK', () => {
    expect(validateReadOnlySparql('ASK { ?s ?p ?o }').safe).toBe(true);
  });

  it('allows DESCRIBE', () => {
    expect(validateReadOnlySparql('DESCRIBE <http://example.org/x>').safe).toBe(true);
  });

  it('rejects INSERT DATA', () => {
    const result = validateReadOnlySparql('INSERT DATA { <s> <p> <o> }');
    expect(result.safe).toBe(false);
    expect(result.reason).toContain('SELECT, CONSTRUCT, ASK, or DESCRIBE');
  });

  it('rejects DELETE WHERE', () => {
    const result = validateReadOnlySparql('DELETE WHERE { ?s ?p ?o }');
    expect(result.safe).toBe(false);
  });

  it('rejects CLEAR GRAPH', () => {
    const result = validateReadOnlySparql('CLEAR GRAPH <http://example.org>');
    expect(result.safe).toBe(false);
  });

  it('rejects DROP GRAPH', () => {
    const result = validateReadOnlySparql('DROP GRAPH <http://example.org>');
    expect(result.safe).toBe(false);
  });

  it('rejects LOAD', () => {
    const result = validateReadOnlySparql('LOAD <http://example.org/data>');
    expect(result.safe).toBe(false);
  });

  it('allows comments containing mutating keywords', () => {
    const result = validateReadOnlySparql(
      '# This query does not INSERT anything\nSELECT ?s WHERE { ?s ?p ?o }',
    );
    expect(result.safe).toBe(true);
  });

  it('allows PREFIX declarations before SELECT', () => {
    const result = validateReadOnlySparql(`
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?name WHERE { ?s <http://schema.org/name> ?name }
    `);
    expect(result.safe).toBe(true);
  });

  it('allows multiple PREFIX declarations', () => {
    const result = validateReadOnlySparql(`
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      PREFIX schema: <http://schema.org/>
      SELECT ?s WHERE { ?s rdf:type schema:Person }
    `);
    expect(result.safe).toBe(true);
  });

  it('allows BASE declaration before SELECT', () => {
    const result = validateReadOnlySparql(`
      BASE <http://example.org/>
      SELECT ?s WHERE { ?s ?p ?o }
    `);
    expect(result.safe).toBe(true);
  });
});
