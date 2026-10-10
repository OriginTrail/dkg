// SPDX-License-Identifier: Apache-2.0

/**
 * Outbound delivery of author-catalog head announcements, owned by the public catalog service.
 * This module decides which head is sent when; `public-catalog-head-fanout-v1.ts` is how one head
 * is sent (peer selection, waves, the budget of the sends).
 *
 * Two callers share one bounded fan-out:
 *
 * - `announce` is the awaited fan-out behind the service's explicit announce API. Every requested
 *   peer is attempted and reported, so a peer this node's own policy refuses is a failed peer.
 * - `deliver` is the hand-off a catalog mutation makes once its head is durable (GH#3081). It
 *   returns at once, so the next change of the scope never waits for a peer. One owner per catalog
 *   scope then sends the head: peers this node's own policy refuses are left out before anything
 *   is sent and are not failures, and a newer head replaces one that was not sent yet.
 *
 * Replacing an unsent head is safe because an announcement is a hint to pull, and a receiver
 * needs the newest head only. It fetches the announced head by digest and applies that head's
 * whole set; when its own applied head is more than one version behind, it proves the lineage by
 * fetching the skipped signed heads from the provider (at most RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1
 * of them); and it treats a head older than its applied one as already satisfied. Three rules
 * keep a replacement inside what that allows:
 *
 * - The newest handed-off head is never dropped in favour of an older one.
 * - The peers of a replaced head are carried over to the head that replaces it, as far as the
 *   peers of one fan-out go. A waiting head whose peers do not all fit is not replaced for them:
 *   it stays, for those peers only, and is sent first. So every peer a hand-off named is sent
 *   that head or a newer one, unless this node's policy refuses the peer or cannot be asked.
 * - Two heads sent one after the other are at most half the lineage window apart. When a newer
 *   head would be further than that from the head sent before it, the waiting head is kept as a
 *   checkpoint and sent first.
 *
 * A head kept for either reason waits in memory, so there is a limit to them. Past the limit the
 * newest head replaces the waiting one all the same, and the scope's next fan-out says so
 * (`checkpointCapacityExceeded`): peers of the replaced head may have been left out, and a
 * receiver that the newest head leaves more than a lineage window behind cannot apply it, as if it
 * had been away for that many changes.
 *
 * A scope here is one policy generation of one author catalog. A graph authored before its
 * registration has an owner-signed catalog and, after it, a catalog of the registered generation.
 * On the wire both carry the same graph, author and era, but their versions are numbered
 * independently, so they are never compared with each other.
 *
 * A committed head does not reach a peer in these cases, and each is reported: it was not handed
 * off or not queued (the receipt says why); the head could not be fanned out when its turn came (its
 * policy is no longer the accepted one, the service is not started, the host could not run the
 * fan-out); the owner closed first; the peer was refused, could not be checked or did not take
 * the head; the scope ran out of places. Such a peer converges with the scope's next head or
 * through connect-time replay, which sends the current head of each scope.
 *
 * Nothing is persisted here and no refusal is remembered: every fan-out asks the current policy
 * again, and the transport asks once more immediately before and after each send.
 *
 * An owner runs in the async context this object was constructed in, never in the context of the
 * mutation that handed the head off: that caller's request deadline, cancellation and work
 * priority end with the caller, and a delivery outlives it.
 *
 * Bounds: one fan-out and at most {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1}
 * waiting heads per scope (the newest, and heads kept before it only when a backlog is that deep
 * or names that many peers), at most
 * {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_CHECKPOINTS_V1} kept heads in all scopes together, at
 * most {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1} scopes, and
 * {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1} hand-off fan-outs selecting peers and
 * starting sends at a time. A fan-out has a deadline for selecting its peers and one time budget
 * for all its sends. `close` aborts every fan-out and resolves when the last send has settled; it
 * does not wait for a policy read that is still in flight.
 */

import { AsyncResource } from 'node:async_hooks';

import { RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 } from './catalog-head-lineage-v1.js';
import {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
  snapshotRfc64RemoteCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';
import {
  Rfc64CatalogHeadFanoutV1,
  describeRfc64CatalogHeadSendsV1,
  type AnnounceRfc64PublicCatalogHeadResultV1,
  type Rfc64CatalogHeadFanoutPortsV1,
  type Rfc64CatalogHeadSendV1,
} from './public-catalog-head-fanout-v1.js';
import {
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  parseRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

export type { AnnounceRfc64PublicCatalogHeadResultV1 };

/** Catalog scopes that may hold a head waiting for its fan-out. */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1 = 1_024;
/**
 * The most versions between two heads sent one after the other: half of what a receiver can prove
 * its way across. A newer head replaces the waiting one only while it stays this close to the head
 * sent before it.
 */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1 =
  RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 / 2;
/**
 * Waiting heads one scope may hold: the newest, and the heads kept before it. A second one is
 * needed only by a backlog of more than {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1}
 * versions, or by one that names more peers than a fan-out addresses, so this many cover a scope
 * whose changes are 65,536 versions ahead of its last fan-out. Past that the newest waiting head
 * is replaced whatever it costs, and the scope's next fan-out reports it.
 */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1 = 64;
/**
 * Kept heads (checkpoints, and heads waiting for peers a newer head had no room for) all scopes
 * may hold together. Every scope keeps a place for its newest head; this keeps many deep backlogs
 * from adding up.
 */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_CHECKPOINTS_V1 = 4_096;
/**
 * Hand-off fan-outs that select their peers and start their sends at once; further scopes wait
 * their turn with their newest head. A fan-out that has started every send gives its turn back:
 * waiting for a peer that does not answer never holds another scope's delivery.
 */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 = 4;
const CLOSED_MESSAGE_V1 = 'RFC-64 catalog head delivery closed';

export interface DeliverRfc64PublicCatalogHeadInputV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Unique peer IDs, at most RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1. An empty list: nobody. */
  readonly peers: readonly string[];
}

/**
 * What a hand-off did with the head. It says nothing about delivery: the fan-out runs later and
 * reports through {@link Rfc64CatalogHeadDeliveryOptionsV1.onDelivered}.
 */
export interface Rfc64CatalogHeadHandoffV1 {
  /**
   * - `queued`: the scope's owner sends this head to these peers, or a newer one handed off before
   *   its turn.
   * - `nobody`: the peer list is empty once this node is removed from it.
   * - `not-queued`: nobody took the head; `reason` says why. The head stays durable and reaches
   *   peers with the scope's next head or through replay.
   */
  readonly status: 'queued' | 'nobody' | 'not-queued';
  /**
   * Why a head was not queued: the owner is `closed`, every scope slot is taken (`full`), the
   * input is malformed (`invalid`), there is no service to take it (`unavailable`), or its
   * mutation's caller had given up by the time the head was durable (`cancelled`).
   */
  readonly reason?: 'closed' | 'full' | 'invalid' | 'unavailable' | 'cancelled';
}

const HANDOFF_QUEUED_V1: Rfc64CatalogHeadHandoffV1 = Object.freeze({ status: 'queued' });
const HANDOFF_NOBODY_V1: Rfc64CatalogHeadHandoffV1 = Object.freeze({ status: 'nobody' });
const notQueuedV1 = (
  reason: NonNullable<Rfc64CatalogHeadHandoffV1['reason']>,
): Rfc64CatalogHeadHandoffV1 => Object.freeze({ status: 'not-queued', reason });
const HANDOFF_CLOSED_V1 = notQueuedV1('closed');
const HANDOFF_FULL_V1 = notQueuedV1('full');
const HANDOFF_INVALID_V1 = notQueuedV1('invalid');
/** The receipt of a hand-off made while there is no service to take it. */
export const RFC64_CATALOG_HEAD_HANDOFF_UNAVAILABLE_V1 = notQueuedV1('unavailable');
/** What a mutation reports instead of a hand-off when its caller gave up after the commit. */
export const RFC64_CATALOG_HEAD_HANDOFF_CANCELLED_V1 = notQueuedV1('cancelled');

/** One finished fan-out of a handed-off head. */
export interface Rfc64CatalogHeadDeliveryOutcomeV1 extends AnnounceRfc64PublicCatalogHeadResultV1 {
  /** Peers this node's own policy refused when the fan-out ran. Nothing was sent to them. */
  readonly refusedPeers: readonly string[];
  /**
   * Peers this node could not check: its policy decision did not answer, because a lookup failed
   * or came back empty-handed, or not in time. Nothing was sent to them. This is not a refusal.
   */
  readonly uncheckedPeers: readonly string[];
  /**
   * Peers the head was sent to while they were authorized, whose authorization this node could
   * not confirm once the send had finished: it had ended, or could not be checked.
   */
  readonly unconfirmedPeers: readonly string[];
  /** Earlier heads of the scope replaced before they were sent, since its last fan-out. */
  readonly supersededHeads: number;
  /**
   * True when, since the scope's last fan-out, a waiting head was replaced although it should
   * have been kept and no place was free: more versions than a receiver can prove its way across
   * may now lie between two sent heads of this scope, or peers of the replaced head were left out.
   */
  readonly checkpointCapacityExceeded: boolean;
  readonly durationMs: number;
  /**
   * Why the head was not fanned out at all: its policy is no longer accepted, the service is not
   * started, the owner closed, or the host could not run the fan-out.
   */
  readonly notDeliverable: string | null;
}

export interface Rfc64CatalogHeadDeliveryOptionsV1
  extends Omit<Rfc64CatalogHeadFanoutPortsV1, 'now'> {
  /** Throws when a handed-off head may not be fanned out now. Runs when its fan-out starts. */
  readonly assertDeliverable: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeers: readonly string[],
  ) => void;
  /** Local libp2p identity, removed from every peer list. */
  readonly localPeerId?: string;
  /** Diagnostic-only observer of every finished hand-off fan-out. */
  readonly onDelivered?: (outcome: Rfc64CatalogHeadDeliveryOutcomeV1) => void;
  /**
   * Runs each hand-off fan-out, so its host can choose the lanes that the fan-out's own policy
   * reads take. Defaults to calling it directly.
   */
  readonly runFanout?: (fanout: () => Promise<void>) => Promise<void>;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
  /** Override of {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1}. */
  readonly maxWaitingHeadsPerScope?: number;
  /** Override of {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_CHECKPOINTS_V1}. */
  readonly maxCheckpoints?: number;
}

