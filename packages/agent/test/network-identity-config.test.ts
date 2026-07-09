import { describe, expect, it } from 'vitest';
import { DEFAULT_GENESIS_ID, computeNetworkId } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

describe('DKGAgent network identity config', () => {
  it('stores the computed network identity on the agent and node configs', async () => {
    const agent = await DKGAgent.create({
      name: 'NetworkIdentityConfigTest',
      genesisId: 'gnosis-mainnet',
      store: new OxigraphStore(),
    });

    const expectedNetworkId = await computeNetworkId('gnosis-mainnet');
    expect((agent as any).config.networkIdentity).toMatchObject({
      genesisId: 'gnosis-mainnet',
      networkId: expectedNetworkId,
    });
    expect((agent.node as any).config.networkIdentity).toMatchObject({
      genesisId: 'gnosis-mainnet',
      networkId: expectedNetworkId,
    });

    await agent.stop().catch(() => {});
  });

  it('normalizes omitted genesisId to the default genesis identity', async () => {
    const omitted = await DKGAgent.create({
      name: 'NetworkIdentityConfigOmittedDefault',
      store: new OxigraphStore(),
    });
    const explicit = await DKGAgent.create({
      name: 'NetworkIdentityConfigExplicitDefault',
      genesisId: DEFAULT_GENESIS_ID,
      store: new OxigraphStore(),
    });

    try {
      const expectedNetworkId = await computeNetworkId(DEFAULT_GENESIS_ID);
      expect((omitted as any).config.genesisId).toBe(DEFAULT_GENESIS_ID);
      expect((omitted as any).config.networkIdentity).toEqual((explicit as any).config.networkIdentity);
      expect((omitted as any).config.networkIdentity).toMatchObject({
        genesisId: DEFAULT_GENESIS_ID,
        networkId: expectedNetworkId,
      });
      expect((omitted.node as any).config.networkIdentity).toEqual((omitted as any).config.networkIdentity);
    } finally {
      await omitted.stop().catch(() => {});
      await explicit.stop().catch(() => {});
    }
  });
});
