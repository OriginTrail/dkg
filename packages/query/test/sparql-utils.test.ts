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

  it('keeps dotted prefix labels inside one prefixed-name token', () => {
    const sparql = 'drop.core:value graph.core:edge from.core:item';
    const tokens = [];
    let cursor = 0;

    for (let token = readNextSparqlCodeToken(sparql, cursor); token !== null;
      token = readNextSparqlCodeToken(sparql, cursor)) {
      tokens.push(token);
      cursor = token.end;
    }

    expect(tokens.map((token) => token.kind === 'prefixedName'
      ? `${token.prefixedName.prefix}:${token.prefixedName.local}`
      : token.kind)).toEqual([
      'drop.core:value',
      'graph.core:edge',
      'from.core:item',
    ]);
  });

  it('keeps adjacent comments and statement separators outside prefixed names', () => {
    const sparql = 'ex:o# GRAPH <urn:forbidden>\n. ex:escaped\\#value . ex:tail.]';
    const tokens = [];
    let cursor = 0;

    for (let token = readNextSparqlCodeToken(sparql, cursor); token !== null;
      token = readNextSparqlCodeToken(sparql, cursor)) {
      tokens.push(token);
      cursor = token.end;
    }

    expect(tokens.map((token) => {
      if (token.kind === 'prefixedName') {
        return `prefixed:${token.prefixedName.prefix}:${token.prefixedName.local}`;
      }
      if (token.kind === 'word') return `word:${token.word}`;
      if (token.kind === 'char') return `char:${token.value}`;
      return token.kind;
    })).toEqual([
      'prefixed:ex:o',
      'char:.',
      'prefixed:ex:escaped\\#value',
      'char:.',
      'prefixed:ex:tail',
      'char:.',
      'char:]',
    ]);
  });
});
