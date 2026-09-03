import { describe, expect, it } from 'vitest';
import {
  prepareSparql,
  type PreparedSparql,
  type ValidPreparedSparql,
} from '../src/sparql-lexical-scanner.js';
import { prepareSparqlQuery } from '../src/sparql-query.js';

function validPrepared(source: string): ValidPreparedSparql {
  const prepared = prepareSparql(source);
  if (prepared.status !== 'valid') throw new Error('expected valid prepared SPARQL');
  return prepared;
}

describe('prepared SPARQL query facts', () => {
  it('accepts the canonical valid lexical artifact as its sole source owner', () => {
    const source = 'SELECT ?s WHERE { ?s <urn:p> ?o }';
    const prepared = validPrepared(source);
    const fromArtifact = prepareSparqlQuery(prepared);

    expect(fromArtifact.prepared).toBe(prepared);
    expect(fromArtifact.source).toBe(prepared.source);
  });

  it('owns raw source coordinates and UCHAR-decoded variable identities', () => {
    const source = String.raw`SELECT ?\u0073 WHERE \u007B ?\u0073 <urn:p> ?o \u007D`;
    const query = prepareSparqlQuery(validPrepared(source));

    expect(query.source).toBe(source);
    expect(query.operation).toBe('SELECT');
    expect(query.where).toMatchObject({
      openStart: source.indexOf(String.raw`\u007B`),
      openEnd: source.indexOf(String.raw`\u007B`) + String.raw`\u007B`.length,
      close: source.indexOf(String.raw`\u007D`),
    });
    expect(query.queryVariables).toEqual([
      { source: String.raw`?\u0073`, logicalName: 's' },
      { source: '?o', logicalName: 'o' },
    ]);
  });

  it('recognizes shorthand groups without inventing a WHERE keyword', () => {
    const query = prepareSparqlQuery(validPrepared('ASK { ?s <urn:p> ?o }'));

    expect(query.operation).toBe('ASK');
    expect(query.where).toMatchObject({ hasUnion: false });
    expect(query.whereVariables).toEqual([
      { source: '?s', logicalName: 's' },
      { source: '?o', logicalName: 'o' },
    ]);
  });

  it('does not type malformed lexical artifacts as prepared queries', () => {
    type Malformed = Extract<PreparedSparql, { status: 'malformed-uchar' }>;
    type QueryPreparationAcceptsMalformed = Malformed extends Parameters<
      typeof prepareSparqlQuery
    >[0] ? true : false;
    const queryPreparationAcceptsMalformed: QueryPreparationAcceptsMalformed = false;

    expect(queryPreparationAcceptsMalformed).toBe(false);
    expect(prepareSparql(String.raw`SELECT ?\u00ZZ WHERE {}`).status)
      .toBe('malformed-uchar');
  });
});
