import { describe, it, expect, afterEach } from 'vitest';
import { DKGNode, nodeHasDirectPublicAddress, connectionsBusyAppProtocols } from '../src/node.js';
import { ProtocolRouter } from '../src/protocol-router.js';
import { PeerDiscoveryManager } from '../src/discovery.js';
import { TypedEventBus } from '../src/event-bus.js';

function recorder<A extends unknown[], R>(impl: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => { calls.push(args); return impl(...args); };
  return Object.assign(fn, { calls });
}

// Pristine console methods, captured before any test swaps them. Each
// test that observes console output installs a recorder via the helper
// below; afterEach reinstates these unconditionally (see note there).
const ORIG_CONSOLE_WARN = console.warn;
const ORIG_CONSOLE_LOG = console.log;

// Install a recorder over a suppressed console method (the recorder
// swallows the call, matching the original suppress-and-observe spy).
// Returns the recorder so the test can inspect `.calls`.
function spyConsole(method: 'warn' | 'log') {
  const rec = recorder((..._args: unknown[]): void => {});
  console[method] = rec as unknown as typeof console.warn;
  return rec;
}

describe('Circuit Relay', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    // Unconditionally restore any console recorders installed in the
    // test body. Codex PR #526 round 5e: per-test recorders were
    // reinstated inline at the bottom of each test, but a thrown
    // assertion or start() error left console swapped and corrupted
    // later tests. Restoring at this scope guarantees cleanup even on
    // failure.
    console.warn = ORIG_CONSOLE_WARN;
    console.log = ORIG_CONSOLE_LOG;
    for (const n of nodes) {
      try {
        await n.stop();
      } catch (err) {
        console.warn('Teardown: node.stop() failed', err);
      }
    }
    nodes.length = 0;
  });

  it('two nodes communicate through a direct connection via relay peer', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    const nodeB = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();

    await new Promise(r => setTimeout(r, 1000));

    const relayPeers = relay.libp2p.getPeers().map(p => p.toString());
    expect(relayPeers).toContain(nodeA.peerId);
    expect(relayPeers).toContain(nodeB.peerId);

    const { multiaddr } = await import('@multiformats/multiaddr');
    const bAddr = nodeB.multiaddrs[0];
    await nodeA.libp2p.dial(multiaddr(bAddr));
    await new Promise(r => setTimeout(r, 500));

    const enc = new TextEncoder();
    const dec = new TextDecoder();

    const routerA = new ProtocolRouter(nodeA);
    const routerB = new ProtocolRouter(nodeB);

    routerB.register('/test/relay-echo/1.0.0', async (data) => {
      return enc.encode(`relayed:${dec.decode(data)}`);
    });

    const response = await routerA.send(
      nodeB.peerId,
      '/test/relay-echo/1.0.0',
      enc.encode('ping'),
    );
    expect(dec.decode(response)).toBe('relayed:ping');
  }, 30000);

  it('protocol stream through circuit relay upgrades to direct via retry', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    const nodeB = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(nodeA, nodeB);
    await nodeA.start();
    await nodeB.start();
    await new Promise(r => setTimeout(r, 2000));

    const enc = new TextEncoder();
    const dec = new TextDecoder();
    const routerA = new ProtocolRouter(nodeA);
    routerA.register('/test/relay-echo/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    const routerB = new ProtocolRouter(nodeB);

    // Dial through the circuit relay — ProtocolRouter.send will retry after
    // the connection manager upgrades from relay to direct mid-stream.
    const { multiaddr } = await import('@multiformats/multiaddr');
    await nodeB.libp2p.dial(multiaddr(`${relayAddr}/p2p-circuit/p2p/${nodeA.peerId}`));
    await new Promise(r => setTimeout(r, 2000));

    const response = await routerB.send(
      nodeA.peerId,
      '/test/relay-echo/1.0.0',
      enc.encode('via-circuit'),
      15000,
    );
    expect(dec.decode(response)).toBe('echo:via-circuit');
    routerA.unregister('/test/relay-echo/1.0.0');
  }, 30000);

  it('relay node starts with enableRelayServer', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    expect(relay.isStarted).toBe(true);
    expect(relay.peerId).toBeTruthy();
    expect(relay.multiaddrs.length).toBeGreaterThan(0);
  }, 15000);

  it('node can connect to a relay peer on startup', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(node);
    await node.start();

    await new Promise(r => setTimeout(r, 500));

    const peers = node.libp2p.getPeers().map(p => p.toString());
    expect(peers).toContain(relay.peerId);
  }, 15000);

  it('getConnections reports transport type for relay connections', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(node);
    await node.start();
    await new Promise(r => setTimeout(r, 1000));

    const bus = new TypedEventBus();
    const discovery = new PeerDiscoveryManager(node, bus);
    const conns = await discovery.getConnections();

    expect(conns.length).toBeGreaterThan(0);

    const toRelay = conns.find(c => c.peerId === relay.peerId);
    expect(toRelay).toBeDefined();
    expect(toRelay!.transport).toBe('direct');
    expect(toRelay!.direction).toBeDefined();
    expect(toRelay!.openedAt).toBeGreaterThan(0);
  }, 15000);

  it('getConnectionSummary returns correct totals', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const nodeA = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(nodeA);
    await nodeA.start();
    await new Promise(r => setTimeout(r, 1000));

    const bus = new TypedEventBus();
    const discovery = new PeerDiscoveryManager(nodeA, bus);
    const summary = await discovery.getConnectionSummary();

    expect(summary.total).toBeGreaterThan(0);
    expect(summary.direct + summary.relayed).toBe(summary.total);
    expect(summary.peers.length).toBe(summary.total);
  }, 15000);

  it('edge node recovers relay connection after disruption', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/') && !a.includes('/ws'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    await new Promise(r => setTimeout(r, 1000));

    // Verify initial connection
    expect(edge.libp2p.getConnections().length).toBeGreaterThan(0);

    // Force-close all connections to simulate network drop
    for (const conn of edge.libp2p.getConnections()) {
      await conn.close();
    }

    // Watchdog checks every 10s and redials after 1.5–2.5s delay; allow up to 25s for recovery
    let restored = false;
    for (let i = 0; i < 26; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (edge.libp2p.getConnections().length > 0) {
        restored = true;
        break;
      }
    }

    expect(restored).toBe(true);
  }, 35000);

  it('node with relay peers starts with tcp keepAlive and connectionManager config', async () => {
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    await new Promise(r => setTimeout(r, 1500));

    // Node should have at least one connection (to relay); config (keepAlive, maxConnections) is applied at start
    expect(edge.libp2p.getConnections().length).toBeGreaterThan(0);
    expect(edge.isStarted).toBe(true);
  }, 15000);

  it('edge with relayReservationCount=2 and 2 relays reserves on both', async () => {
    // PR3 multi-reservation behavior: by configuring N `/p2p-circuit`
    // listen addrs + `reservationConcurrency: N` we expect libp2p to
    // hold N parallel reservations on N distinct relays (subject to
    // discovery — bootstrap supplies the relayPeers list directly so
    // there's no random-walk delay). This test pins the wiring
    // end-to-end: 2 relays + 1 edge with count=2 must produce 2
    // distinct `/p2p-circuit` self-addresses on the edge, each tagged
    // with a different relay's PeerId.
    //
    // Why count=2 not the default 3: keeps the test light (one fewer
    // libp2p instance to spin up + tear down) while still exercising
    // the N>1 path. The validation tests cover the full default range.
    const relay1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    const relay2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay1, relay2);
    await relay1.start();
    await relay2.start();

    const relay1Addr = relay1.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay2Addr = relay2.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relay1Addr, relay2Addr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    // Poll for both reservations — discovery + reservation HOP roundtrip
    // takes a beat per relay. Bound the wait at 10s (ample margin over
    // the typical 1-2s observed locally) and bail early when both
    // /p2p-circuit self-addrs land. We assert the relay PeerIds are
    // distinct so a single reservation announcing two equivalent addrs
    // can't false-positive.
    const relay1PidStr = relay1.peerId;
    const relay2PidStr = relay2.peerId;
    const deadline = Date.now() + 10_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      const hasRelay1 = circuitAddrs.some(a => a.includes(`/p2p/${relay1PidStr}/p2p-circuit`));
      const hasRelay2 = circuitAddrs.some(a => a.includes(`/p2p/${relay2PidStr}/p2p-circuit`));
      if (hasRelay1 && hasRelay2) break;
      await new Promise(r => setTimeout(r, 250));
    }

    const hasRelay1 = circuitAddrs.some(a => a.includes(`/p2p/${relay1PidStr}/p2p-circuit`));
    const hasRelay2 = circuitAddrs.some(a => a.includes(`/p2p/${relay2PidStr}/p2p-circuit`));
    expect(hasRelay1, `expected reservation on relay1; circuitAddrs=${JSON.stringify(circuitAddrs)}`).toBe(true);
    expect(hasRelay2, `expected reservation on relay2; circuitAddrs=${JSON.stringify(circuitAddrs)}`).toBe(true);
  }, 20000);

  it('clamps relayReservationCount to relayPeers.length and warns', async () => {
    // Codex review on PR #526: requesting 3 reservations when only 1
    // relay is configured can't deliver the documented N-(N-1)
    // tolerance and would queue an unattainable target. The fix is
    // to clamp + warn at start(). We verify the warn fires and the
    // edge actually only ends up with 1 /p2p-circuit self-addr (not
    // 3 attempts queued forever).
    const warnSpy = spyConsole('warn');

    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
      relayReservationCount: 3,
    });
    nodes.push(edge);
    await edge.start();

    const clampWarn = warnSpy.calls.find(call =>
      typeof call[0] === 'string' && call[0].includes('clamping to 1'),
    );
    expect(clampWarn, `expected clamp warning; got: ${JSON.stringify(warnSpy.calls)}`).toBeDefined();

    // Wait for the (single) reservation, then assert exactly one
    // distinct circuit self-addr (i.e. no extra duplicate listen addrs
    // hung up waiting for a relay that doesn't exist).
    const deadline = Date.now() + 5_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      if (circuitAddrs.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const distinctRelayPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(distinctRelayPids.size).toBe(1);

    console.warn = ORIG_CONSOLE_WARN;
  }, 15000);

  it('skips multi-reservation amplification on relay-server (core) nodes with relayPeers', async () => {
    // PR #526 round-2 review (branarakic): the daemon's CLI fallback
    // supplies network.relays to BOTH core and edge nodes by default,
    // so without this gate a `nodeRole: "core"` instance would push
    // 3 `/p2p-circuit` listen addrs and try to reserve on other
    // relays. That contradicts the docs framing ("public node doesn't
    // need relay reservations") and multiplies relay-slot consumption
    // network-wide. The fix: core nodes with relayPeers fall back to
    // the legacy single /p2p-circuit listen addr, and
    // relayReservationCount is ignored with a warning.
    //
    // Note: the existing "node with relay peers starts with tcp
    // keepAlive" test above asserts a core node still functions when
    // relayPeers are set — this test pins the warning + the absence
    // of the multi-reservation amplification.
    const warnSpy = spyConsole('warn');

    const upstreamRelay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(upstreamRelay);
    await upstreamRelay.start();

    const upstreamRelayAddr = upstreamRelay.multiaddrs.find(a => a.includes('/tcp/'))!;

    // Core node ALSO running a relay server, which ALSO has a
    // relayPeer (the daemon-fallback scenario branarakic flagged).
    // We set count=3 to make sure it's actively ignored.
    const core = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
      relayPeers: [upstreamRelayAddr],
      relayReservationCount: 3,
    });
    nodes.push(core);
    await core.start();

    const ignoreWarn = warnSpy.calls.find(call =>
      typeof call[0] === 'string'
      && call[0].includes('relayReservationCount=3')
      && call[0].includes('relay servers don\'t multi-reserve'),
    );
    expect(
      ignoreWarn,
      `expected core-ignore warning; got: ${JSON.stringify(warnSpy.calls)}`,
    ).toBeDefined();

    console.warn = ORIG_CONSOLE_WARN;

    // Also assert the actual NON-amplification contract — Codex PR #526
    // round 5d caught that the warning-only assertion above wouldn't
    // catch a regression where the warning still fires but the
    // listener was wrongly amplified. Core nodes with relayPeers must
    // get AT MOST one `/p2p-circuit` listen address (the legacy
    // single-reservation fallback), regardless of relayReservationCount.
    const coreCircuitSelfAddrs = core.libp2p
      .getMultiaddrs()
      .map(ma => ma.toString())
      .filter(a => a.includes('/p2p-circuit'));
    expect(
      coreCircuitSelfAddrs.length,
      `core node with relayPeers must NOT amplify into multiple /p2p-circuit reservations; got: ${JSON.stringify(coreCircuitSelfAddrs)}`,
    ).toBeLessThanOrEqual(1);
  }, 15000);

  it('dedupes duplicate relayPeers entries by peerId for clamp + relayTargets', async () => {
    // Codex review on PR #526 round 4 caught that `reservedRelayCount`
    // was derived from raw `relayTargets`, so a duplicate config like
    // `[relayA-with-suffix-A, relayA-with-suffix-B]` (two entries that
    // resolve to the same peerId) was counted twice. With
    // `relayReservationCount: 2`, the watchdog would think target is
    // met by one actual reservation duplicated in its view — defeating
    // the redundancy guarantee.
    //
    // Fix asserts:
    //   1. The clamp warns when distinct count < raw entry count, and
    //      the chosen `relayReservationCount` is bounded by the distinct
    //      count, not the raw length.
    //   2. The edge ends up with exactly 1 distinct `/p2p-circuit`
    //      self-addr (one reservation on the one real relay), not 2
    //      duplicate entries that would falsely satisfy the watchdog.
    const warnSpy = spyConsole('warn');

    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();

    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr, relayAddr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const dedupWarn = warnSpy.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('2 entries supplied')
      && call[0].includes('1 distinct relay peers usable')
      && call[0].includes('exact-duplicate multiaddrs'),
    );
    expect(
      dedupWarn,
      `expected dedup warning; got: ${JSON.stringify(warnSpy.calls.map(c => c[0]))}`,
    ).toBeDefined();

    const clampWarn = warnSpy.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('clamping to 1'),
    );
    expect(
      clampWarn,
      `expected clamp-to-distinct-count warning; got: ${JSON.stringify(warnSpy.calls.map(c => c[0]))}`,
    ).toBeDefined();

    const deadline = Date.now() + 5_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      if (circuitAddrs.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const distinctRelayPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(distinctRelayPids.size).toBe(1);

    console.warn = ORIG_CONSOLE_WARN;
  }, 15000);

  it('drops self-peerId entries from the clamp + relayTargets (Codex PR #526 round 5)', async () => {
    // Bug Codex caught: the round-4 distinct-peerId clamp counted
    // entries pointing at this node's OWN peerId, even though the
    // relayTargets push later filters them out. Result: clamp could
    // pass `count = N + 1` against actual `relayTargets.length = N`,
    // making the watchdog gate (`reservedRelayCount >= target`)
    // unattainable.
    //
    // Test: edge with `[realRelayAddr, selfAddr]` and
    // `relayReservationCount: 2`. Expected behaviour with the
    // round-5 fix:
    //   1. Self-filter warning fires (`1 pointing at this node's
    //      own peerId`).
    //   2. Clamp warning fires (`clamping to 1`) — the canonical
    //      usable count is 1, not 2.
    //   3. Edge gets exactly 1 reservation; watchdog never tries to
    //      claim a 2nd because target was clamped to the achievable
    //      1, not the over-counted 2.
    const { ed25519GetPublicKey } = await import('../src/crypto/ed25519.js');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const { privateKeyFromRaw } = await import('@libp2p/crypto/keys');
    const { randomBytes } = await import('crypto');

    const seed = new Uint8Array(randomBytes(32));
    const pub = await ed25519GetPublicKey(seed);
    const raw64 = new Uint8Array(64);
    raw64.set(seed, 0);
    raw64.set(pub, 32);
    const pk = privateKeyFromRaw(raw64);
    const selfPid = peerIdFromPrivateKey(pk);
    const selfMultiaddr = `/ip4/127.0.0.1/tcp/9999/p2p/${selfPid.toString()}`;

    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const warnSpy = spyConsole('warn');

    const edge = new DKGNode({
      privateKey: seed,
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr, selfMultiaddr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const selfFilterWarn = warnSpy.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes("pointing at this node's own peerId"),
    );
    expect(
      selfFilterWarn,
      `expected self-filter warning; got: ${JSON.stringify(warnSpy.calls.map(c => c[0]))}`,
    ).toBeDefined();

    const clampWarn = warnSpy.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('usable relay peers=1')
      && call[0].includes('clamping to 1'),
    );
    expect(
      clampWarn,
      `expected clamp-to-usable-count warning; got: ${JSON.stringify(warnSpy.calls.map(c => c[0]))}`,
    ).toBeDefined();

    console.warn = ORIG_CONSOLE_WARN;

    const deadline = Date.now() + 5_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      if (circuitAddrs.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const distinctRelayPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(distinctRelayPids.size).toBe(1);
  }, 15000);

  it('preserves alternate multiaddrs for the same peerId as fallbacks (Codex PR #526 round 5c)', async () => {
    // Bug Codex caught: the round-5 dedup-by-peerId dropped alternate
    // multiaddrs for the same relay (e.g. `[relayA-tcp, relayA-ws]`
    // collapsed to one address) — defeating libp2p's transport-fallback
    // behaviour and clamping the node to fewer reservations than
    // configured if the surviving address went stale.
    //
    // Round-5c fix: dedup is now by full multiaddr STRING, not by
    // peerId; same-peerId-different-multiaddr entries get aggregated
    // into one `RelayTarget` whose `addrs` carries both, and the
    // node passes `addrs` (an array) to `node.dial()` so libp2p
    // tries each in order.
    //
    // Test: spin up a real relay. Configure edge with the relay's
    // real multiaddr PLUS a fake unreachable multiaddr that resolves
    // to the SAME peerId (different transport endpoint).
    // Expected: edge merges them under one peer, the warning
    // categorises them as "alternate addrs merged", reservation
    // count stays 1, AND the edge actually establishes a relay
    // reservation (the real addr works even though the alternate
    // one is unreachable).
    // Round-5e adjustment: alt-addrs aggregation is a healthy
    // supported config and is now logged at info level
    // (`console.log`), NOT at warn level. The test must record log
    // calls to observe it AND must NOT see any warn call mentioning
    // "alternate addrs" (otherwise we've regressed to noisy warnings
    // on healthy startup).
    const warnSpy = spyConsole('warn');
    const logSpy = spyConsole('log');

    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();
    const realAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;
    const realPidMatch = realAddr.match(/\/p2p\/([^/]+)$/);
    expect(realPidMatch, 'relay multiaddr must include /p2p/<peerId>').not.toBeNull();
    const relayPid = realPidMatch![1];
    const fakeAlternateAddr = `/ip4/127.0.0.1/tcp/9/p2p/${relayPid}`;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [realAddr, fakeAlternateAddr],
      relayReservationCount: 1,
    });
    nodes.push(edge);
    await edge.start();

    const altInfo = logSpy.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('alternate addrs merged')
      && call[0].includes('1 distinct relay peers'),
    );
    expect(
      altInfo,
      `expected alt-addrs-merged info log; got: ${JSON.stringify(logSpy.calls.map(c => c[0]))}`,
    ).toBeDefined();
    const altWarn = warnSpy.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('alternate addrs'),
    );
    expect(
      altWarn,
      `alt-addrs aggregation must NOT trigger a warn-level log on a healthy config; got warn calls: ${JSON.stringify(warnSpy.calls.map(c => c[0]))}`,
    ).toBeUndefined();

    const deadline = Date.now() + 5_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      if (circuitAddrs.length > 0) break;
      await new Promise(r => setTimeout(r, 250));
    }
    expect(
      circuitAddrs.length,
      `edge should have established a reservation via the working addr; got: ${JSON.stringify(circuitAddrs)}`,
    ).toBeGreaterThan(0);
  }, 15000);

  it('falls back to no-relays path when every relayPeers entry is unusable (Codex PR #526 round 5b)', async () => {
    // Bug Codex caught: the legacy `/p2p-circuit` listener fallback
    // was gated on `else if (this.config.relayPeers?.length)`, which
    // matched not only the intended core-node case but also edge
    // nodes whose relayPeers were ALL filtered out
    // (malformed/self/duplicate) — leaving them half-configured
    // (`/p2p-circuit` listener with nothing to reserve against).
    // Round-5b fix: gate the fallback on `enableRelay && relayPeers`,
    // so the unusable case truly hits the no-relays path.
    //
    // Test: edge with `relayPeers: [malformed, malformed]`.
    //   - Expected: NO `/p2p-circuit` in listen addresses, no
    //     watchdog started, no `/p2p-circuit` self-addrs ever
    //     advertised.
    const warnSpy = spyConsole('warn');

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: ['/not-a-multiaddr', 'also-malformed'],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const usableWarn = warnSpy.calls.find((call) =>
      typeof call[0] === 'string'
      && call[0].includes('0 distinct relay peers usable')
      && call[0].includes('malformed'),
    );
    expect(
      usableWarn,
      `expected "0 distinct relay peers usable / malformed" warning; got: ${JSON.stringify(warnSpy.calls.map(c => c[0]))}`,
    ).toBeDefined();
    console.warn = ORIG_CONSOLE_WARN;

    await new Promise(r => setTimeout(r, 500));

    const circuitAddrs = edge.libp2p
      .getMultiaddrs()
      .map(ma => ma.toString())
      .filter(a => a.includes('/p2p-circuit'));
    expect(
      circuitAddrs,
      `expected NO /p2p-circuit self-addrs (edge should have fallen back to no-relays path); got: ${JSON.stringify(circuitAddrs)}`,
    ).toHaveLength(0);
  }, 10000);

  it('caps forced reservation-redials per tick at the missing-slot count (Codex PR #526 round 5)', async () => {
    // Bug Codex caught: the round-4 watchdog called
    // `refreshReservationSnapshot()` after each successful
    // `node.dial()` but kept iterating. A completed dial doesn't
    // guarantee the new `/p2p-circuit` self-addr is advertised yet,
    // so during recovery from `1/2 → 2/2` in a `3 peers, target=2`
    // setup, the post-dial snapshot would still see
    // `reservedRelayCount === 1` and the loop would redial the
    // third relay too — overshooting the target.
    //
    // Round-5 fix: cap forced redials per tick at the missing-slot
    // count computed at TICK START. For 3 peers / target=2 / starting
    // 2 reservations held, missing=0 → no forced redials at all
    // even if the snapshot transiently lies about which peer is
    // reserved during a tick.
    //
    // We can't easily simulate "1/2 reservations" deterministically,
    // so we assert the simpler invariant: when target is fully met,
    // the watchdog must never log "to force reserve" for any peer.
    // This catches both the existing round-3 bug AND any regression
    // where the budget cap is computed incorrectly (since
    // missing=0 should hard-cap at 0 forced redials regardless of
    // the per-peer gate state).
    const relay1 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false, enableRelayServer: true });
    const relay2 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false, enableRelayServer: true });
    const relay3 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false, enableRelayServer: true });
    nodes.push(relay1, relay2, relay3);
    await relay1.start();
    await relay2.start();
    await relay3.start();
    const relay1Addr = relay1.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay2Addr = relay2.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay3Addr = relay3.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relay1Addr, relay2Addr, relay3Addr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const distinct = new Set(
        edge.libp2p.getMultiaddrs()
          .map(ma => ma.toString())
          .filter(a => a.includes('/p2p-circuit'))
          .map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1])
          .filter(Boolean),
      );
      if (distinct.size >= 2) break;
      await new Promise(r => setTimeout(r, 250));
    }

    const logSpy = spyConsole('log');
    try {
      // Three back-to-back ticks: even if one tick saw a stale
      // snapshot, the per-tick budget should keep total forced
      // redials at 0 across all of them when the target is met.
      const tick = (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick.bind(edge);
      await tick();
      await tick();
      await tick();
      const churnLogs = logSpy.calls.filter((call) =>
        typeof call[0] === 'string'
        && call[0].includes('Relay watchdog')
        && call[0].includes('to force reserve'),
      );
      expect(
        churnLogs,
        `expected 0 forced-redial logs across 3 ticks; got: ${JSON.stringify(churnLogs.map(c => c[0]))}`,
      ).toHaveLength(0);
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }
  }, 25000);

  it('does not churn the unreserved relay when relayReservationCount < relayPeers.length', async () => {
    // Codex review on PR #526 round 3 caught a real bug in the round-2
    // watchdog: with target>1, the per-relay gate required EVERY
    // configured peer to hold a reservation. For configs like 3 peers
    // + count=2, the unreserved third peer's gate
    // (`!thisRelayHasReservation`) stayed true forever and the
    // watchdog would tear it down + redial on every grace-window
    // expiry — wasted churn at best, breaks the existing 2 reservations
    // at worst (drop+redial closes the existing connection).
    //
    // Round-3 fix: gate is now "this peer holds OR `reservedRelayCount
    // >= target`". For 2-of-3 we expect 2 reservations and the
    // watchdog should leave the third peer alone.
    //
    // We assert the absence of churn by spying on the watchdog's
    // dropping/redial log line and triggering watchdogTick directly
    // (it's `private` so we type-cast — same escape hatch as a few
    // other tests in this file).
    const relay1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    const relay2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    const relay3 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay1, relay2, relay3);
    await relay1.start();
    await relay2.start();
    await relay3.start();

    const relay1Addr = relay1.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay2Addr = relay2.multiaddrs.find(a => a.includes('/tcp/'))!;
    const relay3Addr = relay3.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relay1Addr, relay2Addr, relay3Addr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();

    const deadline = Date.now() + 10_000;
    let circuitAddrs: string[] = [];
    while (Date.now() < deadline) {
      circuitAddrs = edge.libp2p
        .getMultiaddrs()
        .map(ma => ma.toString())
        .filter(a => a.includes('/p2p-circuit'));
      const distinct = new Set(
        circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
      );
      if (distinct.size >= 2) break;
      await new Promise(r => setTimeout(r, 250));
    }
    const initialReservedPids = new Set(
      circuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(
      initialReservedPids.size,
      `expected exactly 2 reservations from 2-of-3 config; got circuitAddrs=${JSON.stringify(circuitAddrs)}`,
    ).toBe(2);

    const logSpy = spyConsole('log');
    try {
      await (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick();

      const churnLog = logSpy.calls.find((call) =>
        typeof call[0] === 'string'
        && call[0].includes('Relay watchdog')
        && (
          call[0].includes('this relay missing')
          || call[0].includes('to force reserve')
          || call[0].includes('reservation-redial')
        ),
      );
      expect(
        churnLog,
        `expected NO watchdog churn for the unreserved peer; got: ${JSON.stringify(logSpy.calls.map(c => c[0]))}`,
      ).toBeUndefined();
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }

    const finalCircuitAddrs = edge.libp2p
      .getMultiaddrs()
      .map(ma => ma.toString())
      .filter(a => a.includes('/p2p-circuit'));
    const finalReservedPids = new Set(
      finalCircuitAddrs.map(a => a.match(/\/p2p\/([^/]+)\/p2p-circuit/)?.[1]).filter(Boolean),
    );
    expect(finalReservedPids.size).toBe(2);
    for (const pid of initialReservedPids) {
      expect(finalReservedPids.has(pid as string)).toBe(true);
    }
  }, 25000);

  it('publicly-reachable node keeps relay-target connections despite 0 reservations (PR #1508)', async () => {
    // 2026-07-07 Gnosis mainnet incident: a public Core Node advertises a
    // direct public self-address, so libp2p never forms a `/p2p-circuit`
    // self-addr for it and `haveAnyReservation` stays false forever. The
    // pre-#1508 watchdog read that as "reservation lost everywhere" and
    // `close()` + redialed every relay-target connection on each tick past
    // the grace window — permanent churn against the very sibling cores
    // that StorageACK streams run over (aborting in-flight ACK replies the
    // publisher then mislabeled INVALID_SIGNATURE).
    //
    // Gate under test: `reservationGateSatisfied` is also satisfied by
    // `nodeIsPubliclyReachable` (`nodeHasDirectPublicAddress` over the
    // node's self-addrs). Deleting that gate from `watchdogTick` must make
    // THIS test fail — the classifier-only tests in
    // relay-public-reachability.test.ts stay green without it.
    //
    // Harness wrinkle: test nodes listen on loopback, which the classifier
    // rightly treats as non-public. We reproduce the mainnet self-addr
    // shape via `announceAddresses`: when announce addrs are configured,
    // libp2p's AddressManager returns ONLY those from `getMultiaddrs()`,
    // handing the watchdog exactly what the incident node saw — one direct
    // public self-addr, ZERO /p2p-circuit self-addrs, transport to the
    // relay target up. The announced addr is RFC 5737 TEST-NET-3
    // (public-classified, guaranteed unroutable) and is never dialed.
    const relay = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      enableRelayServer: true,
    });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
      announceAddresses: ['/ip4/203.0.113.7/tcp/9090'],
    });
    nodes.push(edge);
    await edge.start();

    // start() awaits the relay-target dial, but poll briefly anyway so a
    // slow accept can't flake the precondition.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (edge.libp2p.getConnections().some(c => c.remotePeer.toString() === relay.peerId)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Preconditions: the exact watchdog-observable mainnet state.
    const selfAddrs = edge.libp2p.getMultiaddrs().map(ma => ma.toString());
    expect(
      selfAddrs.filter(a => a.includes('/p2p-circuit')),
      `expected ZERO /p2p-circuit self-addrs (announce-only address set); got: ${JSON.stringify(selfAddrs)}`,
    ).toHaveLength(0);
    expect(nodeHasDirectPublicAddress(selfAddrs)).toBe(true);

    const before = edge.libp2p.getConnections().filter(c => c.remotePeer.toString() === relay.peerId);
    expect(before.length).toBeGreaterThan(0);
    const beforeIds = before.map(c => c.id).sort();

    const logSpy = spyConsole('log');
    try {
      // The first manual tick is already "past the grace window":
      // `relayReservationRedialAt` is empty, so nothing suppresses the
      // forcing branch except the public-reachability gate under test.
      // Two ticks so a first-tick pass can't mask a second-tick drop.
      const tick = (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick.bind(edge);
      await tick();
      await tick();

      const churnLogs = logSpy.calls.filter((call) =>
        typeof call[0] === 'string'
        && call[0].includes('Relay watchdog')
        && (call[0].includes('dropping + redialing') || call[0].includes('to force reserve')),
      );
      expect(
        churnLogs,
        `public node must NOT force-drop relay-target connections; got: ${JSON.stringify(churnLogs.map(c => c[0]))}`,
      ).toHaveLength(0);
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }

    // The very same connections survived — close() was never called on them.
    const after = edge.libp2p.getConnections().filter(c => c.remotePeer.toString() === relay.peerId);
    expect(after.map(c => c.id).sort()).toEqual(beforeIds);
    expect(after.every(c => c.status === 'open')).toBe(true);
  }, 20000);

  it("NAT'd node (private self-addrs only) still forces reservation recovery (PR #1508 sanity)", async () => {
    // Counterpart to the public-node test above: the #1508 gate must not
    // disable reservation recovery for nodes that genuinely depend on it.
    // Every pre-existing watchdog test asserts the forcing branch's
    // ABSENCE; this one pins that it still FIRES on the NAT'd path.
    //
    // Deterministic "transport up, reservation impossible" state: the
    // relay target is NOT a relay server, so it never advertises the
    // circuit-hop protocol and the edge holds a live connection but can
    // never obtain a reservation. Loopback-only listen addrs make
    // `nodeHasDirectPublicAddress` false, so the watchdog must take the
    // drop + redial path on the first tick (empty grace map = past the
    // grace window).
    const target = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(target);
    await target.start();
    const targetAddr = target.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [targetAddr],
    });
    nodes.push(edge);
    await edge.start();

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (edge.libp2p.getConnections().some(c => c.remotePeer.toString() === target.peerId)) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // Preconditions: transport up, no public self-addr, no reservation.
    const selfAddrs = edge.libp2p.getMultiaddrs().map(ma => ma.toString());
    expect(nodeHasDirectPublicAddress(selfAddrs)).toBe(false);
    expect(selfAddrs.filter(a => a.includes('/p2p-circuit'))).toHaveLength(0);
    expect(
      edge.libp2p.getConnections().some(c => c.remotePeer.toString() === target.peerId),
    ).toBe(true);

    const logSpy = spyConsole('log');
    try {
      await (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick();

      const forcingLog = logSpy.calls.find((call) =>
        typeof call[0] === 'string'
        && call[0].includes('Relay watchdog')
        && call[0].includes('to force reserve'),
      );
      expect(
        forcingLog,
        `NAT'd node with 0 reservations must still force-redial; got: ${JSON.stringify(logSpy.calls.map(c => c[0]))}`,
      ).toBeDefined();
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }
  }, 20000);
});

