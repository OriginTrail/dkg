import { describe, expect, it } from 'vitest';

import {
  RFC64_AUTHOR_SEAL_READ_QUERY_ID_V1,
  compileRfc64AuthorSealReadOperationV1,
  deriveCanonicalGraphScopedAuthorSealPlacementV1,
  type CanonicalGraphScopedAuthorSealCoordinateV1,
} from '../src/index.js';

const COORDINATE = Object.freeze({
  contextGraphId: '0x0123456789abcdef0123456789abcdef01234567/14',
  subGraphName: null,
  authorAddress: '0x89abcdef0123456789abcdef0123456789abcdef',
  assertionCoordinate: 'research',
}) as CanonicalGraphScopedAuthorSealCoordinateV1;

describe('RFC-64 author-seal read manifest v1', () => {
  it('derives one exact bounded query from the authenticated coordinate', () => {
    const operation = compileRfc64AuthorSealReadOperationV1({ coordinate: COORDINATE });
    const placement = deriveCanonicalGraphScopedAuthorSealPlacementV1(COORDINATE);
    expect(operation).toEqual({
      queryId: RFC64_AUTHOR_SEAL_READ_QUERY_ID_V1,
      coordinate: COORDINATE,
      graphIri: placement.metaGraph,
      subjectIri: placement.subject,
      resultKind: 'bindings',
      resultVariables: ['p', 'o'],
      minimumRowCount: 14,
      maximumRowCount: 15,
      rowCeiling: 16,
      responseByteCeiling: 64 * 1024,
      concurrencyClass: 'rfc64-author-seal-v1',
      sparql: `SELECT ?p ?o\nWHERE {\n  GRAPH <${placement.metaGraph}> {\n`
        + `    <${placement.subject}> ?p ?o .\n  }\n}\nLIMIT 16`,
    });
    expect(Object.isFrozen(operation)).toBe(true);
    expect(Object.isFrozen(operation.coordinate)).toBe(true);
  });

  it('rejects raw query controls and accessor-backed coordinates without invoking them', () => {
    expect(() => compileRfc64AuthorSealReadOperationV1({
      coordinate: COORDINATE,
      sparql: 'SELECT * WHERE { GRAPH ?g { ?s ?p ?o } }',
    })).toThrow(/invalid field set/u);

    let invoked = false;
    const coordinate = { ...COORDINATE } as Record<string, unknown>;
    Object.defineProperty(coordinate, 'authorAddress', {
      enumerable: true,
      get() {
        invoked = true;
        return COORDINATE.authorAddress;
      },
    });
    expect(() => compileRfc64AuthorSealReadOperationV1({ coordinate }))
      .toThrow(/invalid field set/u);
    expect(invoked).toBe(false);
  });
});
