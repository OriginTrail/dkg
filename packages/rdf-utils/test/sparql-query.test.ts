import { describe, expect, it } from 'vitest';
import { prepareSparql } from '../src/sparql-lexical-scanner.js';
import { prepareSparqlQuery } from '../src/sparql-query.js';

describe('prepared SPARQL query facts', () => {
  it('accepts either source text or its canonical lexical artifact', () => {
    const source = 'SELECT ?s WHERE { ?s <urn:p> ?o }';
    const prepared = prepareSparql(source);
    const fromArtifact = prepareSparqlQuery(prepared);

    expect(fromArtifact).toEqual(prepareSparqlQuery(source));
    expect(fromArtifact.prepared).toBe(prepared);
    expect(fromArtifact.source).toBe(prepared.source);
  });

  it('owns raw source coordinates and UCHAR-decoded variable identities', () => {
    const source = String.raw`SELECT ?\u0073 WHERE \u007B ?\u0073 <urn:p> ?o \u007D`;
    const query = prepareSparqlQuery(prepareSparql(source));

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
    const query = prepareSparqlQuery('ASK { ?s <urn:p> ?o }');

    expect(query.operation).toBe('ASK');
    expect(query.where).toMatchObject({ hasUnion: false });
    expect(query.whereVariables).toEqual([
      { source: '?s', logicalName: 's' },
      { source: '?o', logicalName: 'o' },
    ]);
  });

  it('returns empty query facts for malformed UCHAR input', () => {
    const query = prepareSparqlQuery(String.raw`SELECT ?\u00ZZ WHERE {}`);

    expect(query.prepared.status).toBe('malformed-uchar');
    expect(query.operation).toBeNull();
    expect(query.where).toBeNull();
    expect(query.queryVariables).toEqual([]);
  });
});
