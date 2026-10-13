import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PROTOCOL_SWM_UPDATE, type OperationContext } from '@origintrail-official/dkg-core';
import { SwmSubstrateMethods } from '../src/dkg-agent-swm-substrate.js';
import {
  createCGMemberEnumerator,
  type CGMemberEnumeratorDeps,
} from '../src/swm/enumerate-cg-members.js';
import {
  SHARE_DELIVERY_MIN_RELAYED_BYTES,
  SHARE_DELIVERY_MIN_RELAYED_SECONDS,
  connectionCarriesShareDelivery,
} from '../src/swm/relayed-connection-allowance.js';
import {
  SHARED_MEMORY_FOLLOWER_TTL_MS,
  SharedMemoryFollowers,
  sharedMemoryFollowersOf,
} from '../src/swm/shared-memory-followers.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import type { SyncRequestEnvelope } from '../src/sync/auth/request-build.js';

// Two edge nodes that reach each other only through a relay have a connection
// with an allowance, and GossipSub does not run over it. A share into a public
// context graph went to the graph's GossipSub subscribers over a direct
// connection, so it never went to such a peer. These tests cover the pieces
// that deliver it: who follows the graph, which connection may carry the
// share, and the recipient list that results.

const SELF = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
const PEER_A = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
const PEER_B = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';
const GRAPH = 'test-cg/shares-through-relay';

/** What a Core node grants for one circuit today. */
const CORE_CIRCUIT = { bytes: 256n * 1024n * 1024n, seconds: 30 * 60 };
/** What a relay with libp2p's defaults grants. */
const SMALL_CIRCUIT = { bytes: 128n * 1024n, seconds: 2 * 60 };

describe('connectionCarriesShareDelivery', () => {
  it('accepts a direct connection, which has no allowance', () => {
    expect(connectionCarriesShareDelivery(undefined)).toBe(true);
    expect(connectionCarriesShareDelivery(null)).toBe(true);
  });

  it('accepts a relayed connection with what a Core node grants', () => {
    expect(connectionCarriesShareDelivery(CORE_CIRCUIT)).toBe(true);
  });

  it('rejects a relayed connection with a small allowance', () => {
    expect(connectionCarriesShareDelivery(SMALL_CIRCUIT)).toBe(false);
  });

  it('rejects a small allowance by its bytes when the seconds read 1,000 times too large', () => {
    // What a client reads through a relay that sends its duration in milliseconds.
    expect(connectionCarriesShareDelivery({ bytes: 128n * 1024n, seconds: 120_000 })).toBe(false);
    expect(connectionCarriesShareDelivery({ bytes: 256n * 1024n * 1024n - 620n, seconds: 1_800_000 })).toBe(true);
  });

  it('judges the bytes and the seconds each on its own', () => {
    const enoughBytes = SHARE_DELIVERY_MIN_RELAYED_BYTES;
    const enoughSeconds = SHARE_DELIVERY_MIN_RELAYED_SECONDS;
    expect(connectionCarriesShareDelivery({ bytes: enoughBytes, seconds: enoughSeconds })).toBe(true);
    expect(connectionCarriesShareDelivery({ bytes: enoughBytes - 1n, seconds: enoughSeconds })).toBe(false);
    expect(connectionCarriesShareDelivery({ bytes: enoughBytes, seconds: enoughSeconds - 1 })).toBe(false);
  });

  it('reads a limit the relay did not set as no restriction', () => {
    expect(connectionCarriesShareDelivery({ seconds: 30 * 60 })).toBe(true);
    expect(connectionCarriesShareDelivery({ bytes: 256n * 1024n * 1024n })).toBe(true);
    expect(connectionCarriesShareDelivery({})).toBe(true);
  });

  it('accepts the bytes as a number as well as a bigint', () => {
    expect(connectionCarriesShareDelivery({ bytes: 64 * 1024 * 1024, seconds: 600 })).toBe(true);
    expect(connectionCarriesShareDelivery({ bytes: 1024, seconds: 600 })).toBe(false);
  });

  it('does not rely on an allowance it cannot read', () => {
    expect(connectionCarriesShareDelivery('limited')).toBe(false);
    expect(connectionCarriesShareDelivery({ bytes: 'many', seconds: 600 })).toBe(false);
    expect(connectionCarriesShareDelivery({ bytes: Number.NaN })).toBe(false);
    expect(connectionCarriesShareDelivery({ seconds: '600' })).toBe(false);
  });

  it('stops counting a relayed connection once its allowance has run down', () => {
    const circuit = { bytes: SHARE_DELIVERY_MIN_RELAYED_BYTES, seconds: 30 * 60 };
    expect(connectionCarriesShareDelivery(circuit)).toBe(true);
    circuit.bytes -= 1n;
    expect(connectionCarriesShareDelivery(circuit)).toBe(false);
  });
});

