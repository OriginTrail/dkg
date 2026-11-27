import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { sparqlString } from '@origintrail-official/dkg-core';
import { DKGQueryEngine } from '../src/dkg-query-engine.js';

describe('DKGQueryEngine UCHAR integration', () => {
  it.each([
    [String.raw`"\u0022"`, '"'],
    [String.raw`'\u0022'`, '"'],
    [String.raw`"""\u0022"""`, '"'],
    [String.raw`'''\u0022'''`, '"'],
    [String.raw`"\u005C"`, '\\'],
    [String.raw`'\u005C'`, '\\'],
    [String.raw`"""\u000A"""`, '\n'],
    [String.raw`'''\u000A'''`, '\n'],
  ])('executes raw UCHAR literal payload without promoting it to syntax: %s', async (
    literal,
    expected,
  ) => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const result = await engine.query(`SELECT ?x WHERE { BIND(${literal} AS ?x) }`);

    expect(result.bindings).toEqual([{ x: sparqlString(expected) }]);
  });

  it.each([
    String.raw`\u00ZZ`,
    String.raw`\u006E`,
  ])('round-trips a sparqlString UCHAR lookalike: %s', async (value) => {
    const store = new OxigraphStore();
    const engine = new DKGQueryEngine(store);

    const result = await engine.query(
      `SELECT ?value WHERE { BIND(${sparqlString(value)} AS ?value) }`,
    );

    expect(result.bindings).toEqual([{ value: sparqlString(value) }]);
  });
});
