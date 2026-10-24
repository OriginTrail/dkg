import { afterEach, describe, expect, it, vi } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import { QueryHandler } from '../src/query-handler.js';
import { classifySparqlForm } from '../src/sparql-guard.js';
import { assertExplicitGraphIrisAllowed, requireGraphScopeRewrite, transitionGraphScope } from '../src/sparql-graph-scope.js';
import { TRUST_LEVEL_PREDICATE } from '@origintrail-official/dkg-core';
import { prepareSparql, prepareSparqlQuery } from '@origintrail-official/dkg-rdf-utils/sparql';
import { injectMinTrustFilter } from '../src/sparql-min-trust.js';
import { constrainGraphVariablesToAllowedSet, prepareGraphScope } from '../src/sparql-graph-scope.js';
import { classifyScopedContentGraph } from '../src/scoped-content-partition.js';
import { selectContentPartitions } from '../src/content-partition-policy.js';
import { ScopedContentGraphDiscoveryMemo } from '../src/scoped-content-graph-discovery-memo.js';

function prepared(source: string) {
  const result = prepareSparql(source);
  if (result.status !== 'valid') throw new Error(`Invalid lexical fixture: ${source}`);
  return result;
}

describe('minimum-trust rewriting refuses unsupported shapes', () => {
  it.each([
    'SELECT *',
    'SELECT * WHERE {',
    'SELECT * WHERE {}',
    'SELECT * WHERE { VALUES (?s) { (<urn:s>) } ?s ?p ?o }',
    'SELECT * WHERE { VALUES ?s { (<urn:s>) } ?s ?p ?o }',
    'SELECT * WHERE { VALUES ?s { { <urn:s> } } ?s ?p ?o }',
    'SELECT * WHERE { ?s ?p ?o OPTIONAL { ?s ?p2 ?o2 } }',
    'SELECT * WHERE { ?s ?p ?o MINUS { ?s ?p2 ?o2 } }',
    'SELECT * WHERE { GRAPH <urn:g> { ?s ?p ?o } }',
    'SELECT * WHERE { SERVICE <urn:remote> { ?s ?p ?o } }',
    'SELECT * WHERE { ?s ?p ?o . VALUES ?s { <urn:s> } }',
    'SELECT * WHERE { ?s ?p ?o . FILTER true . }',
    'SELECT * WHERE { ?s ?p ?o . FILTER true }',
    'SELECT * WHERE { ( <urn:s> ) ?p ?o }',
    'SELECT * WHERE { [ <urn:p> <urn:o> ] ?p ?o }',
    'SELECT * WHERE { _:anonymous ?p ?o }',
    'SELECT * WHERE { FILTER(1 = 1) }',
  ])('returns an explicit unsupported result for %s', source => {
    expect(injectMinTrustFilter(prepareSparqlQuery(prepared(source)), 2))
      .toEqual({ kind: 'unsupported', reason: 'unsupported-query-shape' });
  });

  it('preserves VALUES and filters while adding one trust requirement per distinct subject', () => {
    const source = 'PREFIX ex: <urn:> SELECT ?s WHERE { VALUES ?s { <urn:a> } ?s ex:p ?o . ?s ex:q ?q . ex:fixed ex:p ?o . <urn:other> ex:p ?o . FILTER bound(?s) }';
    const result = injectMinTrustFilter(prepareSparqlQuery(prepared(source)), 3);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('Expected a supported flat query');
    expect(result.value).toContain('VALUES ?s { <urn:a> }');
    expect(result.value).toContain('FILTER bound(?s)');
    expect(result.value.match(new RegExp(`<${TRUST_LEVEL_PREDICATE}>`, 'g'))).toHaveLength(3);
    for (const [subject, index] of [['?s', 0], ['ex:fixed', 1], ['<urn:other>', 2]] as const) {
      expect(result.value).toContain(`${subject} <${TRUST_LEVEL_PREDICATE}> ?__dkgTrust${index} .`);
      expect(result.value).toContain(`STR(?__dkgTrust${index})) >= 3`);
    }
    expect(prepareSparqlQuery(prepared(result.value)).structure.balanced).toBe(true);
  });
});

