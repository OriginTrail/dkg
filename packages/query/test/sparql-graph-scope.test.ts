import { describe, expect, it } from 'vitest';
import { OxigraphStore, type Quad } from '@origintrail-official/dkg-storage';
import {
  contextGraphDataUri,
  contextGraphSharedMemoryUri,
  contextGraphVerifiableMemoryUri,
} from '@origintrail-official/dkg-core';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import {
  materializeGraphScopeForExecution,
  prepareGraphScope,
  rewriteGraphSet,
  wrapWithGraph,
  wrapWithGraphValues,
} from '../src/sparql-graph-scope.js';

const CG = 'qa-extra-cg';

function quad(subject: string, predicate: string, object: string, graph: string): Quad {
  return { subject, predicate, object, graph };
}

describe('prepared SPARQL graph scope', () => {
  it('accepts the canonical lexical artifact as its sole source owner', () => {
    const prepared = prepareSparql('SELECT * WHERE { GRAPH <urn:g> { ?s ?p ?o } }');
    const scope = prepareGraphScope(prepared);

    expect(scope.prepared).toBe(prepared);
    expect(scope.source).toBe(prepared.source);
    expect(scope.graphTargets).toEqual([
      expect.objectContaining({ kind: 'iri', iri: 'urn:g' }),
    ]);
  });

  it('keeps no-op graph rewrites byte-identical and materializes syntax only for execution', () => {
    const source = String.raw`SELECT ?s WHERE \u007B GRAPH <urn:g> \u007B ?s <urn:p> "\u007B" \u007D \u007D`;
    const scope = prepareGraphScope(source);

    const rewrite = wrapWithGraph(scope, 'urn:other');
    expect(rewrite.kind).toBe('ready');
    if (rewrite.kind !== 'ready') throw new Error('expected graph rewrite to be ready');
    expect(rewrite.value).toBe(scope);
    expect(scope.source).toBe(source);
    expect(materializeGraphScopeForExecution(scope)).toBe(
      String.raw`SELECT ?s WHERE { GRAPH <urn:g> { ?s <urn:p> "\u007B" } }`,
    );
  });

  it('returns typed reasons and preserves canonical graph-set fallbacks', () => {
    const malformed = rewriteGraphSet(
      prepareGraphScope('SELECT * WHERE { ?s ?p ?o'),
      ['urn:g1', 'urn:g2'],
      'values-union',
    );
    expect(malformed).toMatchObject({ kind: 'unsupported', reason: 'missing-where' });

    const nestedUnion = rewriteGraphSet(
      prepareGraphScope('SELECT * WHERE { { ?s <urn:p> ?o } UNION { ?s <urn:q> ?o } }'),
      ['urn:g1', 'urn:g2'],
      'values-union',
    );
    expect(nestedUnion).toMatchObject({ kind: 'unsupported', reason: 'nested-union' });

    const collisionScope = prepareGraphScope(
      'SELECT ?__dkgViewGraph ?s WHERE { ?s <urn:p> ?o }',
    );
    expect(wrapWithGraphValues(collisionScope, ['urn:g1', 'urn:g2']))
      .toMatchObject({ kind: 'unsupported', reason: 'helper-variable-collision' });
    const collisionFallback = rewriteGraphSet(
      collisionScope,
      ['urn:g1', 'urn:g2'],
      'values-union',
    );
    expect(collisionFallback.kind).toBe('ready');

    const graphlessDescribe = rewriteGraphSet(
      prepareGraphScope('DESCRIBE <urn:s> LIMIT 10'),
      ['urn:g1', 'urn:g2'],
      'union-only',
    );
    expect(graphlessDescribe.kind).toBe('ready');
    if (graphlessDescribe.kind !== 'ready') {
      throw new Error('expected graphless DESCRIBE rewrite to be ready');
    }
    expect(graphlessDescribe.value.source).toContain('FROM <urn:g1> FROM <urn:g2>');
  });

  it('prepares graph targets as payload-complete discriminated variants', () => {
    const [iriTarget, variableTarget, invalidTarget] = prepareGraphScope(
      'SELECT * WHERE { GRAPH <urn:allowed> { ?s ?p ?o } '
        + 'GRAPH ?g { ?s ?p ?o } GRAPH missing:name { ?s ?p ?o } }',
    ).graphTargets;

    expect(iriTarget.kind).toBe('iri');
    if (iriTarget.kind !== 'iri') throw new Error('expected IRI graph target');
    expect(iriTarget.iri).toBe('urn:allowed');
    expect('variable' in iriTarget).toBe(false);

    expect(variableTarget.kind).toBe('variable');
    if (variableTarget.kind !== 'variable') throw new Error('expected variable graph target');
    expect(variableTarget.variable).toEqual({ source: '?g', logicalName: 'g' });
    expect('iri' in variableTarget).toBe(false);

    expect(invalidTarget.kind).toBe('invalid');
    expect('iri' in invalidTarget).toBe(false);
    expect('variable' in invalidTarget).toBe(false);
  });
});

