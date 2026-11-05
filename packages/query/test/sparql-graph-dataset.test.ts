import { describe, expect, it, vi } from 'vitest';
import { ChangelogStore, OxigraphStore } from '@origintrail-official/dkg-storage';
import { materializePreparedSparql, prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { resolveQueryReadPlan } from '../src/query-read-plan.js';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';
import {
  hasNestedSelect,
  hasRepeatedPath,
  planGraphDataset,
  withDatasetClauses,
} from '../src/sparql-graph-dataset.js';
import {
  constrainGraphVariablesToAllowedSet,
  prepareGraphScope,
  requireGraphScopeRewrite,
  rewriteGraphRoute,
  rewriteGraphSet,
  rewriteSingleGraph,
  wrapWithDeduplicatedGraphValues,
  wrapWithGraphValues,
} from '../src/sparql-graph-scope.js';

const graphs = ['urn:g:1', 'urn:g:2'];
const NAMED = 'FROM NAMED <urn:g:1> FROM NAMED <urn:g:2>';
const DEFAULT = 'FROM <urn:g:1> FROM <urn:g:2>';

function scope(source: string) {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('Expected valid test input');
  return prepareGraphScope(prepared);
}

const ready = (result: ReturnType<typeof rewriteGraphSet>) => materializePreparedSparql(requireGraphScopeRewrite(result).prepared);

describe('hasRepeatedPath', () => {
  it.each([
    'SELECT * WHERE { ?s <urn:p>+ ?o }',
    'SELECT * WHERE { ?s <urn:p>* ?o }',
    'SELECT * WHERE { ?s <urn:p>? ?o }',
    'PREFIX e: <urn:> SELECT * WHERE { ?s e:p+ ?o }',
    'PREFIX : <urn:> SELECT * WHERE { ?s :p* ?o }',
    'SELECT * WHERE { ?s a+ ?o }',
    'SELECT * WHERE { ?s (<urn:a>/<urn:b>)+ ?o }',
    'SELECT * WHERE { ?s (<urn:a>|<urn:b>)* ?o }',
    'SELECT * WHERE { ?s ^<urn:p>+ ?o }',
    'SELECT * WHERE { ?s !<urn:p>+ ?o }',
    'SELECT * WHERE { ?s !(<urn:a>|<urn:b>)+ ?o }',
    'SELECT * WHERE { ?s <urn:a>/<urn:b>* ?o }',
    'SELECT ?s WHERE { ?s <urn:q> ?x FILTER EXISTS { ?s <urn:p>+ ?o } }',
    'ASK { <urn:s> <urn:p>* <urn:o> }',
    String.raw`SELECT * WHERE { ?s <urn:p>\u002B ?o }`,
    'SELECT * WHERE { ?s <urn:p> # note\n + ?o }',
  ])('finds a repeat in %s', (query) => {
    expect(hasRepeatedPath(scope(query))).toBe(true);
  });

  it.each([
    'SELECT * WHERE { ?s ?p ?o }',
    'SELECT (COUNT(*) AS ?c) WHERE { ?s ?p ?o }',
    'SELECT * WHERE { ?s <urn:a>/<urn:b> ?o }',
    'SELECT * WHERE { ?s <urn:a>|<urn:b> ?o }',
    'SELECT * WHERE { ?s ^<urn:a> ?o }',
    'SELECT * WHERE { ?s !<urn:a> ?o }',
    'SELECT * WHERE { ?s <urn:p>?o }',
    'SELECT * WHERE { ?s <urn:a+b> ?o }',
    'SELECT * WHERE { ?s <urn:p> "a+" }',
    'SELECT * WHERE { ?s <urn:p> ?o } # <urn:p>+',
    'SELECT * WHERE { ?s <urn:p> ?n FILTER(?n + 1 > 2) }',
  ])('finds no repeat in %s', (query) => {
    expect(hasRepeatedPath(scope(query))).toBe(false);
  });
});

describe('hasNestedSelect', () => {
  it.each([
    'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }',
    'SELECT ?s WHERE { ?s ?p ?o FILTER EXISTS { { SELECT ?x WHERE { ?x ?p ?o } } } }',
    'ASK { { SELECT ?s WHERE { ?s ?p ?o } } }',
    'SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x }',
    String.raw`SELECT ?s WHERE { { S\u0045LECT ?s WHERE { ?s ?p ?o } } }`,
    'PREFIX e: <urn:> SELECT ?s WHERE { { SELECT ?s WHERE { ?s e:p ?o } } }',
  ])('finds one in %s', (query) => {
    expect(hasNestedSelect(scope(query))).toBe(true);
  });

  it.each([
    'SELECT ?s WHERE { ?s ?p ?o }',
    'SELECT ?s WHERE { ?s <urn:p> "SELECT" }',
    'SELECT ?s WHERE { ?s ?p ?o } # SELECT',
    'PREFIX SELECT: <urn:> SELECT ?s WHERE { ?s SELECT:p ?o }',
  ])('finds none in %s', (query) => {
    expect(hasNestedSelect(scope(query))).toBe(false);
  });
});

describe('planGraphDataset', () => {
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', 'none', 'guard'],
    ['SELECT ?s WHERE { ?s <urn:p>+ ?o }', 'none', 'dataset-only'],
    ['SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', 'dataset-only', 'dataset-only'],
    ['ASK { ?s <urn:p>* ?o }', 'none', 'dataset-only'],
    ['CONSTRUCT { ?s ?p ?o } WHERE { { SELECT ?s ?p ?o WHERE { ?s ?p ?o } } }', 'dataset-only', 'dataset-only'],
    ['DESCRIBE ?s WHERE { ?s ?p ?o }', 'none', 'describe'],
    ['DESCRIBE <urn:s>', 'none', 'describe'],
    ['DESCRIBE ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', 'dataset-only', 'describe'],
  ] as const)('%s takes %s on Oxigraph and %s elsewhere', (query, oxigraph, other) => {
    expect(planGraphDataset(scope(query), 'oxigraph')).toBe(oxigraph);
    expect(planGraphDataset(scope(query), null)).toBe(other);
  });
});

