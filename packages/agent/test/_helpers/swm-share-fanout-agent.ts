// SPDX-License-Identifier: Apache-2.0

/**
 * An agent whose shares into a context graph go to fake peers: the graph's
 * subscribers and followers that a test names, each answering a share as the
 * test says. Shared by the suites on who a share goes to
 * (`swm-shares-through-relay.test.ts`, `swm-share-holder-cores.test.ts` and
 * `swm-owed-public-share-wiring.test.ts`).
 */
import { expect } from 'vitest';
import { MockChainAdapter } from '@origintrail-official/dkg-chain';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { DKGAgent } from '../../src/index.js';
import { sharedMemoryFollowersOf } from '../../src/swm/shared-memory-followers.js';
import { FANOUT_RESPONSE_REJECTED, FANOUT_RESPONSE_RETRYABLE } from '../../src/swm/substrate-fanout.js';

export const SELF = '12D3KooWQz2bQbQueABKRSjV9koF8VYsXk5TdCsUmPf5zAEZg3q6';
export const PEER_A = '12D3KooWRdP3mMN9KkQCWKFjFxhgpXp8Q2y8zQZkgRYfGQ4bQh3a';
export const PEER_B = '12D3KooWFHUALUrdSfrVHSxtCRCJC9xvxS7nYfM6T1sbYVak9HTu';
export const PEER_C = '12D3KooWGRUVh6uXvRkYt8oYp9VvrxgZvKk3eYcZ6oZ3mGJ8sQwT';
export const GRAPH = 'test-cg/shares-through-relay';
/** The wallet of the owner of a graph whose id names it. */
export const OWNER_WALLET = '0x1111111111111111111111111111111111111111';

export const SHARE_PROTOCOL = '/dkg/10.0.1/swm-update';
export const DELIVERED = { delivered: true as const, response: new Uint8Array(), attempts: 1, messageId: 'm' };
/** The receiver's answer for a share it will never apply. */
export const REFUSED = { delivered: true as const, response: FANOUT_RESPONSE_REJECTED, attempts: 1, messageId: 'm' };
/** The receiver's answer for a share it cannot apply now. */
export const RETRY_LATER = { delivered: true as const, response: FANOUT_RESPONSE_RETRYABLE, attempts: 1, messageId: 'm' };
export type ShareAnswer = typeof DELIVERED | typeof REFUSED | typeof RETRY_LATER;

/**
 * An agent with GossipSub subscribers `subscribers` and followers `followers`
 * of `graph`, every peer dialable; `share` makes the next share and resolves
 * with the peers it was sent to directly, sorted.
 */
export async function agentWith(options: {
  subscribers: string[];
  followers: string[];
  answer?: (peerId: string) => ShareAnswer;
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
