import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphStore, type Quad } from '@dkg/storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { validateReadOnlySparql } from '../src/sparql-guard.js';

const PARANET = 'agent-registry';
const GRAPH = `did:dkg:paranet:${PARANET}`;
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

  it('queries paranet-scoped data', async () => {
    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET },
    );
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]['name']).toContain('ImageBot');
  });

  it('returns all triples for entity', async () => {
    const result = await engine.query(
      `SELECT ?s ?p ?o WHERE { ?s ?p ?o }`,
      { paranetId: PARANET },
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
        object: `did:dkg:paranet:${PARANET}`,
        graph: META,
      },
    ]);

    const result = await engine.resolveKA(ual);
    expect(result.rootEntity).toBe(ENTITY);
    expect(result.paranetId).toBe(PARANET);
    expect(result.quads.length).toBeGreaterThanOrEqual(2);
  });

  it('throws on unknown UAL', async () => {
    await expect(engine.resolveKA('did:dkg:mock:9999/99')).rejects.toThrow(
      'KA not found',
    );
  });

  it('queries across all paranets', async () => {
    // Add data to another paranet
    await store.insert([
      q('did:dkg:agent:QmTextBot', 'http://schema.org/name', '"TextBot"', 'did:dkg:paranet:text-tools'),
    ]);

    const result = await engine.queryAllParanets(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
    );
    expect(result.bindings.length).toBe(2);
  });

  it('queries workspace graph when graphSuffix is _workspace', async () => {
    const workspaceGraph = `did:dkg:paranet:${PARANET}/_workspace`;
    await store.insert([
      q('urn:ws:entity:1', 'http://schema.org/name', '"Workspace Only"', workspaceGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, graphSuffix: '_workspace' },
    );
    expect(result.bindings.length).toBe(1);
    expect(result.bindings[0]['name']).toContain('Workspace Only');
  });

  it('queries union of data and workspace when includeWorkspace is true', async () => {
    const workspaceGraph = `did:dkg:paranet:${PARANET}/_workspace`;
    await store.insert([
      q('urn:ws:entity:union', 'http://schema.org/name', '"In Workspace"', workspaceGraph),
    ]);

    const result = await engine.query(
      'SELECT ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, includeWorkspace: true },
    );
    const names = result.bindings.map((r) => String(r['name']));
    expect(names.some((n) => n.includes('ImageBot'))).toBe(true);
    expect(names.some((n) => n.includes('In Workspace'))).toBe(true);
    expect(result.bindings.length).toBe(2);
  });

  it('dedupes duplicate rows when includeWorkspace returns same binding from data and workspace', async () => {
    const workspaceGraph = `did:dkg:paranet:${PARANET}/_workspace`;
    await store.insert([
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', GRAPH),
      q('urn:dup:entity:1', 'http://schema.org/name', '"Duplicate"', workspaceGraph),
    ]);

    const result = await engine.query(
      'SELECT ?s ?name WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, includeWorkspace: true },
    );

    const duplicates = result.bindings.filter((row) =>
      row['s'] === 'urn:dup:entity:1' && String(row['name']).includes('Duplicate'),
    );
    expect(duplicates.length).toBe(1);
  });

  it('dedupes duplicate quads for includeWorkspace CONSTRUCT queries', async () => {
    const workspaceGraph = `did:dkg:paranet:${PARANET}/_workspace`;
    await store.insert([
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', GRAPH),
      q('urn:dup:quad:1', 'http://schema.org/name', '"QuadDup"', workspaceGraph),
    ]);

    const result = await engine.query(
      'CONSTRUCT { ?s <http://schema.org/name> ?name } WHERE { ?s <http://schema.org/name> ?name }',
      { paranetId: PARANET, includeWorkspace: true },
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
