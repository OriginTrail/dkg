import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PeerResolver,
  StubNetworkStateRegistry,
  type Network,
  type NetworkStateRegistry,
  type AgentDirectoryLookup,
  type Address,
  type NodeIdentity,
} from '../src/network/index.js';

const PEER_A = '12D3KooWA' + 'a'.repeat(43);
const PEER_B = '12D3KooWB' + 'b'.repeat(43);
const RELAY_ADDR =
  '/ip4/178.104.54.178/tcp/9090/p2p/12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';

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
    const findPeerSpy = vi.fn();
    net.__findPeerImpl = findPeerSpy;
    const dirSpy = vi.fn(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(out).toEqual(['/ip4/10.0.0.1/tcp/9090']);
    expect(findPeerSpy).not.toHaveBeenCalled();
    expect(dirSpy).not.toHaveBeenCalled();
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
    const findPeerSpy = vi.fn();
    net.__findPeerImpl = findPeerSpy;

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(),
    });
    await resolver.resolve(PEER_B, { skipDht: true });

    expect(findPeerSpy).not.toHaveBeenCalled();
  });

  it('step 2: DHT failures are swallowed and resolution proceeds', async () => {
    net.__findPeerImpl = async () => {
      throw new Error('dht boom');
    };
    const dirSpy = vi.fn(async () => RELAY_ADDR);

    const resolver = new PeerResolver({
      network: net,
      registry,
      agentDirectory: makeAgentDir(dirSpy),
    });
    const out = await resolver.resolve(PEER_B);

    expect(dirSpy).toHaveBeenCalledWith(PEER_B, expect.any(Object));
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
    const dirSpy = vi.fn(async () => RELAY_ADDR);

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
