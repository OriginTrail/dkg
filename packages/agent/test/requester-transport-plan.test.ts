// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import {
  createRequesterTransportPlan,
  createStrictChangelogTransportPlan,
} from '../src/sync/requester/transport-plan.js';

describe('requester transport planning', () => {
  it('constructs durable and changelog work while retaining deferred graphs', async () => {
    const runDurable = vi.fn(async (contextGraphId: string, remaining: number) => (
      `${contextGraphId}:${remaining}`
    ));
    const runChangelog = vi.fn(async (contextGraphId: string) => contextGraphId);
    const plan = await createRequesterTransportPlan({
      remotePeerId: '12D3KooWPlannerPeer',
      contextGraphIds: ['agents', 'public', 'private'],
      selectWork: (contextGraphId) => {
        if (contextGraphId === 'agents') {
          return {
            lane: 'durable',
            run: (remaining: number) => runDurable(contextGraphId, remaining),
          };
        }
        if (contextGraphId === 'public') {
          return {
            lane: 'changelog',
            run: () => runChangelog(contextGraphId),
          };
        }
        return { lane: 'deferred' };
      },
    });

    expect(plan.work.map(({ contextGraphId, lane, operationId }) => ({
      contextGraphId,
      lane,
      operationId,
    }))).toEqual([
      {
        contextGraphId: 'agents',
        lane: 'durable',
        operationId: 'durable:agents:nnerPeer',
      },
      {
        contextGraphId: 'public',
        lane: 'changelog',
        operationId: 'changelog:public:nnerPeer',
      },
    ]);
    expect(plan.deferredContextGraphIds).toEqual(['private']);
    await expect(plan.work[0]!.run(3)).resolves.toBe('agents:3');
    await expect(plan.work[1]!.run(2)).resolves.toBe('public');
    expect(runDurable).toHaveBeenCalledWith('agents', 3);
    expect(runChangelog).toHaveBeenCalledWith('public');
  });

  it('builds strict changelog work without an impossible durable runner', async () => {
    const run = vi.fn(async () => 'public');
    const plan = await createStrictChangelogTransportPlan({
      remotePeerId: '12D3KooWStrictPlannerPeer',
      contextGraphIds: ['public', 'private'],
      selectWork: (contextGraphId) => contextGraphId === 'public'
        ? { lane: 'changelog', run }
        : { lane: 'deferred' },
    });

    expect(plan.work).toHaveLength(1);
    expect(plan.work[0]!.lane).toBe('changelog');
    await expect(plan.work[0]!.run(1)).resolves.toBe('public');
    expect(plan.deferredContextGraphIds).toEqual(['private']);
  });
});
