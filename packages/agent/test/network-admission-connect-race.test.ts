import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GENESIS_ID,
  PROTOCOL_NETWORK_IDENTITY,
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

  async function createAgent(name: string, networkId: string, genesisId = DEFAULT_GENESIS_ID): Promise<DKGAgent> {
    const agent = await DKGAgent.create({
      name,
      listenHost: '127.0.0.1',
      listenPort: 0,
      store: new OxigraphStore(),
      networkIdentity: {
        genesisId,
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
    return agent;
  }

  async function startAgent(name: string, networkId: string, genesisId = DEFAULT_GENESIS_ID): Promise<DKGAgent> {
    const agent = await createAgent(name, networkId, genesisId);
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

  it('serves identity while both agents are still loading persistent application state', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const a = await createAgent('BootingPeerA', networkId);
    const b = await createAgent('BootingPeerB', networkId);
    const release = Promise.withResolvers<void>();
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    for (const [index, agent] of [a, b].entries()) {
      const load = agent.loadAgentsFromStore.bind(agent);
      vi.spyOn(agent, 'loadAgentsFromStore').mockImplementation(async () => {
        entered[index]!.resolve();
        await release.promise;
        await load();
      });
    }
    const starts = [a.start(), b.start()];
    try {
      await Promise.all(entered.map(gate => gate.promise));
      for (const agent of [a, b]) expect(agent.node.libp2p.getProtocols()).toContain(PROTOCOL_NETWORK_IDENTITY);
      const address = a.multiaddrs.find(addr => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
      expect(address).toBeDefined();
      await b.node.libp2p.dial(multiaddr(address!));
      await expect(Promise.all([
        b.networkAdmissionCoordinator.ensureAdmitted(a.peerId, createOperationContext('connect')),
        a.networkAdmissionCoordinator.ensureAdmitted(b.peerId, createOperationContext('connect')),
      ])).resolves.toEqual([true, true]);
      expect(b.networkAdmission.getRetryableProbeBackoff(a.peerId)).toBeUndefined();
      expect(a.networkAdmission.getRetryableProbeBackoff(b.peerId)).toBeUndefined();
    } finally {
      release.resolve();
      await Promise.all(starts);
    }
  }, 20_000);

  it('refuses redials after a real signed network-identity mismatch', async () => {
    const local = await startAgent('RejectedDialLocal', await computeNetworkId(DEFAULT_GENESIS_ID));
    const foreignGenesisId = 'gnosis-mainnet';
    const foreign = await startAgent(
      'RejectedDialForeign',
      await computeNetworkId(foreignGenesisId),
      foreignGenesisId,
    );
    const foreignPeer = peerIdFromString(foreign.peerId);
    const address = foreign.multiaddrs.find((entry) => entry.includes('/tcp/') && !entry.includes('/p2p-circuit'));
    expect(address).toBeDefined();

    // Exercise rejection in one direction. Otherwise the foreign node's
    // automatic reciprocal probe can reject and disconnect local before local
    // receives the real signed foreign proof, yielding a transient empty stream.
    foreign.networkAdmission.markVerifiedSameNetwork(local.peerId);

    // The first connection is allowed so identity admission can ask for a
    // signed proof. Production admission then closes it and installs the
    // transport refusal before libp2p's reconnect machinery reacts.
    await local.node.libp2p.dial(multiaddr(address!)).catch(() => undefined);
    expect(await local.networkAdmissionCoordinator.ensureAdmitted(
      foreign.peerId,
      createOperationContext('connect'),
    )).toBe(false);
    const deadline = Date.now() + 10_000;
    while (!local.networkAdmissionCoordinator.isRejectedPeer(foreign.peerId)) {
      if (Date.now() >= deadline) throw new Error('signed mismatch was not rejected');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(local.node.libp2p.getConnections(foreignPeer)).toHaveLength(0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(local.node.libp2p.dial(multiaddr(address!)))
        .rejects.toMatchObject({ name: 'DialDeniedError' });
      expect(local.node.libp2p.getConnections(foreignPeer)).toHaveLength(0);
    }
  }, 25_000);
});
