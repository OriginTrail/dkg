import { describe, expect, it } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { PROTOCOL_SWM_UPDATE, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../src/index.js';
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
  }) {
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
    for (const peerId of options.followers) sharedMemoryFollowersOf(agent).note(GRAPH, peerId);
    let shares = 0;
    const share = async (subGraphName: string | null | undefined): Promise<string[]> => {
      sent.length = 0;
      shares += 1;
      await agent.publishWorkspaceGossip(
        GRAPH,
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
