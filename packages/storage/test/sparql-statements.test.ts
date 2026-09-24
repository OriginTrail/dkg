import { describe, expect, it } from 'vitest';
import {
  pureSparqlStatements,
  sparqlStatements,
  type PureSparqlStatements,
  type SparqlQueryPlan,
  type SparqlUpdatePlan,
  type WithInvalidTerms,
} from '../src/adapters/sparql-statements.js';
import { createSparqlTermPolicy, SparqlTermRejectedError } from '../src/adapters/sparql-term-policy.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

const ADAPTERS = ['oxigraph', 'sparql-http', 'blazegraph'] as const;
const G = 'http://ex.org/g';

type PurePlan = WithInvalidTerms<SparqlQueryPlan | SparqlUpdatePlan> | null;

function withoutInvalidTerms(plan: WithInvalidTerms<SparqlQueryPlan | SparqlUpdatePlan>): object {
  const copy: Record<string, unknown> = { ...plan };
  delete copy.invalidTerms;
  return copy;
}

// Each builder with well-formed terms, and the exact plan the pure builder
// returns: the statement, its operation, for an update the graphs it writes,
// and no invalid terms. The adapters' factory returns the same plan without
// the invalidTerms field.
const WELL_FORMED: Array<[string, (statements: PureSparqlStatements) => PurePlan, PurePlan]> = [
  [
    'insertData',
    (statements) => statements.insertData([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: G },
      { subject: '_:b0', predicate: 'http://ex.org/p', object: '<http://ex.org/o>', graph: '' },
    ]),
    {
      operation: 'insert',
      update: 'INSERT DATA {\n  GRAPH <http://ex.org/g> {\n    <http://ex.org/s> <http://ex.org/p> "v" .\n  }\n' +
        '  _:b0 <http://ex.org/p> <http://ex.org/o> .\n}',
      scope: { kind: 'graphs', graphs: [G, ''] },
      invalidTerms: [],
    },
  ],
  [
    'deleteData',
    (statements) => statements.deleteData([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: G },
      { subject: '_:b0', predicate: 'http://ex.org/p', object: '"w"', graph: G },
    ]),
    {
      operation: 'delete',
      update: 'DELETE DATA {\nGRAPH <http://ex.org/g> { <http://ex.org/s> <http://ex.org/p> "v" . }\n};\n' +
        'DELETE { GRAPH <http://ex.org/g> {\n    ?b0 <http://ex.org/p> "w" .\n  } } ' +
        'WHERE { GRAPH <http://ex.org/g> {\n    ?b0 <http://ex.org/p> "w" .\n  } }',
      scope: { kind: 'graphs', graphs: [G] },
      invalidTerms: [],
    },
  ],
  ['deleteData with nothing to delete', (statements) => statements.deleteData([]), null],
  [
    'deleteByPattern in one graph',
    (statements) => statements.deleteByPattern({ graph: G, subject: 'http://ex.org/s', object: '"v"' }),
    {
      operation: 'deleteByPattern',
      update: 'DELETE { GRAPH <http://ex.org/g> { <http://ex.org/s> ?p "v" } } ' +
        'WHERE { GRAPH <http://ex.org/g> { <http://ex.org/s> ?p "v" } }',
      scope: { kind: 'graphs', graphs: [G] },
      invalidTerms: [],
    },
  ],
  [
    'deleteByPattern across graphs',
    (statements) => statements.deleteByPattern({ predicate: 'http://ex.org/p' }),
    {
      operation: 'deleteByPattern',
      update: 'DELETE { GRAPH ?g_ctx { ?s <http://ex.org/p> ?o } } WHERE { GRAPH ?g_ctx { ?s <http://ex.org/p> ?o } }',
      scope: { kind: 'all' },
      invalidTerms: [],
    },
  ],
  [
    'deleteBySubjectPrefix',
    (statements) => statements.deleteBySubjectPrefix(G, 'http://ex.org/entity/'),
    {
      operation: 'deleteBySubjectPrefix',
      update: 'DELETE { GRAPH <http://ex.org/g> { ?s ?p ?o } } WHERE { GRAPH <http://ex.org/g> ' +
        '{ ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "http://ex.org/entity/")) } }',
      scope: { kind: 'graphs', graphs: [G] },
      invalidTerms: [],
    },
  ],
  [
    'dropGraph',
    (statements) => statements.dropGraph(G),
    {
      operation: 'dropGraph',
      update: 'DROP SILENT GRAPH <http://ex.org/g>',
      scope: { kind: 'graphs', graphs: [G] },
      invalidTerms: [],
    },
  ],
  [
    'hasGraph',
    (statements) => statements.hasGraph(G),
    { operation: 'hasGraph', sparql: 'ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }', invalidTerms: [] },
  ],
  [
    'countQuads in one graph',
    (statements) => statements.countQuads(G),
    {
      operation: 'countQuads',
      sparql: 'SELECT (COUNT(*) AS ?c) WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }',
      invalidTerms: [],
    },
  ],
  [
    'countQuads across the store',
    (statements) => statements.countQuads(),
    {
      operation: 'countQuads',
      sparql: 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
      invalidTerms: [],
    },
  ],
];