describe('withDatasetClauses', () => {
  it.each([
    ['SELECT ?s WHERE { ?s ?p ?o }', `SELECT ?s ${NAMED} WHERE { ?s ?p ?o }`],
    ['SELECT ?s { ?s ?p ?o }', `SELECT ?s ${NAMED} { ?s ?p ?o }`],
    ['SELECT ?s{ ?s ?p ?o }', `SELECT ?s ${NAMED} { ?s ?p ?o }`],
    ['select distinct ?s where { ?s ?p ?o }', `select distinct ?s ${NAMED} where { ?s ?p ?o }`],
    ['SELECT (EXISTS { ?a ?b ?c } AS ?x) WHERE { ?s ?p ?o }', `SELECT (EXISTS { ?a ?b ?c } AS ?x) ${NAMED} WHERE { ?s ?p ?o }`],
    ['ASK { ?s ?p ?o }', `ASK ${NAMED} { ?s ?p ?o }`],
    ['ASK WHERE { ?s ?p ?o }', `ASK ${NAMED} WHERE { ?s ?p ?o }`],
    ['CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', `CONSTRUCT { ?s ?p ?o } ${NAMED} WHERE { ?s ?p ?o }`],
    ['CONSTRUCT { ?s ?p ?o } { ?s ?p ?o }', `CONSTRUCT { ?s ?p ?o } ${NAMED} { ?s ?p ?o }`],
    ['CONSTRUCT WHERE { ?s ?p ?o }', `CONSTRUCT ${NAMED} WHERE { ?s ?p ?o }`],
    ['DESCRIBE ?s WHERE { ?s ?p ?o }', `DESCRIBE ?s ${NAMED} WHERE { ?s ?p ?o }`],
    ['SELECT ?s WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x }', `SELECT ?s ${NAMED} WITH { SELECT ?s WHERE { ?s ?p ?o } } AS %x WHERE { INCLUDE %x }`],
    ['PREFIX e: <urn:> SELECT ?s # note\nWHERE { ?s e:p ?o }', `PREFIX e: <urn:> SELECT ?s # note\n${NAMED} WHERE { ?s e:p ?o }`],
    ['SELECT ?s { ?s ?p ?o } ORDER BY (EXISTS { ?a ?b ?c })', `SELECT ?s ${NAMED} { ?s ?p ?o } ORDER BY (EXISTS { ?a ?b ?c })`],
  ])('places the clauses in %s', (query, expected) => {
    expect(withDatasetClauses(scope(query), graphs, 'FROM NAMED')).toBe(expected);
  });

  it('writes each graph once', () => {
    expect(withDatasetClauses(scope('DESCRIBE ?s WHERE { ?s ?p ?o }'), [...graphs, ...graphs], 'FROM'))
      .toBe(`DESCRIBE ?s ${DEFAULT} WHERE { ?s ?p ?o }`);
  });

  it.each([
    ['DESCRIBE <urn:s>', `DESCRIBE <urn:s> ${DEFAULT} `],
    ['DESCRIBE <urn:s> LIMIT 1', `DESCRIBE <urn:s> ${DEFAULT} LIMIT 1`],
    ['DESCRIBE ?s VALUES ?s { <urn:s> }', `DESCRIBE ?s ${DEFAULT} VALUES ?s { <urn:s> }`],
  ])('uses the same dataset writer for graphless %s', (query, expected) => {
    expect(withDatasetClauses(scope(query), graphs, 'FROM')).toBe(expected);
  });

  it('refuses a graph IRI that could break out of its brackets', () => {
    expect(() => withDatasetClauses(scope('SELECT ?s WHERE { ?s ?p ?o }'), ['urn:g> } #'], 'FROM NAMED')).toThrow();
  });
});

