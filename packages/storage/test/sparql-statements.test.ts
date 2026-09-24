import { describe, expect, it } from 'vitest';
import {
  sparqlStatements,
  type SparqlQueryPlan,
  type SparqlStatements,
  type SparqlUpdatePlan,
} from '../src/adapters/sparql-statements.js';
import { SparqlTermValidationError } from '@origintrail-official/dkg-core';
import { createSparqlTermPolicy } from '../src/adapters/sparql-term-policy.js';
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
    {
      operation: 'dropGraph',
      update: 'DROP SILENT GRAPH <http://ex.org/g>',
      scope: { kind: 'graphs', graphs: [G] },
    },
  ],
  [
    'hasGraph',
    (statements) => statements.hasGraph(G),
    { operation: 'hasGraph', sparql: 'ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }' },
  ],
  [
    'countQuads in one graph',
    (statements) => statements.countQuads(G),
    {
      operation: 'countQuads',
      sparql: 'SELECT (COUNT(*) AS ?c) WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }',
    },
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
  it.each(WELL_FORMED)('%s builds the same plan for every adapter, reporting nothing', (_name, build, plan) => {
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

  it.each(ADAPTERS)('reports each invalid term once, labelled with adapter %s and the plan\'s operation', (adapter) => {
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
      // A plan runs as the same operation its terms were reported under, and
      // carries no diagnostics of its own.
      expect(plans.map((plan) => plan.operation)).toEqual(observed.counted.map((point) => point.operation));
      for (const plan of plans) expect(plan).not.toHaveProperty('invalidTerms');
    } finally {
      observed.restore();
    }
  });

  it('reports every invalid term of one statement, and nothing for an empty delete', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('oxigraph');
      statements.deleteByPattern({ graph: 'http://ex.org/g^x', predicate: 'http://ex.org/p q' });
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

  it('builds under the policy it is given, reporting a rejection once', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('sparql-http', createSparqlTermPolicy('reject'));
      expect(() => statements.dropGraph('http://ex.org/g^x')).toThrow(SparqlTermValidationError);
      expect(() => statements.deleteData([
        { subject: '_:bad label', predicate: 'http://ex.org/p', object: '"v"', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(statements.dropGraph(G).update).toBe('DROP SILENT GRAPH <http://ex.org/g>');
      expect(observed.counted.map((point) => [point.operation, point.enforcement])).toEqual([
        ['dropGraph', 'reject'],
        ['delete', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });
});

describe('the absolute-IRI rule', () => {
  const QUAD_IRI_CHECK_OPERATIONS = [
    'insert',
    'replaceGraph',
    'replaceGraphAndSubject',
    'replaceSubject',
    'rfc64AuthorCommitCasV1',
  ] as const;

  it('builds a statement holding relative and RFC 3987-invalid IRIs byte for byte as before', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const plan = sparqlStatements('sparql-http').insertData([
        { subject: 'rel-s', predicate: 'http://ex.org/p', object: '"42"^^<integer>', graph: G },
        { subject: 'http://ex.org/s', predicate: '<rel-p>', object: 'http://ex.org/%zz', graph: 'rel-g' },
      ]);
      expect(plan.update).toBe(
        'INSERT DATA {\n  GRAPH <http://ex.org/g> {\n    <rel-s> <http://ex.org/p> "42"^^<integer> .\n  }\n' +
          '  GRAPH <rel-g> {\n    <http://ex.org/s> <rel-p> <http://ex.org/%zz> .\n  }\n}',
      );
      expect(observed.counted.map((point) => [point.operation, point.position, point.kind])).toEqual([
        ['insert', 'subject', 'relative-iri'],
        ['insert', 'datatype', 'relative-iri'],
        ['insert', 'predicate', 'relative-iri'],
        ['insert', 'object', 'rfc3987-iri'],
        ['insert', 'graph', 'relative-iri'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it.each(ADAPTERS)('checkIris reports %s writes under their own operation, and builds nothing', (adapter) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements(adapter);
      const quads = [
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"42"^^integer', graph: G },
        { subject: '_:b0', predicate: 'http://ex.org/p', object: 'rel-o', graph: '' },
        { subject: '<http://ex.org/s>', predicate: 'http://ex.org/p', object: '"v"@en', graph: G },
      ];
      for (const operation of QUAD_IRI_CHECK_OPERATIONS) {
        expect(statements.checkIris(operation, quads)).toBeUndefined();
      }
      expect(observed.counted).toEqual(QUAD_IRI_CHECK_OPERATIONS.flatMap((operation) => [
        { value: 1, adapter, operation, position: 'datatype', kind: 'relative-iri', enforcement: 'observe' },
        { value: 1, adapter, operation, position: 'object', kind: 'relative-iri', enforcement: 'observe' },
      ]));
    } finally {
      observed.restore();
    }
  });

  it('checkIris checks every position and throws under the reject policy', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      sparqlStatements('oxigraph').checkIris('replaceGraph', [
        { subject: 'rel-s', predicate: 'rel-p', object: 'http://ex.org/o', graph: 'http://ex.org:bad/g' },
      ]);
      expect(observed.counted.map((point) => [point.position, point.kind])).toEqual([
        ['subject', 'relative-iri'],
        ['predicate', 'relative-iri'],
        ['graph', 'rfc3987-iri'],
      ]);

      const strict = sparqlStatements('oxigraph', createSparqlTermPolicy('reject'));
      expect(() => strict.checkIris('insert', [
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"42"^^<integer>', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(() => strict.checkIris('insert', [
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"42"^^<urn:dt>', graph: '' },
      ])).not.toThrow();
      expect(observed.counted.slice(3).map((point) => [point.operation, point.enforcement])).toEqual([
        ['insert', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });
});
