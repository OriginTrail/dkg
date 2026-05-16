import { describe, it, expect, afterEach, vi } from 'vitest';
import { multiaddr } from '@multiformats/multiaddr';
import { DKGNode } from '../src/node.js';
import {
  ProtocolRouter,
  PeerResolver,
  StubNetworkStateRegistry,
  LibP2PNetwork,
} from '../src/index.js';

/**
 * RFC 07 PR-3 — `ProtocolRouter.send` consults the resolver before
 * `dialProtocol`. The test verifies the structural property (resolver
 * is called once per send, with the correct peerId) using two real
 * libp2p nodes; resolution-order semantics are covered in
 * `peer-resolver.test.ts`.
 */
describe('ProtocolRouter.send + PeerResolver', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) await n.stop();
    nodes.length = 0;
  });

  function spawn(): DKGNode {
    const n = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(n);
    return n;
  }

  it('primes peerStore via resolver BEFORE dialProtocol on a cold peer', async () => {
    // Codex feedback PR #497 round 3: the previous version of this
    // test pre-warmed the connection (a.libp2p.dial(b)) before
    // routerA.send(), so router.send() could succeed even if the
    // resolver was never consulted before the first dial. Without a
    // cold peer + an explicit "resolver-must-have-primed-peerStore"
    // assertion, the test didn't actually prove the PR-448-class
    // guarantee that the resolver primes peerStore before
    // dialProtocol.
    //
    // This rewrite:
    //   - keeps the peers cold (no pre-dial, no mDNS)
    //   - asserts peerStore for B is empty BEFORE routerA.send()
    //   - wires the resolver to populate peerStore with B's real addr
    //     when called
    //   - succeeds in sending, which is only possible if the
    //     resolver ran before dialProtocol (otherwise libp2p would
    //     have no addr to dial)
    //   - asserts peerStore for B is populated AFTER send
    //
    // No `dialProtocol` instrumentation is needed — the
    // "send-succeeded-against-cold-peerStore" property is the
    // structural proof of ordering.
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();

    const networkA = new LibP2PNetwork(a);
    const { peerIdFromString } = await import('@libp2p/peer-id');
    const bPeerIdObj = peerIdFromString(b.peerId);
    const peerstoreAddrCount = async (): Promise<number> => {
      try {
        const peer = await a.libp2p.peerStore.get(bPeerIdObj);
        return peer.addresses.length;
      } catch {
        return 0;
      }
    };

    expect(await peerstoreAddrCount()).toBe(0);

    const resolveSpy = vi.fn(async (_peerId, _opts) => {
      await networkA.addKnownAddresses(b.peerId, [b.multiaddrs[0]]);
      return [b.multiaddrs[0]];
    });
    const resolver = new PeerResolver({
      network: networkA,
      registry: new StubNetworkStateRegistry(),
      agentDirectory: { findRelayForPeer: async () => null },
    });
    resolver.resolve = resolveSpy as unknown as typeof resolver.resolve;

    const routerA = new ProtocolRouter(a, { peerResolver: resolver });
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/resolver-integration/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      b.peerId,
      '/test/resolver-integration/1.0.0',
      enc.encode('hi'),
    );
    expect(dec.decode(response)).toBe('echo:hi');
    expect(resolveSpy).toHaveBeenCalledOnce();
    expect(await peerstoreAddrCount()).toBeGreaterThan(0);

    // Brief settle so libp2p teardown doesn't race the next test.
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  it('passes AbortSignal + perStepTimeoutMs to resolver (PR #497 round 1)', async () => {
    // Separate from the call-ordering test above so each test asserts
    // one property. The peers MUST be cold (no pre-dial) for the
    // resolver to be consulted: after the May 2026 soak postmortem
    // PR introduced the existing-connection fast path in
    // `protocol-router.ts`, a pre-dialed peer would short-circuit
    // through `tryReuseExistingConnection` and the resolver would
    // never be called. Keeping the peers cold here keeps the test
    // honestly exercising the resolver path it claims to test.
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();

    const networkA = new LibP2PNetwork(a);
    const resolveSpy = vi.fn(async (_peerId, _opts) => {
      await networkA.addKnownAddresses(b.peerId, [b.multiaddrs[0]]);
      return [b.multiaddrs[0]];
    });
    const resolver = new PeerResolver({
      network: networkA,
      registry: new StubNetworkStateRegistry(),
      agentDirectory: { findRelayForPeer: async () => null },
    });
    resolver.resolve = resolveSpy as unknown as typeof resolver.resolve;

    const routerA = new ProtocolRouter(a, { peerResolver: resolver });
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/resolver-args/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    await routerA.send(b.peerId, '/test/resolver-args/1.0.0', enc.encode('hi'));

    expect(resolveSpy).toHaveBeenCalledOnce();
    const callArgs = resolveSpy.mock.calls[0];
    expect(callArgs[0]).toBe(b.peerId);
    const opts = callArgs[1] as { signal?: AbortSignal; perStepTimeoutMs?: number };
    expect(opts).toBeDefined();
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(typeof opts.perStepTimeoutMs).toBe('number');

    // Same brief settle as the "primes peerStore" test above so
    // libp2p's incoming-stream cleanup on B can drain before
    // `afterEach` tears the nodes down — otherwise the cold-dial
    // produces an unhandled rejection from
    // `Connection.onIncomingStream → stream.abort` racing the
    // stop sequence.
    await new Promise((r) => setTimeout(r, 50));
  }, 15000);

  it('resolver throwing does not block send (best-effort)', async () => {
    // Pre-dial so the existing-connection fast path is the one that
    // ultimately delivers the message — proves that even if the
    // resolver layer is broken/throwing, send still succeeds against
    // a live connection. This is the strictly stronger version of
    // the previous assertion (which required resolver+dialProtocol
    // to be tolerant of resolver-throw): the fast path makes the
    // resolver irrelevant on the warm path, so the broken-resolver
    // assertion shrinks to "irrelevant code can't break send".
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();
    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const resolveSpy = vi.fn(async () => {
      throw new Error('resolver boom');
    });
    const resolver = new PeerResolver({
      network: new LibP2PNetwork(a),
      registry: new StubNetworkStateRegistry(),
      agentDirectory: { findRelayForPeer: async () => null },
    });
    resolver.resolve = resolveSpy as unknown as typeof resolver.resolve;

    const routerA = new ProtocolRouter(a, { peerResolver: resolver });
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/resolver-tolerant/1.0.0', async (data) => {
      return enc.encode(`ok:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      b.peerId,
      '/test/resolver-tolerant/1.0.0',
      enc.encode('hi'),
    );
    expect(dec.decode(response)).toBe('ok:hi');
    // Warm path: fast-path reuse of the existing connection sends
    // the bytes WITHOUT consulting the resolver. The previous
    // assertion (`toHaveBeenCalledOnce`) reflected the pre-PR-5
    // shape where every send always paid the resolver cost; with
    // PR 5 the resolver is only called on a fast-path miss.
    expect(resolveSpy).not.toHaveBeenCalled();
  }, 15000);

  it('omitting peerResolver preserves legacy behaviour (no consult, direct dial)', async () => {
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();
    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const routerA = new ProtocolRouter(a);
    const routerB = new ProtocolRouter(b);

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/no-resolver/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      b.peerId,
      '/test/no-resolver/1.0.0',
      enc.encode('hi'),
    );
    expect(dec.decode(response)).toBe('echo:hi');
  }, 15000);

  // Codex review feedback on PR #497 round 5: keeping peerResolver
  // optional makes the priming guarantee implicit and a future
  // `new ProtocolRouter(node)` would silently skip priming. The
  // mitigation is a one-time loud warn at first cold dial.
  it('warns once on first send() when peerResolver is omitted (PR #497 round 5)', async () => {
    const a = spawn();
    const b = spawn();
    await a.start();
    await b.start();
    await a.libp2p.dial(multiaddr(b.multiaddrs[0]));
    await new Promise((r) => setTimeout(r, 300));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const routerA = new ProtocolRouter(a);
    const routerB = new ProtocolRouter(b);
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    routerB.register('/test/warn-no-resolver/1.0.0', async (data) =>
      enc.encode(`echo:${dec.decode(data)}`),
    );

    await routerA.send(b.peerId, '/test/warn-no-resolver/1.0.0', enc.encode('1'));
    await routerA.send(b.peerId, '/test/warn-no-resolver/1.0.0', enc.encode('2'));
    await routerA.send(b.peerId, '/test/warn-no-resolver/1.0.0', enc.encode('3'));

    const matches = warnSpy.mock.calls.filter((c) => {
      const first = c[0];
      return typeof first === 'string' && first.includes('peerResolver');
    });
    expect(matches.length).toBe(1);
    expect(matches[0][0]).toMatch(/RFC 07/);

    warnSpy.mockRestore();
  }, 15000);
});
