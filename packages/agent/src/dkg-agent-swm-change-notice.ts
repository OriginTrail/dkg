// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's change notice of a public graph, as agent methods: the owner
 * tells its followers that the graph's shared memory changed, and a follower
 * pulls the graph from the sender. A Core that hosts the graph tells the
 * graph's owner of a share into a named sub-graph (`swm/core-hosted-graph.ts`).
 * The protocol logic lives in `swm/shared-memory-change-notice.ts`. `start()`
 * (`dkg-agent-lifecycle.ts`) registers the protocol, and `stop()`
 * (`dkg-agent.ts`) stops both sides.
 */

import { createOperationContext, PROTOCOL_SWM_CHANGE_NOTICE } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from './rfc64/catalog-peers-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './rfc64/public-catalog-transport-v1.js';
import {
  SWM_CHANGE_NOTICE_MAX_BYTES,
  SwmChangeNoticeReceiver,
  SwmChangeNotifier,
  sendSwmChangeNotice,
  swmChangeNoticeHint,
  swmChangeRecipients,
  type SwmChangeNoticeDisposition,
  type SwmChangeRecipientPorts,
} from './swm/shared-memory-change-notice.js';
import { hostsPublicGraphAsCore } from './swm/core-hosted-graph.js';
import { sharedMemoryFollowersOf } from './swm/shared-memory-followers.js';

/** One agent's two sides of the notice, and its forwards of catalog heads that are still choosing their recipients. */
export interface SwmChangeNoticeOwnersV1 {
  readonly notifier: SwmChangeNotifier;
  readonly receiver: SwmChangeNoticeReceiver;
  readonly forwards: Set<Promise<void>>;
  stopped: boolean;
}

