import { describe, expect, it } from 'vitest';

import { readNextSparqlCodeToken } from '../src/sparql-utils.js';

describe('readNextSparqlCodeToken', () => {
  it('reports semantic terms and structural characters honestly', () => {
    const sparql = 'ex:subject ?s { GRAPH';
    const tokens = [];
    let cursor = 0;

    for (let token = readNextSparqlCodeToken(sparql, cursor); token !== null;
      token = readNextSparqlCodeToken(sparql, cursor)) {
      tokens.push(token);
      cursor = token.end;
    }

    expect(tokens).toEqual([
      {
        kind: 'prefixedName',
        prefixedName: { prefix: 'ex', local: 'subject', length: 10 },
        start: 0,
        end: 10,
      },
      { kind: 'variable', variable: '?s', start: 11, end: 13 },
      { kind: 'char', value: '{', start: 14, end: 15 },
      { kind: 'word', word: 'GRAPH', start: 16, end: 21 },
    ]);
  });
});
