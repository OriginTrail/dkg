// SPDX-License-Identifier: Apache-2.0

import { encodeCanonicalCgSharedPublicRootProjectionV1 } from '@origintrail-official/dkg-core';
import {
  BlazegraphStore,
  quadsToNQuads,
  readExactGraphPaged,
  tryReplaceGraphAndSubjectAtomically,
  type Quad,
} from '@origintrail-official/dkg-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseNQuads } from '../src/dkg-agent-utils.js';
import {
  projectionReadBackByteLimitV1,
  readBackHoldsProjectionV1,
} from '../src/rfc64/projection-store-read-back-v1.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SUBJECT = `urn:dkg:test:projection-read-back:${RUN}:asset`;
const GRAPH = `urn:dkg:test:projection-read-back:${RUN}:swm`;
const CHANGED_GRAPH = `urn:dkg:test:projection-read-back:${RUN}:changed`;
const META_GRAPH = `urn:dkg:test:projection-read-back:${RUN}:meta`;
const SEAL_SUBJECT = `urn:dkg:test:projection-read-back:${RUN}:seal`;
const typed = (value: string, datatype: string) => `"${value}"^^<${XSD}${datatype}>`;

/** One asset as an author writes it: a name, times, readings and a text with tabs. */
const ASSET = [
  { subject: SUBJECT, predicate: 'https://schema.org/name', object: '"A shared asset"' },
  { subject: SUBJECT, predicate: 'https://schema.org/dateCreated', object: typed('2026-10-12T13:08:51Z', 'dateTime') },
  { subject: SUBJECT, predicate: 'https://schema.org/dateModified', object: typed('2026-10-12T15:08:51+02:00', 'dateTime') },
  { subject: SUBJECT, predicate: 'https://schema.org/value', object: typed('100', 'double') },
  { subject: SUBJECT, predicate: 'https://schema.org/ratingValue', object: typed('5', 'float') },
  { subject: SUBJECT, predicate: 'https://schema.org/duration', object: typed('PT1H', 'duration') },
  { subject: SUBJECT, predicate: 'https://schema.org/position', object: typed('42', 'integer') },
  { subject: SUBJECT, predicate: 'https://schema.org/text', object: '"column one\\tcolumn two\\tcolumn three"' },
];

/** The receiver's own steps: write the verified projection, then read it back. */
async function writeProjection(
  store: BlazegraphStore,
  graph: string,
  projectionText: string,
): Promise<Quad[]> {
  const quads = parseNQuads(projectionText);
  const replaced = await tryReplaceGraphAndSubjectAtomically(
    store,
    graph,
    quads.map((quad) => ({ ...quad, graph })),
    META_GRAPH,
    SEAL_SUBJECT,
    [{ subject: SEAL_SUBJECT, predicate: 'https://example.org/sealed', object: '"1"', graph: META_GRAPH }],
    { source: 'test-projection-read-back' },
  );
  expect(replaced).toBe(true);
  return quads;
}

describe('reading a canonical projection back (live Blazegraph)', () => {
  let store: BlazegraphStore;
  let projectionBytes: Uint8Array;
  let projectionText: string;

  beforeAll(async () => {
    if (!BLAZEGRAPH_URL) {
      throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    }
    store = new BlazegraphStore(BLAZEGRAPH_URL, { timeout: 15_000 });
    projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(ASSET);
    projectionText = new TextDecoder().decode(projectionBytes);
    await writeProjection(store, GRAPH, projectionText);
  }, 60_000);

  afterAll(async () => {
    if (!store) return;
    for (const graph of [GRAPH, CHANGED_GRAPH, META_GRAPH]) {
      await store.dropGraph(graph).catch(() => {});
    }
    await store.close().catch(() => {});
  });

  const readBack = (graph: string, maxNQuadsBytes: number): Promise<Quad[]> => readExactGraphPaged(store, graph, {
    expectedQuadCount: ASSET.length,
    maxQuadCount: ASSET.length,
    maxNQuadsBytes,
    outputGraph: '',
    queryOptions: { source: 'test-projection-read-back' },
  });

  it('fails a read that is limited to the projection bytes', async () => {
    await expect(readBack(GRAPH, projectionBytes.byteLength))
      .rejects.toMatchObject({ code: 'NQUADS_BYTE_LIMIT_EXCEEDED' });
  });

  it('reads the projection back within the allowance, in the lexical form of the store', async () => {
    const quads = await readBack(GRAPH, projectionReadBackByteLimitV1(projectionText, ASSET.length));
    const stored = new Map(quads.map((quad) => [quad.predicate, quad.object]));

    // The projection carries the tabs themselves; the store returns them escaped.
    expect(projectionText).toContain('"column one\tcolumn two\tcolumn three"');
    expect(stored.get('https://schema.org/text')).toBe('"column one\\tcolumn two\\tcolumn three"');

    expect(stored.get('https://schema.org/dateCreated')).toBe(typed('2026-10-12T13:08:51.000Z', 'dateTime'));
    expect(stored.get('https://schema.org/dateModified')).toBe(typed('2026-10-12T13:08:51.000Z', 'dateTime'));
    expect(stored.get('https://schema.org/value')).toBe(typed('100.0', 'double'));
    expect(stored.get('https://schema.org/ratingValue')).toBe(typed('5.0', 'float'));
    expect(`${quadsToNQuads(quads)}\n`).not.toBe(projectionText);
    expect(readBackHoldsProjectionV1(projectionBytes, quads)).toBe(true);
  });

  it('tells a changed value apart', async () => {
    const changedText = projectionText.replace('2026-10-12T13:08:51Z', '2026-10-12T13:08:52Z');
    expect(changedText).not.toBe(projectionText);
    await writeProjection(store, CHANGED_GRAPH, changedText);

    const quads = await readBack(CHANGED_GRAPH, projectionReadBackByteLimitV1(changedText, ASSET.length));
    expect(readBackHoldsProjectionV1(projectionBytes, quads)).toBe(false);
  });
});
