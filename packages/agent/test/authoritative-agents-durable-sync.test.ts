// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import {
  contextGraphDataUri,
  createOperationContext,
  SYSTEM_CONTEXT_GRAPHS,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import {
  getSyncCheckpointKey,
  MemorySyncCheckpointStore,
} from '../src/sync/checkpoint/state.js';
import { AuthoritativeGraphSnapshotMaterializer } from '../src/sync/requester/authoritative-graph-snapshot.js';
import type { SyncPageResult } from '../src/sync/requester/page-fetch.js';

const contextGraphId = SYSTEM_CONTEXT_GRAPHS.AGENTS;
const graph = contextGraphDataUri(contextGraphId);
const remotePeerId = '12D3KooWAuthoritativeAgentsPeer';
const checkpointKey = getSyncCheckpointKey(
  remotePeerId,
  contextGraphId,
  false,
  'data',
);

function agentQuad(id: string): Quad {
  return {
    subject: `did:dkg:agent:${id}`,
    predicate: 'http://dkg.io/ontology/peerId',
    object: `"peer-${id}"`,
    graph,
  };
}

function page(input: {
  quads: Quad[];
  resumedFromOffset: number;
  nextOffset: number;
  completed: boolean;
  timedOut: boolean;
}): SyncPageResult {
  return {
    ...input,
    rawResumedFromOffset: input.resumedFromOffset,
    rawNextOffset: input.nextOffset,
    bytesReceived: input.quads.length,
    checkpointKey,
  };
}

