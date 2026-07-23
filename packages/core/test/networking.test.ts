import { describe, it, expect, afterEach, vi } from 'vitest';
import { DKGNode } from '../src/node.js';
import { ProtocolRouter, DEFAULT_MAX_READ_BYTES } from '../src/protocol-router.js';
import { GossipSubManager } from '../src/gossipsub-manager.js';
import { DKGEvent, TypedEventBus } from '../src/event-bus.js';
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

    // When the receiver's `maxReadBytes` is exceeded, the libp2p stream
    // must tear down with a size-limit error. A bare `rejects.toThrow()`
    // would also accept unrelated setup failures (e.g. "peer not
    // connected", "protocol not registered") which would HIDE a real
    // regression where the limit was silently removed and the handler
    // received the oversize payload. Pin the error vocabulary AND keep
    // the strong behavioural invariant below (`handlerCalled === false`).
    await expect(
      router1.send(node2.peerId, '/test/big-request/1.0.0', new Uint8Array(tinyLimit + 100)),
    ).rejects.toThrow(
      /too large|exceed|max.*byte|size.*limit|reset|aborted|closed|stream/i,
    );
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

  it('contains rejected async handlers at the gossip boundary', async () => {
    let listener!: (event: {
      detail: { topic: string; data: Uint8Array; from: string };
    }) => void;
    const pubsub = {
      addEventListener: (_event: string, handler: typeof listener) => { listener = handler; },
      subscribe: () => {},
      unsubscribe: () => {},
      publish: async () => {},
      getTopics: () => [],
    };
    const node = { libp2p: { services: { pubsub } } } as unknown as DKGNode;
    const manager = new GossipSubManager(node, new TypedEventBus());
    const topic = 'dkg/context-graph/test/finalization';
    let resolveLogged!: (args: unknown[]) => void;
    const logged = new Promise<unknown[]>((resolve) => { resolveLogged = resolve; });
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      resolveLogged(args);
    });
    try {
      manager.onMessage(topic, async () => {
        throw new Error('store remains busy');
      });
      listener({
        detail: { topic, data: new Uint8Array(), from: 'peer-a' },
      });

      await expect(logged).resolves.toEqual([
        `[GossipSub] handler error on topic "${topic}":`,
        'store remains busy',
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('ignores incidental truthy returns from synchronous handlers', async () => {
    let listener!: (event: {
      detail: { topic: string; data: Uint8Array; from: string };
    }) => void;
    const pubsub = {
      addEventListener: (_event: string, handler: typeof listener) => { listener = handler; },
      subscribe: () => {},
      unsubscribe: () => {},
      publish: async () => {},
      getTopics: () => [],
    };
    const node = { libp2p: { services: { pubsub } } } as unknown as DKGNode;
    const manager = new GossipSubManager(node, new TypedEventBus());
    const topic = 'dkg/context-graph/test/finalization';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      manager.onMessage(topic, () => 1);
      listener({
        detail: { topic, data: new Uint8Array(), from: 'peer-a' },
      });
      await Promise.resolve();

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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

    const topic = 'dkg/context-graph/test/finalization';
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

  it('uses network-scoped wire topics while exposing logical topics', async () => {
    const subscribed: string[] = [];
    const published: Array<{ topic: string; data: Uint8Array }> = [];
    const handlers: Array<(evt: { detail: { topic: string; data: Uint8Array; from: string } }) => void> = [];
    const topics = new Set<string>();
    const pubsub = {
      addEventListener: (_event: string, handler: (evt: { detail: { topic: string; data: Uint8Array; from: string } }) => void) => {
        handlers.push(handler);
      },
      subscribe: (topic: string) => {
        subscribed.push(topic);
        topics.add(topic);
      },
      unsubscribe: (topic: string) => {
        topics.delete(topic);
      },
      publish: async (topic: string, data: Uint8Array) => {
        published.push({ topic, data });
      },
      getTopics: () => [...topics],
      getSubscribers: (topic: string) => topic.endsWith('/context-graph/test/finalization')
        ? [{ toString: () => 'peer-a' }]
        : [],
    };
    const node = { libp2p: { services: { pubsub } } } as unknown as DKGNode;
    const bus = new TypedEventBus();
    const admissionChecks: Array<{ peerId: string; topic: string }> = [];
    const manager = new GossipSubManager(node, bus, {
      networkId: 'base-testnet',
      chainId: 'base:84532',
      isPeerAccepted: (peerId, topic) => {
        admissionChecks.push({ peerId, topic });
        return peerId === 'peer-a';
      },
    });
    const logicalTopic = 'dkg/context-graph/test/finalization';
    const wireTopic = 'dkg/network/base-testnet.base:84532/context-graph/test/finalization';

    const events: unknown[] = [];
    bus.on(DKGEvent.GOSSIP_MESSAGE, (evt) => events.push(evt));
    const received: Array<{ topic: string; from: string; data: string }> = [];
    manager.onMessage(logicalTopic, (topic, data, from) => {
      received.push({ topic, from, data: new TextDecoder().decode(data) });
    });

    manager.subscribe(logicalTopic);
    await manager.publish(logicalTopic, new TextEncoder().encode('hello'));
    handlers[0]({
      detail: {
        topic: wireTopic,
        from: 'peer-a',
        data: new TextEncoder().encode('from-wire'),
      },
    });
    handlers[0]({
      detail: {
        topic: wireTopic,
        from: 'peer-b',
        data: new TextEncoder().encode('rejected-wire'),
      },
    });
    handlers[0]({
      detail: {
        topic: 'dkg/network/base-mainnet/context-graph/test/finalization',
        from: 'peer-b',
        data: new TextEncoder().encode('foreign-wire'),
      },
    });

    expect(subscribed).toEqual([wireTopic]);
    expect(published.map((entry) => entry.topic)).toEqual([wireTopic]);
    expect(manager.subscribedTopics).toEqual([logicalTopic]);
    expect(manager.getSubscribers(logicalTopic)).toEqual(['peer-a']);
    expect(events).toEqual([{ topic: logicalTopic, from: 'peer-a', data: new TextEncoder().encode('from-wire') }]);
    expect(received).toEqual([{ topic: logicalTopic, from: 'peer-a', data: 'from-wire' }]);
    expect(admissionChecks).toEqual([
      { peerId: 'peer-a', topic: logicalTopic },
      { peerId: 'peer-b', topic: logicalTopic },
    ]);
  });
});
