import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GENESIS_ID,
  PROTOCOL_NETWORK_IDENTITY,
  computeNetworkId,
  createOperationContext,
  isProtocolUnsupportedError,
  type DKGNodeConfig,
} from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKGAgent } from '../src/dkg-agent.js';

/** NetworkAdmissionCoordinator's default identity-probe budget. */
const PROBE_TIMEOUT_MS = 3_000;

type Libp2pOfAgent = DKGAgent['node']['libp2p'];
type StreamOpenOutcome = 'refused' | 'opened' | 'failed';

interface ProtocolOpenWatch {
  /**
   * Every attempt to open `protocol` on a stream from the watched node, in
   * order, however the router reached it: libp2p's `dialProtocol`, or
   * `newStream` on a connection the router reuses. A refused attempt is the
   * peer's multistream `na`.
   */
  readonly opens: readonly StreamOpenOutcome[];
  /**
   * How many `libp2p.dialProtocol` calls for `protocol` rejected as a refusal.
   * That rejection is what ends a ProtocolRouter attempt: the router first
   * tries `newStream` on an open connection (a refusal there is swallowed),
   * then falls through to `dialProtocol` inside the same attempt.
   */
  readonly refusedDials: number;
  /**
   * How many stream opens had been observed when the first refused
   * `dialProtocol` ended a router attempt. One attempt can make several opens
   * (the reuse path's `newStream`, then `dialProtocol`'s own), so counting opens
   * does not count attempts; this index marks where the refused attempt ends.
   * Every open at or after it belongs to a later attempt, that is, the retry.
   */
  readonly opensAtFirstRefusedDial: number;
  dispose(): void;
}

/**
 * Observe, on the probing side, every stream the node opens for `protocol`.
 * `onFirstRefusedDial` runs once, synchronously, when a `dialProtocol` of
 * `protocol` has just been rejected as unsupported, before that rejection
 * reaches the router. Registering the peer's handler from it therefore puts the
 * handler in place after the refusal and before the router's retry, whatever
 * the timing of the dial. It must not run on the reuse path's refusal: that one
 * is followed, in the same attempt, by a `dialProtocol` the fresh handler
 * would already answer, so the attempt would succeed without any retry.
 */
