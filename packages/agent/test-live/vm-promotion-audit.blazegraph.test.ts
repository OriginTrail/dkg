// SPDX-License-Identifier: Apache-2.0

import { contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore } from '@origintrail-official/dkg-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { storageAckPromotedBatchQuery } from '../src/vm-promotion-audit.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const NAMESPACE = `ack-batch-live-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const META_GRAPH = contextGraphMetaUri(NAMESPACE);
const DKG = 'http://dkg.io/ontology/';
const INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

describe('VM promotion audit batch query (live Blazegraph)', () => {
  let store: BlazegraphStore;

  beforeAll(async () => {
    if (!BLAZEGRAPH_URL) throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    store = new BlazegraphStore(BLAZEGRAPH_URL);
    await store.insert([1, 2, 3].flatMap((number) => [
      {
        subject: `urn:ka:${NAMESPACE}:${number}`,
        predicate: `${DKG}status`,
        object: '"confirmed"',
        graph: META_GRAPH,
      },
      {
        subject: `urn:ka:${NAMESPACE}:${number}`,
        predicate: `${DKG}assertionVersion`,
        object: `"${number === 2 ? 1 : 2}"^^<${INTEGER}>`,
        graph: META_GRAPH,
      },
    ]));
  });

  afterAll(async () => {
    if (store) {
      await store.dropGraph(META_GRAPH).catch(() => {});
      await store.close().catch(() => {});
    }
  });

  it('matches confirmed versions within their exact graph', async () => {
    const candidates = [1, 2, 3, 4].map((number) => ({
      operationSubject: `urn:op:${NAMESPACE}:${number}`,
      namespace: NAMESPACE,
      kaUal: `urn:ka:${NAMESPACE}:${number}`,
      assertionVersion: BigInt(number === 2 ? 2 : 1),
      signedAtMs: 0,
      registered: false,
    }));
    const result = await store.query(storageAckPromotedBatchQuery(candidates));

    expect(result).toMatchObject({ type: 'bindings' });
    if (result.type !== 'bindings') throw new Error('Expected bindings');
    expect(result.bindings.map((row) => row['op']).sort()).toEqual([
      candidates[0]!.operationSubject,
      candidates[2]!.operationSubject,
    ]);
  });
});
