import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

const CG = 'finalization-chain-e2e';
const ROOT = `did:dkg:context-graph:${CG}`;
const PER_CGID = `${ROOT}/context/7`;
const VM = `${ROOT}/_verifiable_memory/0xAA/1`;
const ENTITY = 'urn:finalization-chain:entity:1';
const NAME = 'http://schema.org/name';
const TYPE = 'http://schema.org/additionalType';

function q(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

const NAME_QUERY = `SELECT ?name WHERE { <${ENTITY}> <${NAME}> ?name }`;

describe('verifiable-memory read-both deduplicates mirrored triples (#1270)', () => {
  it('collapses an identical triple mirrored between root and per-KA VM', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const triple = q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT);
    await store.insert([triple, { ...triple, graph: VM }]);

    const result = await engine.query(NAME_QUERY, { contextGraphId: CG });

    expect(result.bindings).toEqual([{ name: '"Finalization Chain Draft"' }]);
  });

  it('preserves SELECT bag multiplicity for distinct triples with the same projection', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const name = q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT);
    await store.insert([
      name,
      q(ENTITY, TYPE, '"Document"', ROOT),
      { ...name, graph: VM },
    ]);

    const result = await engine.query(
      `SELECT ?s WHERE { ?s ?p ?o . FILTER(?s = <${ENTITY}>) }`,
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ s: ENTITY }, { s: ENTITY }]);
  });

  it('preserves mappings that differ by an OPTIONAL binding in a later VM graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const name = q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT);
    await store.insert([
      name,
      { ...name, graph: VM },
      q(ENTITY, TYPE, '"Document"', VM),
    ]);

    const result = await engine.query(
      `SELECT ?name ?type WHERE {
        <${ENTITY}> <${NAME}> ?name .
        OPTIONAL { <${ENTITY}> <${TYPE}> ?type }
      }`,
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(result.bindings).toHaveLength(2);
    expect(result.bindings.filter((binding) => binding['type'] === undefined)).toHaveLength(1);
    expect(result.bindings.filter((binding) => binding['type'] === '"Document"')).toHaveLength(1);
  });

  it('actually reads and deduplicates the per-cgId graph in VM view routing', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const triple = q(ENTITY, NAME, '"Finalization Chain Draft"', ROOT);
    await store.insert([triple, { ...triple, graph: PER_CGID }]);

    const result = await engine.query(NAME_QUERY, {
      contextGraphId: CG,
      view: 'verifiable-memory',
    });

    expect(result.bindings).toEqual([{ name: '"Finalization Chain Draft"' }]);
  });

  it('deduplicates a per-cgId and per-KA mirror when the root graph is empty', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const triple = q(ENTITY, NAME, '"Finalization Chain Draft"', PER_CGID);
    await store.insert([triple, { ...triple, graph: VM }]);

    const result = await engine.query(NAME_QUERY, {
      contextGraphId: CG,
      view: 'verifiable-memory',
    });

    expect(result.bindings).toEqual([{ name: '"Finalization Chain Draft"' }]);
  });
});