function createHarness(responses: SyncPageResult[]) {
  const syncCheckpoints = new MemorySyncCheckpointStore();
  const authoritativeAgentSnapshots = new AuthoritativeGraphSnapshotMaterializer(
    syncCheckpoints,
  );
  const obsolete = agentQuad('obsolete');
  let live = [obsolete];
  const replaceGraph = vi.fn(async (_graph: string, quads: readonly Quad[]) => {
    live = [...quads];
  });
  let responseIndex = 0;
  const agentLike: any = {
    config: { syncAgentsMeta: false },
    store: { replaceGraph },
    syncCheckpoints,
    authoritativeAgentSnapshots,
    fetchSyncPages: async (
      _ctx: unknown,
      _peerId: string,
      _contextGraphId: string,
      _includeSharedMemory: boolean,
      phase: 'data' | 'meta',
    ) => {
      if (phase !== 'data') throw new Error(`Unexpected ${phase} fetch`);
      const response = responses[responseIndex++];
      if (!response) throw new Error('No controlled DATA response remains');
      syncCheckpoints.setResponderSession(
        response.checkpointKey,
        'immutable-agents-session',
        Date.now() + 60_000,
        Date.now(),
        undefined,
        undefined,
        response.rawNextOffset ?? response.nextOffset,
      );
      return response;
    },
    processDurableBatchInWorker: async (dataQuads: Quad[], metaQuads: Quad[]) => ({
      verifiedData: dataQuads,
      verifiedMeta: metaQuads,
      consumedUnpersistedMetaTriples: 0,
      totalFetchedDataQuads: dataQuads.length,
      totalFetchedMetaQuads: metaQuads.length,
      rejectedKcs: 0,
      emptyResponses: dataQuads.length === 0 && metaQuads.length === 0 ? 1 : 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
    }),
    insertSyncedQuadsAndInvalidateListCache: vi.fn(async () => {}),
    oversizeTombstoneLog: { record: vi.fn() },
    invalidateListContextGraphsCache: vi.fn(),
    contextGraphMetaProjection: { markDirtyFromQuads: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const run = () => LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraph.call(
    agentLike,
    createOperationContext('sync'),
    remotePeerId,
    contextGraphId,
    1,
  );
  return {
    run,
    replaceGraph,
    syncCheckpoints,
    authoritativeAgentSnapshots,
    live: () => live,
  };
}

describe('authoritative AGENTS durable snapshot materialization', () => {
  it('discards retained bytes when the responder session is superseded', async () => {
    const checkpoints = new MemorySyncCheckpointStore();
    const materializer = new AuthoritativeGraphSnapshotMaterializer(checkpoints);
    const partial = page({
      quads: [agentQuad('partial')],
      resumedFromOffset: 0,
      nextOffset: 1,
      completed: false,
      timedOut: true,
    });
    checkpoints.setResponderSession(
      checkpointKey,
      'session-a',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      1,
    );
    await materializer.materialize({
      page: partial,
      verifiedQuads: partial.quads,
      retainablePrefix: true,
      completeSnapshot: false,
      commit: vi.fn(),
    });
    checkpoints.set(checkpointKey, 1, Date.now(), 1);
    checkpoints.setResponderSession(
      checkpointKey,
      'session-b',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      1,
    );

    materializer.prepareFetch(checkpointKey);

    expect(materializer.retainedTriples(checkpointKey)).toBe(0);
    expect(checkpoints.get(checkpointKey)).toBeUndefined();
  });

  it('installs a complete zero-offset snapshot and reports committed rows', async () => {
    const fresh = agentQuad('fresh');
    const harness = createHarness([page({
      quads: [fresh],
      resumedFromOffset: 0,
      nextOffset: 1,
      completed: true,
      timedOut: false,
    })]);

    const result = await harness.run();

    expect(result.complete).toBe(true);
    expect(result.insertedTriples).toBe(1);
    expect(result.insertedDataTriples).toBe(1);
    expect(harness.replaceGraph).toHaveBeenCalledTimes(1);
    expect(harness.live()).toEqual([fresh]);
  });

  it('refuses a completed nonzero suffix when no matching prefix is retained', async () => {
    const suffix = agentQuad('suffix-only');
    const response = page({
      quads: [suffix],
      resumedFromOffset: 50,
      nextOffset: 51,
      completed: true,
      timedOut: false,
    });
    const harness = createHarness([response]);
    harness.syncCheckpoints.set(checkpointKey, 50, Date.now(), 50);
    harness.syncCheckpoints.setResponderSession(
      checkpointKey,
      'immutable-agents-session',
      Date.now() + 60_000,
      Date.now(),
      undefined,
      undefined,
      50,
    );

    const result = await harness.run();

    expect(result.complete).toBe(false);
    expect(result.insertedTriples).toBe(0);
    expect(harness.replaceGraph).not.toHaveBeenCalled();
    expect(harness.live()).toEqual([agentQuad('obsolete')]);
  });

  it('resumes a partial snapshot on the second invocation and commits atomically', async () => {
    const first = agentQuad('first');
    const second = agentQuad('second');
    const harness = createHarness([
      page({
        quads: [first],
        resumedFromOffset: 0,
        nextOffset: 1,
        completed: false,
        timedOut: true,
      }),
      page({
        quads: [second],
        resumedFromOffset: 1,
        nextOffset: 2,
        completed: true,
        timedOut: false,
      }),
    ]);

    const partial = await harness.run();
    expect(partial.complete).toBe(false);
    expect(partial.insertedTriples).toBe(0);
    expect(harness.replaceGraph).not.toHaveBeenCalled();
    expect(harness.live()).toEqual([agentQuad('obsolete')]);
    expect(harness.authoritativeAgentSnapshots.retainedTriples(checkpointKey)).toBe(1);

    const completed = await harness.run();
    expect(completed.complete).toBe(true);
    expect(completed.insertedTriples).toBe(2);
    expect(completed.insertedDataTriples).toBe(2);
    expect(harness.replaceGraph).toHaveBeenCalledTimes(1);
    expect(harness.live()).toEqual([first, second]);
    expect(harness.authoritativeAgentSnapshots.retainedTriples(checkpointKey)).toBe(0);
  });
});
