import { describe, expect, it } from 'vitest';
import { canonicalizeNQuadsV1 } from '../../src/rdf/nquads.js';
import {
  canonicalSparqlAuditBytesV1,
  compileLocalSparqlPatchV1,
} from '../../src/rdf/sparql.js';

const GRAPH = 'urn:dkg:graph:alpha';
const OTHER_GRAPH = 'urn:dkg:graph:other';
const base = canonicalizeNQuadsV1([
  '<urn:s:1> <urn:p:name> "one" <urn:dkg:graph:alpha> .',
  '<urn:s:1> <urn:p:tag> "old" <urn:dkg:graph:alpha> .',
  '<urn:s:2> <urn:p:name> "two" <urn:dkg:graph:alpha> .',
  '<urn:s:2> <urn:p:tag> "old" <urn:dkg:graph:alpha> .',
  '<urn:s:3> <urn:p:name> "three" <urn:dkg:graph:other> .',
].join('\n'));

function compile(sparql: string, overrides: Partial<Parameters<typeof compileLocalSparqlPatchV1>[0]> = {}) {
  return compileLocalSparqlPatchV1({
    sparql,
    base,
    allowedGraphIris: [GRAPH],
    ...overrides,
  });
}

describe('bounded local SPARQL compiler', () => {
  it('compiles INSERT DATA into explicit canonical inserts and a deterministic result', () => {
    const result = compile(`
      INSERT DATA {
        GRAPH <${GRAPH}> {
          <urn:s:4> <urn:p:name> "four"@EN .
          <urn:s:4> <urn:p:name> "four"@en .
        }
      }
    `);
    expect(result.deleteDataset.text).toBe('');
    expect(result.insertDataset.text).toBe(
      '<urn:s:4> <urn:p:name> "four"@en <urn:dkg:graph:alpha> .\n',
    );
    expect(result.resultDataset.quadCount).toBe(6);
  });

  it('treats comments as lexical whitespace, including an end-of-file comment', () => {
    const result = compile(`INSERT # operation comment
      DATA { GRAPH <${GRAPH}> { <urn:s:4> <urn:p:name> "four" . } } # eof`);
    expect(result.insertDataset.quadCount).toBe(1);
  });

  it('compiles DELETE DATA and preserves SPARQL no-op deletion semantics', () => {
    const result = compile(`DELETE DATA { GRAPH <${GRAPH}> {
      <urn:s:1> <urn:p:tag> "old" .
      <urn:missing> <urn:p:tag> "old" .
    } }`);
    expect(result.deleteDataset.quadCount).toBe(2);
    expect(result.insertDataset.quadCount).toBe(0);
    expect(result.resultDataset.text).not.toContain('<urn:s:1> <urn:p:tag>');
    expect(result.resultDataset.text).toContain('<urn:s:2> <urn:p:tag>');
  });

  it('evaluates a bounded DELETE/INSERT WHERE exactly once against the declared base', () => {
    const result = compile(`
      DELETE { GRAPH <${GRAPH}> { ?subject <urn:p:tag> ?old . } }
      INSERT { GRAPH <${GRAPH}> { ?subject <urn:p:tag> "new" . } }
      WHERE {
        GRAPH <${GRAPH}> { ?subject <urn:p:name> ?name . }
        GRAPH <${GRAPH}> { ?subject <urn:p:tag> ?old . }
      }
    `);
    expect(result.deleteDataset.text).toBe([
      '<urn:s:1> <urn:p:tag> "old" <urn:dkg:graph:alpha> .',
      '<urn:s:2> <urn:p:tag> "old" <urn:dkg:graph:alpha> .',
      '',
    ].join('\n'));
    expect(result.insertDataset.text).toBe([
      '<urn:s:1> <urn:p:tag> "new" <urn:dkg:graph:alpha> .',
      '<urn:s:2> <urn:p:tag> "new" <urn:dkg:graph:alpha> .',
      '',
    ].join('\n'));
    expect(result.resultDataset.text).not.toContain('"old"');
    expect(result.resultDataset.text).toContain('<urn:s:3>');
  });

  it('supports deterministic insert-only and delete-only WHERE forms and empty result bindings', () => {
    const inserted = compile(`INSERT { GRAPH <${GRAPH}> { ?s <urn:p:copy> ?name . } }
      WHERE { GRAPH <${GRAPH}> { ?s <urn:p:name> ?name . } }`);
    expect(inserted.insertDataset.quadCount).toBe(2);
    const deleted = compile(`DELETE { GRAPH <${GRAPH}> { ?s <urn:p:tag> ?tag . } }
      WHERE { GRAPH <${GRAPH}> { ?s <urn:p:tag> ?tag . } }`);
    expect(deleted.deleteDataset.quadCount).toBe(2);
    const noMatch = compile(`DELETE { GRAPH <${GRAPH}> { ?s <urn:p:none> ?value . } }
      WHERE { GRAPH <${GRAPH}> { ?s <urn:p:none> ?value . } }`);
    expect(noMatch.deleteDataset.quadCount).toBe(0);
    expect(noMatch.resultDataset.bytes).toEqual(base.bytes);
  });

  it('matches repeated variables consistently', () => {
    const repeated = compile(`INSERT { GRAPH <${GRAPH}> { ?s <urn:p:self> ?s . } }
      WHERE { GRAPH <${GRAPH}> { ?s <urn:p:name> ?s . } }`);
    expect(repeated.insertDataset.quadCount).toBe(0);
  });

  it.each([
    'SERVICE', 'LOAD', 'CLEAR', 'DROP', 'COPY', 'MOVE', 'ADD', 'CREATE', 'WITH', 'USING',
  ])('rejects unsafe operation keyword %s before evaluation', (keyword) => {
    expect(() => compile(`${keyword} <urn:x>`)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SPARQL_UNSAFE' }),
    );
  });

  it.each(['NOW', 'RAND', 'UUID', 'STRUUID', 'BNODE'])('rejects nondeterministic function %s', (fn) => {
    expect(() => compile(`INSERT { GRAPH <${GRAPH}> { ?s <urn:p> ?v . } }
      WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ${fn}() . } }`)).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SPARQL_UNSAFE' }),
    );
  });

  it('rejects every unsupported or escaping syntax class with stable codes', () => {
    const cases = [
      [`INSERT DATA { GRAPH ?g { <urn:s> <urn:p> "x" . } }`, 'WAL_RDF_SCOPE_ESCAPE'],
      [`INSERT DATA { GRAPH "literal" { <urn:s> <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${OTHER_GRAPH}> { <urn:s> <urn:p> "x" . } }`, 'WAL_RDF_SCOPE_ESCAPE'],
      [`INSERT DATA { GRAPH <${GRAPH}> { ?s <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { _:b <urn:p> "x" . } }`, 'WAL_RDF_BLANK_NODE'],
      [`INSERT DATA { <urn:s> <urn:p> "x" . }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { "s" <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { <urn:s> "p" "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { SUBJECT <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT { GRAPH <${GRAPH}> { ?unbound <urn:p> "x" . } } WHERE { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . } }`, 'WAL_RDF_UNBOUND_VARIABLE'],
      [`INSERT { GRAPH <${GRAPH}> { ?s <urn:p> STR(?v) . } } WHERE { GRAPH <${GRAPH}> { ?s <urn:p> ?v . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`PREFIX x: <urn:x> INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`ASK { GRAPH <${GRAPH}> { ?s ?p ?o . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" ; } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . } } DELETE DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`DELETE { } WHERE { }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT { GRAPH <${GRAPH}> { ?s <urn:p:x> ?v . } } WHERE { GRAPH <${GRAPH}> { ?s <urn:p:name> ?v . } } INSERT`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . } } @`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
      [`INSERT DATA { GRAPH <${GRAPH}> { ? <urn:p> "x" . } }`, 'WAL_RDF_SPARQL_UNSUPPORTED'],
    ] as const;
    for (const [sparql, code] of cases) {
      expect(() => compile(sparql), sparql).toThrow(expect.objectContaining({ code }));
    }
  });

  it('enforces source, solution, template, base, result, and option limits', () => {
    const insert = `INSERT DATA { GRAPH <${GRAPH}> { <urn:s:4> <urn:p> "x" . } }`;
    expect(() => compile(insert, { maximumSourceBytes: 1 })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => compile(`INSERT { GRAPH <${GRAPH}> { ?s <urn:p:x> ?v . } }
      WHERE { GRAPH <${GRAPH}> { ?s <urn:p:name> ?v . } }`, { maximumSolutions: 1 })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
    );
    expect(() => compile(`INSERT DATA { GRAPH <${GRAPH}> {
      <urn:s:4> <urn:p> "x" . <urn:s:5> <urn:p> "y" .
    } }`, { maximumQuads: 1 })).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    expect(() => compile(`DELETE DATA { GRAPH <${GRAPH}> { <urn:s:1> <urn:p:name> "one" . } }`, {
      maximumQuads: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
    for (const options of [
      { maximumSourceBytes: 0 }, { maximumSolutions: Number.NaN }, { maximumQuads: -1 },
    ]) {
      expect(() => compile(insert, options)).toThrow(
        expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }),
      );
    }
  });

  it('requires NFC source and canonicalizes optional audit bytes without executing them', () => {
    expect(() => compile('INSERT DATA { GRAPH <urn:g> { <urn:s> <urn:p> "Cafe\u0301" . } }'))
      .toThrow(expect.objectContaining({ code: 'WAL_RDF_SPARQL_UNSUPPORTED' }));
    expect(new TextDecoder().decode(canonicalSparqlAuditBytesV1('  INSERT DATA {}\r\n')))
      .toBe('INSERT DATA {}\n');
    expect(new TextDecoder().decode(canonicalSparqlAuditBytesV1(' \n '))).toBe('');
    expect(() => canonicalSparqlAuditBytesV1('Cafe\u0301')).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SPARQL_UNSUPPORTED' }),
    );
  });

  it('requires a non-empty unique exact graph scope', () => {
    const sparql = `INSERT DATA { GRAPH <${GRAPH}> { <urn:s> <urn:p> "x" . } }`;
    expect(() => compile(sparql, { allowedGraphIris: [] })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }),
    );
    expect(() => compile(sparql, { allowedGraphIris: [GRAPH, GRAPH] })).toThrow(
      expect.objectContaining({ code: 'WAL_RDF_SCOPE_ESCAPE' }),
    );
  });

  it('rejects a result that exceeds the bound even when base and explicit insert each fit', () => {
    const one = canonicalizeNQuadsV1(`<urn:s:1> <urn:p:name> "one" <${GRAPH}> .`);
    expect(() => compileLocalSparqlPatchV1({
      sparql: `INSERT DATA { GRAPH <${GRAPH}> { <urn:s:2> <urn:p:name> "two" . } }`,
      base: one,
      allowedGraphIris: [GRAPH],
      maximumQuads: 1,
    })).toThrow(expect.objectContaining({ code: 'WAL_RDF_LIMIT_EXCEEDED' }));
  });
});
