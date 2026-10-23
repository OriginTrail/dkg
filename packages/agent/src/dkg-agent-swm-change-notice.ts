// SPDX-License-Identifier: Apache-2.0

/**
 * The owner's change notice of a public graph, as agent methods: the owner
 * tells its followers that the graph's shared memory changed, and a follower
 * pulls the graph from the sender. The protocol logic lives in
 * `swm/shared-memory-change-notice.ts`. `start()` (`dkg-agent-lifecycle.ts`)
 * registers the protocol, and `stop()` (`dkg-agent.ts`) stops both sides.
 *
 * Also a Core's forward of a member's signed share to the graph's owner, and
 * the owner's receipt of it (`swm/owner-share-forward.ts`): both hang on the
 * same apply hook, registration and shutdown.
 */

import {
  createOperationContext,
  DKG_GOSSIP_MAX_RPC_BYTES,
  PROTOCOL_SWM_CHANGE_NOTICE,
  PROTOCOL_SWM_UPDATE_RELAYED,
} from '@origintrail-official/dkg-core';
import { coreHostedOwnerPeerIds } from './core-hosted-definition.js';
import { toLibp2pPeerId } from './p2p/peer-id.js';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { rfc64UnregisteredAuthorityOwnerV1 } from './rfc64/unregistered-authority-transport-v1.js';
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
import { sharedMemoryFollowersOf } from './swm/shared-memory-followers.js';
import {
  checkRelayedShare,
  graphHasAllowlist,
  OwnerShareForwarder,
  RelayedShareApplies,
  RelayedShareRateLimit,
  relayedShareKey,
  shouldForwardShareToOwner,
  type OwnerShareToForward,
} from './swm/owner-share-forward.js';
import { coreHostsPublicGraph } from './swm/relay-only-share-routes.js';
import { FANOUT_RESPONSE_REJECTED } from './swm/substrate-fanout.js';

/**
 * One agent's two sides of the notice, its forwards of catalog heads that are
 * still choosing their recipients (and of shares still deciding whether they
 * go to the owner), its forwards of members' shares to graph owners, and the
 * rate limit and the applies of the shares Cores relay to it.
 */
export interface SwmChangeNoticeOwnersV1 {
  readonly notifier: SwmChangeNotifier;
  readonly receiver: SwmChangeNoticeReceiver;
  readonly forwards: Set<Promise<void>>;
  readonly ownerForwarder: OwnerShareForwarder;
  readonly relayedShares: RelayedShareRateLimit;
  readonly relayedApplies: RelayedShareApplies;
  stopped: boolean;
}

/** The fields of an applied share that the apply hook reads. */
export interface SwmAppliedShareV1 {
  readonly cgId?: string;
  readonly subGraphName?: string;
  readonly shareOperationId?: string;
  readonly publisherPeerId?: string;
}

