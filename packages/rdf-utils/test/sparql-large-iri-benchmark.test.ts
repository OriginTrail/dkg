import { describe, expect, it, vi } from 'vitest';
import {
  prepareSparql,
  sparqlLexicalScannerTesting,
} from '../src/sparql-lexical-scanner.js';
import { scanSparqlIriRef } from '../src/sparql-lexical-primitives.js';

describe('large raw IRI scanner regression', () => {
  it('consumes the canonical scan result instead of traversing the IRI twice', () => {
    const body = `urn:large:${'segment/'.repeat(32_768)}tail`;
    const source = `SELECT * WHERE { GRAPH <${body}> { ?s ?p ?o } }`;
    let logicalValueReads = 0;
    const scanner = vi.fn<typeof scanSparqlIriRef>((value, start) => {
      const result = scanSparqlIriRef(value, start);
      if (result === null) return null;
      return {
        end: result.end,
        get logicalValue() {
          logicalValueReads += 1;
          return result.logicalValue;
        },
      };
    });

    const prepared = sparqlLexicalScannerTesting.prepareWithIriScanner(source, scanner);

    expect(prepared).toEqual(prepareSparql(source));
    expect(scanner).toHaveBeenCalledTimes(1);
    expect(logicalValueReads).toBe(1);
    expect(prepared.tokens.find((token) => token.kind === 'iri')).toMatchObject({
      kind: 'iri',
      logicalValue: body,
    });
  });
});
