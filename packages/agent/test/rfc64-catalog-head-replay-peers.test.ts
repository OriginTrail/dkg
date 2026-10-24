// SPDX-License-Identifier: Apache-2.0

/**
 * A peer whose request to replay a graph's catalog heads this node
 * authorized follows the graph, whether or not this node can serve the
 * replay now; and a peer that gives no answer to this node's own request is
 * said, with its reason, at debug.
 */
import { multiaddr } from '@multiformats/multiaddr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DKGAgent } from '../src/index.js';
import {
  answerRfc64CatalogHeadReplayRequestV1,
  rfc64CatalogReplayPeerFailureV1,
  type Rfc64CatalogHeadReplayQueueAdmissionV1,
} from '../src/internal/catalog-head-replay-peers.js';
import { SharedMemoryFollowers, sharedMemoryFollowersOf } from '../src/swm/shared-memory-followers.js';
import { Rfc64PublicCatalogTransportErrorV1 } from '../src/rfc64/public-catalog-transport-v1.js';
import {
  createRfc64RolloutAgentHarness,
  RFC64_ROLLOUT_CONTEXT_GRAPH_ID as CONTEXT_GRAPH_ID,
  RFC64_ROLLOUT_NETWORK_ID as NETWORK_ID,
  rfc64RolloutActivation as activation,
} from './_helpers/rfc64-rollout-agent-harness.js';

const GRAPH = 'did:example:replay-peers';
const POLICY = `0x${'ab'.repeat(32)}`;
const PEER = '12D3KooWRequestingPeerAAAA';
const request = Object.freeze({
  kind: 'rfc64-public-catalog-head-replay-request-v1',
  networkId: 'otp:20430',
  contextGraphId: GRAPH,
  policyDigest: POLICY,
}) as never;

function answer(
  admission: Rfc64CatalogHeadReplayQueueAdmissionV1,
  { acceptedPolicyDigest }: { readonly acceptedPolicyDigest: string | undefined } = { acceptedPolicyDigest: POLICY },
) {
  const followers = new SharedMemoryFollowers();
  const log = { info: vi.fn(), warn: vi.fn() };
  const queue = vi.fn(() => admission);
  const answered = answerRfc64CatalogHeadReplayRequestV1({
    request, remotePeerId: PEER, followers, acceptedPolicyDigest, queue, log,
  });
  return { answered, followers, log, queue };
}

