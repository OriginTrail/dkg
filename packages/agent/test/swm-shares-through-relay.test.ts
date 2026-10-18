import { describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  GOSSIP_ENVELOPE_FRESHNESS_MS,
  GOSSIP_TYPE_WORKSPACE_PUBLISH,
  InMemoryMessageIdempotencyStore,
  InMemoryProtocolOutboxStore,
  PROTOCOL_SWM_UPDATE,
  computeGossipSigningPayload,
  createOperationContext,
  decodeGossipEnvelope,
  type OperationContext,
  type ProtocolRouter,
} from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
import { localGossipSigner } from '../src/external-author-signing.js';
import { Messenger } from '../src/p2p/messenger.js';
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
  noteCatalogHeadReplayFollower,
  sharedMemoryFollowersOf,
} from '../src/swm/shared-memory-followers.js';
import { FANOUT_RESPONSE_REJECTED, FANOUT_RESPONSE_RETRYABLE, chooseFanOutTier } from '../src/swm/substrate-fanout.js';
import { registerSyncHandler } from '../src/sync/responder/sync-handler.js';
import { SHARE_HOLDER_REFUSAL_TTL_MS, chooseHoldingCores, shareHolderRefusalsOf } from '../src/swm/relay-only-share-routes.js';
import { OWED_PUBLIC_SHARE_RESIGN_AFTER_MS, peekOwedPublicShares } from '../src/swm/owed-public-shares.js';
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
const PEER_C = '12D3KooWGRUVh6uXvRkYt8oYp9VvrxgZvKk3eYcZ6oZ3mGJ8sQwT';
const GRAPH = 'test-cg/shares-through-relay';
/** The wallet of the owner of a graph whose id names it. */
const OWNER_WALLET = '0x1111111111111111111111111111111111111111';

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

  it('lists a peer after its request, once, and only for that graph', () => {
    const { followers } = withClock();
    expect(followers.followers(GRAPH)).toEqual([]);
    followers.note(GRAPH, PEER_A);
    followers.note(GRAPH, PEER_A);
    followers.note(GRAPH, PEER_B);
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
    // The silent peer is a follower again when it comes back.
    followers.note(GRAPH, PEER_A);
    expect(followers.followers(GRAPH).sort()).toEqual([PEER_A, PEER_B].sort());
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

  describe('a request to replay a graph\'s catalog heads', () => {
    const request = { contextGraphId: GRAPH, policyDigest: `0x${'ab'.repeat(32)}` };

    it('makes the peer a follower when it names the policy this node has accepted', () => {
      const { followers } = withClock();
      expect(noteCatalogHeadReplayFollower(followers, request.policyDigest, request, PEER_A)).toBe(true);
      expect(followers.followers(GRAPH)).toEqual([PEER_A]);
    });

    it('records nothing under another policy, or for a graph this node holds no policy for', () => {
      const { followers } = withClock();
      expect(noteCatalogHeadReplayFollower(followers, `0x${'cd'.repeat(32)}`, request, PEER_A)).toBe(false);
      expect(noteCatalogHeadReplayFollower(followers, undefined, request, PEER_A)).toBe(false);
      expect(followers.followers(GRAPH)).toEqual([]);
      expect(followers.graphCount).toBe(0);
    });
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

  it('keep a follower that GossipSub does not report apart from the subscribers', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => [PEER_A],
      getSharedMemoryFollowers: () => [PEER_B],
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect(result.source).toBe('topic-subscribers');
    expect(result.members).toEqual([PEER_A]);
    expect(result.directFollowers).toEqual([PEER_B]);
  });

  it('have the followers of a public graph that has no subscriber at all', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getSharedMemoryFollowers: (cgId) => (cgId === GRAPH ? [PEER_B] : []),
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect(result).toEqual({ source: 'none', members: [], directFollowers: [PEER_B] });
    expect(await enumerator.enumerate('graph-without-followers')).toEqual({ source: 'none', members: [] });
  });

  it('do not list a subscriber or this node among the followers', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => [PEER_A, SELF],
      getSharedMemoryFollowers: () => [PEER_A, SELF, PEER_B, PEER_B],
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect(result.members).toEqual([PEER_A]);
    expect(result.directFollowers).toEqual([PEER_B]);
  });

  it('have only the followers the node can reach', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => [PEER_C],
      getSharedMemoryFollowers: () => [PEER_A, PEER_B],
      isPeerDialable: (peerId) => {
        if (peerId === PEER_A) throw new Error('peer store lookup failed');
        return peerId === PEER_B;
      },
    }));
    const result = await enumerator.enumerate(GRAPH);
    expect(result.members).toEqual([PEER_C]);
    expect(result.source === 'topic-subscribers' ? result.substrateEligibleMembers : undefined).toEqual([]);
    expect(result.directFollowers).toEqual([PEER_B]);
  });

  it('carry no followers field when none can be reached', async () => {
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => [PEER_C],
      getSharedMemoryFollowers: () => [PEER_A],
      isPeerDialable: (peerId) => peerId === PEER_C,
    }));
    expect(await enumerator.enumerate(GRAPH)).toEqual({
      source: 'topic-subscribers',
      members: [PEER_C],
      substrateEligibleMembers: [PEER_C],
    });
  });

  // The subscriber snapshot is cached for a minute. A follower is not: the
  // peer that asked a moment ago is a recipient of the very next share.
  it('include a new follower at once, while the graph\'s resolution is still cached', async () => {
    const followers = new SharedMemoryFollowers();
    let resolutions = 0;
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: async () => {
        resolutions += 1;
        return null;
      },
      getTopicSubscribers: () => [PEER_A],
      getSharedMemoryFollowers: (cgId) => followers.followers(cgId),
      now: () => 5_000,
    }));
    expect((await enumerator.enumerate(GRAPH)).directFollowers).toBeUndefined();
    followers.note(GRAPH, PEER_B);
    const next = await enumerator.enumerate(GRAPH);
    expect(next.members).toEqual([PEER_A]);
    expect(next.directFollowers).toEqual([PEER_B]);
    expect(resolutions).toBe(1);
  });

  // The cached snapshot can list a peer that has lost its gossip connection
  // since. Once it asks again, through a relay, it is a follower: judged
  // against the subscribers of this moment, not against the snapshot.
  it('treat a peer of the cached snapshot that is no longer a subscriber as a follower', async () => {
    const followers = new SharedMemoryFollowers();
    let subscribersNow = [PEER_A, PEER_C];
    const enumerator = createCGMemberEnumerator(makeDeps({
      getTopicSubscribers: () => subscribersNow,
      getSharedMemoryFollowers: (cgId) => followers.followers(cgId),
      now: () => 5_000,
    }));
    expect((await enumerator.enumerate(GRAPH)).members).toEqual([PEER_A, PEER_C]);
    subscribersNow = [PEER_C];
    followers.note(GRAPH, PEER_A);
    const next = await enumerator.enumerate(GRAPH);
    expect(next.members).toEqual([PEER_A, PEER_C]);
    expect(next.directFollowers).toEqual([PEER_A]);
    // With more subscribers than direct sends allow, the plan still sends to it.
    const plan = chooseFanOutTier({ enumeration: next, maxSubstrateMembers: 1 });
    expect(plan.useSubstrate).toBe(false);
    expect(plan.directFollowers).toEqual([PEER_A]);
  });

  it('join a resolution that is in flight and still read the followers of that moment', async () => {
    const followers = new SharedMemoryFollowers();
    let release: (peers: string[] | null) => void = () => {};
    const enumerator = createCGMemberEnumerator(makeDeps({
      getContextGraphAllowedPeers: () => new Promise((resolve) => { release = resolve; }),
      getTopicSubscribers: () => [PEER_A],
      getSharedMemoryFollowers: (cgId) => followers.followers(cgId),
    }));
    const first = enumerator.enumerate(GRAPH);
    const second = enumerator.enumerate(GRAPH);
    followers.note(GRAPH, PEER_B);
    release(null);
    expect((await first).directFollowers).toEqual([PEER_B]);
    expect((await second).directFollowers).toEqual([PEER_B]);
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
    expect(await privateGraph.enumerate(GRAPH)).toEqual({ source: 'none', members: [] });
    expect(asked).toBe(0);
  });
});