describe('SharedMemoryFollowers', () => {
  function withClock(options: { perGraphLimit?: number; graphLimit?: number } = {}) {
    const clock = { now: 1_000_000 };
    return { clock, followers: new SharedMemoryFollowers({ ...options, now: () => clock.now }) };
  }

  it('lists a peer after its request and reports it as new once', () => {
    const { followers } = withClock();
    expect(followers.followers(GRAPH)).toEqual([]);
    expect(followers.note(GRAPH, PEER_A)).toBe(true);
    expect(followers.note(GRAPH, PEER_A)).toBe(false);
    expect(followers.note(GRAPH, PEER_B)).toBe(true);
    expect(followers.followers(GRAPH).sort()).toEqual([PEER_A, PEER_B].sort());
    expect(followers.followers('another-graph')).toEqual([]);
  });

  it('drops a peer that has been silent for the whole TTL and keeps one that asked again', () => {
    const { clock, followers } = withClock();
    followers.note(GRAPH, PEER_A);
    followers.note(GRAPH, PEER_B);
    clock.now += SHARED_MEMORY_FOLLOWER_TTL_MS - 1;
    followers.note(GRAPH, PEER_B);
    clock.now += 2;
    expect(followers.followers(GRAPH)).toEqual([PEER_B]);
    // The silent peer is new again when it comes back.
    expect(followers.note(GRAPH, PEER_A)).toBe(true);
  });

  it('forgets a graph whose followers have all gone silent', () => {
    const { clock, followers } = withClock();
    followers.note(GRAPH, PEER_A);
    expect(followers.graphCount).toBe(1);
    clock.now += SHARED_MEMORY_FOLLOWER_TTL_MS + 1;
    expect(followers.followers(GRAPH)).toEqual([]);
    expect(followers.graphCount).toBe(0);
  });

  it('keeps at most the limit per graph and lets the longest silent peer go', () => {
    const { clock, followers } = withClock({ perGraphLimit: 2 });
    followers.note(GRAPH, 'first');
    clock.now += 1;
    followers.note(GRAPH, 'second');
    clock.now += 1;
    followers.note(GRAPH, 'first');
    clock.now += 1;
    followers.note(GRAPH, 'third');
    expect(followers.followers(GRAPH)).toEqual(['first', 'third']);
  });

  it('keeps at most the limit of graphs and lets the longest silent graph go', () => {
    const { clock, followers } = withClock({ graphLimit: 2 });
    followers.note('graph-1', PEER_A);
    clock.now += 1;
    followers.note('graph-2', PEER_A);
    clock.now += 1;
    followers.note('graph-1', PEER_B);
    clock.now += 1;
    followers.note('graph-3', PEER_A);
    expect(followers.graphCount).toBe(2);
    expect(followers.followers('graph-2')).toEqual([]);
    expect(followers.followers('graph-1').sort()).toEqual([PEER_A, PEER_B].sort());
  });

  it('gives each agent its own followers and the same ones every time', () => {
    const agentOne = {};
    const agentTwo = {};
    sharedMemoryFollowersOf(agentOne).note(GRAPH, PEER_A);
    expect(sharedMemoryFollowersOf(agentOne).followers(GRAPH)).toEqual([PEER_A]);
    expect(sharedMemoryFollowersOf(agentTwo).followers(GRAPH)).toEqual([]);
  });
});

describe('recipients of a share into a public graph', () => {
  function makeDeps(overrides: Partial<CGMemberEnumeratorDeps>): CGMemberEnumeratorDeps {
    return {
      getContextGraphAllowedPeers: async () => null,
      getContextGraphAllowedAgentPeers: async () => null,
      isPrivateContextGraph: async () => false,
      getTopicSubscribers: () => [],
      topicForCG: (cgId) => `dkg/context-graph/${cgId}/shared-memory`,
      getSelfPeerId: () => SELF,
      ...overrides,
    };
  }

  it('include a follower that GossipSub does not report', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => [PEER_A],
      getSharedMemoryFollowers: () => [PEER_B],
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect(result.source).toBe('topic-subscribers');
    expect([...result.members].sort()).toEqual([PEER_A, PEER_B].sort());
  });

  it('are the followers alone when no peer is subscribed over GossipSub', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getSharedMemoryFollowers: (cgId) => (cgId === GRAPH ? [PEER_B] : []),
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect(result.source).toBe('topic-subscribers');
    expect(result.members).toEqual([PEER_B]);
    expect((await enumerator.enumerate('graph-without-followers')).source).toBe('none');
  });

  it('list a peer once when it is both a subscriber and a follower, and never this node', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => [PEER_A, SELF],
      getSharedMemoryFollowers: () => [PEER_A, SELF, PEER_B],
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect([...result.members].sort()).toEqual([PEER_A, PEER_B].sort());
  });

  it('send directly only to the followers the node can reach', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getSharedMemoryFollowers: () => [PEER_A, PEER_B],
      isPeerDialable: (peerId) => peerId === PEER_B,
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect([...result.members].sort()).toEqual([PEER_A, PEER_B].sort());
    expect(result.source === 'topic-subscribers' ? result.substrateEligibleMembers : undefined).toEqual([PEER_B]);
  });

  it('are the roster alone for a private graph and the allowlist alone for an allowlisted one', async () => {
    let asked = 0;
    const getSharedMemoryFollowers = (): string[] => {
      asked += 1;
      return [PEER_B];
    };
    const allowlisted = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => [PEER_A],
      getSharedMemoryFollowers,
    }));
    expect((await allowlisted.enumerate(GRAPH)).members).toEqual([PEER_A]);
    const privateGraph = createCGMemberEnumerator(makeDeps({
      isPrivateContextGraph: async () => true,
      getSharedMemoryFollowers,
    }));
    expect((await privateGraph.enumerate(GRAPH)).members).toEqual([]);
    expect(asked).toBe(0);
  });
});