describe('graph-variable authorization rejects mixed default patterns', () => {
  it.each([
    '?x ?y ?z .', 'OPTIONAL { ?x ?y ?z }', 'MINUS { ?x ?y ?z }',
    '{ ?x ?y ?z }', 'FILTER(EXISTS { ?x ?y ?z })',
    'FILTER EXISTS { ?x ?y ?z }', 'BIND(EXISTS { ?x ?y ?z } AS ?present)',
    'SERVICE <urn:remote> { ?x ?y ?z }',
    '{ SELECT ?x WHERE { ?x ?y ?z } }',
  ])('refuses a default pattern alongside GRAPH ?g: %s', extra => {
    const scope = prepareGraphScope(prepared(`SELECT * WHERE { GRAPH ?g { ?s ?p ?o } ${extra} }`));
    expect(() => constrainGraphVariablesToAllowedSet(scope, ['urn:allowed']))
      .toThrow('cannot be mixed with default-graph triple patterns');
  });

  it.each([
    'OPTIONAL { GRAPH <urn:allowed> { ?x ?y ?z } }',
    'MINUS { GRAPH <urn:allowed> { ?x ?y ?z } }',
    'FILTER(EXISTS { GRAPH <urn:allowed> { ?x ?y ?z } })',
    'BIND(1 AS ?constant)',
    'VALUES ?other { <urn:allowed> }',
    '{ GRAPH <urn:allowed> { ?x ?y ?z } }',
  ])('permits explicitly named graph patterns while constraining ?g: %s', extra => {
    const scope = prepareGraphScope(prepared(`SELECT * WHERE { GRAPH ?g { ?s ?p ?o } ${extra} }`));
    const result = constrainGraphVariablesToAllowedSet(scope, ['urn:allowed']);
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') throw new Error('Expected a supported named-graph query');
    expect(result.value.source).toContain('VALUES ?g { <urn:allowed> }');
    expect(result.value.source).toContain(extra);
    expect(result.value.structure.balanced).toBe(true);
  });
});

describe('partition rejection and caller-local discovery failures', () => {
  const root = 'did:dkg:context-graph:boundary';
  it.each(['urn:elsewhere', `${root}/`, `${root}/bad name`, `${root}/draft`])
    ('does not classify an unrelated or malformed graph %s', graph => {
      expect(classifyScopedContentGraph(graph, 'boundary', new Set(), new Set(), new Set())).toBeUndefined();
    });

  it('matches draft owners case-insensitively and excludes other owners without changing partitions', () => {
    const partitions = [
      { graph: 'urn:one', kind: 'draft', draftOwner: '0x' + 'AbCd'.repeat(10), broadScopeEligible: true },
      { graph: 'urn:two', kind: 'draft', draftOwner: '0x' + 'EE'.repeat(20), broadScopeEligible: true },
      { graph: 'urn:ownerless', kind: 'draft', draftOwner: null, broadScopeEligible: true },
    ] as const;
    expect(selectContentPartitions(partitions, { kind: 'owners', owners: ['0x' + 'abcd'.repeat(10)] })).toEqual(['urn:one']);
    expect(selectContentPartitions(partitions, { kind: 'owners', owners: [] })).toEqual([]);
    expect(selectContentPartitions(partitions, { kind: 'all' })).toEqual(['urn:one', 'urn:two', 'urn:ownerless']);
  });

  it('does not start discovery for an already-aborted caller', async () => {
    const reason = new Error('caller cancelled');
    const load = vi.fn();
    const memo = new ScopedContentGraphDiscoveryMemo(null);
    await expect(memo.get({ contextKey: 'cg', laneKey: 'read', graphPrefix: root, signal: AbortSignal.abort(reason), load }))
      .rejects.toBe(reason);
    expect(load).not.toHaveBeenCalled();
  });

  it('shares a failed flight, propagates the original failure, and allows a fresh retry', async () => {
    const memo = new ScopedContentGraphDiscoveryMemo({ writeRevisionCoverage: 'all-writers', getWriteRevision: () => ({ generation: 1, stable: true }) });
    const failure = new Error('store unavailable');
    const value = { inventory: ['urn:recovered'], partitions: [] };
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(value);
    const request = { contextKey: 'cg', laneKey: 'read', graphPrefix: root, load };
    const first = memo.get(request);
    const second = memo.get(request);
    await Promise.all([expect(first).rejects.toBe(failure), expect(second).rejects.toBe(failure)]);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(memo.get(request)).resolves.toEqual(value);
    expect(load).toHaveBeenCalledTimes(2);
    await expect(memo.get(request)).resolves.toEqual(value);
    expect(load).toHaveBeenCalledTimes(2);
  });
});