describe('rewriteGraphSet with a known and an unknown engine', () => {
  const flat = 'SELECT ?s ?o WHERE { ?s <urn:p> ?o }';

  it('leaves a flat Oxigraph read exactly as it was', () => {
    expect(ready(rewriteGraphSet(scope(flat), graphs, 'deduplicated-values-union', 'oxigraph')))
      .toBe(ready(wrapWithDeduplicatedGraphValues(scope(flat), graphs)));
    expect(ready(rewriteGraphSet(scope(flat), graphs, 'values-union', 'oxigraph')))
      .toBe(ready(wrapWithGraphValues(scope(flat), graphs)));
  });

  it('leaves an Oxigraph path read exactly as it was', () => {
    const path = 'SELECT ?s ?o WHERE { ?s <urn:p>+ ?o }';
    expect(ready(rewriteGraphSet(scope(path), graphs, 'values-union', 'oxigraph')))
      .toBe(ready(wrapWithGraphValues(scope(path), graphs)));
  });

  it('keeps the rewrite on a flat read and adds the dataset on an unknown engine', () => {
    const text = ready(rewriteGraphSet(scope(flat), graphs, 'deduplicated-values-union', null));
    expect(text).toContain(`SELECT ?s ?o ${DEFAULT} ${NAMED} WHERE`);
    expect(text).toContain('VALUES');
    expect(text.replace(`${DEFAULT} ${NAMED} `, '')).toBe(ready(wrapWithDeduplicatedGraphValues(scope(flat), graphs)));
  });

  it.each([
    ['a nested SELECT on an unknown engine', 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', null],
    ['a nested SELECT on Oxigraph', 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }', 'oxigraph'],
  ] as const)('lets the dataset alone select graphs for %s', (_name, query, engine) => {
    const text = ready(rewriteGraphSet(scope(query), graphs, 'deduplicated-values-union', engine));
    expect(text).toContain(NAMED);
    expect(text).toContain('GRAPH ?__dkgViewGraph');
    expect(text).not.toContain('VALUES');
  });

  it('preserves mirror suppression and hidden-path multiplicity on the dataset route', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        ...graphs.map(graph => ({ subject: 'urn:s', predicate: 'urn:p', object: 'urn:m1', graph })),
        ...graphs.map(graph => ({ subject: 'urn:m1', predicate: 'urn:q', object: 'urn:o', graph })),
        { subject: 'urn:s', predicate: 'urn:p', object: 'urn:m2', graph: graphs[0] },
        { subject: 'urn:m2', predicate: 'urn:q', object: 'urn:o', graph: graphs[0] },
      ]);
      const query = (text: string) => store.query(ready(rewriteGraphSet(scope(text), graphs, 'deduplicated-values-union', null)));
      expect((await query('SELECT ?s WHERE { ?s <urn:p>+ ?o }')).bindings).toEqual([{ s: 'urn:s' }, { s: 'urn:s' }]);
      expect((await query('SELECT ?s ?o WHERE { ?s <urn:p>+/<urn:q> ?o }')).bindings)
        .toEqual([{ s: 'urn:s', o: 'urn:o' }, { s: 'urn:s', o: 'urn:o' }]);
      expect((await query('SELECT (COUNT(*) AS ?n) WHERE { ?s <urn:p>+ ?o }')).bindings[0]?.n).toMatch(/^"2"/);
    } finally { await store.close(); }
  });

  it('hides the helper variable from SELECT * on the dataset route', () => {
    const text = ready(rewriteGraphSet(scope('SELECT * WHERE { ?s <urn:p>+ ?o }'), graphs, 'values-union', null));
    expect(text).toContain(`SELECT * ${DEFAULT} ${NAMED} WHERE { { SELECT ?s ?o WHERE { GRAPH ?__dkgViewGraph {`);
  });

  it('keeps the outer modifiers and carries a plain LIMIT inside', () => {
    const text = ready(rewriteGraphSet(scope('SELECT ?s ?o WHERE { ?s <urn:p>+ ?o } LIMIT 5'), graphs, 'values-union', null));
    expect(text).toMatch(/} LIMIT 5 }\s+}\s+LIMIT 5$/);
  });

  it.each(['oxigraph', null] as const)('reports a caller UNION as before on the dataset route (%s)', (engine) => {
    const query = 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } UNION { ?s <urn:p> ?o } }';
    expect(rewriteGraphSet(scope(query), graphs, 'values-union', engine))
      .toMatchObject({ kind: 'unsupported', reason: 'nested-union' });
  });

  it.each(['oxigraph', null] as const)('keeps constant GRAPH branches on a union-only route (%s)', (engine) => {
    const text = ready(rewriteGraphSet(scope('SELECT ?s WHERE { { SELECT ?s WHERE { ?s ?p ?o } } }'), graphs, 'union-only', engine));
    expect(text).toContain(NAMED);
    expect(text).toContain('GRAPH <urn:g:1>');
    expect(text).toContain('GRAPH <urn:g:2>');
    expect(text).not.toContain('GRAPH ?');
  });

  it('falls back to constant GRAPH branches, with the dataset, on a helper collision', () => {
    const text = ready(rewriteGraphSet(scope('SELECT ?__dkgViewGraph ?s WHERE { ?s <urn:p>+ ?o }'), graphs, 'values-union', null));
    expect(text).toContain(NAMED);
    expect(text).toContain('GRAPH <urn:g:1>');
    expect(text).toContain('GRAPH <urn:g:2>');
  });

  describe('DESCRIBE on an unknown engine', () => {
    it('reads the pattern and the description from the list', () => {
      const rewritten = ready(rewriteGraphSet(scope('DESCRIBE ?s WHERE { ?s <urn:p> ?o }'), graphs, 'deduplicated-values-union', null));
      expect(rewritten).toContain(`${DEFAULT} ${NAMED} WHERE { { SELECT * WHERE {`);
      expect(rewritten).toContain('GRAPH ?__dkgDedupGraph');
    });

    it('keeps a graphless DESCRIBE as it was', () => {
      expect(ready(rewriteGraphSet(scope('DESCRIBE <urn:s>'), graphs, 'values-union', null)))
        .toContain('DESCRIBE <urn:s> FROM <urn:g:1> FROM <urn:g:2>');
    });

    it('refuses a caller GRAPH clause with a clear reason', () => {
      for (const query of ['DESCRIBE ?s WHERE { GRAPH <urn:g:1> { ?s <urn:p> ?o } }', 'DESCRIBE <urn:s> WHERE { GRAPH ?g { ?s <urn:p> ?o } }']) {
        expect(() => rewriteGraphSet(scope(query), graphs, 'values-union', null)).toThrow(/DESCRIBE cannot be combined with a GRAPH clause/);
        expect(() => rewriteSingleGraph(scope(query), 'urn:g:1', null)).toThrow(/DESCRIBE cannot be combined with a GRAPH clause/);
      }
    });

    it('leaves a caller GRAPH clause to the store on Oxigraph', () => {
      const query = scope('DESCRIBE ?s WHERE { GRAPH <urn:g:1> { ?s <urn:p> ?o } }');
      expect(rewriteGraphSet(query, graphs, 'values-union', 'oxigraph')).toEqual({ kind: 'ready', value: query });
    });
  });

  it('leaves Oxigraph DESCRIBE on the rewrite it had', () => {
    const query = 'DESCRIBE ?s WHERE { ?s <urn:p> ?o }';
    expect(ready(rewriteGraphSet(scope(query), graphs, 'values-union', 'oxigraph')))
      .toBe(ready(wrapWithGraphValues(scope(query), graphs)));
  });

  describe('a caller GRAPH clause', () => {
    const constrained = (query: string) => requireGraphScopeRewrite(constrainGraphVariablesToAllowedSet(scope(query), graphs));

    it('keeps the VALUES that bind the caller variable, beside the dataset', () => {
      const text = ready(rewriteGraphSet(constrained('SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }'), graphs, 'values-union', null));
      expect(text).toContain(NAMED);
      expect(text).toContain('VALUES ?g { <urn:g:1> <urn:g:2> }');
    });

    it('adds the dataset on Oxigraph only around a nested SELECT', () => {
      const flatRead = constrained('SELECT ?g ?s WHERE { GRAPH ?g { ?s <urn:p>+ ?o } }');
      expect(rewriteGraphSet(flatRead, graphs, 'values-union', 'oxigraph')).toEqual({ kind: 'ready', value: flatRead });
      const nested = constrained('SELECT ?s WHERE { GRAPH ?g { { SELECT ?s WHERE { ?s ?p ?o } } } }');
      expect(ready(rewriteGraphSet(nested, graphs, 'values-union', 'oxigraph'))).toContain(NAMED);
    });

    it('adds the dataset to a constant GRAPH on an unknown engine', () => {
      expect(ready(rewriteGraphSet(scope('SELECT ?s WHERE { GRAPH <urn:g:1> { ?s ?p ?o } }'), graphs, 'values-union', null)))
        .toBe(`SELECT ?s ${DEFAULT} ${NAMED} WHERE { GRAPH <urn:g:1> { ?s ?p ?o } }`);
    });
  });
});

