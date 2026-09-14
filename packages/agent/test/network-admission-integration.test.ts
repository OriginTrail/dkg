import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GENESIS_ID,
  computeNetworkId,
  createOperationContext,
} from '@origintrail-official/dkg-core';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

describe('network admission integration', () => {
  it('authenticates the default wallet exposed by a real Core identity handler', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const corePrivateKey = `0x${'33'.repeat(32)}`;
    const coreAgentAddress = new ethers.Wallet(corePrivateKey).address;
    const requester = await DKGAgent.create({
      name: 'AdmissionIntegrationBindingRequester',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });
    const core = await DKGAgent.create({
      name: 'AdmissionIntegrationBindingCore',
      listenPort: 0,
      nodeRole: 'core',
      store: new OxigraphStore(),
      chainAdapter: Object.assign(new NoChainAdapter(), {
        getOperationalPrivateKey: () => corePrivateKey,
      }),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });
    try {
      await requester.start();
      await core.start();

      // The registry resolver owns normalization and refuses a default identity
      // for which the daemon has no custodial wallet.
      core.defaultAgentAddress = coreAgentAddress.toLowerCase();
      expect(core.getDefaultCustodialSigningIdentity()).toEqual({
        agentAddress: coreAgentAddress,
        privateKey: corePrivateKey,
      });
      const externalWallet = ethers.Wallet.createRandom();
      const selfSovereign = await core.registerAgent('Core external identity', {
        publicKey: ethers.SigningKey.computePublicKey(externalWallet.privateKey, true),
      });
      core.defaultAgentAddress = selfSovereign.agentAddress.toLowerCase();
      expect(core.getDefaultCustodialSigningIdentity()).toBeUndefined();
      core.defaultAgentAddress = coreAgentAddress.toLowerCase();

      const coreAddr = core.multiaddrs.find((addr) =>
        addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
      expect(coreAddr).toBeDefined();
      await requester.connectTo(coreAddr!);

      expect(requester.networkAdmissionCoordinator.authenticatedAgentAddress(core.peerId))
        .toBe(coreAgentAddress);
      await expect(requester.networkAdmissionCoordinator.ensurePeerAgentBinding(
        core.peerId,
        coreAgentAddress,
        createOperationContext('connect'),
      )).resolves.toBe(true);
    } finally {
      await requester.stop().catch(() => {});
      await core.stop().catch(() => {});
    }
  }, 15000);

  it('admits a real explicit connect to a peer on the same network identity', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const local = await DKGAgent.create({
      name: 'AdmissionIntegrationSameLocal',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });
    const remote = await DKGAgent.create({
      name: 'AdmissionIntegrationSameRemote',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });

    try {
      await local.start();
      await remote.start();
      const remoteAddr = remote.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
      expect(remoteAddr).toBeDefined();

      await expect(local.connectTo(remoteAddr!)).resolves.toBeUndefined();
      expect(local.networkAdmission.snapshot().verifiedPeerIds).toContain(remote.peerId);
    } finally {
      await local.stop().catch(() => {});
      await remote.stop().catch(() => {});
    }
  }, 15000);

  it('rejects a real explicit connect to a peer on a different network identity', async () => {
    const localNetworkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const foreignNetworkId = await computeNetworkId('gnosis-mainnet');
    const local = await DKGAgent.create({
      name: 'AdmissionIntegrationLocal',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId: localNetworkId,
        chainId: 'chain:1',
      },
    });
    const foreign = await DKGAgent.create({
      name: 'AdmissionIntegrationForeign',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: 'gnosis-mainnet',
        networkId: foreignNetworkId,
        chainId: 'chain:1',
      },
    });

    try {
      await local.start();
      await foreign.start();
      const foreignAddr = foreign.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
      expect(foreignAddr).toBeDefined();

      await expect(local.connectTo(foreignAddr!))
        .rejects.toMatchObject({ code: 'NETWORK_ADMISSION_REJECTED' });
      expect(local.networkAdmission.snapshot().verifiedPeerIds).not.toContain(foreign.peerId);
      expect(local.networkAdmission.snapshot().quarantinedPeerIds).toContain(foreign.peerId);
    } finally {
      await local.stop().catch(() => {});
      await foreign.stop().catch(() => {});
    }
  }, 15000);
});
