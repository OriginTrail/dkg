// SPDX-License-Identifier: Apache-2.0

/**
 * The fresh `_meta` fetch the curator metadata refresh and the sub-graph
 * lookup of a write share (`sync/requester/fresh-meta-fetch.ts`): checkpoint
 * cleared, fresh responder session, control-plane admission unless nested, and
 * one fetch from a peer for a graph at a time (a second fresh session would
 * supersede the first at the responder).
 */
import { contextGraphMetaGraphUri, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { describe, expect, it, vi } from 'vitest';

import { withSyncAdmissionSource } from '../src/sync/attempt-telemetry.js';
import { getSyncCheckpointKey } from '../src/sync/checkpoint/state.js';
import { fetchFreshContextGraphMeta } from '../src/sync/requester/fresh-meta-fetch.js';

const GRAPH = '0x1111111111111111111111111111111111111111/graph';
const OTHER_GRAPH = '0x1111111111111111111111111111111111111111/other';
const PEER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const OTHER_PEER = '12D3KooWPvHB21rJUKQuPb7sZDCyveJmtsL3PryNN3y99n6hqRNh';

function fetchAgent(options: { readonly holdMs?: number } = {}) {
  const syncCheckpoints = new Map<string, number>();
  const running = new Map<string, number>();
  const most = new Map<string, number>();
  const fetchSyncPages = vi.fn(async (
    _ctx: OperationContext,
    peerId: string,
    contextGraphId: string,
    _includeSharedMemory: boolean,
    _phase: string,
    _graphUri: string,
    _deadline: number,
    _options?: { signal?: AbortSignal; forceFreshSession?: boolean },
  ) => {
    const pair = `${peerId}\0${contextGraphId}`;
    running.set(pair, (running.get(pair) ?? 0) + 1);
    most.set(pair, Math.max(most.get(pair) ?? 0, running.get(pair)!));
    try {
      await new Promise((resolve) => setTimeout(resolve, options.holdMs ?? 0));
      return { quads: [], checkpointKey: `checkpoint:${pair}`, resumedFromOffset: 0, completed: true };
    } finally {
      running.set(pair, running.get(pair)! - 1);
    }
  });
  const runContextGraphSyncWithBackpressure = vi.fn(async <T>(
    _ctx: OperationContext,
    _contextGraphId: string,
    _lane: 'durable',
    _label: string,
    work: () => Promise<T>,
  ): Promise<T> => work());
  return { agent: { syncCheckpoints, fetchSyncPages, runContextGraphSyncWithBackpressure }, syncCheckpoints, most };
}

const ctx = createOperationContext('sync');

describe('fetchFreshContextGraphMeta', () => {
  it('clears the meta checkpoint, asks for a fresh session and is admitted as control-plane traffic', async () => {
    const { agent, syncCheckpoints } = fetchAgent();
    const checkpoint = getSyncCheckpointKey(PEER, GRAPH, false, 'meta');
    syncCheckpoints.set(checkpoint, 512);
    const signal = new AbortController().signal;

    const result = await fetchFreshContextGraphMeta(agent, ctx, PEER, GRAPH, { deadline: () => 1_234, signal });

    expect(result.completed).toBe(true);
    expect(syncCheckpoints.has(checkpoint)).toBe(false);
    expect(agent.fetchSyncPages).toHaveBeenCalledWith(
      ctx, PEER, GRAPH, false, 'meta', contextGraphMetaGraphUri(GRAPH), 1_234, { signal, forceFreshSession: true },
    );
    expect(agent.runContextGraphSyncWithBackpressure).toHaveBeenCalledWith(
      ctx, GRAPH, 'durable', 'durable:control-plane', expect.any(Function), { operationSignal: signal, source: 'control-plane' },
    );
  });

  it('stays inside an enclosing admission instead of acquiring a second one', async () => {
    const { agent } = fetchAgent();

    await withSyncAdmissionSource('reconcile', () =>
      fetchFreshContextGraphMeta(agent, ctx, PEER, GRAPH, { deadline: () => 1_234 }));

    expect(agent.fetchSyncPages).toHaveBeenCalledOnce();
    expect(agent.runContextGraphSyncWithBackpressure).not.toHaveBeenCalled();
  });

  it('runs one fetch from a peer for a graph at a time, and others side by side', async () => {
    const { agent, most } = fetchAgent({ holdMs: 20 });
    const fetch = (peerId: string, contextGraphId: string) =>
      fetchFreshContextGraphMeta(agent, ctx, peerId, contextGraphId, { deadline: () => Date.now() + 1_000 });

    await Promise.all([fetch(PEER, GRAPH), fetch(PEER, GRAPH), fetch(PEER, OTHER_GRAPH), fetch(OTHER_PEER, GRAPH)]);

    expect(agent.fetchSyncPages).toHaveBeenCalledTimes(4);
    expect(most.get(`${PEER}\0${GRAPH}`)).toBe(1);
    expect(most.get(`${PEER}\0${OTHER_GRAPH}`)).toBe(1);
    expect(most.get(`${OTHER_PEER}\0${GRAPH}`)).toBe(1);
  });

  it('reads the deadline when its turn starts, and gives up a turn its caller no longer waits for', async () => {
    const { agent } = fetchAgent({ holdMs: 30 });
    const first = fetchFreshContextGraphMeta(agent, ctx, PEER, GRAPH, { deadline: () => 1 });
    const deadline = vi.fn(() => 2);
    const controller = new AbortController();
    const second = fetchFreshContextGraphMeta(agent, ctx, PEER, GRAPH, { deadline, signal: controller.signal });
    const third = fetchFreshContextGraphMeta(agent, ctx, PEER, GRAPH, { deadline: () => 3 });
    controller.abort(new Error('the write gave up'));

    await first;
    await expect(second).rejects.toThrow('the write gave up');
    await third;
    expect(deadline).not.toHaveBeenCalled();
    expect(agent.fetchSyncPages.mock.calls.map((call) => call[6])).toEqual([1, 3]);
  });
});