describe('the fan-out plan for a public graph with followers', () => {
  it.each([
    ['few subscribers', [PEER_A], 100, true],
    ['more subscribers than the cap, where the subscribers get gossip only', [PEER_A, PEER_C], 1, false],
  ] as const)('keeps the followers with %s', (_name, members, cap, useSubstrate) => {
    const plan = chooseFanOutTier({
      enumeration: { source: 'topic-subscribers', members, directFollowers: [PEER_B] },
      maxSubstrateMembers: cap,
    });
    expect(plan.useSubstrate).toBe(useSubstrate);
    expect(plan.substrateMembers).toEqual(useSubstrate ? members : []);
    expect(plan.directFollowers).toEqual([PEER_B]);
  });

  it('keeps the followers of a graph without subscribers', () => {
    const plan = chooseFanOutTier({
      enumeration: { source: 'none', members: [], directFollowers: [PEER_B] },
      maxSubstrateMembers: 100,
    });
    expect(plan).toMatchObject({ useSubstrate: false, useGossip: true, substrateMembers: [], directFollowers: [PEER_B] });
  });

  it('has no followers field without followers, and none for an allowlisted graph', () => {
    expect(chooseFanOutTier({
      enumeration: { source: 'topic-subscribers', members: [PEER_A] },
      maxSubstrateMembers: 100,
    })).not.toHaveProperty('directFollowers');
    expect(chooseFanOutTier({
      enumeration: { source: 'topic-subscribers', members: [PEER_A], directFollowers: [] },
      maxSubstrateMembers: 100,
    })).not.toHaveProperty('directFollowers');
    expect(chooseFanOutTier({
      enumeration: { source: 'allowlist', isPrivate: false, members: [PEER_A], directFollowers: [PEER_B] },
      maxSubstrateMembers: 100,
    })).not.toHaveProperty('directFollowers');
  });
});