describe('graph-scope engine integration', () => {
  it('keeps an adjacent fragment IRI inside the requested context graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const requestedGraph = contextGraphDataUri(CG);
    const otherGraph = contextGraphDataUri('other-cg');
    const predicate = 'http://example.com/p#name';
    await store.insert([
      quad('urn:requested', predicate, '"Requested"', requestedGraph),
      quad('urn:other', predicate, '"Other"', otherGraph),
    ]);

    const result = await engine.query(
      'SELECT ?o WHERE{?s<http://example.com/p#name>?o}',
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ o: '"Requested"' }]);
  });

  it('rejects a scoped query when its graph wrapper cannot prove the WHERE boundary', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    await expect(engine.query(
      'SELECT ?o WHERE { ?s <http://example.com/p#name> ?o',
      { contextGraphId: CG },
    )).rejects.toThrow(
      /Scoped query violation: unable to locate (?:a graph-scopable WHERE block|the end of the scoped WHERE block)/,
    );
  });

  it.each([
    ['GRAPH', '\r'],
    ['FROM', '\r'],
    ['GRAPH', String.raw`\u000D`],
    ['FROM', String.raw`\u000D`],
  ])('rejects %s hidden after a %s comment boundary before store dispatch', async (
    clause,
    commentBoundary,
  ) => {
    const store = new OxigraphStore();
    const originalQuery = store.query.bind(store);
    let queryCalls = 0;
    store.query = async (...args) => {
      queryCalls++;
      return originalQuery(...args);
    };
    const engine = new DKGQueryEngine(store);
    const hidden = clause === 'GRAPH'
      ? 'WHERE { GRAPH <urn:private> { ?s <urn:p> ?o } }'
      : 'FROM <urn:private> WHERE { ?s <urn:p> ?o }';

    await expect(engine.query(
      `SELECT ?o # decoy${commentBoundary}${hidden}`,
      { contextGraphId: CG },
    )).rejects.toThrow(/Scoped query violation/);
    expect(queryCalls).toBe(0);
  });

  it('scopes graphless DESCRIBE with LIMIT to the requested context graph', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Requested"', contextGraphDataUri(CG)),
      quad('urn:a', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      'DESCRIBE <urn:a> LIMIT 10',
      { contextGraphId: CG },
    );

    expect(result.quads?.map((value) => value.object)).toEqual(['"Requested"']);
  });

  it('scopes graphless DESCRIBE with LIMIT across every authorized view graph only', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Root"', contextGraphDataUri(CG)),
      quad(
        'urn:a',
        'urn:p',
        '"Verified"',
        contextGraphVerifiableMemoryUri(CG, 'describe-multi'),
      ),
      quad('urn:a', 'urn:p', '"Foreign"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      'DESCRIBE <urn:a> LIMIT 10',
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(result.quads?.map((value) => value.object).sort())
      .toEqual(['"Root"', '"Verified"']);
  });

  it('does not alias a UCHAR-spelled caller variable to the dedup helper', async () => {
    const store = new OxigraphStore();
    const originalQuery = store.query.bind(store);
    const queries: string[] = [];
    store.query = async (...args) => {
      queries.push(args[0]);
      return originalQuery(...args);
    };
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:root', 'urn:p', '"Root"', contextGraphDataUri(CG)),
      quad(
        'urn:verified',
        'urn:p',
        '"Verified"',
        contextGraphVerifiableMemoryUri(CG, 'variable-collision'),
      ),
    ]);

    const equivalent = await engine.query(
      'SELECT ?s WHERE { ?s <urn:p> ?callerValue }',
      { contextGraphId: CG, view: 'verifiable-memory' },
    );
    queries.length = 0;
    const escaped = await engine.query(
      String.raw`SELECT ?s WHERE { ?s <urn:p> ?\u005F_dkgDedupGraph }`,
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(escaped.bindings.map((binding) => binding['s']).sort())
      .toEqual(equivalent.bindings.map((binding) => binding['s']).sort());
    expect(escaped.bindings.every((binding) => Object.keys(binding).join() === 's')).toBe(true);
    expect(queries.some((query) => query.includes('VALUES (?__dkgDedupGraph'))).toBe(false);
  });

  it('does not alias a UCHAR-spelled caller variable to the view helper', async () => {
    const store = new OxigraphStore();
    const originalQuery = store.query.bind(store);
    const queries: string[] = [];
    store.query = async (...args) => {
      queries.push(args[0]);
      return originalQuery(...args);
    };
    const engine = new DKGQueryEngine(store);
    const swmRoot = contextGraphSharedMemoryUri(CG);
    await store.insert([
      quad('urn:first', 'urn:p', '"First"', `${swmRoot}/0xagent/1`),
      quad('urn:second', 'urn:p', '"Second"', `${swmRoot}/0xagent/2`),
    ]);

    const equivalent = await engine.query(
      'SELECT ?s WHERE { ?s <urn:p> ?callerValue }',
      { contextGraphId: CG, view: 'shared-working-memory' },
    );
    queries.length = 0;
    const escaped = await engine.query(
      String.raw`SELECT ?s WHERE { ?s <urn:p> ?\u005F_dkgViewGraph }`,
      { contextGraphId: CG, view: 'shared-working-memory' },
    );

    expect(escaped.bindings.map((binding) => binding['s']).sort())
      .toEqual(equivalent.bindings.map((binding) => binding['s']).sort());
    expect(escaped.bindings.every((binding) => Object.keys(binding).join() === 's')).toBe(true);
    expect(queries.some((query) => query.includes('VALUES ?__dkgViewGraph'))).toBe(false);
  });

  it('scopes a single graph when the WHERE braces use UCHAR source spans', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Requested"', contextGraphDataUri(CG)),
      quad('urn:a', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?o WHERE \u007B ?s <urn:p> ?o \u007D`,
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ o: '"Requested"' }]);
  });

  it('scopes multiple view graphs when the WHERE braces use UCHAR source spans', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    await store.insert([
      quad('urn:a', 'urn:p', '"Root"', contextGraphDataUri(CG)),
      quad(
        'urn:b',
        'urn:p',
        '"Verified"',
        contextGraphVerifiableMemoryUri(CG, 'encoded-braces'),
      ),
      quad('urn:c', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?o WHERE \u007B ?s <urn:p> ?o \u007D`,
      { contextGraphId: CG, view: 'verifiable-memory' },
    );

    expect(result.bindings.map((binding) => binding['o']).sort())
      .toEqual(['"Root"', '"Verified"']);
  });

  it('constrains GRAPH variables when group braces use UCHAR source spans', async () => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);
    const requestedGraph = contextGraphDataUri(CG);
    await store.insert([
      quad('urn:a', 'urn:p', '"Requested"', requestedGraph),
      quad('urn:b', 'urn:p', '"Other"', contextGraphDataUri('other-cg')),
    ]);

    const result = await engine.query(
      String.raw`SELECT ?g ?o WHERE \u007B GRAPH ?g \u007B ?s <urn:p> ?o \u007D \u007D`,
      { contextGraphId: CG },
    );

    expect(result.bindings).toEqual([{ g: requestedGraph, o: '"Requested"' }]);
  });
});