function watchProtocolOpens(
  libp2p: Libp2pOfAgent,
  protocol: string,
  onFirstRefusedDial: () => void,
): ProtocolOpenWatch {
  const opens: StreamOpenOutcome[] = [];
  let refusedDials = 0;
  let opensAtFirstRefusedDial = 0;
  const forProtocol = (protocols: unknown): boolean =>
    (Array.isArray(protocols) ? protocols : [protocols]).includes(protocol);
  const outcomeOf = (err: unknown): StreamOpenOutcome =>
    (isProtocolUnsupportedError(err) ? 'refused' : 'failed');
  const spies: Array<{ mockRestore(): void }> = [];

  const target = libp2p as unknown as {
    dialProtocol(peer: unknown, protocols: unknown, options?: unknown): Promise<unknown>;
  };
  const originalDial = target.dialProtocol.bind(target);
  spies.push(vi.spyOn(target, 'dialProtocol').mockImplementation(async (peer, protocols, options) => {
    try {
      return await originalDial(peer, protocols, options);
    } catch (err) {
      if (forProtocol(protocols) && isProtocolUnsupportedError(err)) {
        refusedDials += 1;
        if (refusedDials === 1) {
          opensAtFirstRefusedDial = opens.length;
          onFirstRefusedDial();
        }
      }
      throw err;
    }
  }));

  type WatchedConnection = {
    newStream(protocols: unknown, options?: unknown): Promise<unknown>;
  };
  const patched = new WeakSet<object>();
  const watchConnection = (connection: WatchedConnection): void => {
    if (patched.has(connection)) return;
    patched.add(connection);
    const originalNewStream = connection.newStream.bind(connection);
    spies.push(vi.spyOn(connection, 'newStream').mockImplementation(async (protocols, options) => {
      if (!forProtocol(protocols)) return originalNewStream(protocols, options);
      try {
        const stream = await originalNewStream(protocols, options);
        opens.push('opened');
        return stream;
      } catch (err) {
        opens.push(outcomeOf(err));
        throw err;
      }
    }));
  };
  for (const connection of libp2p.getConnections()) watchConnection(connection as unknown as WatchedConnection);
  const onConnectionOpen = (evt: Event): void => {
    watchConnection((evt as CustomEvent<WatchedConnection>).detail);
  };
  libp2p.addEventListener('connection:open', onConnectionOpen);

  return {
    opens,
    get refusedDials() { return refusedDials; },
    get opensAtFirstRefusedDial() { return opensAtFirstRefusedDial; },
    dispose() {
      libp2p.removeEventListener('connection:open', onConnectionOpen);
      for (const spy of spies) spy.mockRestore();
    },
  };
}

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
  // The handler is registered by the observation, never by a timer. A timer
  // started before the dial (say 700 ms) lets a slow dial or an event-loop
  // pause install the handler before the first probe, and the probe then
  // succeeds on its first attempt: the test would pass with the retry option
  // removed. Here the handler appears only once the probing side has seen its
  // own `dialProtocol` of the identity protocol refused, so the probe can only
  // be admitted by a retry.
  it('admits a peer whose identity handler appears only after the first identity probe was refused', async () => {
    const networkId = await computeNetworkId(DEFAULT_GENESIS_ID);
    const a = await startAgent('BootingPeerA', networkId);
    const b = await startAgent('BootingPeerB', networkId);
    // A is "still booting": the identity handler is not registered yet.
    a.router.unregister(PROTOCOL_NETWORK_IDENTITY);

    // B starts its own identity probe when the connection opens, and the
    // explicit call below joins it, so the hook is installed before the dial
    // and registers the handler exactly once, whichever probe sees the refusal.
    let handlerRegistrations = 0;
    let refusedAt = 0;
    const watch = watchProtocolOpens(b.node.libp2p, PROTOCOL_NETWORK_IDENTITY, () => {
      handlerRegistrations += 1;
      refusedAt = Date.now();
      a.networkAdmissionCoordinator.registerIdentityProtocol(a.router);
    });
    let admittedAt = 0;
    try {
      const aAddress = a.multiaddrs.find((addr) => addr.includes('/tcp/') && !addr.includes('/p2p-circuit'));
      expect(aAddress).toBeDefined();
      await b.node.libp2p.dial(multiaddr(aAddress!));

      // Bounded by the coordinator's own probe budget: if the refusal is never
      // seen the handler is never registered and this rejects, it does not hang.
      const admitted = await b.networkAdmissionCoordinator
        .ensureAdmitted(a.peerId, createOperationContext('connect'))
        .catch((err: unknown) => {
          throw new Error(
            `identity probe did not admit the peer (stream opens seen on the probing side: ` +
              `[${watch.opens.join(', ')}], refused dials: ${watch.refusedDials}, ` +
              `handler registrations: ${handlerRegistrations}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
            { cause: err },
          );
        });
      admittedAt = Date.now();
      expect(admitted).toBe(true);
    } finally {
      watch.dispose();
    }

    // The refusal was observed, and it is what registered the handler.
    expect(watch.refusedDials).toBeGreaterThanOrEqual(1);
    expect(handlerRegistrations).toBe(1);
    // Direct retry signal. Counting opens does not count attempts (one refused
    // attempt is two refused opens: the reuse path's, then `dialProtocol`'s), so
    // split the opens at the refusal that ended the first attempt: everything
    // before it was refused, and a stream was then opened, and got through to the
    // handler registered in between, by a LATER attempt: the retry.
    const beforeRefusal = watch.opens.slice(0, watch.opensAtFirstRefusedDial);
    const afterRefusal = watch.opens.slice(watch.opensAtFirstRefusedDial);
    expect(beforeRefusal.length).toBeGreaterThanOrEqual(1);
    expect(beforeRefusal.every((outcome) => outcome === 'refused')).toBe(true);
    expect(afterRefusal.at(-1)).toBe('opened');
    expect(b.networkAdmission.isAcceptedPeer(a.peerId)).toBe(true);
    expect(b.networkAdmission.getRetryableProbeBackoff(a.peerId)).toBeUndefined();
    // Generous: the router's retry schedule is 500 ms + 1000 ms inside the
    // coordinator's 3 s probe budget. This bounds a stall; it does not prove the retry.
    expect(admittedAt - refusedAt).toBeLessThan(PROBE_TIMEOUT_MS);
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
