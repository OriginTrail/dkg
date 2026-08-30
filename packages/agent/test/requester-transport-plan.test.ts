// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';
import { createRequesterTransportPlan } from '../src/sync/requester/transport-plan.js';

describe('requester transport planning', () => {
  it('constructs durable and changelog work while retaining deferred graphs', async () => {
    const runDurable = vi.fn(async (contextGraphId: string, remaining: number) => (
      `${contextGraphId}:${remaining}`
    ));
    const runChangelog = vi.fn(async (contextGraphId: string) => contextGraphId);
    const lanes = new Map([
      ['agents', 'durable' as const],
      ['public', 'changelog' as const],
      ['private', 'deferred' as const],
    ]);

    const plan = await createRequesterTransportPlan({
      remotePeerId: '12D3KooWPlannerPeer',
      contextGraphIds: ['agents', 'public', 'private'],
      selectLane: (contextGraphId) => lanes.get(contextGraphId)!,
      runDurable,
      runChangelog,
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
});