describe('rewriteSingleGraph and rewriteGraphRoute', () => {
  it('scopes one graph as before on Oxigraph', () => {
    expect(ready(rewriteSingleGraph(scope('SELECT ?s WHERE { ?s ?p ?o }'), 'urn:g:1', 'oxigraph')))
      .toBe('SELECT ?s WHERE { GRAPH <urn:g:1> {  ?s ?p ?o  } }');
  });

  it('adds the dataset on an unknown engine', () => {
    expect(ready(rewriteSingleGraph(scope('SELECT ?s WHERE { ?s ?p ?o }'), 'urn:g:1', null)))
      .toBe('SELECT ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { GRAPH <urn:g:1> {  ?s ?p ?o  } }');
  });

  it('reads DESCRIBE from the one graph on an unknown engine', () => {
    expect(ready(rewriteSingleGraph(scope('DESCRIBE ?s WHERE { ?s ?p ?o }'), 'urn:g:1', null)))
      .toBe('DESCRIBE ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { { SELECT * WHERE {  GRAPH <urn:g:1> {  ?s ?p ?o  }  } } }');
  });

  it('passes the engine to the fallback graph', () => {
    const union = 'SELECT ?s WHERE { { ?s <urn:p> ?o } UNION { ?s <urn:q> ?o } }';
    expect(ready(rewriteGraphRoute(scope(union), graphs, 'urn:g:1', 'values-union', 'compatibility', null)))
      .toContain('SELECT ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { GRAPH <urn:g:1>');
    expect(ready(rewriteGraphRoute(scope(union), graphs, 'urn:g:1', 'values-union', 'compatibility', 'oxigraph')))
      .not.toContain('FROM NAMED');
  });

  it('keeps a graph list empty of graphs on the fallback', () => {
    expect(ready(rewriteGraphRoute(scope('DESCRIBE ?s WHERE { ?s ?p ?o }'), [], 'urn:g:1', 'union-only', 'compatibility', null)))
      .toBe('DESCRIBE ?s FROM <urn:g:1> FROM NAMED <urn:g:1> WHERE { { SELECT * WHERE {  GRAPH <urn:g:1> {  ?s ?p ?o  }  } } }');
  });
});