describe('a share into a public graph that has followers', () => {
  const SHARE_PROTOCOL = '/dkg/10.0.1/swm-update';
  const DELIVERED = { delivered: true as const, response: new Uint8Array(), attempts: 1, messageId: 'm' };
  /** The receiver's answer for a share it will never apply. */
  const REFUSED = { delivered: true as const, response: FANOUT_RESPONSE_REJECTED, attempts: 1, messageId: 'm' };
  /** The receiver's answer for a share it cannot apply now. */
  const RETRY_LATER = { delivered: true as const, response: FANOUT_RESPONSE_RETRYABLE, attempts: 1, messageId: 'm' };

  async function agentWith(options: {
    subscribers: string[];
    followers: string[];
    answer?: (peerId: string) => typeof DELIVERED | typeof REFUSED | typeof RETRY_LATER;
    graph?: string;
  }) {
    const graph = options.graph ?? GRAPH;
    const agent = await DKGAgent.create({
      name: `shares-through-relay-${Math.random().toString(36).slice(2)}`,
      chainAdapter: new MockChainAdapter(),
    });
    const host = agent as unknown as {
      node: object;
      gossip: unknown;
      messenger: unknown;
      isPeerDialable: (peerId: string) => Promise<boolean>;
      swmSubstrateMaxMembers: number;
      rfc64LegacySwmApplyAllowedForScope: (contextGraphId: string, subGraphName: string | null) => boolean;
    };
    Object.defineProperty(host.node, 'peerId', { value: SELF, configurable: true });
    host.gossip = {
      subscribe() {},
      unsubscribe() {},
      onMessage() {},
      async publish() {},
      getSubscribers: () => [...options.subscribers],
    };
    host.isPeerDialable = async () => true;
    const sent: string[] = [];
    host.messenger = {
      sendReliable: async (peerId: string, protocolId: string) => {
        expect(protocolId).toBe(SHARE_PROTOCOL);
        sent.push(peerId);
        return (options.answer ?? (() => DELIVERED))(peerId);
      },
    };
    for (const peerId of options.followers) sharedMemoryFollowersOf(agent).note(graph, peerId);
    let shares = 0;
    const share = async (subGraphName: string | null | undefined): Promise<string[]> => {
      sent.length = 0;
      shares += 1;
      await agent.publishWorkspaceGossip(
        graph,
        new Uint8Array([1, 2, 3, shares]),
        createOperationContext('share'),
        null,
        `share-${shares}`,
        subGraphName === undefined ? undefined : { subGraphName },
      );
      await agent.awaitInFlightSubstrateFanOuts();
      return [...sent].sort();
    };
    return { agent, host, share };
  }

  it('goes to the follower as well as to the subscriber', async () => {
    const { share } = await agentWith({ subscribers: [PEER_A], followers: [PEER_B] });
    expect(await share('reports')).toEqual([PEER_A, PEER_B].sort());
  });

  it('goes to the follower when there is no subscriber', async () => {
    const { share } = await agentWith({ subscribers: [], followers: [PEER_B] });
    expect(await share('reports')).toEqual([PEER_B]);
  });

  it('goes to a peer once when it is a subscriber and a follower', async () => {
    const { share } = await agentWith({ subscribers: [PEER_A], followers: [PEER_A] });
    expect(await share('reports')).toEqual([PEER_A]);
  });

  it('goes to the follower when the graph has more subscribers than direct sends allow', async () => {
    const { host, share } = await agentWith({ subscribers: [PEER_A, PEER_C], followers: [PEER_B] });
    host.swmSubstrateMaxMembers = 1;
    // The subscribers get it by gossip alone; the follower has no gossip path.
    expect(await share('reports')).toEqual([PEER_B]);
  });

  it('goes to every follower, past the number of unknown subscribers one share probes', async () => {
    const followers = ['follower-1', 'follower-2', 'follower-3', 'follower-4', 'follower-5'];
    const { share } = await agentWith({ subscribers: [], followers });
    expect(await share('reports')).toEqual(followers);
  });

  it('still goes to a follower that refused the share before', async () => {
    const { agent, share } = await agentWith({
      subscribers: [PEER_A],
      followers: [PEER_B],
      answer: () => REFUSED,
    });
    expect(await share('reports')).toEqual([PEER_A, PEER_B].sort());
    // The refusal is remembered for the subscriber, which gossip also reaches,
    // and not for the follower, for which this send is the only path.
    expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, PEER_A)).toBe('failed');
    expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, PEER_B)).toBeUndefined();
    expect(await share('reports')).toEqual([PEER_B]);
  });

  // A follower that answers "not now" is sent the share again by the watchdog.
  // That retry must reach every such follower: the narrowing to three peers a
  // round is for subscribers, which gossip also reaches.
  it('is sent again to every follower that asked for a retry, not to three of them', async () => {
    const followers = ['follower-1', 'follower-2', 'follower-3', 'follower-4'];
    let retryLater = true;
    const { agent, share } = await agentWith({
      subscribers: [PEER_A],
      followers,
      answer: (peerId) => (retryLater && peerId !== PEER_A ? RETRY_LATER : DELIVERED),
    });
    expect(await share('reports')).toEqual([PEER_A, ...followers].sort());
    const tracked = agent.getSwmAckQuorumRecordSnapshotForTests('share-1') as
      | { acked: readonly string[]; directMembers?: readonly string[] }
      | undefined;
    expect(tracked?.acked).toEqual([PEER_A]);
    expect([...(tracked?.directMembers ?? [])].sort()).toEqual(followers);

    retryLater = false;
    const sent: string[] = [];
    const messenger = (agent as unknown as { messenger: { sendReliable: (peerId: string, protocolId: string) => Promise<unknown> } }).messenger;
    const sendReliable = messenger.sendReliable;
    messenger.sendReliable = async (peerId, protocolId) => {
      sent.push(peerId);
      return sendReliable(peerId, protocolId);
    };
    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId: 'share-1',
      cgId: GRAPH,
      payload: new Uint8Array([1, 2, 3, 1]),
      missingPeers: followers,
    });
    expect([...sent].sort()).toEqual(followers);
    // None of it is remembered against a follower, whatever it answered.
    for (const peerId of followers) expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, peerId)).toBeUndefined();
    // Every member has the share now, so the tracking of it has ended.
    expect(agent.getSwmAckQuorumRecordSnapshotForTests('share-1')).toBeUndefined();
  });

  // Nine of ten is the quorum at which a share's tracking used to end.
  it('is still sent again to the one follower that asked for a retry when nine subscribers have it', async () => {
    const subscribers = Array.from({ length: 9 }, (_unused, index) => `subscriber-${index + 1}`);
    let retryLater = true;
    const { agent, host, share } = await agentWith({
      subscribers,
      followers: [PEER_B],
      answer: (peerId) => (retryLater && peerId === PEER_B ? RETRY_LATER : DELIVERED),
    });
    // Every subscriber is sent to: none of them is narrowed away in this case.
    (host as unknown as { selectSwmFanoutPeersForActiveShare: (input: { candidatePeers: readonly string[] }) => unknown })
      .selectSwmFanoutPeersForActiveShare = (input) => ({
        selectedPeers: [...input.candidatePeers],
        knownGoodPeers: [],
        unknownProbedPeers: [],
        skippedRecentPeers: [],
        candidatePeers: [...input.candidatePeers],
      });
    expect(await share('reports')).toEqual([...subscribers, PEER_B].sort());
    const pending = agent.getSwmAckQuorumRecordSnapshotForTests('share-1');
    expect(pending?.ackPct).toBe(0.9);
    expect([...(pending?.acked ?? [])].sort()).toEqual([...subscribers].sort());

    retryLater = false;
    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId: 'share-1',
      cgId: GRAPH,
      payload: new Uint8Array([1, 2, 3, 1]),
      missingPeers: [PEER_B],
    });
    expect(agent.getSwmAckQuorumRecordSnapshotForTests('share-1')).toBeUndefined();
  });

  it('is tracked, and sent again, when a follower is the only recipient', async () => {
    let retryLater = true;
    const { agent, share } = await agentWith({
      subscribers: [],
      followers: [PEER_B],
      answer: () => (retryLater ? RETRY_LATER : DELIVERED),
    });
    expect(await share('reports')).toEqual([PEER_B]);
    expect(agent.getSwmAckQuorumRecordSnapshotForTests('share-1')).toMatchObject({ expectedMembers: [PEER_B], acked: [] });
    retryLater = false;
    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId: 'share-1',
      cgId: GRAPH,
      payload: new Uint8Array([1, 2, 3, 1]),
      missingPeers: [PEER_B],
    });
    expect(agent.getSwmAckQuorumRecordSnapshotForTests('share-1')).toBeUndefined();
  });

  it('is sent again to a subscriber by the old rules, beside the followers', async () => {
    const subscribers = ['subscriber-1', 'subscriber-2', 'subscriber-3', 'subscriber-4', 'subscriber-5'];
    const { agent, share } = await agentWith({ subscribers, followers: [PEER_B], answer: () => RETRY_LATER });
    await share('reports');
    const sent: string[] = [];
    (agent as unknown as { messenger: { sendReliable: (peerId: string) => Promise<unknown> } }).messenger.sendReliable = async (peerId) => {
      sent.push(peerId);
      return RETRY_LATER;
    };
    await agent.invokeSwmSubstrateTopUpForTests({
      shareOperationId: 'share-1',
      cgId: GRAPH,
      payload: new Uint8Array([1, 2, 3, 1]),
      missingPeers: [...subscribers, PEER_B],
    });
    // Three subscribers this round, as before, and the follower.
    expect(sent.filter((peerId) => peerId !== PEER_B)).toHaveLength(3);
    expect(sent).toContain(PEER_B);
  });

  describe('into the root', () => {
    it('does not go to the follower when the catalog owns the root, and the next sub-graph share does', async () => {
      const { host, share } = await agentWith({ subscribers: [PEER_A], followers: [PEER_B] });
      const asked: Array<string | null> = [];
      host.rfc64LegacySwmApplyAllowedForScope = (_contextGraphId, subGraphName) => {
        asked.push(subGraphName);
        return subGraphName !== null;
      };
      expect(await share(null)).toEqual([PEER_A]);
      expect(asked).toEqual([null]);
      expect(await share('reports')).toEqual([PEER_A, PEER_B].sort());
      expect(asked).toEqual([null]);
    });

    it('goes to the follower when the root is on the direct lane', async () => {
      const { host, share } = await agentWith({ subscribers: [], followers: [PEER_B] });
      host.rfc64LegacySwmApplyAllowedForScope = () => true;
      expect(await share(null)).toEqual([PEER_B]);
    });

    it('goes to the follower when the caller does not say where the share goes', async () => {
      const { host, share } = await agentWith({ subscribers: [], followers: [PEER_B] });
      host.rfc64LegacySwmApplyAllowedForScope = () => false;
      expect(await share(undefined)).toEqual([PEER_B]);
    });
  });

  // An author that connects only to Cores has no route to the graph's owner:
  // GossipSub does not run over a relayed connection, and the owner never asked
  // it for the graph. The owner needs the share itself, with its author's seal.
  describe('to the graph\'s owner', () => {
    const OWNER = '12D3KooWSmU3owJvB9sFw8uApDgKrv2VBMecsGGvgAc4Gq6hB57M';
    const OWNER_2 = '12D3KooWAbLiM6Xy2TfXtFpUrXqttnTSuctW8Lo1mkauaijsNrWw';

    /** The graph's owner is OWNER; `connected` lists the peers this node holds a connection to. */
    async function withOwner(options: {
      connected?: string[];
      reachable?: boolean;
      /** Peers whose dial fails without an error, as `ensurePeerConnected` lets a failed dial pass. */
      silentlyUnreachable?: string[];
      /** The graph's peer allowlist; none by default. */
      allowedPeers?: string[];
      owners?: string[] | (() => string[]);
      /** This node runs the graph's owner. */
      own?: boolean;
      isPrivate?: boolean;
      graph?: string;
    } = {}) {
      const target = await agentWith({ subscribers: [PEER_A], followers: [], graph: options.graph });
      const connected = options.connected ?? [];
      const connects: string[] = [];
      const owners = options.owners ?? [OWNER];
      Object.assign(target.host, {
        isPrivateContextGraph: async () => options.isPrivate === true,
        resolveCuratorPeerIdsForCg: async () => (options.own === true
          ? { peerIds: [], curatorIsLocal: true, legacyTripleResolved: false }
          : { peerIds: typeof owners === 'function' ? owners() : owners, curatorIsLocal: false, legacyTripleResolved: true }),
        ensurePeerConnected: async (peerId: string) => {
          connects.push(peerId);
          if (options.reachable === false) throw new Error('no route to the owner');
          if (options.silentlyUnreachable?.includes(peerId)) return;
          connected.push(peerId);
        },
        ...(options.allowedPeers === undefined
          ? {}
          : { resolveSwmAllowedPeersForCurrentAuthority: async () => options.allowedPeers }),
      });
      Object.defineProperty(target.host.node, 'libp2p', {
        value: {
          getPeers: () => connected.map((peerId) => ({ toString: () => peerId })),
          peerStore: { get: async () => ({ protocols: [SHARE_PROTOCOL] }) },
        },
        configurable: true,
      });
      return { ...target, connects };
    }

    it('goes to an owner this node is not connected to, through a connection made for it', async () => {
      const { share, connects } = await withOwner();
      expect(await share('reports')).toEqual([PEER_A, OWNER].sort());
      expect(connects).toEqual([OWNER]);
    });

    it('counts an owner peer it could not dial as not reached, though the peer store lists its protocol, and goes to the next', async () => {
      const { share, connects } = await withOwner({ owners: [OWNER, OWNER_2], silentlyUnreachable: [OWNER] });
      expect(await share('reports')).toEqual([PEER_A, OWNER_2].sort());
      expect(connects).toEqual([OWNER, OWNER_2]);
    });

    it('goes to the owner of a public graph whose peer allowlist does not name the owner\'s peer, and once when it does', async () => {
      const offList = await withOwner({ allowedPeers: [PEER_A] });
      expect(await offList.share('reports')).toEqual([PEER_A, OWNER].sort());
      expect(offList.connects).toEqual([OWNER]);

      const onList = await withOwner({ allowedPeers: [PEER_A, OWNER] });
      expect(await onList.share('reports')).toEqual([PEER_A, OWNER].sort());
    });

    it('goes to a connected owner without connecting again', async () => {
      const { share, connects } = await withOwner({ connected: [OWNER] });
      expect(await share('reports')).toEqual([PEER_A, OWNER].sort());
      expect(connects).toEqual([]);
    });

    it('still goes to the others when the owner cannot be reached, and the next share does not wait for it', async () => {
      const { share, connects } = await withOwner({ reachable: false });
      expect(await share('reports')).toEqual([PEER_A]);
      expect(await share('reports')).toEqual([PEER_A]);
      expect(connects).toEqual([OWNER]);
    });

    it('looks an owner the local phonebook does not know up on demand, then goes to it', async () => {
      let phonebookHasOwner = false;
      const lookups: string[][] = [];
      const target = await withOwner({
        graph: `${OWNER_WALLET}/owned-elsewhere`,
        owners: () => (phonebookHasOwner ? [OWNER] : []),
      });
      Object.assign(target.host, {
        ensureAgentsInOnDemandPhonebook: async (wallets: readonly string[]) => {
          lookups.push([...wallets]);
          phonebookHasOwner = true;
          return new Set(wallets.map((wallet) => wallet.toLowerCase()));
        },
      });
      expect(await target.share('reports')).toEqual([PEER_A, OWNER].sort());
      expect(lookups).toEqual([[OWNER_WALLET]]);
      expect(target.connects).toEqual([OWNER]);
    });

    it('goes to the others when a Core\'s phonebook does not know the owner either, and the next share does not look again', async () => {
      const lookups: string[][] = [];
      const target = await withOwner({ graph: `${OWNER_WALLET}/owned-elsewhere`, owners: [] });
      Object.assign(target.host, {
        ensureAgentsInOnDemandPhonebook: async (wallets: readonly string[]) => {
          lookups.push([...wallets]);
          return new Set<string>();
        },
      });
      expect(await target.share('reports')).toEqual([PEER_A]);
      expect(await target.share('reports')).toEqual([PEER_A]);
      expect(lookups).toHaveLength(1);
      expect(target.connects).toEqual([]);
    });

    it('is not routed for a root the catalog owns, on the graph\'s own node, or for a private graph', async () => {
      const root = await withOwner();
      root.host.rfc64LegacySwmApplyAllowedForScope = (_contextGraphId, subGraphName) => subGraphName !== null;
      expect(await root.share(null)).toEqual([PEER_A]);
      const ownNode = await withOwner({ own: true, graph: `${OWNER_WALLET}/owned-here` });
      const lookups: string[][] = [];
      Object.assign(ownNode.host, {
        ensureAgentsInOnDemandPhonebook: async (wallets: readonly string[]) => {
          lookups.push([...wallets]);
          return new Set<string>();
        },
      });
      expect(await ownNode.share('reports')).toEqual([PEER_A]);
      const privateGraph = await withOwner({ isPrivate: true });
      await privateGraph.agent.routeShareToPublicGraphOwnerV1(GRAPH);
      expect([...root.connects, ...ownNode.connects, ...privateGraph.connects]).toEqual([]);
      expect(lookups).toEqual([]);
    });
  });

  // A relay-only member right after a graph is created: no Core subscribes to
  // the graph yet, the owner is not found, and no other Edge has asked this
  // one for the graph. The share went to nobody, silently. A Core that hosts
  // the graph applies a member's sub-graph share without subscribing, and the
  // other members pull it from there, so the share goes to the connected Cores.
  describe('into a public graph that no recipient holds for others', () => {
    const CORES = ['core-1', 'core-2', 'core-3', 'core-4', 'core-5', 'core-6'];
    type Answer = typeof DELIVERED | typeof REFUSED | typeof RETRY_LATER;

    interface CoreHost {
      config: { nodeRole?: 'core' | 'edge' };
      peerCapabilityRegistry: { supportsCore(peerId: string): boolean };
      connectedSharedMemoryCoresV1(): Promise<string[]>;
      isPrivateContextGraph(contextGraphId: string): Promise<boolean>;
      resolveSwmAllowedPeersForCurrentAuthority(contextGraphId: string): Promise<string[] | null>;
      log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
      started: boolean;
    }

    async function withCores(options: {
      cores: string[];
      subscribers?: string[];
      followers?: string[];
      answer?: (peerId: string) => Answer;
      graph?: string;
    }) {
      const target = await agentWith({
        subscribers: options.subscribers ?? [],
        followers: options.followers ?? [],
        answer: options.answer,
        graph: options.graph,
      });
      const host = target.host as unknown as CoreHost;
      const cores = new Set(options.cores.concat((options.subscribers ?? []).filter((peerId) => peerId.startsWith('core-'))));
      host.peerCapabilityRegistry.supportsCore = (peerId) => cores.has(peerId);
      host.connectedSharedMemoryCoresV1 = async () => [...options.cores];
      return { ...target, coreHost: host };
    }

    it('goes to the connected Cores, which are tracked and retried like followers', async () => {
      const { agent, share } = await withCores({ cores: ['core-2', 'core-1'], answer: () => RETRY_LATER });
      expect(await share('reports')).toEqual(['core-1', 'core-2']);
      const tracked = agent.getSwmAckQuorumRecordSnapshotForTests('share-1');
      expect([...(tracked?.expectedMembers ?? [])].sort()).toEqual(['core-1', 'core-2']);
      expect([...(tracked?.directMembers ?? [])].sort()).toEqual(['core-1', 'core-2']);
    });

    it('goes to at most four Cores, the same ones for each share of a graph', async () => {
      const { share } = await withCores({ cores: CORES });
      const chosen = chooseHoldingCores({ contextGraphId: GRAPH, candidates: CORES, exclude: new Set(), refused: () => false });
      expect(chosen).toHaveLength(4);
      expect(await share('reports')).toEqual([...chosen].sort());
      expect(await share('reports')).toEqual([...chosen].sort());
    });

    it('goes to the Cores beside a follower, and to no extra Core when a Core subscribes', async () => {
      const withFollower = await withCores({ cores: ['core-1'], followers: [PEER_B] });
      expect(await withFollower.share('reports')).toEqual([PEER_B, 'core-1'].sort());
      const subscribedCore = await withCores({ cores: ['core-1', 'core-2'], subscribers: ['core-9'] });
      expect(await subscribedCore.share('reports')).toEqual(['core-9']);
    });

    it('goes to the Cores beside Edge subscribers, without remembering their answers as a subscriber\'s', async () => {
      const { agent, share } = await withCores({
        cores: ['core-1'],
        subscribers: [PEER_A],
        answer: (peerId) => (peerId === 'core-1' ? REFUSED : DELIVERED),
      });
      expect(await share('reports')).toEqual([PEER_A, 'core-1'].sort());
      expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, PEER_A)).toBe('good');
      expect(agent.getSwmFanoutPeerOutcomeForTests(GRAPH, 'core-1')).toBeUndefined();
    });

    it('does not go to a Core for a private graph, an unreadable one, a captured roster, an allowlist, or from a Core', async () => {
      const privateGraph = await withCores({ cores: ['core-1'] });
      privateGraph.coreHost.isPrivateContextGraph = async () => true;
      expect(await privateGraph.share('reports')).toEqual([]);

      const unreadable = await withCores({ cores: ['core-1'] });
      unreadable.coreHost.isPrivateContextGraph = async () => { throw new Error('store unavailable'); };
      expect(await unreadable.share('reports')).toEqual([]);

      const allowlisted = await withCores({ cores: ['core-1'] });
      allowlisted.coreHost.resolveSwmAllowedPeersForCurrentAuthority = async () => [PEER_A];
      expect(await allowlisted.share('reports')).toEqual([PEER_A]);

      const fromCore = await withCores({ cores: ['core-1'] });
      fromCore.coreHost.config.nodeRole = 'core';
      expect(await fromCore.share('reports')).toEqual([]);

      const captured = await withCores({ cores: ['core-1'] });
      const sent: string[] = [];
      (captured.host.messenger as { sendReliable: (peerId: string) => Promise<unknown> }).sendReliable = async (peerId) => {
        sent.push(peerId);
        return DELIVERED;
      };
      await captured.agent.publishWorkspaceGossip(
        GRAPH,
        { message: new Uint8Array([7]), fanout: { kind: 'captured', snapshot: { source: 'agent-roster', members: [PEER_A], complete: true } } },
        createOperationContext('share'),
        null,
        'captured-share',
        { subGraphName: 'reports' },
      );
      await captured.agent.awaitInFlightSubstrateFanOuts();
      expect(sent).toEqual([PEER_A]);
    });

    it('does not go to a Core with a share into a root the catalog owns, and does with one on the direct lane', async () => {
      const catalogRoot = await withCores({ cores: ['core-1'] });
      catalogRoot.host.rfc64LegacySwmApplyAllowedForScope = (_contextGraphId, subGraphName) => subGraphName !== null;
      expect(await catalogRoot.share(null)).toEqual([]);
      const directRoot = await withCores({ cores: ['core-1'] });
      directRoot.host.rfc64LegacySwmApplyAllowedForScope = () => true;
      expect(await directRoot.share(null)).toEqual(['core-1']);
    });

    it('is sent again to a Core that asked for a retry, though the quorum is met, until it applies the share', async () => {
      let retryLater = true;
      const { agent, host, share } = await withCores({
        cores: ['core-1'],
        subscribers: Array.from({ length: 9 }, (_unused, index) => `edge-${index + 1}`),
        answer: (peerId) => (retryLater && peerId === 'core-1' ? RETRY_LATER : DELIVERED),
      });
      // Every subscriber is sent to: none of them is narrowed away in this case.
      (host as unknown as { selectSwmFanoutPeersForActiveShare: (input: { candidatePeers: readonly string[] }) => unknown })
        .selectSwmFanoutPeersForActiveShare = (input) => ({
          selectedPeers: [...input.candidatePeers],
          knownGoodPeers: [],
          unknownProbedPeers: [],
          skippedRecentPeers: [],
          candidatePeers: [...input.candidatePeers],
        });
      await share('reports');
      const pending = agent.getSwmAckQuorumRecordSnapshotForTests('share-1');
      expect(pending?.ackPct).toBeGreaterThanOrEqual(0.9);
      expect(pending?.directMembers).toEqual(['core-1']);
      retryLater = false;
      await agent.invokeSwmSubstrateTopUpForTests({
        shareOperationId: 'share-1',
        cgId: GRAPH,
        payload: new Uint8Array([1, 2, 3, 1]),
        missingPeers: ['core-1'],
      });
      expect(agent.getSwmAckQuorumRecordSnapshotForTests('share-1')).toBeUndefined();
    });

    it('leaves out a Core that refused the graph\'s share for ten minutes, and takes another', async () => {
      let now = 5_000_000;
      const target = await withCores({
        cores: ['core-1', 'core-2', 'core-3'],
        answer: (peerId) => (peerId === 'core-1' ? REFUSED : RETRY_LATER),
      });
      shareHolderRefusalsOf(target.agent, () => now);
      target.coreHost.connectedSharedMemoryCoresV1 = async () => ['core-1', 'core-2'];
      expect(await target.share('reports')).toEqual(['core-1', 'core-2']);
      expect(target.agent.getSwmAckQuorumRecordSnapshotForTests('share-1')?.expectedMembers).toEqual(['core-2']);

      target.coreHost.connectedSharedMemoryCoresV1 = async () => ['core-1', 'core-2', 'core-3'];
      expect(await target.share('reports')).toEqual(['core-2', 'core-3']);
      now += SHARE_HOLDER_REFUSAL_TTL_MS;
      expect(await target.share('reports')).toEqual(['core-1', 'core-2', 'core-3']);
    });

    it('says in its fan-out line how many Cores it went to', async () => {
      const { coreHost, share } = await withCores({ cores: ['core-1', 'core-2'] });
      const info = vi.spyOn(coreHost.log, 'info');
      await share('reports');
      expect(info.mock.calls.map(([, message]) => String(message)).find((line) => line.startsWith('SWM substrate fan-out')))
        .toMatch(/ cores=2$/);
    });

    it('is not silent when it reaches nobody: a started node warns and keeps it, a node not started keeps nothing', async () => {
      const notStarted = await withCores({ cores: [] });
      const quiet = vi.spyOn(notStarted.coreHost.log, 'warn');
      expect(await notStarted.share('reports')).toEqual([]);
      expect(quiet.mock.calls.map(([, message]) => String(message)).filter((line) => line.includes('reached no peer'))).toHaveLength(1);
      expect(peekOwedPublicShares(notStarted.agent)).toBeUndefined();

      const running = await withCores({ cores: [] });
      const warn = vi.spyOn(running.coreHost.log, 'warn');
      running.coreHost.started = true;
      try {
        expect(await running.share('reports')).toEqual([]);
        const lines = warn.mock.calls.map(([, message]) => String(message)).filter((line) => line.includes('reached no peer'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('sub-graph "reports"');
        expect(lines[0]).toContain('op=share-1');
        expect(lines[0]).toContain('kept for 30 min');
        expect(peekOwedPublicShares(running.agent)?.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: false }]);
        // While the node stops, a share is no longer kept; once it starts again it is.
        running.agent.stopOwedPublicSharesV1();
        expect(await running.share('reports')).toEqual([]);
        expect(peekOwedPublicShares(running.agent)?.size).toBe(0);
        running.agent.reopenOwedPublicSharesV1();
        expect(await running.share('reports')).toEqual([]);
        expect(peekOwedPublicShares(running.agent)?.snapshot()).toMatchObject([{ shareOperationId: 'share-3' }]);
      } finally {
        running.agent.stopOwedPublicSharesV1();
        running.coreHost.started = false;
      }
      expect(peekOwedPublicShares(running.agent)?.closed).toBe(true);
    });
  });

  // What the agent wires into the store of owed shares (`swm/owed-public-shares.ts`).
  describe('kept because it reached nobody or not the owner', () => {
    const OWNER = '12D3KooWOwnerOfTheOwnedGraph';
    const CORE = '12D3KooWConnectedCoreNode';
    const OWNED_ELSEWHERE = `${OWNER_WALLET}/owned-elsewhere`;

    interface WiredHost {
      started: boolean;
      node: object;
      peerCapabilityRegistry: { supportsCore(peerId: string): boolean };
      networkAdmissionCoordinator: { isAcceptedPeer(peerId: string): boolean };
      resolveCuratorPeerIdsForCg(contextGraphId: string): Promise<{ peerIds: string[]; curatorIsLocal: boolean; legacyTripleResolved: boolean }>;
      ensureAgentsInOnDemandPhonebook(wallets: readonly string[]): Promise<Set<string>>;
      routeShareToPublicGraphOwnerV1(contextGraphId: string): Promise<readonly string[]>;
      encodeWorkspaceGossipMessage(contextGraphId: string, message: Uint8Array, signer?: unknown): Promise<Uint8Array>;
      log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
    }

    async function running(options: { answer?: (peerId: string) => typeof DELIVERED | typeof REFUSED | typeof RETRY_LATER; connections?: () => unknown[] } = {}) {
      const target = await agentWith({ subscribers: [], followers: [], graph: OWNED_ELSEWHERE, answer: options.answer });
      const host = target.host as unknown as WiredHost;
      // A kept share is sent apart from the fan-out, by a send that never queues.
      const received: Array<{ peerId: string; bytes: number[]; messageId: string }> = [];
      const messenger = target.host.messenger as {
        sendReliable: (peerId: string, protocolId: string) => Promise<unknown>;
        sendRequestOwned?: (peerId: string, protocolId: string, payload: Uint8Array, opts?: { messageId: string }) => Promise<unknown>;
      };
      const send = messenger.sendReliable;
      messenger.sendRequestOwned = async (peerId, protocolId, payload, opts) => {
        received.push({ peerId, bytes: [...payload], messageId: opts?.messageId ?? '' });
        return send(peerId, protocolId);
      };
      Object.defineProperty(host.node, 'libp2p', {
        value: {
          getPeers: () => [],
          getConnections: options.connections ?? (() => []),
          peerStore: { get: async () => ({ protocols: [SHARE_PROTOCOL] }) },
        },
        configurable: true,
      });
      host.peerCapabilityRegistry.supportsCore = (peerId) => peerId === CORE;
      host.networkAdmissionCoordinator = { isAcceptedPeer: () => true };
      host.resolveCuratorPeerIdsForCg = async () => ({ peerIds: [], curatorIsLocal: false, legacyTripleResolved: false });
      host.ensureAgentsInOnDemandPhonebook = async () => new Set<string>();
      host.started = true;
      return { ...target, wired: host, received };
    }

    it('is sent to the owner, signed again, once the owner can be found, and counted as delivered', async () => {
      const { agent, wired, received, share } = await running();
      try {
        expect(await share('reports')).toEqual([]);
        const owed = peekOwedPublicShares(agent);
        expect(owed?.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: true }]);

        wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
        const resign = vi.spyOn(wired, 'encodeWorkspaceGossipMessage').mockResolvedValue(new Uint8Array([9, 9, 9]));
        const delivered = agent.getSwmSubstrateFanoutStats().delivered[OWNED_ELSEWHERE] ?? 0;
        const later = Date.now() + OWED_PUBLIC_SHARE_RESIGN_AFTER_MS;
        vi.spyOn(Date, 'now').mockReturnValue(later);
        try {
          await owed!.tick();
        } finally {
          vi.mocked(Date.now).mockRestore();
        }
        expect(resign).toHaveBeenCalledWith(OWNED_ELSEWHERE, new Uint8Array([1, 2, 3, 1]), null);
        expect(received).toEqual([{ peerId: OWNER, bytes: [9, 9, 9], messageId: `swm-owed-share-1-${OWNER}-1` }]);
        await agent.awaitInFlightSubstrateFanOuts();
        expect(agent.getSwmSubstrateFanoutStats().delivered[OWNED_ELSEWHERE]).toBe(delivered + 1);
        expect(owed?.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: true, owner: false }]);
      } finally {
        agent.stopOwedPublicSharesV1();
        wired.started = false;
      }
    });

    // A Core refuses an outdated version of an asset as it refuses a graph it
    // does not host. A kept share sent again may be outdated by then: its
    // refusal must not keep the Core from the next, fresh share.
    it('is sent to a Core that connects later; a refusal of it does not keep the Core from the next share; nothing is sent once the node stops', async () => {
      let connections: unknown[] = [];
      const { agent, wired, received, share } = await running({
        answer: () => REFUSED,
        connections: () => connections,
      });
      try {
        await share('reports');
        const owed = peekOwedPublicShares(agent)!;
        connections = [{ remotePeer: { toString: () => CORE } }, { remotePeer: { toString: () => PEER_A } }];
        await owed.tick();
        expect(received.map((sent) => sent.peerId)).toEqual([CORE]);
        expect(shareHolderRefusalsOf(agent).refused(OWNED_ELSEWHERE, 'reports', CORE)).toBe(false);
        expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'share-1', holder: false, owner: true }]);
        const warn = vi.spyOn(wired.log, 'warn');
        expect(await share('reports')).toEqual([CORE]);
        // The fresh share's own refusal is remembered.
        expect(shareHolderRefusalsOf(agent).refused(OWNED_ELSEWHERE, 'reports', CORE)).toBe(true);
        // Refused by its only recipients, the fresh share is kept as one that reached nobody.
        expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'share-1' }, { shareOperationId: 'share-2', holder: true, owner: true }]);
        expect(warn.mock.calls.map(([, message]) => String(message))
          .some((line) => line.includes('op=share-2 refused by every connected Core it went to'))).toBe(true);

        agent.stopOwedPublicSharesV1();
        await owed.tick();
        expect(received).toHaveLength(1);
        expect(owed.closed).toBe(true);
      } finally {
        agent.stopOwedPublicSharesV1();
        wired.started = false;
      }
    });

    it('warns when the owner refuses it, and a send that throws counts as failed', async () => {
      let throws = true;
      const { agent, wired, received, share } = await running({ answer: () => REFUSED });
      const messenger = (agent as unknown as { messenger: { sendRequestOwned: (...args: unknown[]) => Promise<unknown> } }).messenger;
      const send = messenger.sendRequestOwned;
      messenger.sendRequestOwned = async (...args) => {
        if (throws) throw new Error('protocol not supported');
        return send(...args);
      };
      try {
        await share('reports');
        const owed = peekOwedPublicShares(agent)!;
        wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
        await owed.tick();
        expect(owed.size).toBe(1);
        throws = false;
        const warn = vi.spyOn(wired.log, 'warn');
        await owed.tick();
        expect(received.map((sent) => sent.peerId)).toEqual([OWNER]);
        expect(warn.mock.calls.map(([, message]) => String(message)).some((line) => line.includes('refused'))).toBe(true);
      } finally {
        agent.stopOwedPublicSharesV1();
        wired.started = false;
      }
    });

    it('leaves no row in the durable outbox when a send of it times out, pass after pass', async () => {
      const { agent, wired, share } = await running();
      const outboxStore = new InMemoryProtocolOutboxStore();
      const attempts: string[] = [];
      const router = {
        send: async (peerId: string) => {
          attempts.push(peerId);
          throw new Error('send timeout');
        },
        register: () => undefined,
      };
      (agent as unknown as { messenger: Messenger }).messenger = new Messenger({
        router: router as unknown as ProtocolRouter,
        idempotencyStore: new InMemoryMessageIdempotencyStore(),
        outboxStore,
      });
      try {
        await share('reports');
        const owed = peekOwedPublicShares(agent)!;
        wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
        const failed = agent.getSwmSubstrateFanoutStats().failed[OWNED_ELSEWHERE] ?? 0;
        for (let pass = 0; pass < 3; pass += 1) await owed.tick();
        expect(attempts).toEqual([OWNER, OWNER, OWNER]);
        expect(outboxStore.pendingFor(OWNER)).toEqual([]);
        expect(agent.getSwmSubstrateFanoutStats().failed[OWNED_ELSEWHERE]).toBe(failed + 3);
        expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'share-1', owner: true }]);
      } finally {
        agent.stopOwedPublicSharesV1();
        wired.started = false;
      }
    });

    // The owner may be found minutes after the share: the envelope it then
    // gets is signed again, by the share's author, and receivers take it.
    it('is signed again by its author: the envelope sent is fresh, carries the same payload and verifies as the author\'s', async () => {
      const { agent, wired, received } = await running();
      const wallet = ethers.Wallet.createRandom();
      const signer = localGossipSigner(wallet.address, wallet.privateKey);
      const message = new Uint8Array([4, 5, 6]);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const sharedAt = Date.parse('2026-10-18T17:07:22.000Z');
        vi.setSystemTime(sharedAt);
        await agent.publishWorkspaceGossip(OWNED_ELSEWHERE, message, createOperationContext('share'), signer, 'signed-share', { subGraphName: 'reports' });
        const owed = peekOwedPublicShares(agent)!;
        expect(owed.snapshot()).toMatchObject([{ shareOperationId: 'signed-share', signedAt: sharedAt }]);
        wired.routeShareToPublicGraphOwnerV1 = async () => [OWNER];
        const sentAt = sharedAt + 6 * 60_000;
        vi.setSystemTime(sentAt);
        await owed.tick();
        expect(received).toHaveLength(1);
        const envelope = decodeGossipEnvelope(new Uint8Array(received[0]!.bytes));
        expect(Date.parse(envelope.timestamp)).toBe(sentAt);
        expect(sentAt - sharedAt).toBeGreaterThan(GOSSIP_ENVELOPE_FRESHNESS_MS);
        expect([...envelope.payload]).toEqual([...message]);
        expect(envelope.agentAddress).toBe(wallet.address);
        const signingPayload = computeGossipSigningPayload(GOSSIP_TYPE_WORKSPACE_PUBLISH, OWNED_ELSEWHERE, envelope.timestamp, envelope.payload);
        expect(ethers.verifyMessage(signingPayload, ethers.hexlify(envelope.signature))).toBe(wallet.address);
      } finally {
        vi.useRealTimers();
        agent.stopOwedPublicSharesV1();
        wired.started = false;
      }
    });

    it('is not kept for an owner that runs on this node', async () => {
      const target = await agentWith({ subscribers: [PEER_A], followers: [], graph: OWNED_ELSEWHERE });
      const host = target.host as unknown as WiredHost & { localAgents: Map<string, { agentAddress: string }> };
      const anotherAgent = '0x2222222222222222222222222222222222222222';
      host.localAgents.set(anotherAgent, { agentAddress: anotherAgent });
      host.localAgents.set(OWNER_WALLET, { agentAddress: OWNER_WALLET });
      host.resolveCuratorPeerIdsForCg = async () => ({ peerIds: [], curatorIsLocal: false, legacyTripleResolved: false });
      host.ensureAgentsInOnDemandPhonebook = async () => new Set<string>();
      host.started = true;
      try {
        expect(await target.share('reports')).toEqual([PEER_A]);
        expect(peekOwedPublicShares(target.agent)).toBeUndefined();
        host.localAgents.delete(OWNER_WALLET);
        expect(await target.share('reports')).toEqual([PEER_A]);
        expect(peekOwedPublicShares(target.agent)?.snapshot()).toMatchObject([{ shareOperationId: 'share-2', holder: false, owner: true }]);
      } finally {
        target.agent.stopOwedPublicSharesV1();
        host.started = false;
      }
    });

    it('lists as connected Cores only admitted Cores that take shares, and none on a node that is not running', async () => {
      const { agent, wired } = await running({
        connections: () => [
          { remotePeer: { toString: () => CORE } },
          { remotePeer: { toString: () => CORE } },
          { remotePeer: { toString: () => PEER_A } },
        ],
      });
      expect(await agent.connectedSharedMemoryCoresV1()).toEqual([CORE]);
      wired.networkAdmissionCoordinator = { isAcceptedPeer: () => false };
      expect(await agent.connectedSharedMemoryCoresV1()).toEqual([]);
      wired.networkAdmissionCoordinator = { isAcceptedPeer: () => { throw new Error('not started'); } };
      expect(await agent.connectedSharedMemoryCoresV1()).toEqual([]);
      wired.started = false;
      expect(await agent.connectedSharedMemoryCoresV1()).toEqual([]);
    });
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
