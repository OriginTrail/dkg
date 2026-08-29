/**
 * Live Blazegraph oracle for the RFC-64 exact shared-projection stream.
 * CI supplies BLAZEGRAPH_TEST_URL; ordinary local runs skip this cell.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BlazegraphStore,
  SyncSharedProjectionStoreV1,
} from '../src/index.js';
import type { Quad } from '../src/triple-store.js';
import { createRfc64SharedProjectionTestFixture } from './helpers/rfc64-shared-projection-fixture.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const CONTEXT_GRAPH = `0x0123456789abcdef0123456789abcdef01234567/${Date.now()}`;
const FIXTURE = createRfc64SharedProjectionTestFixture({
  contextGraphId: CONTEXT_GRAPH,
  assertionCoordinate: 'live-blazegraph',
});
const PROJECTION_BYTES = FIXTURE.projectionBytes;
const REQUEST = FIXTURE.request;
const OPERATION = FIXTURE.operation;
const UNRELATED_GRAPHS = Array.from(
  { length: 4 },
  (_, index) => `urn:rfc64-live-blazegraph:${Date.now()}:${index}`,
);

describe.skipIf(!BLAZEGRAPH_URL)('RFC-64 shared-projection stream (live Blazegraph)', () => {
  let store: BlazegraphStore;

  beforeAll(async () => {
    store = new BlazegraphStore(BLAZEGRAPH_URL as string, { timeout: 10_000 });
    await cleanup();
  }, 30_000);

  afterAll(async () => {
    if (!store) return;
    await cleanup();
    await store.close();
  });

  it('returns exact verified bytes at 1x and with 10x unrelated named-graph state', async () => {
    await store.insert([
      quad('urn:z', '"zeta"', OPERATION.graphIri),
      quad('urn:a', '"alpha"', OPERATION.graphIri),
    ]);
    const gateway = new SyncSharedProjectionStoreV1(store);

    const oneX = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5_000,
    });
    expect(await collect(oneX.bytes)).toEqual(PROJECTION_BYTES);

    await store.insert(Array.from({ length: 20 }, (_, index) => (
      quad(`urn:unrelated:${index}`, `"${index}"`, UNRELATED_GRAPHS[index % 4])
    )));
    const tenX = await gateway.open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5_000,
    });
    expect(await collect(tenX.bytes)).toEqual(PROJECTION_BYTES);
    expect(await store.countQuads(OPERATION.graphIri)).toBe(2);
  }, 30_000);

  it('honors pre-dispatch caller cancellation through the public gateway', async () => {
    const abort = new AbortController();
    const reason = new DOMException('live caller cancelled', 'AbortError');
    abort.abort(reason);
    const result = await new SyncSharedProjectionStoreV1(store).open(REQUEST, {
      operatorByteCeiling: 4096,
      timeoutMs: 5_000,
      signal: abort.signal,
    });

    await expect(collect(result.bytes)).rejects.toBe(reason);
  });

  async function cleanup(): Promise<void> {
    await Promise.all([
      store.dropGraph(OPERATION.graphIri).catch(() => undefined),
      ...UNRELATED_GRAPHS.map((graph) => store.dropGraph(graph).catch(() => undefined)),
    ]);
  }
});

function quad(subject: string, object: string, graph: string): Quad {
  return Object.freeze({ subject, predicate: 'urn:p', object, graph });
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