describe('what reaches an Oxigraph store through the engine', () => {
  const ID = 'dataset-route';
  const ROOT = `did:dkg:context-graph:${ID}`;
  const VM = `${ROOT}/_verifiable_memory/a/1`;

  async function sent(sparql: string, wrap: (store: OxigraphStore) => OxigraphStore | ChangelogStore = store => store) {
    const inner = new OxigraphStore();
    await inner.insert([
      { subject: 'urn:s:1', predicate: 'urn:p', object: 'urn:s:2', graph: ROOT },
      { subject: 'urn:s:3', predicate: 'urn:p', object: 'urn:s:4', graph: VM },
    ]);
    const query = vi.spyOn(inner, 'query');
    try {
      await new DKGQueryEngine(wrap(inner)).query(sparql, { contextGraphId: ID });
      return query.mock.calls.map(([text]) => text).filter(text => text.includes('urn:p'));
    } finally {
      await inner.close();
    }
  }

  it('sends a flat read and a path read with no dataset', async () => {
    for (const read of ['SELECT ?s WHERE { ?s <urn:p> ?o }', 'SELECT ?s WHERE { ?s <urn:p>+ ?o }']) {
      const [text] = await sent(read);
      expect(text).toContain('VALUES');
      expect(text).not.toContain('FROM NAMED');
    }
  });

  it('sends a nested SELECT with the dataset, through a decorator too', async () => {
    const read = 'SELECT ?s WHERE { { SELECT ?s WHERE { ?s <urn:p> ?o } } }';
    for (const wrap of [undefined, (store: OxigraphStore) => new ChangelogStore(store)]) {
      const [text] = await sent(read, wrap);
      expect(text).toContain(`FROM NAMED <${ROOT}> FROM NAMED <${VM}>`);
      expect(text).not.toContain('VALUES');
    }
  });
});

