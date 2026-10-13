import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

describe('opt-in Working Memory default dataset', () => {
  const cg = '0x1111111111111111111111111111111111111111/jpb-data';
  const owner = '0x1111111111111111111111111111111111111111';
  const root = `did:dkg:context-graph:${cg}`;
  const wm = `${root}/_working_memory/${owner}`;
  const name = 'http://schema.org/name';
  const link = 'urn:test:hasOrder';
  const options = { contextGraphId: cg, agentAddress: owner, view: 'working-memory' as const,
    includeContextGraphPartitions: true };
  const join = `SELECT DISTINCT ?name WHERE { <urn:test:monitor> <${link}> ?order . ?order <${name}> ?name } ORDER BY ?name`;
  let store: OxigraphStore;
  let engine: DKGQueryEngine;
  beforeEach(async () => {
    store = new OxigraphStore(); engine = new DKGQueryEngine(store);
    const quad = (subject: string, predicate: string, object: string, graph: string) => ({ subject, predicate, object, graph });
    await store.insert([
      quad('urn:test:monitor', link, 'urn:test:order:1', `${wm}/1`),
      quad('urn:test:monitor', link, 'urn:test:order:2', `${wm}/1`),
      quad('urn:test:order:1', name, '"A"', `${wm}/2`),
      quad('urn:test:order:2', name, '"B"', `${wm}/3`),
      // DISTINCT must also deduplicate an identical fact stored in two KAs.
      quad('urn:test:order:1', name, '"A"', `${wm}/3`),
      quad('urn:test:order:1', name, '"FOREIGN CG"', `${root}-foreign/_working_memory/${owner}/1`),
      quad('urn:test:order:1', name, '"OTHER AGENT"', `${root}/_working_memory/0x2222222222222222222222222222222222222222/1`),
      quad('urn:test:order:1', name, '"SWM"', `${root}/_shared_memory`),
      quad('urn:test:order:1', name, '"VM"', `${root}/_verifiable_memory/1`),
      quad('urn:test:order:1', name, '"META"', `${root}/_meta`),
      quad('urn:test:order:1', name, '"PRIVATE"', `${root}/_private`),
    ]);
  });
  afterEach(async () => { await store.close(); });
  it('joins KAs with DISTINCT and paginates only authorized WM content', async () => {
    expect((await engine.query(join, options)).bindings).toEqual([{ name: '"A"' }, { name: '"B"' }]);
    expect((await engine.query(join + ' LIMIT 1 OFFSET 1', options)).bindings).toEqual([{ name: '"B"' }]);
  });
  it('supports OPTIONAL and NOT EXISTS across partitions', async () => {
    const query = `SELECT ?order WHERE { <urn:test:monitor> <${link}> ?order .
      OPTIONAL { ?order <${name}> ?name }
      FILTER NOT EXISTS { ?order <${name}> "A" } }`;
    expect((await engine.query(query, options)).bindings).toEqual([{ order: 'urn:test:order:2' }]);
  });
  it('preserves ASK, CONSTRUCT and optional WHERE forms', async () => {
    expect((await engine.query(`ASK { <urn:test:monitor> <${link}> ?o . ?o <${name}> "B" }`, options)).bindings)
      .toEqual([{ result: 'true' }]);
    const result = await engine.query(`CONSTRUCT { ?o <${name}> ?n } WHERE { <urn:test:monitor> <${link}> ?o . ?o <${name}> ?n }`, options);
    expect(result.quads).toHaveLength(2);
    expect((await engine.query(`SELECT DISTINCT ("WHERE in string" AS ?literal) ?name { <urn:test:monitor> <${link}> ?o . ?o <${name}> ?name }`, options)).bindings).toHaveLength(2);
  });
  it('keeps legacy per-KA behavior without the opt-in', async () => {
    expect((await engine.query(join, { ...options, includeContextGraphPartitions: false })).bindings).toEqual([]);
  });
  it('rejects caller datasets and foreign explicit GRAPH targets', async () => {
    await expect(engine.query(`SELECT ?s FROM <${root}-foreign> WHERE { ?s ?p ?o }`, options)).rejects.toThrow('FROM');
    await expect(engine.query(`SELECT ?s WHERE { GRAPH <${root}-foreign> { ?s ?p ?o } }`, options)).rejects.toThrow('allowed graph set');
  });
  it('keeps by-name WM reads pinned to one KA', async () => {
    expect((await engine.query(join, { ...options, assertionName: 'missing' })).bindings).toEqual([]);
  });
});