/** Per agent. `start()` drops them, so that a restarted agent does not keep the stopped ones. */
const ownersByAgentV1 = new WeakMap<object, SwmChangeNoticeOwnersV1>();

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SwmChangeNoticeMethods extends DKGAgentBase {
  /** Answer change notices from now on, reading at most a notice's size of a request. */
  registerSwmChangeNoticeProtocolV1(this: DKGAgent): void {
    ownersByAgentV1.delete(this);
    const ctx = createOperationContext('sync');
    this.router.register(PROTOCOL_SWM_CHANGE_NOTICE, async (data, peerIdObj) => {
      // Answered at once; the pull it may start runs on its own.
      const peerId = peerIdObj.toString();
      void this.handleSwmChangeNoticeV1(data, peerId).catch((error: unknown) => {
        this.log.info(ctx, `SWM change notice from ${peerId.slice(-8)} not handled: ${errorText(error)}`);
      });
      return new Uint8Array();
    }, { maxReadBytes: SWM_CHANGE_NOTICE_MAX_BYTES });
  }

  /** Shutdown: the owner tells nobody of a change any more, and the follower starts no pull. */
  stopSwmChangeNoticesV1(this: DKGAgent): void {
    const owners = this.swmChangeNoticeOwnersV1();
    owners.stopped = true;
    owners.notifier.stop();
    owners.receiver.stop();
  }

  /**
   * A share from another peer was applied here. On the owner of a public
   * graph, tell the graph's followers so that they pull it now; on a Core that
   * hosts the graph, tell the graph's owner of a share into a named sub-graph
   * (`swm/shared-memory-change-notice.ts`). Never throws, never waits.
   */
  noticeSwmFollowersAfterApplyV1(this: DKGAgent, outcome: {
    readonly cgId?: string;
    readonly subGraphName?: string;
    readonly shareOperationId?: string;
  }, fromPeerId: string): void {
    if (outcome.cgId === undefined) return;
    this.swmChangeNotifierV1().afterRemoteChange({
      contextGraphId: outcome.cgId,
      subGraphName: outcome.subGraphName ?? null,
      hint: swmChangeNoticeHint(outcome.shareOperationId),
      sourcePeerId: fromPeerId,
    });
  }

  /**
   * The catalog receiver applied another author's root head. On the owner of
   * a public graph, hand the head's announcement to the catalog's delivery
   * owner for the graph's followers, except the peer it came from; it sends
   * the head as it sends this node's own, and each follower pulls the head
   * from this node through its catalog receiver. Never throws, never waits.
   */
  forwardRemoteRfc64CatalogHeadV1(this: DKGAgent, announcement: Rfc64PublicCatalogHeadAnnouncementV1, providerPeerId: string): void {
    const owners = this.swmChangeNoticeOwnersV1();
    if (owners.stopped) return;
    const { contextGraphId } = announcement;
    const forward = swmChangeRecipients(this.swmChangeRecipientPortsV1(), contextGraphId, new Set([providerPeerId]))
      .then((recipients) => {
        if (recipients.length === 0 || owners.stopped) return;
        this.deliverRfc64CatalogHeadV1({
          announcement,
          peers: recipients.slice(0, RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1),
        });
      })
      .catch((error: unknown) => {
        this.log.info(createOperationContext('share'), `Catalog head of "${contextGraphId}" not passed on: ${errorText(error)}`);
      });
    owners.forwards.add(forward);
    void forward.finally(() => owners.forwards.delete(forward));
  }

  /** A change notice from `fromPeerId`; see `swm/shared-memory-change-notice.ts`. */
  async handleSwmChangeNoticeV1(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<SwmChangeNoticeDisposition> {
    return this.swmChangeNoticeReceiverV1().handle(data, fromPeerId);
  }

  /** Resolves when the notices, pulls and forwards started so far have ended; for tests. */
  async whenSwmChangeNoticesSettledV1(this: DKGAgent): Promise<void> {
    const owners = this.swmChangeNoticeOwnersV1();
    while (owners.forwards.size > 0) await Promise.allSettled(owners.forwards);
    await owners.notifier.settled();
    await owners.receiver.settled();
  }

  swmChangeNotifierV1(this: DKGAgent): SwmChangeNotifier {
    return this.swmChangeNoticeOwnersV1().notifier;
  }

  swmChangeNoticeReceiverV1(this: DKGAgent): SwmChangeNoticeReceiver {
    return this.swmChangeNoticeOwnersV1().receiver;
  }

  /** Whom the owner of a public graph tells of a change: the followers a direct send reaches. */
  swmChangeRecipientPortsV1(this: DKGAgent): SwmChangeRecipientPorts {
    return {
      ownsPublicGraph: async (contextGraphId) => (
        await this.isCuratorOf(contextGraphId) && !await this.isPrivateContextGraph(contextGraphId)
      ),
      noteFollower: (contextGraphId, peerId) => sharedMemoryFollowersOf(this).note(contextGraphId, peerId),
      followers: async (contextGraphId) => {
        const followers = sharedMemoryFollowersOf(this).followers(contextGraphId);
        const reachable = await Promise.all(followers.map((peerId) => this.isPeerDialable(peerId).catch(() => false)));
        return followers.filter((_, index) => reachable[index]);
      },
      selfPeerId: () => this.peerId,
    };
  }

  swmChangeNoticeOwnersV1(this: DKGAgent): SwmChangeNoticeOwnersV1 {
    const existing = ownersByAgentV1.get(this);
    if (existing !== undefined) return existing;
    const shareCtx = createOperationContext('share');
    const syncCtx = createOperationContext('sync');
    // The peers of a graph's owner, looked up at most once per graph in 5 min.
    const ownerPeers = new Map<string, { readonly at: number; readonly peerIds: readonly string[] }>();
    const ownerPeerIds = async (contextGraphId: string): Promise<readonly string[]> => {
      const cached = ownerPeers.get(contextGraphId);
      if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.peerIds;
      const owner = await this.resolveCuratorPeerIdsForCg(contextGraphId, { maxPeerIds: 16 }).catch(() => undefined);
      const peerIds = owner?.peerIds ?? [];
      ownerPeers.delete(contextGraphId);
      if (ownerPeers.size >= 256) ownerPeers.delete(ownerPeers.keys().next().value as string);
      ownerPeers.set(contextGraphId, { at: Date.now(), peerIds });
      return peerIds;
    };
    const notifier = new SwmChangeNotifier({
      ...this.swmChangeRecipientPortsV1(),
      hostedGraphOwnerPeers: async (contextGraphId) => {
        if (!hostsPublicGraphAsCore(this, contextGraphId)) return [];
        const connected = new Set(this.node.libp2p.getPeers().map((peer) => peer.toString()));
        const peerIds = await ownerPeerIds(this.rfc64AuthorityContextGraphIdV1(contextGraphId));
        return peerIds.filter((peerId) => connected.has(peerId));
      },
      deliver: (notice, recipients) => sendSwmChangeNotice(notice, recipients, (peerId, bytes) => this.messenger.sendToPeer(
        peerId, PROTOCOL_SWM_CHANGE_NOTICE, bytes, { timeoutMs: DKGAgentBase.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS },
      )),
      log: (message) => this.log.info(shareCtx, message),
    });
    const receiver = new SwmChangeNoticeReceiver({
      follows: async (contextGraphId) => (
        this.subscribedContextGraphs.get(this.rfc64AuthorityContextGraphIdV1(contextGraphId))?.subscribed === true
        && !await this.isPrivateContextGraph(contextGraphId)
      ),
      // The graph's owner, or a peer that follows the graph from this node
      // (it asked this node for the graph's shared memory under the accepted
      // policy). Either way only a connected peer: the pull goes to it.
      acceptsSender: async (contextGraphId, peerId) => {
        if (!this.node.libp2p.getPeers().some((peer) => peer.toString() === peerId)) return false;
        if (sharedMemoryFollowersOf(this).followers(contextGraphId).includes(peerId)) return true;
        return (await ownerPeerIds(contextGraphId)).includes(peerId);
      },
      // The pull the reconciler would make, brought forward: classed and
      // measured as one. It never joins a sync of the graph from the sender
      // that was already running: that one may have read the sender's
      // metadata before the change.
      pull: async (peerId, contextGraphId) => {
        const result = await this.syncSharedMemoryFromPeerDetailed(peerId, [contextGraphId], {
          source: 'reconcile',
          freshSnapshot: true,
        });
        return (result.deferredBackpressure ?? 0) > 0 ? 'deferred' : 'pulled';
      },
      log: (message) => this.log.info(syncCtx, message),
    });
    const owners: SwmChangeNoticeOwnersV1 = { notifier, receiver, forwards: new Set(), stopped: false };
    ownersByAgentV1.set(this, owners);
    return owners;
  }
}
