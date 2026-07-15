import { describe, expect, it } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';

describe('DKGAgent assertion.promoteAsync default storage lane', () => {
  it('enqueues omitted agentAddress as the effective default agent lane', async () => {
    const defaultAgentAddress = `0x${'11'.repeat(20)}`;
    const enqueued: unknown[] = [];
    const agent = Object.create(DKGAgent.prototype) as any;

    agent.defaultAgentAddress = defaultAgentAddress;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      configurable: true,
    });
    agent._promoteQueue = {
      enqueue: async (request: unknown) => {
        enqueued.push(request);
        return 'job-1';
      },
    };

    const result = await agent.assertion.promoteAsync('cg-1', 'asset-1');

    expect(result).toEqual({ jobId: 'job-1' });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      contextGraphId: 'cg-1',
      assertionName: 'asset-1',
      entities: 'all',
      agentAddress: defaultAgentAddress,
    });
  });

  it('enqueues whole-KA sharing through the selector-free lifecycle interface', async () => {
    const defaultAgentAddress = `0x${'22'.repeat(20)}`;
    const enqueued: unknown[] = [];
    const agent = Object.create(DKGAgent.prototype) as any;

    agent.defaultAgentAddress = defaultAgentAddress;
    Object.defineProperty(agent, 'peerId', {
      value: '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6',
      configurable: true,
    });
    agent._promoteQueue = {
      enqueue: async (request: unknown) => {
        enqueued.push(request);
        return 'job-whole';
      },
    };

    const result = await agent.assertion.shareWholeKnowledgeAssetAsync('cg-1', 'asset-1', {
      subGraphName: 'notes',
    });

    expect(result).toEqual({ jobId: 'job-whole' });
    expect(enqueued).toEqual([expect.objectContaining({
      contextGraphId: 'cg-1',
      assertionName: 'asset-1',
      subGraphName: 'notes',
      entities: 'all',
      agentAddress: defaultAgentAddress,
    })]);
  });
});