/** A relayed share the owner may apply, under its `relayedShareKey`, or why it is refused. */
export type RelayedSwmShareAdmissionV1 = { readonly refusal: string } | { readonly key: string };

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
    // A member's share that a Core passes on to this node as the graph's owner.
    this.router.register(PROTOCOL_SWM_UPDATE_RELAYED, async (data, peerIdObj) => (
      this.handleRelayedSwmShareV1(data, peerIdObj.toString())
    ), { maxReadBytes: DKG_GOSSIP_MAX_RPC_BYTES });
  }

  /** Shutdown: the owner tells nobody of a change any more, the follower starts no pull, and no share goes to an owner. */
  stopSwmChangeNoticesV1(this: DKGAgent): void {
    const owners = this.swmChangeNoticeOwnersV1();
    owners.stopped = true;
    owners.notifier.stop();
    owners.receiver.stop();
    owners.ownerForwarder.stop();
  }

  /**
   * A share from another peer was applied here. On the owner of a public
   * graph, tell the graph's followers so that they pull it now
   * (`swm/shared-memory-change-notice.ts`). With the share's bytes (`wire`),
   * a Core also passes a member's share on to the graph's owner
   * ({@link forwardShareToGraphOwnerV1}). Never throws, never waits.
   */
  noticeSwmFollowersAfterApplyV1(this: DKGAgent, outcome: SwmAppliedShareV1, fromPeerId: string, wire?: Uint8Array): void {
    if (outcome.cgId === undefined) return;
    this.swmChangeNotifierV1().afterRemoteChange({
      contextGraphId: outcome.cgId,
      subGraphName: outcome.subGraphName ?? null,
      hint: swmChangeNoticeHint(outcome.shareOperationId),
      sourcePeerId: fromPeerId,
    });
    if (wire !== undefined) this.forwardShareToGraphOwnerV1(outcome, fromPeerId, wire);
  }

  /**
   * On a Core: pass a member's share it has just applied, the bytes as they
   * came, on to the graph's owner (`swm/owner-share-forward.ts`). Detached:
   * the reply to the member does not wait for the checks or the send. Never
   * throws.
   */
  forwardShareToGraphOwnerV1(this: DKGAgent, outcome: SwmAppliedShareV1, fromPeerId: string, wire: Uint8Array): void {
    if (this.config.nodeRole !== 'core') return;
    const owners = this.swmChangeNoticeOwnersV1();
    if (owners.stopped) return;
    const forward = this.ownerBoundShareV1(outcome, fromPeerId, wire)
      .then((share) => {
        if (share !== null && !owners.stopped) owners.ownerForwarder.forward(share);
      })
      .catch((error: unknown) => {
        this.log.debug(createOperationContext('share'), `Share op=${outcome.shareOperationId ?? 'none'} not passed on to the graph's owner: ${errorText(error)}`);
      });
    owners.forwards.add(forward);
    void forward.finally(() => owners.forwards.delete(forward));
  }

  /** The share to pass on to the owner of its graph, or null when it does not go there. */
  async ownerBoundShareV1(this: DKGAgent, outcome: SwmAppliedShareV1, fromPeerId: string, wire: Uint8Array): Promise<OwnerShareToForward | null> {
    if (outcome.cgId === undefined || outcome.shareOperationId === undefined) return null;
    const contextGraphId = this.rfc64AuthorityContextGraphIdV1(outcome.cgId);
    const owner = rfc64UnregisteredAuthorityOwnerV1(contextGraphId);
    if (owner === null) return null;
    const subscription = this.subscribedContextGraphs.get(contextGraphId);
    const forward = await shouldForwardShareToOwner({
      nodeRole: this.config.nodeRole,
      hosted: coreHostsPublicGraph(this.config.nodeRole, subscription),
      subscribed: subscription?.subscribed === true,
      subGraphName: outcome.subGraphName,
      shareOperationId: outcome.shareOperationId,
      publisherPeerId: outcome.publisherPeerId,
      fromPeerId,
      wire,
    }, {
      ownerIsLocal: () => [...this.localAgents.keys()].some((address) => address.toLowerCase() === owner.toLowerCase()),
      publicWithoutAllowlist: async () => (
        !await this.isPrivateContextGraph(contextGraphId) && !graphHasAllowlist(await this.getCgMeta(contextGraphId))
      ),
    });
    return forward ? { contextGraphId, shareOperationId: outcome.shareOperationId, fromPeerId, wire } : null;
  }

  /**
   * A member's share that the Core `fromPeerId` passed on to this node as the
   * graph's owner (`swm/owner-share-forward.ts`). Taken only from an admitted
   * Core, by the curator of a public graph without an allowlist, when the
   * envelope is the asset author's fresh signature over a plain share into a
   * named sub-graph; then applied on the share handler's replay path, which
   * keeps the author seal as for a direct send. The same bytes from other
   * Cores run the handler once (`RelayedShareApplies`). Answers empty when
   * applied and with the refusal byte otherwise; sends no share ack. Never
   * throws.
   */
  async handleRelayedSwmShareV1(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<Uint8Array> {
    const ctx = createOperationContext('share');
    const from = fromPeerId.slice(-8);
    try {
      const admission = await this.admitRelayedSwmShareV1(data, fromPeerId);
      if ('refusal' in admission) {
        this.log.debug(ctx, `Share relayed by ${from} refused: ${admission.refusal}`);
        return FANOUT_RESPONSE_REJECTED;
      }
      const taken = await this.swmChangeNoticeOwnersV1().relayedApplies.once(admission.key, async () => {
        const outcome = await this.getOrCreateSharedMemoryHandler().handle(data, fromPeerId, undefined, { trustedReplay: true });
        if (!outcome.applied) {
          this.log.debug(ctx, `Share relayed by ${from} not applied: ${outcome.reason}`);
          return false;
        }
        this.log.info(ctx, `Applied share op=${outcome.shareOperationId ?? 'none'} of "${outcome.cgId ?? ''}" relayed by Core ${from}`);
        // As after a direct or gossip apply: the owner tells the graph's followers. No bytes, so it is not passed on again.
        this.noticeSwmFollowersAfterApplyV1(outcome, fromPeerId);
        return true;
      });
      if (taken === 'applied-before') this.log.debug(ctx, `Share relayed by ${from} already applied from another copy`);
      return taken === 'refused' ? FANOUT_RESPONSE_REJECTED : new Uint8Array();
    } catch (error) {
      this.log.debug(ctx, `Share relayed by ${from} not handled: ${errorText(error)}`);
      return FANOUT_RESPONSE_REJECTED;
    }
  }

  /** Why a relayed share is refused, cheapest checks first, or the key it is applied under. */
  async admitRelayedSwmShareV1(this: DKGAgent, data: Uint8Array, fromPeerId: string): Promise<RelayedSwmShareAdmissionV1> {
    const owners = this.swmChangeNoticeOwnersV1();
    if (owners.stopped) return { refusal: 'the node is stopping' };
    if (!this.peerCapabilityRegistry.supportsCore(fromPeerId) || !this.networkAdmissionCoordinator.isAcceptedPeer(fromPeerId)) {
      return { refusal: 'the sender is not an admitted Core' };
    }
    if (!owners.relayedShares.allow(fromPeerId)) return { refusal: 'the sender passed its rate limit' };
    const check = checkRelayedShare(data, Date.now());
    if (!check.ok) return { refusal: check.reason };
    const contextGraphId = this.rfc64AuthorityContextGraphIdV1(check.contextGraphId);
    if (!await this.isCuratorOf(contextGraphId)) return { refusal: `this node is not the curator of "${contextGraphId}"` };
    if (await this.isPrivateContextGraph(contextGraphId)) return { refusal: `"${contextGraphId}" is private` };
    if (graphHasAllowlist(await this.getCgMeta(contextGraphId))) return { refusal: `"${contextGraphId}" has an allowlist` };
    return { key: relayedShareKey(contextGraphId, check.shareOperationId, data) };
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
    await owners.ownerForwarder.settled();
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
    const notifier = new SwmChangeNotifier({
      ...this.swmChangeRecipientPortsV1(),
      deliver: (notice, recipients) => sendSwmChangeNotice(notice, recipients, (peerId, bytes) => this.messenger.sendToPeer(
        peerId, PROTOCOL_SWM_CHANGE_NOTICE, bytes, { timeoutMs: DKGAgentBase.SWM_SUBSTRATE_FANOUT_TIMEOUT_MS },
      )),
      // What identify told of the peer; unknown (no protocols yet) is tried.
      supportsNotice: async (peerId) => {
        const libp2pPeerId = toLibp2pPeerId({ toString: () => peerId });
        if (libp2pPeerId === undefined) return undefined;
        const protocols = (await this.node.libp2p.peerStore.get(libp2pPeerId).catch(() => undefined))?.protocols ?? [];
        return protocols.length === 0 ? undefined : protocols.includes(PROTOCOL_SWM_CHANGE_NOTICE);
      },
      log: (message) => this.log.info(shareCtx, message),
    });
    const ownerPeers = new Map<string, { readonly at: number; readonly peerIds: readonly string[] }>();
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
        const cached = ownerPeers.get(contextGraphId);
        if (cached !== undefined && Date.now() - cached.at < 5 * 60_000) return cached.peerIds.includes(peerId);
        const owner = await this.resolveCuratorPeerIdsForCg(contextGraphId, { maxPeerIds: 16 }).catch(() => undefined);
        const peerIds = owner?.peerIds ?? [];
        ownerPeers.delete(contextGraphId);
        if (ownerPeers.size >= 256) ownerPeers.delete(ownerPeers.keys().next().value as string);
        ownerPeers.set(contextGraphId, { at: Date.now(), peerIds });
        return peerIds.includes(peerId);
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
    const ownerForwarder = new OwnerShareForwarder({
      ownerPeers: async (contextGraphId, signal) => {
        const owner = rfc64UnregisteredAuthorityOwnerV1(contextGraphId);
        return owner === null ? [] : coreHostedOwnerPeerIds(this, contextGraphId, owner, signal);
      },
      isConnected: (peerId) => this.node.libp2p.getPeers().some((peer) => peer.toString() === peerId),
      selfPeerId: () => this.peerId,
      send: async (peerId, wire, options) => {
        const answer = await this.messenger.sendToPeer(peerId, PROTOCOL_SWM_UPDATE_RELAYED, wire, options);
        return answer.length === 0 ? 'applied' : 'refused';
      },
      logDebug: (message) => this.log.debug(shareCtx, message),
    });
    const owners: SwmChangeNoticeOwnersV1 = {
      notifier,
      receiver,
      forwards: new Set(),
      ownerForwarder,
      relayedShares: new RelayedShareRateLimit(),
      relayedApplies: new RelayedShareApplies(),
      stopped: false,
    };
    ownersByAgentV1.set(this, owners);
    return owners;
  }
}
