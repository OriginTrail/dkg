import { describe, expect, it } from 'vitest';
import { DKGAgent, type RandomSamplingHandle } from '@origintrail-official/dkg-agent';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';

describe('package-root Random Sampling handle compatibility', () => {
  it.each(['edge', 'core'] as const)('returns a directly usable %s handle from the public agent method', async role => {
    const chain = new MockChainAdapter();
    const agent = await DKGAgent.create({ name: 'PublicHandleConsumer', chainAdapter: chain, listenPort: 0 });
    const result = await agent.createRandomSamplingHandle({
      role, chain, store: agent.store, identityId: 52n,
      useWorkerThread: false, tickIntervalMs: 60_000,
    });
    // Also close the old wrapper's resource during the negative baseline.
    const cleanup = result as unknown as { stop?: () => Promise<void>; handle?: RandomSamplingHandle };
    try {
      expect(result.enabled).toBe(role === 'core');
      expect(() => result.start()).not.toThrow();
      expect(result.getStatus()).toMatchObject({ enabled: role === 'core', role, identityId: '52' });
      await expect(result.stop()).resolves.toBeUndefined();
    } finally {
      await cleanup.stop?.();
      await cleanup.handle?.stop();
      await agent.store.close();
    }
  });
});
