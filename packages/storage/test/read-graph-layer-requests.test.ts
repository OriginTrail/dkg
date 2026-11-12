import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BlazegraphStore } from '../src/adapters/blazegraph.js';
import { guardReadGraphPartition } from '../src/read-graph-partition-store.js';
import { wrapReadGraphLayer } from '../src/read-graph/read-graph-store.js';
import {
  BLAZEGRAPH_TEST_ENDPOINT,
  BLAZEGRAPH_WRITE_CASES,
  recordBlazegraphWrite,
} from './helpers/blazegraph-write-requests.js';

/**
 * The requests BlazegraphStore sends for each write method, recorded before the
 * read-graph layer existed (`blazegraph-write-requests.test.ts` keeps them).
 */
const TODAY: Readonly<Record<string, readonly string[]>> = JSON.parse(
  readFileSync(new URL('./fixtures/blazegraph-write-requests.json', import.meta.url), 'utf8'),
);

describe('read-graph layer on a store without read graphs', () => {
  it.each(BLAZEGRAPH_WRITE_CASES)('$name sends exactly the requests recorded without the layer', async (writeCase) => {
    const { requests, error } = await recordBlazegraphWrite((adapter) => {
      // As createTripleStore composes it: the layer above the adapter, the partition guard above the layer.
      const layer = wrapReadGraphLayer(adapter, { backend: 'blazegraph', options: { url: BLAZEGRAPH_TEST_ENDPOINT } });
      expect(layer.runtime.mirror.size).toBe(0);
      return writeCase.run(guardReadGraphPartition(layer) as unknown as BlazegraphStore);
    });
    expect(error).toBeUndefined();
    expect(requests).toEqual(TODAY[writeCase.name]);
  });
});
