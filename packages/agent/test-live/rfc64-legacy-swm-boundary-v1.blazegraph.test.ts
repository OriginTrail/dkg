// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  initializeRfc64LegacySwmBoundaryV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CONTEXT_GRAPH_ID =
  `0x1111111111111111111111111111111111111111/legacy-boundary-live-${RUN}`;
const META_GRAPH = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID);
const LEGACY_HEAD_COUNT = 5_000;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const KA_UAL = 'http://dkg.io/ontology/kaUal';
const SHARE_OPERATION_ID = 'http://dkg.io/ontology/shareOperationId';
const CONTEXT_GRAPH_ID_PREDICATE = 'http://dkg.io/ontology/contextGraphId';
const WORKSPACE_OPERATION = 'http://dkg.io/ontology/WorkspaceOperation';

describe('RFC-64 legacy SWM boundary (live Blazegraph)', () => {
  let store: BlazegraphStore;
  let persistenceRoot: string;

  beforeAll(async () => {
    if (!BLAZEGRAPH_URL) {
      throw new Error('BLAZEGRAPH_TEST_URL is required for the live Blazegraph suite');
    }
    store = new BlazegraphStore(BLAZEGRAPH_URL, { timeout: 15_000 });
    persistenceRoot = await mkdtemp(join(tmpdir(), 'dkg-rfc64-boundary-blazegraph-'));
    await chmod(persistenceRoot, 0o700);
    await store.dropGraph(META_GRAPH);
    await store.insert(legacyBoundaryFixture());
  }, 60_000);

  afterAll(async () => {
    if (store) {
      await store.dropGraph(META_GRAPH).catch(() => {});
      await store.close().catch(() => {});
    }
    if (persistenceRoot) {
      await rm(persistenceRoot, { recursive: true, force: true });
    }
  });

  it(
    'completes the first-upgrade capture under the store deadline and reuses it on restart',
    async () => {
      const firstOwner = {};
      await initializeRfc64LegacySwmBoundaryV1(
        firstOwner,
        persistenceRoot,
        store,
      );
      expect(readRfc64LegacySwmBoundaryCountV1(
        firstOwner,
        CONTEXT_GRAPH_ID,
      )).toBe(LEGACY_HEAD_COUNT);

      // A second owner represents the next process start. It must load the
      // durable capture rather than repeat the production-sized head scan.
      const restartedOwner = {};
      await initializeRfc64LegacySwmBoundaryV1(
        restartedOwner,
        persistenceRoot,
        store,
      );
      expect(readRfc64LegacySwmBoundaryCountV1(
        restartedOwner,
        CONTEXT_GRAPH_ID,
      )).toBe(LEGACY_HEAD_COUNT);
    },
    30_000,
  );
});

function legacyBoundaryFixture(): Quad[] {
  const quads: Quad[] = [];
  for (let index = 0; index < LEGACY_HEAD_COUNT; index += 1) {
    const ual =
      `did:dkg:otp:20430/0x1111111111111111111111111111111111111111/${index + 1}`;
    const head = `${ual}#dkg-swm-head`;
    const operation = `urn:dkg:workspace-operation:live-boundary:${RUN}:${index}`;
    const shareOperationId = JSON.stringify(`live-boundary-share-${index}`);
    quads.push(
      { graph: META_GRAPH, subject: head, predicate: KA_UAL, object: ual },
      {
        graph: META_GRAPH,
        subject: head,
        predicate: SHARE_OPERATION_ID,
        object: shareOperationId,
      },
      {
        graph: META_GRAPH,
        subject: operation,
        predicate: RDF_TYPE,
        object: WORKSPACE_OPERATION,
      },
      { graph: META_GRAPH, subject: operation, predicate: KA_UAL, object: ual },
      {
        graph: META_GRAPH,
        subject: operation,
        predicate: SHARE_OPERATION_ID,
        object: shareOperationId,
      },
      {
        graph: META_GRAPH,
        subject: operation,
        predicate: CONTEXT_GRAPH_ID_PREDICATE,
        object: JSON.stringify(CONTEXT_GRAPH_ID),
      },
    );
  }
  return quads;
}
