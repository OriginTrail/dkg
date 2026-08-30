import { describe, it, expect, beforeEach } from 'vitest';
import {
  PeerResolver,
  StubNetworkStateRegistry,
  type Network,
  type NetworkStateRegistry,
  type AgentDirectoryLookup,
  type Address,
  type NodeIdentity,
} from '../src/network/index.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl(...args);
  };
  return Object.assign(fn, { calls });
}

const PEER_A = '12D3KooWA' + 'a'.repeat(43);
const PEER_B = '12D3KooWB' + 'b'.repeat(43);
const RELAY_ADDR =
  '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
const RELAY_TARGET = [{
  peerId: '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M',
  addresses: [RELAY_ADDR],
}];

type FindPeerImpl = (
  peerId: NodeIdentity,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<Address[]>;

interface MockNetwork extends Network {
  __conns: Map<NodeIdentity, Array<{ remoteAddr: { toString(): string } }>>;
  __addedAddresses: Array<{ peerId: NodeIdentity; addrs: Address[] }>;
  __findPeerImpl: FindPeerImpl | null;
}

function makeNetwork(): MockNetwork {
  const conns = new Map<NodeIdentity, Array<{ remoteAddr: { toString(): string } }>>();
  const added: Array<{ peerId: NodeIdentity; addrs: Address[] }> = [];
  let findPeerImpl: FindPeerImpl | null = null;
  const net: Partial<MockNetwork> = {
    localId: PEER_A,
    localAddresses: [],
    isStarted: true,
    async start() {},
    async stop() {},
    async dialProtocol() {
      throw new Error('not used in resolver tests');
    },
    async handle() {},
    async unhandle() {},
    getConnections(peerId: NodeIdentity) {
      return (conns.get(peerId) ?? []) as never;
    },
    async addKnownAddresses(peerId: NodeIdentity, addrs: Address[]) {
      added.push({ peerId, addrs });
    },
    async findPeer(peerId: NodeIdentity, opts?: { signal?: AbortSignal; timeoutMs?: number }) {
      if (!findPeerImpl) throw new Error('findPeer not configured');
      return findPeerImpl(peerId, opts);
    },
  };
  Object.defineProperty(net, '__conns', { value: conns, enumerable: false });
  Object.defineProperty(net, '__addedAddresses', { value: added, enumerable: false });
  Object.defineProperty(net, '__findPeerImpl', {
    get: () => findPeerImpl,
    set: (v) => {
      findPeerImpl = v;
    },
    enumerable: false,
  });
  return net as MockNetwork;
}

function makeAgentDir(
  fn?: (peerId: NodeIdentity) => Promise<Address | null>,
): AgentDirectoryLookup {
  return { findRelayForPeer: fn ?? (async () => null) };
}

describe('PeerResolver', () => {
  let net: MockNetwork;
  let registry: NetworkStateRegistry;

  beforeEach(() => {
    net = makeNetwork();
    registry = new StubNetworkStateRegistry();
  });

  it('step 1: returns live-conn remoteAddr and stops', async () => {
    net.__conns.set(PEER_B, [{ remoteAddr: { toString: () => '/ip4/10.0.0.1/tcp/9090' } }]);
    const findPeerSpy = recorder<Parameters<FindPeerImpl>, Promise<Address[]>>(async () => []);
    net.__findPeerImpl = findPeerSpy;
    const dirSpy = recorder(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/10.0.0.1/tcp/9090']);
    expect(findPeerSpy.calls).toEqual([]);
    expect(dirSpy.calls).toEqual([]);
    expect(net.__addedAddresses).toEqual([]);
  });

  it('step 2: walks DHT when no live conn, merges into peerStore', async () => {
    net.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toContain('/ip4/1.2.3.4/tcp/9090');
    expect(net.__addedAddresses).toContainEqual({
      peerId: PEER_B,
      addrs: ['/ip4/1.2.3.4/tcp/9090'],
    });
  });

  it('step 2: opts.skipDht bypasses findPeer entirely', async () => {
    const findPeerSpy = recorder<Parameters<FindPeerImpl>, Promise<Address[]>>(async () => []);
    net.__findPeerImpl = findPeerSpy;

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    await resolver.resolve(PEER_B, { skipDht: true });

    expect(findPeerSpy.calls).toEqual([]);
  });

  it('step 2: DHT failures are swallowed and resolution proceeds', async () => {
    net.__findPeerImpl = async () => {
      throw new Error('dht boom');
    };
    const dirSpy = recorder(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(dirSpy.calls.at(-1)).toEqual([PEER_B, expect.any(Object)]);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 3: registry hits are appended after DHT', async () => {
    net.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];
    const customRegistry: NetworkStateRegistry = {
      lookup: async () => ['/ip4/5.6.7.8/tcp/9090'],
    };

    const resolver = new PeerResolver({
      network: net,
      registry: customRegistry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/1.2.3.4/tcp/9090', '/ip4/5.6.7.8/tcp/9090']);
  });

  it('step 4: agents-CG relay is wrapped as /p2p-circuit/p2p/<peerId>', async () => {
    net.__findPeerImpl = async () => [];
    const dirSpy = recorder(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
    expect(net.__addedAddresses).toContainEqual({
      peerId: PEER_B,
      addrs: [`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`],
    });
  });

  it('step 4: agents-CG returning null is fine, returns empty', async () => {
    net.__findPeerImpl = async () => [];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(async () => null),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([]);
  });

  it('step 5: uses configured relay circuits when DHT only returns private addresses', async () => {
    net.__findPeerImpl = async () => [
      `/ip4/127.0.0.1/tcp/9090/p2p/${PEER_B}`,
      `/ip4/192.168.0.20/tcp/9090/p2p/${PEER_B}`,
      `/ip4/100.105.212.110/tcp/9090/p2p/${PEER_B}`,
    ];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(async () => null),
      configuredRelayTargets: RELAY_TARGET,
    });

    const out = await resolver.resolve(PEER_B);

    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
    expect(net.__addedAddresses).toContainEqual({
      peerId: PEER_B,
      addrs: [`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`],
    });
  });

  it('step 5: does not add configured relay circuits when a public direct route exists', async () => {
    const publicDirect = `/ip4/178.105.87.39/tcp/9090/p2p/${PEER_B}`;
    net.__findPeerImpl = async () => [publicDirect];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(async () => null),
      configuredRelayTargets: RELAY_TARGET,
    });

    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([publicDirect]);
  });

  it('step 5: keeps a directory circuit but also adds configured relays for a relayed-only target', async () => {
    const staleRelay =
      '/ip4/178.104.98.10/tcp/9090/p2p/12D3KooWFWm8sg6dkitmdBd5Uxaqp3CDRL27mFcM7vEHK92Xapyy';
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(async () => staleRelay),
      configuredRelayTargets: RELAY_TARGET,
    });

    const out = await resolver.resolve(PEER_B);

    expect(out).toContain(`${staleRelay}/p2p-circuit/p2p/${PEER_B}`);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
    expect(out[0]).toBe(`${staleRelay}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 4: agents-CG throwing does not abort resolution', async () => {
    net.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: {
        findRelayForPeer: async () => {
          throw new Error('sparql boom');
        },
      },
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/1.2.3.4/tcp/9090']);
  });

  it('Codex PR #496 round 6: addr is omitted from result when peerStore merge fails', async () => {
    // Regression guard: the resolver returns Address[] as a contract
    // that "the peerStore is primed for these addresses". Earlier
    // rounds appended addresses BEFORE awaiting addKnownAddresses, so
    // a peerStore merge failure left the caller seeing a non-empty
    // resolution while the bare peer-id dial silently missed every
    // address. Fix: only append after the merge succeeds; on merge
    // failure the addr stays out of the returned list AND resolution
    // continues into the next step.
    const failingNet = makeNetwork();
    failingNet.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];
    failingNet.addKnownAddresses = async () => {
      throw new Error('peerStore merge boom');
    };

    const resolver = new PeerResolver({
      network: failingNet,
      registry,
      agentDirectory: makeAgentDir(async () => RELAY_ADDR),
    });
    const out = await resolver.resolve(PEER_B);

    // DHT merge failed → DHT addr is NOT in the result.
    // Step 4's relay merge ALSO failed (same stub) → relay addr also out.
    // Resolver returns []; caller knows nothing was actually primed.
    expect(out).toEqual([]);
  });

  it('step 1 (Codex PR #496 r2): live-conn lookup throwing does not abort resolution', async () => {
    // Simulates `network.getConnections(peerId)` throwing on a malformed
    // peerId — which LibP2PNetwork does today by calling peerIdFromString.
    const throwingNet: typeof net = makeNetwork();
    throwingNet.getConnections = () => {
      throw new Error('peerIdFromString boom');
    };
    throwingNet.__findPeerImpl = async () => ['/ip4/1.2.3.4/tcp/9090'];

    const resolver = new PeerResolver({
      network: throwingNet,
      registry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    // Falls through cleanly to step 2.
    expect(out).toEqual(['/ip4/1.2.3.4/tcp/9090']);
  });

  it('step 3 (Codex PR #496 feedback): registry throwing does not abort resolution', async () => {
    net.__findPeerImpl = async () => [];
    const throwingRegistry: NetworkStateRegistry = {
      lookup: async () => {
        throw new Error('registry boom');
      },
    };
    const resolver = new PeerResolver({
      network: net,
      registry: throwingRegistry,
      agentDirectory: makeAgentDir(async () => RELAY_ADDR),
    });
    const out = await resolver.resolve(PEER_B);

    // Falls through to step 4 cleanly.
    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
  });

  // Codex feedback PR #499 round 3: outer signal must short-circuit
  // every resolver step (not just step 2 / DHT).

  it('aborts before any step runs when signal is already aborted', async () => {
    let stepsRan = 0;
    const countingNet = makeNetwork();
    const origGetConnections = countingNet.getConnections;
    countingNet.getConnections = (pid) => {
      stepsRan++;
      return origGetConnections(pid);
    };
    countingNet.__findPeerImpl = async () => {
      stepsRan++;
      return ['/ip4/1.2.3.4/tcp/9090'];
    };
    const countingRegistry: NetworkStateRegistry = {
      lookup: async () => {
        stepsRan++;
        return [];
      },
    };
    const countingDir: AgentDirectoryLookup = {
      findRelayForPeer: async () => {
        stepsRan++;
        return null;
      },
    };

    const resolver = new PeerResolver({
      network: countingNet,
      registry: countingRegistry,
      agentDirectory: countingDir,
    });

    const ctrl = new AbortController();
    ctrl.abort();
    const out = await resolver.resolve(PEER_B, { signal: ctrl.signal });

    expect(out).toEqual([]);
    expect(stepsRan).toBe(0);
  });

  it('skips later steps once signal is aborted mid-resolve', async () => {
    let registryCalled = false;
    let directoryCalled = false;
    const ctrl = new AbortController();

    net.__findPeerImpl = async () => {
      ctrl.abort();
      return [];
    };
    const trackingRegistry: NetworkStateRegistry = {
      lookup: async () => {
        registryCalled = true;
        return [];
      },
    };
    const trackingDir: AgentDirectoryLookup = {
      findRelayForPeer: async () => {
        directoryCalled = true;
        return null;
      },
    };

    const resolver = new PeerResolver({
      network: net,
      registry: trackingRegistry,
      agentDirectory: trackingDir,
    });
    await resolver.resolve(PEER_B, { signal: ctrl.signal });

    expect(registryCalled).toBe(false);
    expect(directoryCalled).toBe(false);
  });

  // Codex feedback PR #496 round 3: when both signal and
  // perStepTimeoutMs are passed, both must be honoured. Pre-fix,
  // signal silently won and the per-step cap was lost.

  it('composes step-local signal honouring both perStepTimeoutMs and outer signal', async () => {
    const seenSignals: AbortSignal[] = [];
    const seenTimeouts: number[] = [];
    net.__findPeerImpl = async (_pid, opts) => {
      if (opts?.signal) seenSignals.push(opts.signal);
      if (opts?.timeoutMs != null) seenTimeouts.push(opts.timeoutMs);
      return [];
    };

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    const ctrl = new AbortController();
    await resolver.resolve(PEER_B, {
      signal: ctrl.signal,
      perStepTimeoutMs: 1234,
    });

    expect(seenTimeouts).toEqual([1234]);
    expect(seenSignals).toHaveLength(1);
    // Step-local signal IS NOT the outer signal (it's a composition).
    expect(seenSignals[0]).not.toBe(ctrl.signal);
    expect(seenSignals[0].aborted).toBe(false);

    // Aborting the outer should propagate.
    ctrl.abort();
    expect(seenSignals[0].aborted).toBe(true);
  });

  it('step 4 (Codex PR #496 round 4): forwards opts.signal to agentDirectory.findRelayForPeer', async () => {
    net.__findPeerImpl = async () => [];
    const ctrl = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const signalingDir: AgentDirectoryLookup = {
      findRelayForPeer: async (_pid, opts) => {
        receivedSignal = opts?.signal;
        return null;
      },
    };

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: signalingDir,
    });
    await resolver.resolve(PEER_B, { signal: ctrl.signal });

    expect(receivedSignal).toBe(ctrl.signal);
  });

  it('defaultPerStepTimeoutMs constructor override applies when opts.perStepTimeoutMs is omitted', async () => {
    // PR feat/chain-network-libp2p-tunables: the constructor option
    // exists for test fixtures and embedders that wire their own
    // resolver — production callers (`connectToPeerId`, chat / routed
    // sends) always pass an explicit `perStepTimeoutMs`. Verify the
    // constructor override is honoured when callers don't pass a
    // per-call value, and that per-call values still win when they
    // do. Codex review of PR #698 round 2 removed the operator-facing
    // wiring; this test still covers the embedder surface.
    const seenTimeouts: number[] = [];
    net.__findPeerImpl = async (_pid, opts) => {
      if (opts?.timeoutMs != null) seenTimeouts.push(opts.timeoutMs);
      return [];
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
      defaultPerStepTimeoutMs: 9999,
    });

    await resolver.resolve(PEER_B);
    expect(seenTimeouts).toEqual([9999]);

    seenTimeouts.length = 0;
    await resolver.resolve(PEER_B, { perStepTimeoutMs: 1234 });
    expect(seenTimeouts).toEqual([1234]);
  });

  it('defaultPerStepTimeoutMs ignores invalid values (NaN / 0 / fractional / negative)', async () => {
    // Permissive validator: invalid values silently fall back to the
    // built-in 5s default so a typo in config.json doesn't brick the
    // resolver at startup.
    const seenTimeouts: number[] = [];
    net.__findPeerImpl = async (_pid, opts) => {
      if (opts?.timeoutMs != null) seenTimeouts.push(opts.timeoutMs);
      return [];
    };
    for (const bad of [NaN, 0, -1, 1.5, Infinity, -Infinity]) {
      seenTimeouts.length = 0;
      const resolver = new PeerResolver({
        network: net,
        registry,
        agentDirectory: makeAgentDir(),
        defaultPerStepTimeoutMs: bad,
      });
      await resolver.resolve(PEER_B);
      expect(seenTimeouts, `bad value: ${bad}`).toEqual([5_000]);
    }
  });

  it('step 4 (phonebook): findAgentDialAddresses returns direct multiaddrs (preferred over findRelayForPeer)', async () => {
    // PR feat/chain-agents-cg-phonebook: when the directory exposes
    // the richer lookup, the resolver primes the peerStore with the
    // agent's published `dkg:multiaddr` entries instead of (only)
    // synthesising the legacy circuit-relay form.
    net.__findPeerImpl = async () => [];
    const direct = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => RELAY_ADDR,
      findAgentDialAddresses: async () => ({
        multiaddrs: [direct],
        relayAddress: RELAY_ADDR,
        lastSeenMs: Date.now(),
      }),
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).toContain(direct);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 4 (phonebook): stale dkg:lastSeen drops multiaddrs but keeps the relay address', async () => {
    // Staleness threshold defaults to 24h. Agents whose lastSeen is
    // older are assumed offline / NAT-rebound; their direct addrs
    // are skipped. The relay address is still tried because relays
    // outlive individual peer NAT bindings.
    net.__findPeerImpl = async () => [];
    const direct = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => null,
      findAgentDialAddresses: async () => ({
        multiaddrs: [direct],
        relayAddress: RELAY_ADDR,
        lastSeenMs: Date.now() - 48 * 60 * 60 * 1000, // 48h old
      }),
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).not.toContain(direct);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 4 (phonebook): falls back to findRelayForPeer when findAgentDialAddresses is not implemented', async () => {
    // Backward-compat: older directory implementations that only
    // implement `findRelayForPeer` continue to work unchanged.
    net.__findPeerImpl = async () => [];
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => RELAY_ADDR,
      // findAgentDialAddresses intentionally omitted
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
  });

  it('step 4 (phonebook): falls back to findRelayForPeer when findAgentDialAddresses returns null', async () => {
    // Codex review of PR #700: the interface JSDoc documents that
    // the resolver falls back to the legacy lookup when the richer
    // one returns null. This protects peers whose profile pre-dates
    // the phonebook schema (no dkg:multiaddr) but who DO have a
    // legacy relay entry — without the fallback they'd resolve to
    // an empty address list.
    net.__findPeerImpl = async () => [];
    const findRelayForPeer = recorder(async () => RELAY_ADDR);
    const findAgentDialAddresses = recorder(async () => null);
    const dir: AgentDirectoryLookup = {
      findRelayForPeer,
      findAgentDialAddresses,
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
    expect(findAgentDialAddresses.calls).toHaveLength(1);
    expect(findRelayForPeer.calls).toHaveLength(1);
  });

  it('step 4 (phonebook): one malformed multiaddr does not poison sibling valid addresses', async () => {
    // Codex review of PR #700: `addKnownAddresses` runs `multiaddr(a)`
    // on every element in one batch; a single bad literal from an
    // untrusted profile would otherwise throw and drop the whole
    // array. The per-address retry path preserves valid siblings.
    net.__findPeerImpl = async () => [];
    const good1 = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const bad = 'not-a-multiaddr';
    const good2 = '/ip4/198.51.100.20/tcp/9090/p2p/' + PEER_B;
    // Mock addKnownAddresses: throw on any batch containing the bad
    // entry; succeed otherwise. Simulates libp2p's actual behaviour.
    const originalAdd = net.addKnownAddresses.bind(net);
    net.addKnownAddresses = async (pid, addrs) => {
      if (addrs.some((a) => a === bad)) {
        throw new Error(`Invalid multiaddr: ${bad}`);
      }
      await originalAdd(pid, addrs);
    };

    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => null,
      findAgentDialAddresses: async () => ({
        multiaddrs: [good1, bad, good2],
        lastSeenMs: Date.now(),
      }),
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).toContain(good1);
    expect(out).toContain(good2);
    expect(out).not.toContain(bad);
  });

  it('step 4 (phonebook): future lastSeenMs beyond skew allowance is rejected (multiaddrs dropped, relay still used)', async () => {
    // Codex review of PR #700 round 3: the round-2 freshness check
    // `Date.now() - lastSeenMs <= threshold` silently accepts ANY
    // future timestamp because the LHS becomes negative. A skewed
    // or malicious agents-CG profile could therefore keep dead
    // direct multiaddrs eligible indefinitely. The round-3 fix
    // adds a 5-minute upper bound; this test pins it.
    net.__findPeerImpl = async () => [];
    const direct = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => null,
      findAgentDialAddresses: async () => ({
        multiaddrs: [direct],
        relayAddress: RELAY_ADDR,
        lastSeenMs: Date.now() + 60 * 60 * 1000, // 1 hour in the future, way beyond 5min skew
      }),
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).not.toContain(direct);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 4 (phonebook): future lastSeenMs within skew allowance is still accepted', async () => {
    // Symmetric corner of the previous test: a small forward skew
    // (NTP drift between hosts) must NOT drop a legitimate fresh
    // profile. 1 minute in the future is well within the 5min
    // allowance, so multiaddrs should still be primed.
    net.__findPeerImpl = async () => [];
    const direct = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => null,
      findAgentDialAddresses: async () => ({
        multiaddrs: [direct],
        lastSeenMs: Date.now() + 60 * 1000, // 1 minute in the future, within 5min skew
      }),
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).toContain(direct);
  });

  it('step 4 (phonebook): missing lastSeenMs is treated as stale (multiaddrs dropped, relay still used)', async () => {
    // Codex review of PR #700 round 2: the `DiscoveredAgent.lastSeen`
    // JSDoc says unknown freshness should fall back to relay only.
    // The round-1 implementation treated `lastSeenMs === undefined` as
    // fresh, so partial / manual agents-CG entries (no heartbeat
    // pulse) bypassed the stale-data guard. This test pins the
    // round-2 behaviour: no `lastSeenMs` ⇒ multiaddrs ignored, relay
    // address still tried.
    net.__findPeerImpl = async () => [];
    const direct = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => null,
      findAgentDialAddresses: async () => ({
        multiaddrs: [direct],
        relayAddress: RELAY_ADDR,
        // lastSeenMs intentionally omitted
      }),
    };
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    const out = await resolver.resolve(PEER_B);
    expect(out).not.toContain(direct);
    expect(out).toContain(`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`);
  });

  it('step 4 (phonebook): custom agentDirectoryStaleThresholdMs is honoured', async () => {
    net.__findPeerImpl = async () => [];
    const direct = '/ip4/203.0.113.10/tcp/9090/p2p/' + PEER_B;
    const dir: AgentDirectoryLookup = {
      findRelayForPeer: async () => null,
      findAgentDialAddresses: async () => ({
        multiaddrs: [direct],
        lastSeenMs: Date.now() - 10_000, // 10s ago — fresh by default
      }),
    };
    // With a strict 1ms threshold even a 10s-old profile is stale.
    const strict = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
      agentDirectoryStaleThresholdMs: 1,
    });
    expect(await strict.resolve(PEER_B)).toEqual([]);

    // Default threshold (24h) keeps the same profile fresh.
    const lenient = new PeerResolver({
      network: net,
      registry,
      agentDirectory: dir,
    });
    expect(await lenient.resolve(PEER_B)).toContain(direct);
  });

  it('returns empty array when nothing resolves', async () => {
    net.__findPeerImpl = async () => [];
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([]);
  });

  it('deduplicates addresses across steps', async () => {
    const dup = '/ip4/1.2.3.4/tcp/9090';
    net.__findPeerImpl = async () => [dup];
    const customRegistry: NetworkStateRegistry = {
      lookup: async () => [dup, '/ip4/9.9.9.9/tcp/9090'],
    };

    const resolver = new PeerResolver({
      network: net,
      registry: customRegistry,
      agentDirectory: makeAgentDir(),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([dup, '/ip4/9.9.9.9/tcp/9090']);
  });

  it('skips DHT step when network does not implement findPeer', async () => {
    const noRoutingNet = { ...net, findPeer: undefined } as Network;
    const resolver = new PeerResolver({
      network: noRoutingNet,
      registry,
      agentDirectory: makeAgentDir(async () => RELAY_ADDR),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual([`${RELAY_ADDR}/p2p-circuit/p2p/${PEER_B}`]);
  });

  it('recordDialFailure / isHealthy / recordDialSuccess are stubs that do not throw', () => {
    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    expect(() => resolver.recordDialSuccess('/ip4/1.2.3.4/tcp/9090')).not.toThrow();
    expect(() => resolver.recordDialFailure('/ip4/1.2.3.4/tcp/9090', 'ETIMEDOUT')).not.toThrow();
    expect(resolver.isHealthy('/ip4/1.2.3.4/tcp/9090')).toBe(true);
  });
});
