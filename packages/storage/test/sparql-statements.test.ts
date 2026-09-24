import { describe, expect, it } from 'vitest';
import { sparqlStatements, type SparqlStatements } from '../src/adapters/sparql-statements.js';
import { createSparqlTermPolicy } from '../src/adapters/sparql-term-policy.js';
import { SparqlTermValidationError } from '../src/sparql-terms.js';
import { observeInvalidSparqlTerms } from './helpers/invalid-sparql-term-observer.js';

const ADAPTERS = ['oxigraph', 'sparql-http', 'blazegraph'] as const;
const G = 'http://ex.org/g';

// Each builder with well-formed terms, and the exact statement it returns.
const WELL_FORMED: Array<[string, (statements: SparqlStatements) => string | null, string]> = [
  [
    'insertData',
    (statements) => statements.insertData([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: G },
      { subject: '_:b0', predicate: 'http://ex.org/p', object: '<http://ex.org/o>', graph: '' },
    ]),
    'INSERT DATA {\n  GRAPH <http://ex.org/g> {\n    <http://ex.org/s> <http://ex.org/p> "v" .\n  }\n' +
      '  _:b0 <http://ex.org/p> <http://ex.org/o> .\n}',
  ],
  [
    'deleteData',
    (statements) => statements.deleteData([
      { subject: 'http://ex.org/s', predicate: 'http://ex.org/p', object: '"v"', graph: G },
    ]),
    'DELETE DATA {\nGRAPH <http://ex.org/g> { <http://ex.org/s> <http://ex.org/p> "v" . }\n}',
  ],
  [
    'deleteByPattern in one graph',
    (statements) => statements.deleteByPattern({ graph: G, subject: 'http://ex.org/s', object: '"v"' }),
    'DELETE { GRAPH <http://ex.org/g> { <http://ex.org/s> ?p "v" } } ' +
      'WHERE { GRAPH <http://ex.org/g> { <http://ex.org/s> ?p "v" } }',
  ],
  [
    'deleteByPattern across graphs',
    (statements) => statements.deleteByPattern({ predicate: 'http://ex.org/p' }),
    'DELETE { GRAPH ?g_ctx { ?s <http://ex.org/p> ?o } } WHERE { GRAPH ?g_ctx { ?s <http://ex.org/p> ?o } }',
  ],
  [
    'deleteBySubjectPrefix',
    (statements) => statements.deleteBySubjectPrefix(G, 'http://ex.org/entity/'),
    'DELETE { GRAPH <http://ex.org/g> { ?s ?p ?o } } WHERE { GRAPH <http://ex.org/g> ' +
      '{ ?s ?p ?o . FILTER(STRSTARTS(STR(?s), "http://ex.org/entity/")) } }',
  ],
  ['dropGraph', (statements) => statements.dropGraph(G), 'DROP SILENT GRAPH <http://ex.org/g>'],
  ['hasGraph', (statements) => statements.hasGraph(G), 'ASK { GRAPH <http://ex.org/g> { ?s ?p ?o } }'],
  [
    'countQuads in one graph',
    (statements) => statements.countQuads(G),
    'SELECT (COUNT(*) AS ?c) WHERE { GRAPH <http://ex.org/g> { ?s ?p ?o } }',
  ],
  [
    'countQuads across the store',
    (statements) => statements.countQuads(),
    'SELECT (COUNT(*) AS ?c) WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }',
  ],
];

describe('sparqlStatements', () => {
  it.each(WELL_FORMED)('%s builds the same statement for every adapter', (_name, build, statement) => {
    const observed = observeInvalidSparqlTerms();
    try {
      for (const adapter of ADAPTERS) {
        expect(build(sparqlStatements(adapter))).toBe(statement);
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
      statements.insertData([quad]);
      statements.deleteData([quad]);
      statements.deleteByPattern({ graph: bad });
      statements.deleteBySubjectPrefix(bad, 'http://ex.org/');
      statements.dropGraph(bad);
      statements.hasGraph(bad);
      statements.countQuads(bad);

      expect(observed.counted.map((point) => [point.adapter, point.operation, point.position])).toEqual([
        [adapter, 'insert', 'graph'],
        [adapter, 'delete', 'graph'],
        [adapter, 'deleteByPattern', 'graph'],
        [adapter, 'deleteBySubjectPrefix', 'graph'],
        [adapter, 'dropGraph', 'graph'],
        [adapter, 'hasGraph', 'graph'],
        [adapter, 'countQuads', 'graph'],
      ]);
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
      expect(statements.dropGraph(G)).toBe('DROP SILENT GRAPH <http://ex.org/g>');
      expect(observed.counted.map((point) => point.enforcement)).toEqual(['reject', 'reject']);
    } finally {
      observed.restore();
    }
  });
});
