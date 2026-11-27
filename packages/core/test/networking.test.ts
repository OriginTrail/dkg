import { describe, it, expect, afterEach, vi } from 'vitest';
import { DKGNode } from '../src/node.js';
import { ProtocolRouter, DEFAULT_MAX_READ_BYTES } from '../src/protocol-router.js';
import { GossipSubManager } from '../src/gossipsub-manager.js';
import { DKGEvent, TypedEventBus } from '../src/event-bus.js';
import { PeerDiscoveryManager } from '../src/discovery.js';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { readdirSync, readFileSync } from 'node:fs';
import {
  DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER,
  DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER_MAINNET,
  gossipMaxTopicBytesPerPeer,
  contextGraphAppTopic,
  contextGraphFinalizationTopic,
  contextGraphSharedMemoryTopic,
  contextGraphUpdateTopic,
  wireTopicForNetwork,
} from '../src/constants.js';

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

  it('advertises a protocol registered after peers have already identified', async () => {
    const node1 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    const node2 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();
    // Install the listener before dialing. Otherwise a slow initial Identify
    // exchange could include lateProtocol and make this test pass without Push.
    const initialIdentify = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        node1.libp2p.removeEventListener('peer:identify', onIdentify);
        reject(new Error('Initial peer identification timed out'));
      }, 6_000);
      const onIdentify = (event: CustomEvent<{ peerId: { toString(): string } }>) => {
        if (event.detail.peerId.toString() !== node2.peerId) return;
        clearTimeout(timeout);
        node1.libp2p.removeEventListener('peer:identify', onIdentify);
        resolve();
      };
      node1.libp2p.addEventListener('peer:identify', onIdentify);
    });
    await node1.libp2p.dial(multiaddr(node2.multiaddrs[0]));
    await initialIdentify;

    const remotePeer = peerIdFromString(node2.peerId);
    const lateProtocol = '/test/late-sync-advertisement/1.0.0';
    const initialProtocols = (await node1.libp2p.peerStore.get(remotePeer)).protocols;
    expect(initialProtocols.length).toBeGreaterThan(0);
    expect(initialProtocols).not.toContain(lateProtocol);
    new ProtocolRouter(node2).register(lateProtocol, async () => new Uint8Array());
    await vi.waitFor(async () => {
      expect((await node1.libp2p.peerStore.get(remotePeer)).protocols).toContain(lateProtocol);
    }, { timeout: 6_000, interval: 100 });
  }, 10_000);

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

  it('says who a published message was sent to', async () => {
    const node1 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'] });
    const node2 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'] });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();
    const gossip1 = new GossipSubManager(node1, new TypedEventBus());
    const gossip2 = new GossipSubManager(node2, new TypedEventBus());
    const topic = 'dkg/context-graph/recipients/publish';
    const data = new TextEncoder().encode('profile');
    gossip1.subscribe(topic);
    await expect(gossip1.publish(topic, data), 'nobody to send it to').resolves.toEqual([]);

    gossip2.subscribe(topic);
    await connectNodes(node1, node2);
    await vi.waitFor(async () => {
      await expect(gossip1.publish(topic, data)).resolves.toEqual([node2.peerId.toString()]);
    }, { timeout: 10_000, interval: 250 });
  }, 20_000);

  it('leaves the topics it meshes on out of the mesh peer\'s peer-store record', async () => {
    const node1 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'] });
    const node2 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'] });
    nodes.push(node1, node2);
    await node1.start();
    await node2.start();
    const gossip1 = new GossipSubManager(node1, new TypedEventBus());
    const gossip2 = new GossipSubManager(node2, new TypedEventBus());
    const topics = Array.from({ length: 6 }, (_, i) => `dkg/context-graph/mesh-tags-${i}/finalization`);
    for (const topic of topics) {
      gossip1.subscribe(topic);
      gossip2.subscribe(topic);
    }
    await connectNodes(node1, node2);
    const data = new TextEncoder().encode('profile');
    await vi.waitFor(async () => {
      for (const topic of topics) {
        expect(node1.libp2p.services.pubsub.getMeshPeers(topic)).toContain(node2.peerId);
        // A message that reaches the peer also carries any GRAFT still waiting to go out.
        await expect(gossip1.publish(topic, data)).resolves.toEqual([node2.peerId]);
      }
    }, { timeout: 10_000, interval: 250 });

    // The read waits for writes to the record that are still pending.
    const record = await node1.libp2p.peerStore.get(peerIdFromString(node2.peerId));
    expect(record.protocols.length, 'the record of a connected peer').toBeGreaterThan(0);
    expect([...record.tags.keys()].filter((tag) => topics.includes(tag))).toEqual([]);
  }, 20_000);

  it('does not say who got a message when the pubsub implementation does not', async () => {
    const pubsub = {
      addEventListener: () => {},
      publish: async () => undefined,
    };
    const node = { libp2p: { services: { pubsub } } } as unknown as DKGNode;
    await expect(new GossipSubManager(node, new TypedEventBus()).publish('topic', new Uint8Array()))
      .resolves.toBeUndefined();
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

  it('invokes in registration order without awaiting async completion', async () => {
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
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCompletion = new Promise<void>((resolve) => { releaseFirst = resolve; });

    manager.onMessage(topic, async () => {
      order.push('first-started');
      await firstCompletion;
      order.push('first-finished');
    });
    manager.onMessage(topic, () => {
      order.push('second');
    });

    listener({
      detail: { topic, data: new Uint8Array(), from: 'peer-a' },
    });
    expect(order).toEqual(['first-started', 'second']);

    releaseFirst();
    await firstCompletion;
    await Promise.resolve();
    expect(order).toEqual(['first-started', 'second', 'first-finished']);
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

  describe('per-peer topic budget', () => {
    // gossipsub charges each topic it records for a peer the topic's length plus
    // 1024 bytes (GossipsubTopicEntryOverhead), and decodes at most 5,000
    // subscriptions per RPC (decodeRpcLimits.maxSubscriptions). It exports neither.
    const topicEntryOverhead = 1024;
    const maxSubscriptionsPerRpc = 5_000;
    const networkDir = new URL('../../../network/', import.meta.url);
    const networks = readdirSync(networkDir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(new URL(file, networkDir), 'utf8')) as {
        networkId: string;
        chain: { chainId: string };
      });
    const namespaceLength = ({ networkId, chain }: (typeof networks)[number]) =>
      wireTopicForNetwork(networkId, 'dkg/', chain.chainId).length;
    const longestNetwork = networks.reduce((a, b) => (namespaceLength(b) > namespaceLength(a) ? b : a));
    const graphTopics = (contextGraphId: string) => [
      contextGraphFinalizationTopic(contextGraphId),
      contextGraphAppTopic(contextGraphId),
      contextGraphUpdateTopic(contextGraphId),
      contextGraphSharedMemoryTopic(contextGraphId),
    ];

    async function startPair() {
      const node1 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
      const node2 = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false });
      nodes.push(node1, node2);
      await node1.start();
      await node2.start();
      const options = { networkId: longestNetwork.networkId, chainId: longestNetwork.chain.chainId };
      const gossip1 = new GossipSubManager(node1, new TypedEventBus(), options);
      const gossip2 = new GossipSubManager(node2, new TypedEventBus(), options);
      return { node1, node2, gossip1, gossip2 };
    }

    // Subscribes node 1 to fresh probe topics until node 2 records one. Node 1's
    // gossip stream to node 2 is then open, and node 2 has handled every RPC that
    // node 1 sent before that probe.
    async function probeUntilRecorded(pair: Awaited<ReturnType<typeof startPair>>, label: string): Promise<void> {
      const probes: string[] = [];
      await vi.waitFor(() => {
        if (probes.some((probe) => pair.gossip2.getSubscribers(probe).includes(pair.node1.peerId))) return;
        const probe = contextGraphSharedMemoryTopic(`${label}-${probes.length}`.padEnd(256, 'p'));
        probes.push(probe);
        pair.gossip1.subscribe(probe);
        throw new Error('node 2 has not recorded a probe yet');
      }, { timeout: 10_000, interval: 250 });
    }

    it('holds 5,000 of the longest wire topics a bundled network uses', () => {
      const longest = Math.max(...networks.flatMap(({ networkId, chain }) =>
        graphTopics('c'.repeat(256)).map((topic) => wireTopicForNetwork(networkId, topic, chain.chainId).length)));
      expect(longest, 'the length the constant\'s comment gives').toBe(375);
      expect(maxSubscriptionsPerRpc * (longest + topicEntryOverhead)).toBeLessThanOrEqual(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER);
    });

    it('gives the mainnet network configs the smaller cap', () => {
      for (const name of ['mainnet-base', 'mainnet-gnosis', 'mainnet-neuroweb']) {
        expect(gossipMaxTopicBytesPerPeer(name), name).toBe(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER_MAINNET);
      }
      expect(gossipMaxTopicBytesPerPeer('testnet')).toBe(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER);
      expect(gossipMaxTopicBytesPerPeer(undefined)).toBe(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER);
      // Still twice what gossipsub's default holds: 1,499 of the longest wire topics, 374 context graphs.
      expect(Math.floor(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER_MAINNET / (375 + topicEntryOverhead))).toBe(1_499);
    });

    it('gives gossipsub the cap of the node\'s network config', async () => {
      const identity = { networkId: longestNetwork.networkId, chainId: longestNetwork.chain.chainId };
      const mainnet = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false,
        networkIdentity: { ...identity, networkConfigName: 'mainnet-base' } });
      const other = new DKGNode({ listenAddresses: ['/ip4/127.0.0.1/tcp/0'], enableMdns: false,
        networkIdentity: { ...identity, networkConfigName: 'testnet' } });
      nodes.push(mainnet, other);
      await mainnet.start();
      await other.start();
      const cap = (node: DKGNode) => (node.libp2p.services.pubsub as unknown as { maxTopicBytesPerPeer: number }).maxTopicBytesPerPeer;
      expect(cap(mainnet)).toBe(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER_MAINNET);
      expect(cap(other)).toBe(DKG_GOSSIP_MAX_TOPIC_BYTES_PER_PEER);
    });

    it('records every topic of a peer with more of them than gossipsub keeps by default', async () => {
      const { node1, node2, gossip1, gossip2 } = await startPair();
      // 300 context graphs with four topics each. The 1 MiB default records 881
      // of these 1,200 topics and drops the rest.
      const topics = Array.from({ length: 300 }, (_, i) => graphTopics(`0x${'ab'.repeat(20)}/graph-${i}`)).flat();
      for (const topic of topics) gossip1.subscribe(topic);
      await connectNodes(node1, node2);

      await vi.waitFor(() => {
        const missing = topics.filter((topic) => !gossip2.getSubscribers(topic).includes(node1.peerId));
        expect(missing.length, 'topics node 2 does not record node 1 on').toBe(0);
      }, { timeout: 10_000, interval: 250 });
      // Flood publishing sends to every peer recorded on the topic.
      const last = topics[topics.length - 1];
      await expect(gossip2.publish(last, new TextEncoder().encode('last'))).resolves.toEqual([node1.peerId]);
    }, 30_000);

    it('hears none of the topics a peer announces in one RPC of more than 5,000', async () => {
      const pair = await startPair();
      // Node 1 announces all of its topics in one RPC when its stream opens, and
      // node 2 drops an RPC with more subscriptions than it decodes. The 8 MiB cap
      // holds at least that many topics; later subscriptions can go past it.
      const topics = Array.from({ length: maxSubscriptionsPerRpc + 1 }, (_, i) => contextGraphUpdateTopic(`announced-${i}`));
      for (const topic of topics) pair.gossip1.subscribe(topic);
      await connectNodes(pair.node1, pair.node2);
      await probeUntilRecorded(pair, 'after-announcement');

      const recorded = topics.filter((topic) => pair.gossip2.getSubscribers(topic).includes(pair.node1.peerId));
      expect(recorded.length, 'announced topics node 2 records').toBe(0);
    }, 30_000);

    it('still bounds the topics it records for one peer', async () => {
      const pair = await startPair();
      const { node1, gossip1, gossip2 } = pair;
      await connectNodes(node1, pair.node2);
      // From here on, each subscribe reaches node 2 as an RPC of its own.
      await probeUntilRecorded(pair, 'stream-open');
      // Each wire topic is 375 characters long, so the budget records 5,996 of
      // them, the probes included.
      const topics = Array.from({ length: 6_100 }, (_, i) => contextGraphSharedMemoryTopic(String(i).padStart(256, 'c')));
      for (const topic of topics) gossip1.subscribe(topic);
      // Node 2 handles the RPCs in order. Dropping the first topic frees one
      // place, and the marker takes it once node 2 has handled every RPC before it.
      gossip1.unsubscribe(topics[0]);
      const marker = contextGraphSharedMemoryTopic('m'.repeat(256));
      gossip1.subscribe(marker);
      await vi.waitFor(() => {
        expect(gossip2.getSubscribers(marker)).toContain(node1.peerId);
      }, { timeout: 30_000, interval: 250 });

      const recorded = [...topics, marker].filter((topic) => gossip2.getSubscribers(topic).includes(node1.peerId)).length;
      expect(recorded).toBeGreaterThanOrEqual(maxSubscriptionsPerRpc);
      expect(recorded).toBeLessThan(topics.length);
    }, 60_000);
  });
});
