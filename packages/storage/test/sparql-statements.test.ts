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

  it.each(ADAPTERS)('%s refuses an invalid term in every update, reporting it once under the update\'s operation', (adapter) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements(adapter);
      const bad = 'http://ex.org/g^x';
      const quad = { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: bad };
      const updates = [
        () => statements.insertData([quad]),
        () => statements.deleteData([quad]),
        () => statements.deleteByPattern({ graph: bad }),
        () => statements.deleteBySubjectPrefix(bad, 'http://ex.org/'),
        () => statements.dropGraph(bad),
      ];
      for (const update of updates) expect(update).toThrow(SparqlTermValidationError);

      expect(observed.counted.map((point) => [point.adapter, point.operation, point.position, point.enforcement])).toEqual([
        [adapter, 'insert', 'graph', 'reject'],
        [adapter, 'delete', 'graph', 'reject'],
        [adapter, 'deleteByPattern', 'graph', 'reject'],
        [adapter, 'deleteBySubjectPrefix', 'graph', 'reject'],
        [adapter, 'dropGraph', 'graph', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it.each(ADAPTERS)('%s builds a query holding an invalid term as before, reporting it once (observe mode)', (adapter) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements(adapter);
      const plans = [statements.hasGraph('http://ex.org/g^x'), statements.countQuads('http://ex.org/g^x')];
      expect(plans).toEqual([
        { operation: 'hasGraph', sparql: 'ASK { GRAPH <http://ex.org/gx> { ?s ?p ?o } }' },
        {
          operation: 'countQuads',
          sparql: 'SELECT (COUNT(*) AS ?c) WHERE { GRAPH <http://ex.org/gx> { ?s ?p ?o } }',
        },
      ]);
      expect(observed.counted.map((point) => [point.adapter, point.operation, point.position, point.enforcement])).toEqual([
        [adapter, 'hasGraph', 'graph', 'observe'],
        [adapter, 'countQuads', 'graph', 'observe'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it.each([
    ['a language tag with a character a tag may not hold', '"value"@en_GB'],
    ['a blank-node label with a character a label may not hold', '_:node!refused'],
    ['a literal holding a raw line break', '"line\nbreak"'],
  ])('refuses %s in every update that renders an object', (_label, object) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('sparql-http');
      const quad = { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object, graph: G };
      expect(() => statements.insertData([quad])).toThrow(SparqlTermValidationError);
      expect(() => statements.deleteData([quad])).toThrow(SparqlTermValidationError);
      expect(() => statements.deleteByPattern({ graph: G, object })).toThrow(SparqlTermValidationError);
      expect(() => statements.checkIris.insert([quad])).toThrow(SparqlTermValidationError);
      expect(observed.counted.map((point) => [point.operation, point.position, point.enforcement])).toEqual([
        ['insert', 'object', 'reject'],
        ['delete', 'object', 'reject'],
        ['deleteByPattern', 'object', 'reject'],
        ['insert', 'object', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it('a delete sends an IRI that breaks only the absolute-IRI rule, so a stored row stays deletable', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('blazegraph');
      const stored = 'http://ex.org/%zz';
      expect(statements.dropGraph(stored).update).toBe('DROP SILENT GRAPH <http://ex.org/%zz>');
      expect(statements.deleteData([
        { subject: stored, predicate: 'http://ex.org/p', object: '"v"', graph: G },
      ])!.update).toBe('DELETE DATA {\nGRAPH <http://ex.org/g> { <http://ex.org/%zz> <http://ex.org/p> "v" . }\n}');
      // An insert of the same IRI is refused.
      expect(() => statements.insertData([
        { subject: stored, predicate: 'http://ex.org/p', object: '"v"', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(observed.counted.map((point) => [point.operation, point.position, point.kind, point.enforcement])).toEqual([
        ['dropGraph', 'graph', 'rfc3987-iri', 'observe'],
        ['delete', 'subject', 'rfc3987-iri', 'observe'],
        ['insert', 'subject', 'rfc3987-iri', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it('in observe mode reports every invalid term of one statement, and nothing for an empty delete', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('oxigraph', createSparqlTermPolicy('observe'));
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
  const META = 'http://ex.org/meta';
  const S = 'http://ex.org/s';

  it('in observe mode builds a statement holding relative and RFC 3987-invalid IRIs byte for byte as before', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const plan = sparqlStatements('sparql-http', createSparqlTermPolicy('observe')).insertData([
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

  it.each(ADAPTERS)('in observe mode checkIris labels each %s write with its own operation, and builds nothing', (adapter) => {
    const observed = observeInvalidSparqlTerms();
    try {
      const { checkIris } = sparqlStatements(adapter, createSparqlTermPolicy('observe'));
      const quads = [
        { subject: S, predicate: 'http://ex.org/p', object: '"42"^^integer', graph: G },
        { subject: '_:b0', predicate: 'http://ex.org/p', object: 'rel-o', graph: G },
        { subject: `<${S}>`, predicate: 'http://ex.org/p', object: '"v"@en', graph: G },
      ];
      expect(checkIris.insert(quads)).toBeUndefined();
      expect(checkIris.replaceGraph(G, quads)).toBeUndefined();
      expect(checkIris.replaceGraphAndSubject(G, quads, META, S, [])).toBeUndefined();
      expect(checkIris.replaceSubject(G, S, quads)).toBeUndefined();
      expect(checkIris.rfc64AuthorCommitCasV1({ semanticQuads: quads, controlTerms: [] })).toBeUndefined();
      const operations = ['insert', 'replaceGraph', 'replaceGraphAndSubject', 'replaceSubject', 'rfc64AuthorCommitCasV1'];
      expect(observed.counted).toEqual(operations.flatMap((operation) => [
        { value: 1, adapter, operation, position: 'datatype', kind: 'relative-iri', enforcement: 'observe' },
        { value: 1, adapter, operation, position: 'object', kind: 'relative-iri', enforcement: 'observe' },
      ]));
    } finally {
      observed.restore();
    }
  });

  it('checkIris checks the terms a write names outside its quads', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const { checkIris } = sparqlStatements('sparql-http', createSparqlTermPolicy('observe'));
      // An empty replace still sends `DROP SILENT GRAPH <rel-g>` or a DELETE for its target.
      checkIris.replaceGraph('rel-g', []);
      checkIris.replaceSubject('http://ex.org:bad/g', 'rel-s', []);
      checkIris.replaceGraphAndSubject(G, [], 'rel-meta', 'rel-subject', []);
      checkIris.rfc64AuthorCommitCasV1({
        semanticQuads: [],
        controlTerms: [
          { term: 'rel-guard-graph', position: 'graph' },
          { term: 'rel-guard-predicate', position: 'predicate' },
          { term: '"1"^^<rel-datatype>', position: 'object' },
          { term: S, position: 'subject' },
        ],
      });
      // Standalone terms first, then the write's quads, then each distinct graph.
      expect(observed.counted.map((point) => [point.operation, point.position, point.kind])).toEqual([
        ['replaceGraph', 'graph', 'relative-iri'],
        ['replaceSubject', 'subject', 'relative-iri'],
        ['replaceSubject', 'graph', 'rfc3987-iri'],
        ['replaceGraphAndSubject', 'subject', 'relative-iri'],
        ['replaceGraphAndSubject', 'graph', 'relative-iri'],
        ['rfc64AuthorCommitCasV1', 'predicate', 'relative-iri'],
        ['rfc64AuthorCommitCasV1', 'datatype', 'relative-iri'],
        ['rfc64AuthorCommitCasV1', 'graph', 'relative-iri'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it('checkIris checks each position of a quad, and each distinct graph once per write', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const inRelativeGraph = (object: string) => ({ subject: 'rel-s', predicate: 'rel-p', object, graph: 'rel-g' });
      sparqlStatements('oxigraph', createSparqlTermPolicy('observe')).checkIris.replaceGraph('rel-g', [
        inRelativeGraph('http://ex.org/o'),
        inRelativeGraph('"v"'),
      ]);
      expect(observed.counted.map((point) => [point.position, point.kind])).toEqual([
        ['subject', 'relative-iri'],
        ['predicate', 'relative-iri'],
        ['subject', 'relative-iri'],
        ['predicate', 'relative-iri'],
        ['graph', 'relative-iri'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it('refuses an insert holding a relative or RFC 3987-invalid IRI, by default', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const statements = sparqlStatements('sparql-http');
      expect(() => statements.insertData([
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"42"^^<integer>', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(() => statements.insertData([
        { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: 'http://ex.org/%zz', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(observed.counted.map((point) => [point.operation, point.position, point.kind, point.enforcement])).toEqual([
        ['insert', 'datatype', 'relative-iri', 'reject'],
        ['insert', 'object', 'rfc3987-iri', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });

  it('checkIris throws by default, and passes absolute IRIs', () => {
    const observed = observeInvalidSparqlTerms();
    try {
      const { checkIris } = sparqlStatements('oxigraph');
      expect(() => checkIris.insert([
        { subject: S, predicate: 'http://ex.org/p', object: '"42"^^<integer>', graph: G },
      ])).toThrow(SparqlTermValidationError);
      expect(() => checkIris.replaceGraph('rel-g', [])).toThrow(SparqlTermValidationError);
      expect(() => checkIris.insert([
        { subject: S, predicate: 'http://ex.org/p', object: '"42"^^<urn:dt>', graph: '' },
      ])).not.toThrow();
      expect(observed.counted.map((point) => [point.operation, point.enforcement])).toEqual([
        ['insert', 'reject'],
        ['replaceGraph', 'reject'],
      ]);
    } finally {
      observed.restore();
    }
  });
});