// Blazegraph itself leaves projected EXISTS unbound and rejects HAVING EXISTS
// (verified on 2.1.5 and 2.1.6). Use the conforming in-process backend to verify
// both dataset policies; live tests separately prove mixed GRAPH/default joins.
describe.each(['oxigraph', null] as const)('outer default-graph expressions (%s)', engine => {
  it('keeps authorized projection, HAVING and ORDER BY matches and excludes unlisted flags', async () => {
    const store = new OxigraphStore();
    try {
      await store.insert([
        { subject: 'urn:s:1', predicate: 'urn:p', object: 'urn:o', graph: graphs[0] },
        { subject: 'urn:s:2', predicate: 'urn:p', object: 'urn:o', graph: graphs[1] },
        { subject: 'urn:s:2', predicate: 'urn:flag', object: '"allowed"', graph: graphs[1] },
        { subject: 'urn:s:1', predicate: 'urn:flag', object: '"hidden"', graph: 'urn:unlisted' },
      ]);
      const query = async (source: string) => (await store.query(ready(rewriteGraphSet(scope(source), graphs, 'deduplicated-values-union', engine)))).bindings;
      const found = await query('SELECT ?s (EXISTS { ?s <urn:flag> ?flag } AS ?flagged) WHERE { ?s <urn:p> ?o } ORDER BY ?s');
      expect(found).toHaveLength(2);
      expect(found[0].flagged).toContain('false');
      expect(found[1].flagged).toContain('true');
      expect(await query('SELECT ?s WHERE { ?s <urn:p> ?o } GROUP BY ?s HAVING(EXISTS { ?s <urn:flag> ?flag })')).toEqual([{ s: 'urn:s:2' }]);
      expect(await query('SELECT ?s WHERE { ?s <urn:p> ?o } ORDER BY DESC(EXISTS { ?s <urn:flag> ?flag }) ?s')).toEqual([{ s: 'urn:s:2' }, { s: 'urn:s:1' }]);
    } finally { await store.close(); }
  });
});

