import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

describe('network admission integration', () => {
  it('rejects a real explicit connect to a peer on a different network identity', async () => {
    const local = await DKGAgent.create({
      name: 'AdmissionIntegrationLocal',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: 'v9-testnet',
        networkId: 'network-a',
        chainId: 'chain:1',
      },
    });
    const foreign = await DKGAgent.create({
      name: 'AdmissionIntegrationForeign',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: 'v9-testnet',
        networkId: 'network-b',
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