describe('Relay watchdog: stream-aware deferral + forced-redial thrash cap (2026-07-12 testnet outage)', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    console.warn = ORIG_CONSOLE_WARN;
    console.log = ORIG_CONSOLE_LOG;
    for (const n of nodes) {
      try {
        await n.stop();
      } catch (err) {
        console.warn('Teardown: node.stop() failed', err);
      }
    }
    nodes.length = 0;
  });

  it('connectionsBusyAppProtocols counts /dkg/ request streams and ignores infra streams', () => {
    const conn = (streams: Array<{ protocol?: string | null }>) => ({ streams });
    // /dkg/ streams count, deduped across connections.
    expect(connectionsBusyAppProtocols([
      conn([{ protocol: '/dkg/10.0.1/storage-ack' }, { protocol: '/dkg/10.0.2/sync' }]),
      conn([{ protocol: '/dkg/10.0.1/storage-ack' }]),
    ]).sort()).toEqual(['/dkg/10.0.1/storage-ack', '/dkg/10.0.2/sync']);
    // Long-lived infra streams never count (they exist on ~every
    // connection; counting them would defer reservation recovery forever).
    expect(connectionsBusyAppProtocols([
      conn([
        { protocol: '/meshsub/1.1.0' },
        { protocol: '/ipfs/id/1.0.0' },
        { protocol: '/ipfs/ping/1.0.0' },
        { protocol: '/libp2p/circuit/relay/0.2.0/hop' },
        { protocol: '/libp2p/circuit/relay/0.2.0/stop' },
        { protocol: '/libp2p/dcutr' },
        { protocol: null },
        {},
      ]),
    ])).toEqual([]);
    // /dkg/-prefixed protocols that are NOT request/response exchanges
    // (adversarial review round 1): the pooled message wire stream is
    // deliberately immortal, and DKG's own kad-dht (network-scoped or not)
    // is ambient infrastructure — neither may defer the forced redial.
    expect(connectionsBusyAppProtocols([
      conn([
        { protocol: '/dkg/10.0.2/message' },
        { protocol: '/dkg/kad/1.0.0' },
        { protocol: '/dkg/testnet.base:84532/kad/1.0.0' },
      ]),
    ])).toEqual([]);
    // No connections / no streams.
    expect(connectionsBusyAppProtocols([])).toEqual([]);
    expect(connectionsBusyAppProtocols([conn([])])).toEqual([]);
  });

  it('defers the forced reservation-redial while a /dkg/ stream is in flight, and resumes after it drains', async () => {
    // "Relay" that runs NO relay server: the edge can connect but a
    // reservation can never form, so every tick enters the
    // forced-redial branch — the 2026-07-12 outage shape (relay slots
    // exhausted ⇒ reservation never appears).
    const relay = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;
    const BUSY_PROTOCOL = '/dkg/test-busy/1.0.0';
    // Handler holds the inbound stream open — an in-flight exchange.
    const held: Array<{ close: () => Promise<void> }> = [];
    await relay.libp2p.handle(BUSY_PROTOCOL, ({ stream }) => { held.push(stream as never); });

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    const relayPid = relay.libp2p.peerId.toString();
    const tick = (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick.bind(edge);
    const redialAt = (edge as unknown as { relayReservationRedialAt: Map<string, number> }).relayReservationRedialAt;

    // Baseline (no busy stream): the forced redial DOES run.
    const logSpy = spyConsole('log');
    try {
      await tick();
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('to force reserve')),
        'baseline tick without app streams should force-redial',
      ).toBe(true);

      // Open an in-flight /dkg/ stream, expire the grace window, tick:
      // the watchdog must DEFER (no close, no redial) and say why.
      const stream = await edge.libp2p.dialProtocol(relay.libp2p.getMultiaddrs(), BUSY_PROTOCOL);
      const busyConnId = edge.libp2p.getConnections(relay.libp2p.peerId)
        .find(c => connectionsBusyAppProtocols([c]).includes(BUSY_PROTOCOL))?.id;
      expect(busyConnId, 'test setup: the busy stream must be visible on a connection').toBeTruthy();
      redialAt.set(relayPid, Date.now() - 16_000);
      logSpy.calls.length = 0;
      await tick();
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('deferring forced redial')
          && c[0].includes(BUSY_PROTOCOL)),
        `expected deferral log; got: ${JSON.stringify(logSpy.calls.map(c => c[0]))}`,
      ).toBe(true);
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('to force reserve')),
        'must not force-redial while a /dkg/ stream is in flight',
      ).toBe(false);
      // Prove the SAME connection object survived (not closed+redialed)
      // and the in-flight stream is still on it (otReviewAgent on
      // PR #1613: a regression could log the deferral, still tear down,
      // and a redial would keep the connection COUNT positive).
      const connsAfter = edge.libp2p.getConnections(relay.libp2p.peerId);
      expect(connsAfter.length).toBeGreaterThan(0);
      expect(connsAfter.map(c => c.id)).toContain(busyConnId);
      expect(
        connectionsBusyAppProtocols(connsAfter),
        'the in-flight stream must still be open on the surviving connection',
      ).toContain(BUSY_PROTOCOL);

      // Drain the stream — BOTH halves: closing only the dialer side
      // leaves the half-open stream (protocol still set) in
      // conn.streams until the responder closes too.
      await stream.abort(new Error('test-drain'));
      for (const h of held) { try { await h.close(); } catch { /* drained */ } }
      const drainDeadline = Date.now() + 5_000;
      while (Date.now() < drainDeadline
        && connectionsBusyAppProtocols(edge.libp2p.getConnections(relay.libp2p.peerId)).length > 0) {
        await new Promise(r => setTimeout(r, 100));
      }
      redialAt.set(relayPid, Date.now() - 16_000);
      logSpy.calls.length = 0;
      await tick();
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('to force reserve')),
        'forced redial should resume once the app stream has drained',
      ).toBe(true);
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }
  }, 40000);

  it('puts a never-reserving relay on cooldown after repeated futile forced redials (while a reservation exists elsewhere)', async () => {
    // Cooldown semantics (review round 1): the thrash cap only suppresses
    // the forced path while the node holds >=1 reservation SOMEWHERE —
    // with zero reservations, urgency wins and the watchdog keeps trying.
    // So the fixture needs BOTH: a real relay server (provides the
    // reservation) and a never-reserving plain peer (accumulates strikes).
    const realRelay = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false, enableRelayServer: true });
    const deadRelay = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(realRelay, deadRelay);
    await realRelay.start();
    await deadRelay.start();
    const realAddr = realRelay.multiaddrs.find(a => a.includes('/tcp/'))!;
    const deadAddr = deadRelay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [realAddr, deadAddr],
      relayReservationCount: 2,
    });
    nodes.push(edge);
    await edge.start();
    // Wait for the real relay's reservation so haveAnyReservation=true.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline
      && !edge.libp2p.getMultiaddrs().some(ma => ma.toString().includes('/p2p-circuit'))) {
      await new Promise(r => setTimeout(r, 250));
    }
    const deadPid = deadRelay.libp2p.peerId.toString();
    const tick = (edge as unknown as { watchdogTick: () => Promise<void> }).watchdogTick.bind(edge);
    const redialAt = (edge as unknown as { relayReservationRedialAt: Map<string, number> }).relayReservationRedialAt;

    const logSpy = spyConsole('log');
    try {
      // Five forced redials of the dead relay (grace window expired
      // manually each round — in production these are >=15s apart). None
      // can yield a reservation (no relay server), so the 5th trips the
      // cooldown. The real relay's gate stays satisfied throughout.
      for (let i = 0; i < 5; i++) {
        if (i > 0) redialAt.set(deadPid, Date.now() - 16_000);
        await tick();
      }
      const forced = logSpy.calls.filter(c => typeof c[0] === 'string' && c[0].includes('to force reserve'));
      expect(forced.length, `exactly 5 forced redials before the cap trips; got: ${JSON.stringify(forced.map(c => c[0]))}`).toBe(5);
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('cooling down forced redials')),
        `expected cooldown log after 5 strikes; got: ${JSON.stringify(logSpy.calls.map(c => c[0]).slice(-6))}`,
      ).toBe(true);

      // On cooldown (and holding a reservation on the real relay): even
      // with the grace window expired, no further teardown of the dead
      // relay — its connection is left alone.
      redialAt.set(deadPid, Date.now() - 16_000);
      logSpy.calls.length = 0;
      await tick();
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('to force reserve')),
        'no forced redial while the relay is on cooldown',
      ).toBe(false);
      expect(edge.libp2p.getConnections(deadRelay.libp2p.peerId).length).toBeGreaterThan(0);
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }
  }, 60000);
});

