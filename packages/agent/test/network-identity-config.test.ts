import { describe, expect, it } from 'vitest';
import { computeNetworkId } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

describe('DKGAgent network identity config', () => {
  it('stores the computed default network identity on the agent config', async () => {
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

    await agent.stop().catch(() => {});
  });
});