describe('content discovery for static GRAPH queries', () => {
  const meta = 'did:dkg:context-graph:discovery/_meta';
  const graph = `GRAPH <${meta}> { ?ka <urn:rootEntity> ?s }`;
  it.each([
    [`SELECT ?s WHERE { ${graph} }`, false],
    [`SELECT ?s WHERE { ${graph} FILTER(BOUND(?s)) }`, false],
    [`SELECT ?s WHERE { ${graph} BIND(1 AS ?n) VALUES ?x { <urn:x> } }`, false],
    [`SELECT ?s WHERE { ${graph} OPTIONAL { GRAPH <${meta}> { ?ka ?p ?o } } }`, false],
    [`SELECT ?s WHERE { ${graph} ?s <urn:flag> ?flag }`, true],
    [`SELECT ?s WHERE { ${graph} FILTER(EXISTS { ?s <urn:flag> ?flag }) }`, true],
    [`SELECT ?s WHERE { ${graph} FILTER(EXISTS { GRAPH <${meta}> { ?s ?p ?o } }) }`, false],
    [`SELECT ?s (EXISTS { ?s <urn:flag> ?flag } AS ?hit) WHERE { ${graph} }`, true],
    [`SELECT ?s (EXISTS { GRAPH <${meta}> { ?s ?p ?o } } AS ?hit) WHERE { ${graph} }`, false],
    ...['WHERE', ''].flatMap(where => [
      [`SELECT ?s WHERE { { SELECT ?s (EXISTS { ?s <urn:flag> ?flag } AS ?hit) ${where} { ${graph} } } }`, true] as const,
      [`SELECT ?s WHERE { { SELECT ?s (EXISTS { GRAPH <${meta}> { ?s ?p ?o } } AS ?hit) ${where} { ${graph} } } }`, false] as const,
    ]),
  ] as const)('discovers content only when needed: %s', (source, needed) => {
    const plan = resolveQueryReadPlan(scope(source), { contextGraphId: 'discovery' }, null);
    expect(plan.kind).toBe('scoped');
    if (plan.kind !== 'scoped') throw new Error('Expected a scoped read');
    expect(plan.discovery.contentPrefixes.length > 0).toBe(needed);
  });

  it('keeps ordinary FILTER variables outside dataset routing on Oxigraph', () => {
    expect(planGraphDataset(scope(`SELECT ?s WHERE { ${graph} FILTER(BOUND(?s)) }`), 'oxigraph')).toBe('none');
    expect(planGraphDataset(scope(`SELECT ?s WHERE { ${graph} FILTER(EXISTS { ?s <urn:flag> ?flag }) }`), 'oxigraph')).toBe('guard');
  });
});
