import { describe, it, expect, afterEach } from 'vitest';
import { DKGNode } from '../src/node.js';
import { ProtocolRouter, DEFAULT_MAX_READ_BYTES } from '../src/protocol-router.js';
import { GossipSubManager } from '../src/gossipsub-manager.js';
import { TypedEventBus } from '../src/event-bus.js';
import { PeerDiscoveryManager } from '../src/discovery.js';
import { multiaddr } from '@multiformats/multiaddr';

async function connectNodes(a: DKGNode, b: DKGNode): Promise<void> {
  const bAddr = b.multiaddrs[0];
  await a.libp2p.dial(multiaddr(bAddr));
  // Wait for identify to complete
  await new Promise((r) => setTimeout(r, 500));
}

describe('DKGNode', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      await n.stop();
    }
    nodes.length = 0;
  });

  it('starts and stops cleanly', async () => {
    const node = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node);
    await node.start();
    expect(node.isStarted).toBe(true);
    expect(node.peerId).toBeTruthy();
    expect(node.multiaddrs.length).toBeGreaterThan(0);
    await node.stop();
    expect(node.isStarted).toBe(false);
  });

  it('two nodes connect via explicit dial', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();

    await connectNodes(node1, node2);

    const peers = node1.libp2p.getPeers().map((p) => p.toString());
    expect(peers).toContain(node2.peerId);
  }, 10000);

  it('getConnections returns ConnectionInfo with direct transport for local peers', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();
    await connectNodes(node1, node2);

    const bus = new TypedEventBus();
    const discovery = new PeerDiscoveryManager(node1, bus);
    const conns = await discovery.getConnections();

    expect(conns.length).toBeGreaterThan(0);
    const toNode2 = conns.find(c => c.peerId === node2.peerId);
    expect(toNode2).toBeDefined();
    expect(toNode2!.transport).toBe('direct');
    expect(toNode2!.remoteAddr).toMatch(/\/ip4\/127\.0\.0\.1/);
    expect(toNode2!.direction).toMatch(/^(inbound|outbound)$/);
    expect(toNode2!.openedAt).toBeGreaterThan(0);
  }, 10000);
});

describe('ProtocolRouter', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      await n.stop();
    }
    nodes.length = 0;
  });

  it('request-response round trip', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();

    const router1 = new ProtocolRouter(node1);
    const router2 = new ProtocolRouter(node2);

    const enc = new TextEncoder();
    const dec = new TextDecoder();

    router2.register('/test/echo/1.0.0', async (data) => {
      return enc.encode(`echo:${dec.decode(data)}`);
    });

    await connectNodes(node1, node2);

    const response = await router1.send(
      node2.peerId,
      '/test/echo/1.0.0',
      enc.encode('hello'),
    );
    expect(dec.decode(response)).toBe('echo:hello');
  }, 15000);

  it('handles binary protobuf-like data', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();

    const router2 = new ProtocolRouter(node2);
    const router1 = new ProtocolRouter(node1);

    router2.register('/test/binary/1.0.0', async (data) => {
      const reversed = new Uint8Array(data).reverse();
      return reversed;
    });

    await connectNodes(node1, node2);

    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const response = await router1.send(
      node2.peerId,
      '/test/binary/1.0.0',
      input,
    );
    expect(Array.from(response)).toEqual([5, 4, 3, 2, 1]);
  }, 15000);

  it('rejects oversized response from handler', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();

    const tinyLimit = 64;
    const router1 = new ProtocolRouter(node1, { maxReadBytes: tinyLimit });
    const router2 = new ProtocolRouter(node2);

    router2.register('/test/big-response/1.0.0', async () => {
      return new Uint8Array(tinyLimit + 100);
    });

    await connectNodes(node1, node2);

    await expect(
      router1.send(node2.peerId, '/test/big-response/1.0.0', new Uint8Array(1)),
    ).rejects.toThrow('Read limit exceeded');
  }, 15000);

  it('rejects oversized request from sender', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();

    const tinyLimit = 64;
    const router1 = new ProtocolRouter(node1);
    const router2 = new ProtocolRouter(node2, { maxReadBytes: tinyLimit });

    let handlerCalled = false;
    router2.register('/test/big-request/1.0.0', async (data) => {
      handlerCalled = true;
      return new Uint8Array(1);
    });

    await connectNodes(node1, node2);

    await expect(
      router1.send(node2.peerId, '/test/big-request/1.0.0', new Uint8Array(tinyLimit + 100)),
    ).rejects.toThrow();
    expect(handlerCalled).toBe(false);
  }, 15000);

  it('DEFAULT_MAX_READ_BYTES is 10 MB', () => {
    expect(DEFAULT_MAX_READ_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe('GossipSubManager', () => {
  const nodes: DKGNode[] = [];

  afterEach(async () => {
    for (const n of nodes) {
      await n.stop();
    }
    nodes.length = 0;
  });

  it('publishes and receives messages', async () => {
    const node1 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    const node2 = new DKGNode({
      listenAddresses: ['/ip4/127.0.0.1/tcp/0'],
      enableMdns: false,
    });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();

    const bus1 = new TypedEventBus();
    const bus2 = new TypedEventBus();
    const gossip1 = new GossipSubManager(node1, bus1);
    const gossip2 = new GossipSubManager(node2, bus2);

    const topic = 'dkg/paranet/test/publish';
    gossip1.subscribe(topic);
    gossip2.subscribe(topic);

    await connectNodes(node1, node2);

    // Wait for GossipSub mesh to form after connection
    await new Promise((r) => setTimeout(r, 2000));

    const received: Uint8Array[] = [];
    gossip2.onMessage(topic, (_t, data) => {
      received.push(data);
    });

    await gossip1.publish(topic, new TextEncoder().encode('test-msg'));

    // Wait for propagation
    await new Promise((r) => setTimeout(r, 2000));

    expect(received.length).toBe(1);
    expect(new TextDecoder().decode(received[0])).toBe('test-msg');
  }, 20000);
});