describe('Relay watchdog: review-round-1 hardening', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    console.warn = ORIG_CONSOLE_WARN;
    console.log = ORIG_CONSOLE_LOG;
    for (const n of nodes) {
      try {
        await n.stop();
      } catch (err) {
        console.warn('Teardown: node.stop() failed', err);
      }
    }
    nodes.length = 0;
  });

  it('clears strikes, cooldown, and busy-deferral state the moment a reservation appears (happy path)', async () => {
    // Real relay SERVER so a reservation actually forms.
    const relay = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false, enableRelayServer: true });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;
    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    // Wait for the circuit reservation.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline
      && !edge.libp2p.getMultiaddrs().some(ma => ma.toString().includes('/p2p-circuit'))) {
      await new Promise(r => setTimeout(r, 250));
    }
    const relayPid = relay.libp2p.peerId.toString();
    const internals = edge as unknown as {
      watchdogTick: () => Promise<void>;
      relayForcedRedialState: Map<string, { strikes: number; cooldownUntil: number; busyDeferralTicks: number }>;
    };
    // Poison the whole state entry as if a strike sequence had just run.
    internals.relayForcedRedialState.set(relayPid, {
      strikes: 4,
      cooldownUntil: Date.now() + 600_000,
      busyDeferralTicks: 7,
    });

    await internals.watchdogTick.call(edge);

    expect(
      internals.relayForcedRedialState.has(relayPid),
      'forced-redial state dropped entirely on happy path',
    ).toBe(false);
  }, 30000);

  it('bypasses an active cooldown when NO reservation exists anywhere (urgency wins)', async () => {
    // Liveness-critical counterpart of the cooldown test (otReviewAgent
    // round 2): with zero reservations the node is inbound-unreachable,
    // so an active cooldown must NOT suppress the forced redial — if
    // every relay were cooled simultaneously nothing would ever retry.
    const deadRelay = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(deadRelay);
    await deadRelay.start();
    const deadAddr = deadRelay.multiaddrs.find(a => a.includes('/tcp/'))!;

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [deadAddr],
    });
    nodes.push(edge);
    await edge.start();
    const deadPid = deadRelay.libp2p.peerId.toString();
    const internals = edge as unknown as {
      watchdogTick: () => Promise<void>;
      relayForcedRedialState: Map<string, { strikes: number; cooldownUntil: number; busyDeferralTicks: number }>;
    };
    // Active cooldown, zero reservations (dead relay runs no relay server,
    // so no /p2p-circuit self-addr can exist).
    internals.relayForcedRedialState.set(deadPid, {
      strikes: 0,
      cooldownUntil: Date.now() + 600_000,
      busyDeferralTicks: 0,
    });
    expect(
      edge.libp2p.getMultiaddrs().some(ma => ma.toString().includes('/p2p-circuit')),
      'test setup: edge must hold no reservation',
    ).toBe(false);

    const logSpy = spyConsole('log');
    try {
      await internals.watchdogTick.call(edge);
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('to force reserve')),
        `cooldown must be bypassed with zero reservations; got: ${JSON.stringify(logSpy.calls.map(c => c[0]))}`,
      ).toBe(true);
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }
  }, 30000);

  it('busy-deferral cap: forced redial proceeds once RELAY_BUSY_DEFERRAL_MAX_TICKS is exceeded', async () => {
    const relay = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(relay);
    await relay.start();
    const relayAddr = relay.multiaddrs.find(a => a.includes('/tcp/'))!;
    const BUSY_PROTOCOL = '/dkg/test-busy-cap/1.0.0';
    await relay.libp2p.handle(BUSY_PROTOCOL, () => { /* hold the stream open */ });

    const edge = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
      relayPeers: [relayAddr],
    });
    nodes.push(edge);
    await edge.start();
    const relayPid = relay.libp2p.peerId.toString();
    const internals = edge as unknown as {
      watchdogTick: () => Promise<void>;
      relayReservationRedialAt: Map<string, number>;
      relayForcedRedialState: Map<string, { strikes: number; cooldownUntil: number; busyDeferralTicks: number }>;
    };
    await edge.libp2p.dialProtocol(relay.libp2p.getMultiaddrs(), BUSY_PROTOCOL);
    internals.relayReservationRedialAt.set(relayPid, Date.now() - 16_000);
    // One tick below the cap: still deferring.
    internals.relayForcedRedialState.set(relayPid, { strikes: 0, cooldownUntil: 0, busyDeferralTicks: 29 });
    const logSpy = spyConsole('log');
    try {
      await internals.watchdogTick.call(edge);
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('deferring forced redial')),
        'tick 30/30 still defers',
      ).toBe(true);
      // Over the cap: teardown proceeds despite the busy stream.
      internals.relayReservationRedialAt.set(relayPid, Date.now() - 16_000);
      internals.relayForcedRedialState.set(relayPid, { strikes: 0, cooldownUntil: 0, busyDeferralTicks: 30 });
      logSpy.calls.length = 0;
      await internals.watchdogTick.call(edge);
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('busy-deferral cap reached')),
        `expected cap-reached log; got: ${JSON.stringify(logSpy.calls.map(c => c[0]))}`,
      ).toBe(true);
      expect(
        logSpy.calls.some(c => typeof c[0] === 'string' && c[0].includes('to force reserve')),
        'forced redial proceeds past the cap',
      ).toBe(true);
    } finally {
      console.log = ORIG_CONSOLE_LOG;
    }
  }, 40000);
});