/** Let a queued replay's completion settle, and its line be logged. */
async function settled(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

describe('answering a request to replay a graph\'s catalog heads', () => {
  it('makes the peer a follower even when the replay is answered busy', () => {
    const busy = Object.freeze({ status: 'busy' as const });
    const { answered, followers, log, queue } = answer(busy);
    expect(answered).toBe(busy);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(followers.followers(GRAPH)).toEqual([PEER]);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('makes the peer a follower before its replay runs, and says what the replay announced', async () => {
    let finish!: (result: { announced: number }) => void;
    const admission = Object.freeze({
      status: 'admitted' as const,
      newlyQueued: true,
      completion: new Promise<{ announced: number }>((resolve) => { finish = resolve; }),
    });
    const { answered, followers, log } = answer(admission);
    expect(answered).toBe(admission);
    expect(followers.followers(GRAPH)).toEqual([PEER]);

    finish({ announced: 2 });
    await settled();
    expect(log.info).toHaveBeenCalledWith('Replayed 2 RFC-64 catalog head(s) to PeerAAAA');
  });

  it('says nothing for a replay that announced nothing', async () => {
    const { log } = answer(Object.freeze({
      status: 'admitted' as const,
      newlyQueued: true,
      completion: Promise.resolve({ announced: 0 }),
    }));
    await settled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('keeps the peer a follower, and warns, when its replay fails', async () => {
    const { followers, log } = answer(Object.freeze({
      status: 'admitted' as const,
      newlyQueued: true,
      completion: Promise.reject(new Error('RFC-64 scoped catalog replay authority is unavailable')),
    }));
    await settled();
    expect(followers.followers(GRAPH)).toEqual([PEER]);
    expect(log.warn).toHaveBeenCalledWith(
      'RFC-64 catalog head replay failed for PeerAAAA: RFC-64 scoped catalog replay authority is unavailable',
    );
  });

  it('leaves the logging to the request that queued a replay another one joins', async () => {
    const { followers, log } = answer(Object.freeze({
      status: 'admitted' as const,
      newlyQueued: false,
      completion: Promise.resolve({ announced: 3 }),
    }));
    await settled();
    expect(followers.followers(GRAPH)).toEqual([PEER]);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('records no follower for a graph under another policy, or one this node holds none for', () => {
    const busy = Object.freeze({ status: 'busy' as const });
    expect(answer(busy, { acceptedPolicyDigest: `0x${'cd'.repeat(32)}` }).followers.followers(GRAPH)).toEqual([]);
    expect(answer(busy, { acceptedPolicyDigest: undefined }).followers.followers(GRAPH)).toEqual([]);
  });
});

describe('a peer that gave no answer to this node\'s replay request', () => {
  it('is said at debug with its reason, and the error is handed back to throw', () => {
    const log = { debug: vi.fn() };
    const error = new Rfc64PublicCatalogTransportErrorV1(
      'catalog-transport-overloaded',
      'remote peer remained busy after 4 catalog-head replay attempt(s)',
    );
    expect(rfc64CatalogReplayPeerFailureV1(log, GRAPH, PEER, error)).toBe(error);
    expect(log.debug).toHaveBeenCalledWith(
      expect.anything(),
      `RFC-64 catalog replay from PeerAAAA for "${GRAPH}" got no answer: `
        + '[catalog-transport-overloaded] remote peer remained busy after 4 catalog-head replay attempt(s)',
    );
    rfc64CatalogReplayPeerFailureV1(log, GRAPH, PEER, 'stream reset');
    expect(log.debug).toHaveBeenLastCalledWith(
      expect.anything(),
      `RFC-64 catalog replay from PeerAAAA for "${GRAPH}" got no answer: stream reset`,
    );
  });
});

/**
 * The same through two agents connected over loopback: the requester sends
 * a real replay request, and the responder's own policy check admits it.
 */
describe('an agent answering a peer\'s replay request it cannot serve now', () => {
  const { startAgent, cleanup } = createRfc64RolloutAgentHarness();

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  function tcpMultiaddr(agent: DKGAgent): string {
    const address = agent.multiaddrs.find((candidate) => candidate.includes('/tcp/'));
    if (address === undefined) throw new Error('agent has no TCP multiaddr');
    return address;
  }

  function acceptEveryPeer(agent: DKGAgent): void {
    const coordinator = (agent as any).networkAdmissionCoordinator;
    coordinator.isAcceptedPeer = () => true;
    coordinator.isRejectedPeer = () => false;
  }

  it('answers busy and still counts the requesting peer among the graph\'s followers', async () => {
    const responder = await startAgent({ name: 'replay-follower-responder', activation: activation('catalog') });
    const requester = await startAgent({ name: 'replay-follower-requester', activation: activation('catalog') });
    acceptEveryPeer(responder);
    acceptEveryPeer(requester);
    // Every replay this responder is asked for finds its queue full.
    const queue = vi.spyOn(responder, 'tryQueueRfc64CatalogHeadReplayV1')
      .mockReturnValue(Object.freeze({ status: 'busy' }) as never);
    await requester.node.libp2p.dial(multiaddr(tcpMultiaddr(responder)));

    await expect((requester as any).rfc64PublicCatalogServiceV1.requestCatalogHeadReplay({
      remotePeerId: responder.peerId,
      networkId: NETWORK_ID,
      contextGraphId: CONTEXT_GRAPH_ID,
    })).rejects.toThrow('catalog-transport-overloaded');
    expect(queue).toHaveBeenCalledWith(requester.peerId, expect.objectContaining({
      contextGraphId: CONTEXT_GRAPH_ID,
    }));
    expect(sharedMemoryFollowersOf(responder).followers(CONTEXT_GRAPH_ID)).toContain(requester.peerId);
  });
});