describe('graph rewrite compatibility boundaries', () => {
  it.each([
    ['ASK {}', 'ASK'], ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', 'CONSTRUCT'],
    ['DESCRIBE <urn:s>', 'DESCRIBE'], ['SELECT * WHERE {}', 'SELECT'], ['not a query', 'SELECT'],
  ])('preserves the documented legacy classifier contract for %s', (source, form) => {
    expect(classifySparqlForm(source)).toBe(form);
  });

  it('retains scope identity on a no-op and refuses malformed Unicode after a rewrite', () => {
    const scope = prepareGraphScope(prepared('SELECT * WHERE { ?s ?p ?o }'));
    expect(transitionGraphScope(scope, scope.source)).toBe(scope);
    expect(() => transitionGraphScope(scope, String.raw`SELECT * WHERE { ?s ?p ?\uZZZZ }`))
      .toThrow('graph rewrite produced malformed SPARQL');
    expect(() => requireGraphScopeRewrite({ kind: 'unsupported', reason: 'nested-union' }))
      .toThrow('graph rewrite is unsupported: nested-union');
  });

  it('does not add a second graph constraint when declared prefixes already authorize every VALUES entry', () => {
    const source = 'PREFIX ex: <urn:> SELECT * WHERE { VALUES ?g { ex:allowed <urn:allowed> } GRAPH ?g { ?s ?p ?o } }';
    const scope = prepareGraphScope(prepared(source));
    expect(constrainGraphVariablesToAllowedSet(scope, ['urn:allowed'])).toEqual({ kind: 'ready', value: scope });
  });

  it.each(['missing:graph', 'UNDEF', '123', '<urn:forbidden>'])
    ('retains an authorization constraint for untrusted VALUES entry %s', value => {
      const scope = prepareGraphScope(prepared(`SELECT * WHERE { VALUES ?g { ${value} } GRAPH ?g { ?s ?p ?o } }`));
      const result = constrainGraphVariablesToAllowedSet(scope, ['urn:allowed']);
      expect(result.kind).toBe('ready');
      if (result.kind !== 'ready') throw new Error('Expected an explicit graph constraint');
      expect(result.value.source).toContain('VALUES ?g { <urn:allowed> }');
      expect(result.value.source).toContain(`VALUES ?g { ${value} }`);
    });
});