describe('sparqlStatements', () => {
  it.each(WELL_FORMED)('%s builds the same plan for every adapter', (_name, build, pure) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const reported = pure === null ? null : withoutInvalidTerms(pure);
      for (const adapter of ADAPTERS) {
        expect(build(pureSparqlStatements(adapter))).toEqual(pure);
        const plan = build(sparqlStatements(adapter) as unknown as PureSparqlStatements);
        expect(plan).toEqual(reported);
        if (plan !== null) expect(plan).not.toHaveProperty('invalidTerms');
      }
      expect(observed.counted).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it.each(ADAPTERS)('labels every builder with adapter %s and its own operation; only the factory reports', (adapter) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const bad = 'http://ex.org/g^x';
      const quad = { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: bad };
      const buildAll = (statements: PureSparqlStatements) => [
        statements.insertData([quad]),
        statements.deleteData([quad])!,
        statements.deleteByPattern({ graph: bad }),
        statements.deleteBySubjectPrefix(bad, 'http://ex.org/'),
        statements.dropGraph(bad),
        statements.hasGraph(bad),
        statements.countQuads(bad),
      ];
      const plans = buildAll(pureSparqlStatements(adapter));

      // The pure builder is side-effect free: each plan only carries its invalid term.
      expect(observed.counted).toEqual([]);
      expect(observed.warnings).toEqual([]);
      expect(plans.map((plan) => plan.invalidTerms.map((term) => [term.site.adapter, term.site.operation, term.position])))
        .toEqual([
          [[adapter, 'insert', 'graph']],
          [[adapter, 'delete', 'graph']],
          [[adapter, 'deleteByPattern', 'graph']],
          [[adapter, 'deleteBySubjectPrefix', 'graph']],
          [[adapter, 'dropGraph', 'graph']],
          [[adapter, 'hasGraph', 'graph']],
          [[adapter, 'countQuads', 'graph']],
        ]);
      // A plan runs as the same operation its terms are labelled with.
      expect(plans.map((plan) => plan.operation)).toEqual(plans.map((plan) => plan.invalidTerms[0].site.operation));

      // The adapters' factory reports each of them exactly once as it builds.
      buildAll(sparqlStatements(adapter) as unknown as PureSparqlStatements);
      expect(observed.counted.map((point) => [point.adapter, point.operation, point.position]))
        .toEqual(plans.map((plan) => [adapter, plan.operation, 'graph']));
    } finally {
      observed.restore();
    }
  });

  it('reports every invalid term of a plan once, and hands the adapter the plan without them', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('oxigraph');
      const plan = statements.deleteByPattern({
        graph: 'http://ex.org/g^x',
        predicate: 'http://ex.org/p q',
      });
      expect(plan).not.toHaveProperty('invalidTerms');
      expect(observed.counted.map((point) => [point.operation, point.position])).toEqual([
        ['deleteByPattern', 'predicate'],
        ['deleteByPattern', 'graph'],
      ]);
      expect(statements.deleteData([])).toBeNull();
      expect(observed.counted).toHaveLength(2);
    } finally {
      observed.restore();
    }
  });

  it('builds under the policy it is given', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const reject = createSparqlTermPolicy('reject');
      const pure = pureSparqlStatements('sparql-http', reject);
      expect(() => pure.dropGraph('http://ex.org/g^x')).toThrow(SparqlTermRejectedError);
      expect(() => pure.deleteData([
        { subject: '_:bad label', predicate: 'http://ex.org/p', object: '"v"', graph: G },
      ])).toThrow(SparqlTermRejectedError);
      expect(pure.dropGraph(G).update).toBe('DROP SILENT GRAPH <http://ex.org/g>');
      // The pure builder reports nothing; the factory reports a rejection once.
      expect(observed.counted).toEqual([]);
      expect(() => sparqlStatements('sparql-http', reject).dropGraph('http://ex.org/g^x'))
        .toThrow(SparqlTermRejectedError);
      expect(observed.counted.map((point) => point.enforcement)).toEqual(['reject']);
    } finally {
      observed.restore();
    }
  });
});
