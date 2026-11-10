import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BLAZEGRAPH_WRITE_CASES,
  recordBlazegraphWrite,
} from './helpers/blazegraph-write-requests.js';

/**
 * The requests BlazegraphStore sends for each write method, recorded on the
 * base of this change with `recordBlazegraphWrite`. A write that carries no
 * read-graph operations must keep sending exactly these requests.
 */
const TODAY: Readonly<Record<string, readonly string[]>> = JSON.parse(
  readFileSync(new URL('./fixtures/blazegraph-write-requests.json', import.meta.url), 'utf8'),
);

describe('BlazegraphStore write requests', () => {
  it('records every write case once', () => {
    expect(Object.keys(TODAY).sort()).toEqual(BLAZEGRAPH_WRITE_CASES.map((c) => c.name).sort());
  });

  it.each(BLAZEGRAPH_WRITE_CASES)('$name sends the recorded requests', async (writeCase) => {
    const { requests, error } = await recordBlazegraphWrite((store) => writeCase.run(store));
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY[writeCase.name]);
  });
});