interface WaitingHeadV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly peers: readonly string[];
}

interface ScopeDeliveryV1 {
  /** Oldest first. The last one is the newest head; the ones before it are kept heads. */
  readonly waiting: WaitingHeadV1[];
  /** Version of the head sent last, or of the one before the first head this owner was given. */
  sentVersion: bigint;
  superseded: number;
  checkpointCapacityExceeded: boolean;
  run: Promise<void> | null;
}

/** What a fan-out's report takes from the scope: counted since the scope's last fan-out. */
type ScopeCountsV1 = Pick<
  Rfc64CatalogHeadDeliveryOutcomeV1,
  'supersededHeads' | 'checkpointCapacityExceeded'
>;

export class Rfc64CatalogHeadDeliveryV1 {
  readonly #options: Rfc64CatalogHeadDeliveryOptionsV1;
  readonly #now: () => number;
  readonly #runFanout: (fanout: () => Promise<void>) => Promise<void>;
  /** The construction-time async context every scope owner starts in. */
  readonly #ownerContext = new AsyncResource('Rfc64CatalogHeadDeliveryV1');
  readonly #lifecycle = new AbortController();
  readonly #fanout: Rfc64CatalogHeadFanoutV1;
  readonly #scopes = new Map<string, ScopeDeliveryV1>();
  readonly #announces = new Set<Promise<unknown>>();
  readonly #turnWaiters: Array<() => void> = [];
  readonly #maxWaitingHeadsPerScope: number;
  readonly #maxCheckpoints: number;
  #activeFanouts = 0;
  /** Kept heads of all scopes together: every waiting head that is not its scope's newest. */
  #checkpoints = 0;