describe('the sync responder reports who follows a graph', () => {
  const noopLog = (_ctx: OperationContext, _message: string): void => {};

  async function responder(authorize: (request: SyncRequestEnvelope) => boolean) {
    const noted: Array<[string, string]> = [];
    let handler: ((data: Uint8Array, peerId: string) => Promise<Uint8Array>) | null = null;
    registerSyncHandler({
      register: (_protocol, registered) => { handler = registered; },
      protocolSync: '/origintrail/dkg/sync/1.0.0',
      syncDeniedResponse: 'sync-denied',
      syncPageSize: 5000,
      sharedMemoryTtlMs: 0,
      store: new OxigraphStore(),
      peerId: SELF,
      parseSyncRequest: (data) => JSON.parse(new TextDecoder().decode(data)) as SyncRequestEnvelope,
      authorizeSyncRequest: async (request) => authorize(request),
      onSharedMemoryRequestAuthorized: (contextGraphId, remotePeerId) => { noted.push([contextGraphId, remotePeerId]); },
      logWarn: noopLog,
      logDebug: noopLog,
    });
    const ask = async (request: SyncRequestEnvelope): Promise<string> => {
      if (handler === null) throw new Error('the sync handler was not registered');
      return new TextDecoder().decode(await handler(new TextEncoder().encode(JSON.stringify(request)), PEER_A));
    };
    return { noted, ask };
  }

  it('for an authorized shared-memory request', async () => {
    const { noted, ask } = await responder(() => true);
    await ask({ contextGraphId: GRAPH, offset: 0, limit: 100, includeSharedMemory: true, phase: 'meta' });
    expect(noted).toEqual([[GRAPH, PEER_A]]);
  });

  it('not for a request it denied', async () => {
    const { noted, ask } = await responder(() => false);
    expect(await ask({ contextGraphId: GRAPH, offset: 0, limit: 100, includeSharedMemory: true, phase: 'meta' }))
      .toBe('sync-denied');
    expect(noted).toEqual([]);
  });

  it('not for a request that does not ask for shared memory', async () => {
    const { noted, ask } = await responder(() => true);
    await ask({ contextGraphId: GRAPH, offset: 0, limit: 100, includeSharedMemory: false, phase: 'meta' });
    expect(noted).toEqual([]);
  });
});

describe('a peer the node may send a share to directly', () => {
  type StubConnection = { limits?: unknown };

  /** The parts of an agent that `isPeerDialable` reads. */
  function host(connections: StubConnection[], protocols: string[] = [PROTOCOL_SWM_UPDATE]) {
    return {
      node: {
        libp2p: {
          getConnections: () => connections,
          getPeers: () => [],
          peerStore: { get: async () => ({ protocols, addresses: [] }) },
        },
      },
    };
  }
  const dialable = (connections: StubConnection[], protocols?: string[]): Promise<boolean> => (
    SwmSubstrateMethods.prototype.isPeerDialable.call(host(connections, protocols) as never, PEER_A)
  );

  it('is one with a direct connection', async () => {
    expect(await dialable([{}])).toBe(true);
  });

  it('is one reached only through a relay that grants what a Core node grants', async () => {
    expect(await dialable([{ limits: CORE_CIRCUIT }])).toBe(true);
  });

  it('is not one reached only through a relay with a small allowance', async () => {
    expect(await dialable([{ limits: SMALL_CIRCUIT }])).toBe(false);
  });

  it('is one with a small relayed connection beside a direct one', async () => {
    expect(await dialable([{ limits: SMALL_CIRCUIT }, {}])).toBe(true);
  });

  it('is not one that does not speak the share protocol, whatever its connection', async () => {
    expect(await dialable([{ limits: CORE_CIRCUIT }], ['/meshsub/1.1.0'])).toBe(false);
  });
});
