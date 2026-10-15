// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's change notice of a public graph, as agent methods: the owner
 * tells its followers that the graph's shared memory changed, and a follower
 * pulls the changed scope from the sender. The protocol logic lives in
 * `swm/shared-memory-change-notice.ts`; the protocol is registered with the
 * other shared-memory protocols in `dkg-agent-lifecycle.ts`.
 */

import { createOperationContext, PROTOCOL_SWM_CHANGE_NOTICE } from '@origintrail-official/dkg-core';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './rfc64/public-catalog-transport-v1.js';
import {
  SwmChangeNoticeReceiver,
  SwmChangeNotifier,
  sendSwmChangeNotice,
  swmChangeNoticeHint,
  type SwmChangeNoticeDisposition,
} from './swm/shared-memory-change-notice.js';
import { sharedMemoryFollowersOf } from './swm/shared-memory-followers.js';

/** Per-agent owners of the change notices (`swm/shared-memory-change-notice.ts`). */
const swmChangeNotifiersV1 = new WeakMap<object, SwmChangeNotifier<Rfc64PublicCatalogHeadAnnouncementV1 | undefined>>();
const swmChangeNoticeReceiversV1 = new WeakMap<object, SwmChangeNoticeReceiver>();

export class SwmChangeNoticeMethods extends DKGAgentBase {
  /**
   * A share from another peer was applied here. On the owner of a public
   * graph, tell the graph's followers so that they pull it now
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
      lane: '',
      detail: undefined,
    });
  }

  /**
   * The catalog receiver applied another author's root head. On the owner of
   * a public graph, forward the head's announcement to the graph's followers;
   * each pulls the head from this node through its own catalog receiver.
   */
  forwardRemoteRfc64CatalogHeadV1(this: DKGAgent, announcement: Rfc64PublicCatalogHeadAnnouncementV1, providerPeerId: string): void {
    this.swmChangeNotifierV1().afterRemoteChange({
      contextGraphId: announcement.contextGraphId,
      subGraphName: null,
      hint: swmChangeNoticeHint(announcement.catalogHeadObjectDigest),
      sourcePeerId: providerPeerId,
      lane: announcement.authorAddress.toLowerCase(),
      detail: announcement,
    });
  }

  /** A change notice from `fromPeerId`; see `swm/shared-memory-change-notice.ts`. */
  async handleSwmChangeNoticeV1(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<SwmChangeNoticeDisposition> {
    return this.swmChangeNoticeReceiverV1().handle(data, fromPeerId);
  }

  swmChangeNotifierV1(this: DKGAgent): SwmChangeNotifier<Rfc64PublicCatalogHeadAnnouncementV1 | undefined> {
    let notifier = swmChangeNotifiersV1.get(this);
    if (notifier !== undefined) return notifier;
    const ctx = createOperationContext('share');
    notifier = new SwmChangeNotifier<Rfc64PublicCatalogHeadAnnouncementV1 | undefined>({
      ownsPublicGraph: async (contextGraphId) => (
        await this.isCuratorOf(contextGraphId) && !await this.isPrivateContextGraph(contextGraphId)
      ),
      noteFollower: (contextGraphId, peerId) => sharedMemoryFollowersOf(this).note(contextGraphId, peerId),
      followers: async (contextGraphId) => {
        const followers = sharedMemoryFollowersOf(this).followers(contextGraphId);
        const reachable = await Promise.all(followers.map((peerId) => this.isPeerDialable(peerId).catch(() => false)));
        return followers.filter((_, index) => reachable[index]);
      },
      deliver: async (change, recipients) => {
        if (change.detail === undefined) {
          return sendSwmChangeNotice(change, recipients, (peerId, bytes) => this.messenger.sendToPeer(
            peerId, PROTOCOL_SWM_CHANGE_NOTICE, bytes, { timeoutMs: DKGAgentBase.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS },
          ));
        }
        const service = this.rfc64PublicCatalogServiceV1;
        if (service === undefined) return 0;
        return (await service.announceCatalogHead({ announcement: change.detail, peers: recipients })).announcedPeers.length;
      },
      selfPeerId: () => this.peerId,
      log: (message) => this.log.info(ctx, message),
    });
    swmChangeNotifiersV1.set(this, notifier);
    return notifier;
  }

  swmChangeNoticeReceiverV1(this: DKGAgent): SwmChangeNoticeReceiver {
    let receiver = swmChangeNoticeReceiversV1.get(this);
    if (receiver !== undefined) return receiver;
    const ctx = createOperationContext('sync');
    const ownerPeers = new Map<string, { readonly at: number; readonly peerIds: readonly string[] }>();
    receiver = new SwmChangeNoticeReceiver({
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
        const cached = ownerPeers.get(contextGraphId);
        if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.peerIds.includes(peerId);
        const owner = await this.resolveCuratorPeerIdsForCg(contextGraphId, { maxPeerIds: 16 }).catch(() => undefined);
        const peerIds = owner?.peerIds ?? [];
        ownerPeers.delete(contextGraphId);
        if (ownerPeers.size >= 256) ownerPeers.delete(ownerPeers.keys().next().value as string);
        ownerPeers.set(contextGraphId, { at: Date.now(), peerIds });
        return peerIds.includes(peerId);
      },
      // The pull the reconciler would make, brought forward: classed and measured as one.
      pull: async (peerId, notice) => {
        const result = await this.syncSharedMemoryFromPeerDetailed(peerId, [notice.contextGraphId], { source: 'reconcile' });
        return (result.deferredBackpressure ?? 0) > 0 ? 'deferred' : 'pulled';
      },
      log: (message) => this.log.info(ctx, message),
    });
    swmChangeNoticeReceiversV1.set(this, receiver);
    return receiver;
  }
}
