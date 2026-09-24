import { describe, expect, it } from 'vitest';
import {
  sparqlStatements,
  type SparqlQueryPlan,
  type SparqlStatements,
  type SparqlUpdatePlan,
} from '../src/adapters/sparql-statements.js';
import { createSparqlTermPolicy } from '../src/adapters/sparql-term-policy.js';
import { SparqlTermValidationError } from '@origintrail-official/dkg-core';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

const ADAPTERS = ['oxigraph', 'sparql-http', 'blazegraph'] as const;
const G = 'http://ex.org/g';

type Plan = SparqlQueryPlan | SparqlUpdatePlan | null;

// Each builder with well-formed terms, and the exact plan it returns: the
// statement, its operation, and for an update the graphs it writes.
const WELL_FORMED: Array<[string, (statements: SparqlStatements) => Plan, Plan]> = [
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
    },
  ],
  [
    'deleteByPattern across graphs',
    (statements) => statements.deleteByPattern({ predicate: 'http://ex.org/p' }),
    {
      operation: 'deleteByPattern',
      update: 'DELETE { GRAPH ?g_ctx { ?s <http://ex.org/p> ?o } } WHERE { GRAPH ?g_ctx { ?s <http://ex.org/p> ?o } }',
      scope: { kind: 'all' },
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
    },
  ],
  [
    'dropGraph',
    (statements) => statements.dropGraph(G),
    { operation: 'dropGraph', update: 'DROP SILENT GRAPH <http://ex.org/g>', scope: { kind: 'graphs', graphs: [G] } },
  ],
  [
    'hasGraph',
    (statements) => statements.hasGraph(G),
    { operation: 'hasGraph', sparql: 'ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }' },
  ],
  [
    'countQuads in one graph',
    (statements) => statements.countQuads(G),
    { operation: 'countQuads', sparql: 'SELECT (COUNT(*) AS ?c) WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }' },
  ],
  [
    'countQuads across the store',
    (statements) => statements.countQuads(),
    {
      operation: 'countQuads',
      sparql: 'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
    },
  ],
];

describe('sparqlStatements', () => {
  it.each(WELL_FORMED)('%s builds the same plan for every adapter', (_name, build, plan) => {
    const observed = observeInvalidSparqlTerms();
    try {
      for (const adapter of ADAPTERS) {
        expect(build(sparqlStatements(adapter))).toEqual(plan);
      }
      expect(observed.counted).toEqual([]);
    } finally {
      observed.restore();
    }
  });

  it.each(ADAPTERS)('labels every builder with adapter %s and its own operation', (adapter) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements(adapter);
      const bad = 'http://ex.org/g^x';
      const quad = { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: bad };
      const plans = [
        statements.insertData([quad]),
        statements.deleteData([quad])!,
        statements.deleteByPattern({ graph: bad }),
        statements.deleteBySubjectPrefix(bad, 'http://ex.org/'),
        statements.dropGraph(bad),
        statements.hasGraph(bad),
        statements.countQuads(bad),
      ];

      expect(observed.counted.map((point) => [point.adapter, point.operation, point.position])).toEqual([
        [adapter, 'insert', 'graph'],
        [adapter, 'delete', 'graph'],
        [adapter, 'deleteByPattern', 'graph'],
        [adapter, 'deleteBySubjectPrefix', 'graph'],
        [adapter, 'dropGraph', 'graph'],
        [adapter, 'hasGraph', 'graph'],
        [adapter, 'countQuads', 'graph'],
      ]);
      // A plan runs as the same operation its terms were counted under.
      expect(plans.map((plan) => plan.operation)).toEqual(observed.counted.map((point) => point.operation));
    } finally {
      observed.restore();
    }
  });

  it('builds under the policy it is given', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('sparql-http', createSparqlTermPolicy('reject'));
      expect(() => statements.dropGraph('http://ex.org/g^x')).toThrow(SparqlTermValidationError);
      expect(() => statements.deleteData([
        { subject: '_:bad label', predicate: 'http://ex.org/p', object: '"v"', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(statements.dropGraph(G).update).toBe('DROP SILENT GRAPH <http://ex.org/g>');
      expect(observed.counted.map((point) => point.enforcement)).toEqual(['reject', 'reject']);
    } finally {
      observed.restore();
    }
  });
});