describe('public authority cache boundaries', () => {
  afterEach(() => { vi.useRealTimers(); });
  const request = (contextGraphId: string) => ({
    operationId: 'query-boundary', lookupType: 'ENTITY_TRIPLES' as const,
    contextGraphId, entityUri: 'urn:entity',
  });

  it('fails closed on resolver rejection, caches the refusal, and retries after expiry', async () => {
    vi.useFakeTimers();
    const store = new OxigraphStore();
    try {
      const resolver = vi.fn().mockRejectedValueOnce(new Error('chain unavailable')).mockResolvedValue(false);
      const handler = new QueryHandler(new DKGQueryEngine(store), { defaultPolicy: 'deny' }, { isContextGraphPublic: resolver });
      expect((await handler.handle(request('one'), 'peer')).status).toBe('ACCESS_DENIED');
      expect((await handler.handle(request('one'), 'peer')).status).toBe('ACCESS_DENIED');
      expect(resolver).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(60_000);
      expect((await handler.handle(request('one'), 'peer')).status).toBe('ACCESS_DENIED');
      expect(resolver).toHaveBeenCalledTimes(2);
    } finally { await store.close(); }
  });

  it('evicts the oldest authority verdict at the bounded capacity and preserves newer entries', async () => {
    const store = new OxigraphStore();
    try {
      const resolver = vi.fn(async () => false);
      const handler = new QueryHandler(new DKGQueryEngine(store), { defaultPolicy: 'deny', rateLimitPerMinute: 2_000 }, { isContextGraphPublic: resolver });
      for (let i = 0; i <= 1_000; i++) {
        expect((await handler.handle(request(`cg-${i}`), 'peer')).status).toBe('ACCESS_DENIED');
      }
      expect(resolver).toHaveBeenCalledTimes(1_001);
      expect((await handler.handle(request('cg-1000'), 'peer')).status).toBe('ACCESS_DENIED');
      expect(resolver).toHaveBeenCalledTimes(1_001);
      expect((await handler.handle(request('cg-0'), 'peer')).status).toBe('ACCESS_DENIED');
      expect(resolver).toHaveBeenCalledTimes(1_002);
    } finally { await store.close(); }
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])
    ('combines ASK results from data=%s and shared-memory=%s', async (data, shared) => {
      const store = new OxigraphStore();
      try {
        const graph = 'did:dkg:context-graph:combined';
        for (const target of [...(data ? [graph] : []), ...(shared ? [`${graph}/_shared_memory`] : [])]) {
          await store.insert([{ subject: 'urn:s', predicate: 'urn:p', object: 'urn:o', graph: target }]);
        }
        const engine = new DKGQueryEngine(store);
        expect(await engine.query('ASK { <urn:s> <urn:p> <urn:o> }', { contextGraphId: 'combined', includeSharedMemory: true }))
          .toEqual({ bindings: [{ result: String(data || shared) }] });
      } finally { await store.close(); }
    });
});


describe('invalid query options and explicit graph targets', () => {
  it.each([
    ['GRAPH missing:name {}', 'cannot be resolved from PREFIX declarations'],
    ['GRAPH 123 {}', 'GRAPH target must be a variable, explicit IRI, or resolvable prefixed name'],
  ])('rejects an unresolved graph target %s', (graph, error) => {
    const scope = prepareGraphScope(prepared(`SELECT * WHERE { ${graph} }`));
    expect(() => assertExplicitGraphIrisAllowed(scope, ['urn:allowed'])).toThrow(error);
  });

  it('returns an unsupported result for a GRAPH variable without a WHERE group', () => {
    const scope = prepareGraphScope(prepared('SELECT * GRAPH ?g'));
    expect(constrainGraphVariablesToAllowedSet(scope, ['urn:allowed']))
      .toEqual({ kind: 'unsupported', reason: 'missing-where' });
  });

  it.each([-1, 4, 0.5, NaN, Infinity])('rejects an invalid numeric trust level %s', async minTrust => {
    const store = new OxigraphStore();
    try {
      const engine = new DKGQueryEngine(store);
      await expect(engine.query('SELECT * WHERE { ?s ?p ?o }', {
        contextGraphId: 'boundary', view: 'verifiable-memory', minTrust,
      })).rejects.toThrow('must be one of TrustLevel');
    } finally { await store.close(); }
  });

  it('rejects an invalid subgraph name before executing a query', async () => {
    const store = new OxigraphStore();
    try {
      await expect(new DKGQueryEngine(store).query('SELECT * WHERE { ?s ?p ?o }', {
        contextGraphId: 'boundary', subGraphName: 'bad name',
      })).rejects.toThrow('Invalid sub-graph name for query');
    } finally { await store.close(); }
  });
});
