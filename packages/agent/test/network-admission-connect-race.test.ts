import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GENESIS_ID,
  PROTOCOL_NETWORK_IDENTITY,
  computeNetworkId,
  createOperationContext,
  type DKGNodeConfig,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { watchProtocolRefusal } from '../../../scripts/testing/protocol-refusal.js';
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

  async function startAgent(name: string, networkId: string, genesisId = DEFAULT_GENESIS_ID): Promise<DKGAgent> {
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

  // A peer that is still booting answers the identity probe with multistream
  // `na` until it registers the identity handler, and admission gates every
  // other protocol. ProtocolRouter fails a refused protocol fast, so the probe
  // opts back into its in-line retry (`retryOnProtocolRefusal`): a peer whose
  // handler shows up within the retry window must be admitted, not pushed
  // into a transient probe backoff.
  //
  // The handler is registered by the observation, never by a timer (see
  // `watchProtocolRefusal`): it appears only once the probing side has seen its
  // own `dialProtocol` of the identity protocol refused, so the probe can only
  // be admitted by a retry.
  it('admits a peer whose identity handler appears only after the first identity probe was refused', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const a = await startAgent('BootingPeerA', networkId);
    const b = await startAgent('BootingPeerB', networkId);
    // A is "still booting": the identity handler is not registered yet.
    a.router.unregister(PROTOCOL_NETWORK_IDENTITY);

    // B starts its own identity probe when the connection opens, and the
    // explicit call below joins that one in-flight attempt, so there is one
    // probe to refuse and the watch registers the handler once. It is installed
    // before the dial.
    const watch = watchProtocolRefusal(b.node.libp2p, PROTOCOL_NETWORK_IDENTITY, () => {
      a.networkAdmissionCoordinator.registerIdentityProtocol(a.router);
    });
    let admittedAfterRefusalMs = 0;
    try {
      const aAddress = a.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
      expect(aAddress).toBeDefined();
      await b.node.libp2p.dial(multiaddr(aAddress!));

      // Bounded by the coordinator's own probe budget: if the refusal is never
      // seen the handler is never registered and this rejects, it does not hang.
      const admitted = await b.networkAdmissionCoordinator
        .ensureAdmitted(a.peerId, createOperationContext('connect'))
        .catch(watch.failWithContext('identity probe did not admit the peer'));
      admittedAfterRefusalMs = watch.msSinceFirstRefusal();
      expect(admitted).toBe(true);
    } finally {
      watch.dispose();
    }

    // The refusal was observed, and it is what registered the handler. Exactly
    // one dial was refused: the connect-time probe and the explicit call share
    // one in-flight attempt, and its retry got through.
    expect(watch.refusedDials).toBe(1);
    expect(watch.registrations).toBe(1);
    expect(b.networkAdmission.isAcceptedPeer(a.peerId)).toBe(true);
    expect(b.networkAdmission.getRetryableProbeBackoff(a.peerId)).toBeUndefined();
    // The retry, independently of the watch's own counters: the router waits its first
    // backoff step (500 ms) after a refused attempt before it tries again, so a probe
    // admitted sooner than that did not go through a retry of the refusal.
    expect(admittedAfterRefusalMs).toBeGreaterThanOrEqual(450);
    // Generous: the router's retry schedule is 500 ms + 1000 ms inside the
    // coordinator's 3 s probe budget. This bounds a stall; it does not prove the retry.
    expect(admittedAfterRefusalMs).toBeLessThan(PROBE_TIMEOUT_MS);
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