  constructor(options: Rfc64CatalogHeadDeliveryOptionsV1) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#runFanout = options.runFanout ?? ((fanout) => fanout());
    this.#fanout = new Rfc64CatalogHeadFanoutV1({
      send: options.send,
      isPeerAuthorized: options.isPeerAuthorized,
      fanoutBudgetMs: options.fanoutBudgetMs,
      selectionBudgetMs: options.selectionBudgetMs,
      now: this.#now,
    }, this.#lifecycle.signal);
    this.#maxWaitingHeadsPerScope = options.maxWaitingHeadsPerScope
      ?? RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_PER_SCOPE_V1;
    this.#maxCheckpoints = options.maxCheckpoints ?? RFC64_CATALOG_HEAD_DELIVERY_MAX_CHECKPOINTS_V1;
  }

  /** Scopes with a head waiting for, or in, its fan-out. */
  get pendingScopes(): number {
    return this.#scopes.size;
  }

  /**
   * Awaited fan-out to exactly `peers`. The caller has already validated the announcement against
   * the accepted policy. Peers a caller's abort or the close path skipped are not reported.
   */
  async announce(
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    peers: readonly string[],
    signal?: AbortSignal,
  ): Promise<AnnounceRfc64PublicCatalogHeadResultV1> {
    const remotePeers = this.#remotePeers(peers);
    const session = this.#fanout.begin(signal);
    const sending = this.#fanout.sendAll(session, announcement, remotePeers).finally(session.end);
    this.#announces.add(sending);
    try {
      return describeRfc64CatalogHeadSendsV1(announcement, await sending);
    } finally {
      this.#announces.delete(sending);
    }
  }

  /** Hand a durable head to its scope's owner. Synchronous; never throws. */
  deliver(input: DeliverRfc64PublicCatalogHeadInputV1): Rfc64CatalogHeadHandoffV1 {
    let head: WaitingHeadV1;
    try {
      head = Object.freeze({
        announcement: parseRfc64PublicCatalogHeadAnnouncementV1(
          encodeRfc64PublicCatalogHeadAnnouncementV1(input.announcement),
        ),
        peers: this.#remotePeers(input.peers),
      });
    } catch {
      return HANDOFF_INVALID_V1;
    }
    if (head.peers.length === 0) return HANDOFF_NOBODY_V1;
    if (this.#lifecycle.signal.aborted) return HANDOFF_CLOSED_V1;
    const key = scopeKeyV1(head.announcement);
    const version = BigInt(head.announcement.catalogVersion);
    const scope = this.#scopes.get(key);
    if (scope === undefined) {
      if (this.#scopes.size >= RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1) return HANDOFF_FULL_V1;
      const created: ScopeDeliveryV1 = {
        waiting: [head],
        sentVersion: version - 1n,
        superseded: 0,
        checkpointCapacityExceeded: false,
        run: null,
      };
      this.#scopes.set(key, created);
      created.run = this.#ownerContext.runInAsyncScope(() => this.#runScope(key, created));
      return HANDOFF_QUEUED_V1;
    }
    this.#coalesce(scope, head, version);
    return HANDOFF_QUEUED_V1;
  }

  /** Add `head` to a scope whose owner is busy, keeping what the module comment promises. */
  #coalesce(scope: ScopeDeliveryV1, head: WaitingHeadV1, version: bigint): void {
    const { waiting } = scope;
    const newest = waiting.at(-1);
    if (newest === undefined) {
      waiting.push(head);
      return;
    }
    const last = waiting.length - 1;
    const hasPlace = waiting.length < this.#maxWaitingHeadsPerScope
      && this.#checkpoints < this.#maxCheckpoints;
    if (version < BigInt(newest.announcement.catalogVersion)) {
      // Never trade the newest waiting head for an older one handed off late: its peers get the
      // newest instead, and the older head goes only to the peers the newest has no room for.
      const { fits, rest } = mergePeersV1(newest.peers, head.peers);
      waiting[last] = waitingHeadV1(newest, fits);
      if (rest.length > 0 && hasPlace) {
        waiting.splice(last, 0, waitingHeadV1(head, rest));
        this.#checkpoints += 1;
        return;
      }
      if (rest.length > 0) scope.checkpointCapacityExceeded = true;
      scope.superseded += 1;
      return;
    }
    const sentBefore = waiting.length > 1
      ? BigInt(waiting.at(-2)!.announcement.catalogVersion)
      : scope.sentVersion;
    // Replacing the waiting head would put more versions between two sent heads than a receiver
    // is sure to prove its way across: it has to stay as a checkpoint and be sent first.
    const stepTooLarge = version - sentBefore
      > BigInt(RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1);
    const { fits, rest } = mergePeersV1(head.peers, newest.peers);
    if (stepTooLarge || rest.length > 0) {
      if (hasPlace) {
        // A checkpoint keeps its own peers. A head that stays only because the newer one has no
        // room for all its peers keeps just those; the newer head takes the others over.
        if (!stepTooLarge) waiting[last] = waitingHeadV1(newest, rest);
        waiting.push(stepTooLarge ? head : waitingHeadV1(head, fits));
        this.#checkpoints += 1;
        return;
      }
      // No place is left to keep the waiting head. Memory stays bounded and no change waits: the
      // newest head replaces it all the same, and the scope's next fan-out reports it.
      scope.checkpointCapacityExceeded = true;
    }
    waiting[last] = waitingHeadV1(head, fits);
    scope.superseded += 1;
  }

  /** Resolves once no handed-off head is waiting or being sent (tests, shutdown coordination). */
  async whenIdle(): Promise<void> {
    while (this.#scopes.size > 0) {
      await Promise.all([...this.#scopes.values()].map(({ run }) => run));
    }
  }

  /** Abort every fan-out, drop every waiting head, and resolve once all of it has settled. */
  async close(): Promise<void> {
    if (!this.#lifecycle.signal.aborted) {
      for (const scope of this.#scopes.values()) scope.waiting.length = 0;
      this.#lifecycle.abort(new DOMException(CLOSED_MESSAGE_V1, 'AbortError'));
    }
    await Promise.allSettled(this.#announces);
    await this.whenIdle();
  }

  /** The single owner of one scope's deliveries. Never rejects. */
  async #runScope(key: string, scope: ScopeDeliveryV1): Promise<void> {
    try {
      while (scope.waiting.length > 0) {
        await this.#acquireTurn();
        // Read after the wait: a newer head may have replaced the one that asked for the turn,
        // and close may have dropped it.
        const head = scope.waiting.shift();
        // A head that leaves others waiting behind it was a kept head.
        if (scope.waiting.length > 0) this.#checkpoints -= 1;
        const counts: ScopeCountsV1 = {
          supersededHeads: scope.superseded,
          checkpointCapacityExceeded: scope.checkpointCapacityExceeded,
        };
        scope.superseded = 0;
        scope.checkpointCapacityExceeded = false;
        if (head !== undefined) scope.sentVersion = BigInt(head.announcement.catalogVersion);
        let holdsTurn = true;
        const releaseTurn = (): void => {
          if (!holdsTurn) return;
          holdsTurn = false;
          this.#releaseTurn();
        };
        let reported = false;
        const report = (outcome: Rfc64CatalogHeadDeliveryOutcomeV1): void => {
          reported = true;
          try {
            this.#options.onDelivered?.(outcome);
          } catch {
            // Observer failures never own delivery work.
          }
        };
        try {
          if (head !== undefined) {
            await this.#runFanout(() => this.#deliverHead(head, counts, releaseTurn, report));
          }
        } catch (cause) {
          // A host that fails to run the fan-out drops this head only; the owner carries on.
          if (head !== undefined && !reported) {
            report(undeliveredOutcomeV1(head, counts, `the fan-out could not be run: ${
              cause instanceof Error ? cause.message : String(cause)
            }`));
          }
        } finally {
          releaseTurn();
        }
      }
    } finally {
      // Same synchronous run as the loop's last check: no hand-off can fall between them.
      this.#scopes.delete(key);
    }
  }

  /**
   * One fan-out of one head, reported exactly once. `onSendsStarted` is called once every send
   * has been started, which is when the fan-out stops needing its turn.
   */
  async #deliverHead(
    head: WaitingHeadV1,
    counts: ScopeCountsV1,
    onSendsStarted: () => void,
    report: (outcome: Rfc64CatalogHeadDeliveryOutcomeV1) => void,
  ): Promise<void> {
    const startedAt = this.#now();
    const refusedPeers: string[] = [];
    const uncheckedPeers: string[] = [];
    const unconfirmedPeers: string[] = [];
    const reportedSends: Rfc64CatalogHeadSendV1[] = [];
    let notDeliverable: string | null = null;
    const session = { end: (): void => undefined };
    try {
      this.#options.assertDeliverable(head.announcement, head.peers);
      const selection = await this.#fanout.select(head.announcement, head.peers);
      refusedPeers.push(...selection.refused);
      uncheckedPeers.push(...selection.unchecked);
      // The budget is for the peers: it starts with the first send, so a slow local read during
      // selection cannot use up the time an eligible peer has to answer.
      const sending = this.#fanout.begin();
      session.end = sending.end;
      const sends = await this.#fanout.sendAll(
        sending,
        head.announcement,
        selection.eligible,
        onSendsStarted,
      );
      for (const send of sends) {
        if (send.outcome === 'sent') reportedSends.push(send);
        // A send the close path cut short is neither a refusal nor a failed delivery.
        else if (this.#lifecycle.signal.aborted) continue;
        else if (send.outcome === 'refused') refusedPeers.push(send.peerId);
        else if (send.outcome === 'unchecked') uncheckedPeers.push(send.peerId);
        else if (send.outcome === 'unconfirmed') unconfirmedPeers.push(send.peerId);
        else reportedSends.push(send);
      }
      if (this.#lifecycle.signal.aborted) notDeliverable = CLOSED_MESSAGE_V1;
    } catch (error) {
      notDeliverable = error instanceof Error ? error.message : String(error);
    } finally {
      session.end();
    }
    report(Object.freeze({
      ...describeRfc64CatalogHeadSendsV1(head.announcement, reportedSends),
      refusedPeers: Object.freeze(refusedPeers),
      uncheckedPeers: Object.freeze(uncheckedPeers),
      unconfirmedPeers: Object.freeze(unconfirmedPeers),
      ...counts,
      durationMs: Math.max(0, this.#now() - startedAt),
      notDeliverable,
    }));
  }

  #remotePeers(peers: readonly string[]): readonly string[] {
    return this.#options.localPeerId === undefined
      ? snapshotRfc64PublicCatalogAnnouncementPeersV1(peers)
      : snapshotRfc64RemoteCatalogAnnouncementPeersV1(peers, this.#options.localPeerId);
  }

  async #acquireTurn(): Promise<void> {
    if (this.#activeFanouts < RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1) {
      this.#activeFanouts += 1;
      return;
    }
    // The releasing fan-out passes its turn on, so the count does not change here.
    await new Promise<void>((resolve) => { this.#turnWaiters.push(resolve); });
  }

  #releaseTurn(): void {
    const next = this.#turnWaiters.shift();
    if (next === undefined) this.#activeFanouts -= 1;
    else next();
  }
}

/** The report of a head that was not fanned out at all. */
function undeliveredOutcomeV1(
  head: WaitingHeadV1,
  counts: ScopeCountsV1,
  notDeliverable: string,
): Rfc64CatalogHeadDeliveryOutcomeV1 {
  return Object.freeze({
    ...describeRfc64CatalogHeadSendsV1(head.announcement, []),
    refusedPeers: Object.freeze([]),
    uncheckedPeers: Object.freeze([]),
    unconfirmedPeers: Object.freeze([]),
    ...counts,
    durationMs: 0,
    notDeliverable,
  });
}

/**
 * One policy generation of one author catalog. The policy digest is part of the key because two
 * generations of a graph share every other announced field and number their versions separately.
 */
function scopeKeyV1(announcement: Rfc64PublicCatalogHeadAnnouncementV1): string {
  return [
    announcement.networkId,
    announcement.contextGraphId,
    announcement.subGraphName ?? '',
    announcement.authorAddress,
    announcement.catalogEra,
    announcement.policyDigest,
  ].join('\n');
}

/**
 * `own` followed by the peers of `more` that are not among them, split at the number of peers one
 * fan-out addresses.
 */
function mergePeersV1(
  own: readonly string[],
  more: readonly string[],
): { readonly fits: readonly string[]; readonly rest: readonly string[] } {
  const all = [...new Set([...own, ...more])];
  return {
    fits: all.slice(0, RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1),
    rest: all.slice(RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1),
  };
}

/** `head` for exactly `peers`. */
function waitingHeadV1(head: WaitingHeadV1, peers: readonly string[]): WaitingHeadV1 {
  const unchanged = peers.length === head.peers.length
    && peers.every((peerId, index) => peerId === head.peers[index]);
  return unchanged
    ? head
    : Object.freeze({ announcement: head.announcement, peers: Object.freeze([...peers]) });
}
