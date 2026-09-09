// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { contextGraphWorkspaceMetaGraphUri } from '@origintrail-official/dkg-core';
import { BlazegraphStore, type Quad } from '@origintrail-official/dkg-storage';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  initializeRfc64LegacySwmBoundaryV1,
  readRfc64LegacySwmBoundaryCountV1,
} from '../src/rfc64/legacy-swm-boundary-v1.js';
import { legacySwmBoundaryFixtureQuadsV1 } from
  '../test/_helpers/legacy-swm-boundary-fixture.js';

const BLAZEGRAPH_URL = process.env.BLAZEGRAPH_TEST_URL;
const RUN = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const CONTEXT_GRAPH_ID =
  `0x1111111111111111111111111111111111111111/legacy-boundary-live-${RUN}`;
const META_GRAPH = contextGraphWorkspaceMetaGraphUri(CONTEXT_GRAPH_ID);
const LEGACY_HEAD_COUNT = 5_000;
const SHARE_MISMATCH_COUNT = 20_000;
const HISTORICAL_OPERATION_SUBJECTS = 317;
const HISTORICAL_SHARES_PER_OPERATION = 316;
const HISTORICAL_OPERATION_ROWS =
  HISTORICAL_OPERATION_SUBJECTS * HISTORICAL_SHARES_PER_OPERATION;
const FIXTURE_INSERT_BATCH_SIZE = 10_000;

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
    let batch: Quad[] = [];
    for (const quad of legacyBoundaryFixture()) {
      batch.push(quad);
      if (batch.length === FIXTURE_INSERT_BATCH_SIZE) {
        await store.insert(batch);
        batch = [];
      }
    }
    if (batch.length > 0) {
      await store.insert(batch);
    }
  }, 120_000);

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
      const querySpy = vi.spyOn(store, 'query');
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
      const captureReadCount = (source: string) => querySpy.mock.calls.filter(
        ([, options]) => options?.source === source,
      ).length;
      const firstHeadReadCount = captureReadCount(
        'agent.rfc64.legacySwmBoundary.readHeads',
      );
      expect(HISTORICAL_OPERATION_ROWS).toBeGreaterThan(100_000);
      expect(firstHeadReadCount).toBe(1);
      const captureQueries = querySpy.mock.calls.filter(([, options]) => (
        options?.source === 'agent.rfc64.legacySwmBoundary.readHeads'
      )).map(([sparql]) => sparql);
      expect(captureQueries).toHaveLength(1);
      expect(captureQueries[0]).toContain(
        'BIND(?operationUal AS ?ual)',
      );
      expect(captureQueries[0]!.match(
        /<http:\/\/dkg\.io\/ontology\/shareOperationId> \?shareId/g,
      )).toHaveLength(2);
      expect(captureQueries[0]).toContain('LIMIT 100001');

      // A second owner represents the next process start. It must load the
      // durable capture rather than repeat the capture query. The late-entry
      // marker read still runs on every start, so observe the sources directly.
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
      expect(captureReadCount(
        'agent.rfc64.legacySwmBoundary.readHeads',
      )).toBe(firstHeadReadCount);
    },
    30_000,
  );
});

function* legacyBoundaryFixture(): Generator<Quad> {
  for (let index = 0; index < LEGACY_HEAD_COUNT; index += 1) {
    const ual =
      `did:dkg:otp:20430/0x1111111111111111111111111111111111111111/${index + 1}`;
    const operation = `urn:dkg:workspace-operation:live-boundary:${RUN}:${index}`;
    const shareOperationId = `live-boundary-share-${index}`;
    yield* legacySwmBoundaryFixtureQuadsV1({
      graph: META_GRAPH,
      contextGraphId: CONTEXT_GRAPH_ID,
      ual,
      operation,
      head: { shareOperationId },
      operationShareOperationIds: [shareOperationId],
    });
  }
  // These look like legacy heads and have WorkspaceOperations, but their share
  // IDs do not match. They must not consume either semantic capture limit.
  for (let index = 0; index < SHARE_MISMATCH_COUNT; index += 1) {
    const kaNumber = LEGACY_HEAD_COUNT + index + 1;
    const ual =
      `did:dkg:otp:20430/0x1111111111111111111111111111111111111111/${kaNumber}`;
    const operation = `urn:dkg:workspace-operation:mismatch:${RUN}:${index}`;
    yield* legacySwmBoundaryFixtureQuadsV1({
      graph: META_GRAPH,
      contextGraphId: CONTEXT_GRAPH_ID,
      ual,
      operation,
      head: {
        shareOperationId: `unrelated-live-boundary-share-${index}`,
      },
      operationShareOperationIds: [
        `mismatched-operation-share-${index}`,
      ],
    });
  }
  // More than 100,000 concrete operation solutions target the first UAL, but
  // every historical share differs from its current head. The exact join must
  // discard all of them before DISTINCT and the 100,000-head limit.
  const historicalUal =
    'did:dkg:otp:20430/0x1111111111111111111111111111111111111111/1';
  for (
    let operationIndex = 0;
    operationIndex < HISTORICAL_OPERATION_SUBJECTS;
    operationIndex += 1
  ) {
    const operation =
      `urn:dkg:workspace-operation:history:${RUN}:${operationIndex}`;
    yield* legacySwmBoundaryFixtureQuadsV1({
      graph: META_GRAPH,
      contextGraphId: CONTEXT_GRAPH_ID,
      ual: historicalUal,
      operation,
      operationShareOperationIds: Array.from(
        { length: HISTORICAL_SHARES_PER_OPERATION },
        (_, shareIndex) => (
          `historical-share-${operationIndex}-${shareIndex}`
        ),
      ),
    });
  }
}
