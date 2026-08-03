import { afterAll, describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { DKGAgent } from '../src/index.js';

describe('agent finalization write-lock wiring', () => {
  let agent: DKGAgent | undefined;

  afterAll(async () => {
    try { await agent?.stop(); } catch { /* not started */ }
  });

  it('shares the production agent lock map with its finalization handler', async () => {
    agent = await DKGAgent.create({
      name: 'FinalizationWriteLockWiring',
      chainAdapter: new MockChainAdapter(),
    });
    const internals = agent as unknown as {
      writeLocks: Map<string, Promise<void>>;
      getOrCreateFinalizationHandler(): unknown;
    };

    const handler = internals.getOrCreateFinalizationHandler() as {
      writeLocks: Map<string, Promise<void>> | undefined;
    };

    expect(internals.writeLocks).toBeInstanceOf(Map);
    expect(handler.writeLocks).toBe(internals.writeLocks);
  });
});
