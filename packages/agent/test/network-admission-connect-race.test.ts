import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GENESIS_ID,
  computeNetworkId,
  createOperationContext,
  type DKGNodeConfig,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

/** NetworkAdmissionCoordinator's default identity-probe budget. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * A probe that starts before its target is connected, and before the
 * target's address is known, parks in the peer resolver's DHT step: both
 * agents listen on loopback only, so kad-dht stays in client mode and the
 * routing table never gains a peer. The probe must still notice the
 * connection the target opens a moment later, instead of timing out and
 * leaving a healthy peer behind a transient-probe backoff window.
 */
describe('network admission when the peer connects mid-probe', () => {
  const agents: DKGAgent[] = [];

  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.stop().catch(() => {});
  });

  async function startAgent(name: string, networkId: string): Promise<DKGAgent> {
    const agent = await DKGAgent.create({
      name,
      listenHost: '127.0.0.1',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId: DEFAULT_GENESIS_ID,
        networkId,
        chainId: 'chain:1',
      },
    });
    agents.push(agent);
    // The agent turns mDNS on whenever it has no bootstrap or relay peers,
    // and mDNS would hand B the address of A before the test connects them.
    // Linux CI without multicast, and macOS without Local Network permission,
    // run without it, so switch it off on the node before it starts.
    (agent.node as unknown as { config: DKGNodeConfig }).config.enableMdns = false;
    await agent.start();
    return agent;
  }

  it('admits a peer that connects while the identity probe to it is still resolving', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const a = await startAgent('ConnectRaceA', networkId);
    const b = await startAgent('ConnectRaceB', networkId);
    const aPeerId = peerIdFromString(a.peerId);
    const knownAddressCount = async (): Promise<number> => {
      try {
        return (await b.node.libp2p.peerStore.get(aPeerId)).addresses.length;
      } catch {
        return 0;
      }
    };

    const startedAt = Date.now();
    let settled = false;
    const admitted = b.networkAdmissionCoordinator
      .ensureAdmitted(a.peerId, createOperationContext('connect'))
      .finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    expect(b.node.libp2p.getConnections(aPeerId)).toHaveLength(0);
    expect(await knownAddressCount()).toBe(0);

    // A dials B, so the connection is inbound on the probing side.
    const bAddress = b.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
    expect(bAddress).toBeDefined();
    await a.node.libp2p.dial(multiaddr(bAddress!));

    await expect(admitted).resolves.toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(PROBE_TIMEOUT_MS - 1_000);
    expect(b.networkAdmission.isAcceptedPeer(a.peerId)).toBe(true);
    expect(b.networkAdmission.getRetryableProbeBackoff(a.peerId)).toBeUndefined();
  }, 20_000);
});
