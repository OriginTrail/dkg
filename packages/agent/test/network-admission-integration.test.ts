import { describe, expect, it, vi } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { DEFAULT_GENESIS_ID, computeNetworkId } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

/**
 * `'connected'` or the dial error's name, so a failing expectation never
 * pretty-prints a live libp2p Connection.
 */
async function dialOutcome(dial: Promise<unknown>): Promise<string> {
  return dial.then(() => 'connected', (err: unknown) => (err as Error).name);
}

describe('network admission integration', () => {
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
      // The production verdict wire: passing the proof must reach the node's
      // transport policy (lifting any earlier denial), never deny the peer.
      const clearDenial = vi.spyOn(local.node, 'clearPeerNetworkMismatchDenial');
      const denyDial = vi.spyOn(local.node, 'denyPeerAfterNetworkMismatch');

      await expect(local.connectTo(remoteAddr!)).resolves.toBeUndefined();
      expect(local.networkAdmission.snapshot().verifiedPeerIds).toContain(remote.peerId);
      expect(clearDenial).toHaveBeenCalledWith(remote.peerId);
      expect(denyDial).not.toHaveBeenCalled();
      expect(await dialOutcome(local.node.libp2p.dial(multiaddr(remoteAddr!)))).toBe('connected');
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

      const denyDial = vi.spyOn(local.node, 'denyPeerAfterNetworkMismatch');

      await expect(local.connectTo(foreignAddr!))
        .rejects.toMatchObject({ code: 'NETWORK_ADMISSION_REJECTED' });
      expect(local.networkAdmission.snapshot().verifiedPeerIds).not.toContain(foreign.peerId);
      expect(local.networkAdmission.snapshot().quarantinedPeerIds).toContain(foreign.peerId);
      // The transport half of the verdict, through the production wire: the
      // rejected peer is denied for the admission quarantine, so libp2p's own
      // redial machinery can no longer reach it.
      expect(denyDial).toHaveBeenCalledWith(foreign.peerId, 5 * 60_000);
      expect(await dialOutcome(local.node.libp2p.dial(multiaddr(foreignAddr!)))).toBe('DialDeniedError');
      expect(await dialOutcome(local.node.libp2p.dial(peerIdFromString(foreign.peerId)))).toBe('DialDeniedError');
    } finally {
      await local.stop().catch(() => {});
      await foreign.stop().catch(() => {});
    }
  }, 15000);
});
