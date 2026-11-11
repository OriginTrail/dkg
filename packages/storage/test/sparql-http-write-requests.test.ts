import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  recordSparqlHttpWrite,
  SPARQL_HTTP_WRITE_CASES,
} from './helpers/sparql-http-write-requests.js';

/**
 * The requests SparqlHttpStore sends for each write method, recorded on the
 * base of this change with `recordSparqlHttpWrite`. A write that carries no
 * read-graph operations must keep sending exactly these requests.
 */
const TODAY: Readonly<Record<string, readonly string[]>> = JSON.parse(
  readFileSync(new URL('./fixtures/sparql-http-write-requests.json', import.meta.url), 'utf8'),
);

describe('SparqlHttpStore write requests', () => {
  it('records every write case once', () => {
    expect(Object.keys(TODAY).sort()).toEqual(SPARQL_HTTP_WRITE_CASES.map((c) => c.name).sort());
  });

  it.each(SPARQL_HTTP_WRITE_CASES)('$name sends the recorded requests', async (writeCase) => {
    const { requests, error } = await recordSparqlHttpWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY[writeCase.name]);
  });
});
