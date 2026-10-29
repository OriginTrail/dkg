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

  it('uses networkIdentity.genesisId as the selected genesis when genesisId is omitted', async () => {
    const networkId = await computeNetworkId('gnosis-mainnet');
    const agent = await DKGAgent.create({
      name: 'NetworkIdentityConfigDerivedGenesis',
      networkIdentity: {
        genesisId: 'gnosis-mainnet',
        networkId,
      },
      store: new OxigraphStore(),
    });

    try {
      expect((agent as any).config.genesisId).toBe('gnosis-mainnet');
      expect((agent as any).config.networkIdentity).toMatchObject({
        genesisId: 'gnosis-mainnet',
        networkId,
      });
      expect((agent.node as any).config.networkIdentity).toEqual((agent as any).config.networkIdentity);
    } finally {
      await agent.stop().catch(() => {});
    }
  });

  it('forwards the transport isolation inputs to the node config', async () => {
    // Dropping either field at this hop silently empties the static
    // other-network list or ignores the operator kill switch.
    const otherNetworkRelays = [
      '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
    ];
    const relayPeers = ['/ip4/10.0.0.1/tcp/9090/p2p/12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy'];
    const isolated = await DKGAgent.create({
      name: 'NetworkIdentityConfigOtherNetworkRelays',
      store: new OxigraphStore(),
      relayPeers,
      otherNetworkRelays,
    });
    const killSwitch = await DKGAgent.create({
      name: 'NetworkIdentityConfigIsolationOff',
      store: new OxigraphStore(),
      networkPeerIsolation: false,
    });

    try {
      expect((isolated.node as any).config.otherNetworkRelays).toEqual(otherNetworkRelays);
      expect((isolated.node as any).config.relayPeers).toEqual(relayPeers);
      expect((isolated.node as any).config.networkPeerIsolation).toBeUndefined();
      expect((killSwitch.node as any).config.networkPeerIsolation).toBe(false);
    } finally {
      await isolated.stop().catch(() => {});
      await killSwitch.stop().catch(() => {});
    }
  });

  it('rejects networkIdentity values that diverge from the selected genesis', async () => {
    const defaultNetworkId = await computeNetworkId(DEFAULT_GENESIS_ID);

    await expect(DKGAgent.create({
      name: 'NetworkIdentityConfigGenesisMismatch',
      genesisId: DEFAULT_GENESIS_ID,
      networkIdentity: {
        genesisId: 'gnosis-mainnet',
        networkId: await computeNetworkId('gnosis-mainnet'),
      },
      store: new OxigraphStore(),
    })).rejects.toThrow(/networkIdentity\.genesisId/);

    await expect(DKGAgent.create({
      name: 'NetworkIdentityConfigNetworkIdMismatch',
      genesisId: DEFAULT_GENESIS_ID,
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId: `${defaultNetworkId}-wrong`,
      },
      store: new OxigraphStore(),
    })).rejects.toThrow(/networkIdentity\.networkId/);
  });
});
