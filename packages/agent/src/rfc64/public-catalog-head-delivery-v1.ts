// SPDX-License-Identifier: Apache-2.0

/**
 * Outbound delivery of author-catalog head announcements, owned by the public catalog service.
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
 * - The peers of a replaced head are carried over to the head that replaces it, so every peer a
 *   hand-off named is sent that head or a newer one.
 * - Two heads sent one after the other are at most half the lineage window apart. When a newer
 *   head would be further than that from the head sent before it, the waiting head is kept as a
 *   checkpoint and sent first.
 *
 * A scope here is one policy generation of one author catalog. A graph authored before its
 * registration has an owner-signed catalog and, after it, a catalog of the registered generation.
 * On the wire both carry the same graph, author and era, but their versions are numbered
 * independently, so they are never compared with each other.
 *
 * A peer that missed an announcement converges through connect-time replay, which sends the
 * current head of each scope.
 *
 * Nothing is persisted here and no refusal is remembered: every fan-out asks the current policy
 * again, and the transport asks once more immediately before and after each send.
 *
 * An owner runs in the async context this object was constructed in, never in the context of the
 * mutation that handed the head off: that caller's request deadline, cancellation and work
 * priority end with the caller, and a delivery outlives it.
 *
 * Bounds: one fan-out and at most {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_V1}
 * waiting heads per scope (the newest, and checkpoints only when a backlog is that deep), at most
 * {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1} scopes,
 * {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1} hand-off fan-outs selecting peers and
 * starting sends at a time, sends started in waves of
 * {@link RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1}, and one time budget for all the sends of a
 * fan-out, counted from its first send. A fan-out owns one abort controller and one budget timer
 * that every send of it shares; no signal is composed per send. Selecting the peers is this node's
 * own reads, each bounded by its store or chain deadline, and is not counted against the budget.
 * `close` aborts every fan-out and resolves when the last one has settled.
 */

import { AsyncResource } from 'node:async_hooks';

import type { SendOptions } from '@origintrail-official/dkg-core';

import type {
  Rfc64CatalogAccessAuthorizationInputV1,
  Rfc64CatalogAccessAuthorizationV1,
} from './catalog-access-policy-v1.js';
import { RFC64_CATALOG_HEAD_LINEAGE_WINDOW_V1 } from './catalog-head-lineage-v1.js';
import {
  RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1,
  snapshotRfc64PublicCatalogAnnouncementPeersV1,
  snapshotRfc64RemoteCatalogAnnouncementPeersV1,
} from './catalog-peers-v1.js';
import {
  Rfc64PublicCatalogTransportErrorV1,
  encodeRfc64PublicCatalogHeadAnnouncementV1,
  parseRfc64PublicCatalogHeadAnnouncementV1,
  type Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';
import { mapWithConcurrency } from '../map-with-concurrency.js';

/** Sends a fan-out starts together. */
export const RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1 = 16;
/**
 * The next wave starts when the previous one has settled, or after this long when it has not, so
 * a peer that never answers holds back the peers of later waves by at most this much per wave and
 * never the peers of its own wave. All sends still end with the fan-out's one budget.
 */
export const RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1 = 1_000;
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
 * Waiting heads one scope may hold: the newest, and the checkpoints before it. Only a backlog of
 * more than {@link RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1} versions needs a second one.
 * Past this many the newest waiting head is replaced whatever the distance: memory stays bounded.
 */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_V1 = 4;
/**
 * Hand-off fan-outs that select their peers and start their sends at once; further scopes wait
 * their turn with their newest head. A fan-out that has started every send gives its turn back:
 * waiting for a peer that does not answer never holds another scope's delivery.
 */
export const RFC64_CATALOG_HEAD_DELIVERY_MAX_ACTIVE_FANOUTS_V1 = 4;
/**
 * Local policy decisions in flight at once while a hand-off fan-out selects its peers. For a
 * private graph one decision reads this node's store several times and, when the graph is
 * registered on chain, the chain once. A few at a time let identical chain reads that are in
 * flight together be shared, without queueing a burst of store reads.
 */
const ELIGIBILITY_CONCURRENCY_V1 = 4;
const CLOSED_MESSAGE_V1 = 'RFC-64 catalog head delivery closed';

export interface AnnounceRfc64PublicCatalogHeadResultV1 {
  /** Validated immutable snapshot used for every delivery attempt. */
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Input-order peers that returned the exact transport ACK. */
  readonly announcedPeers: readonly string[];
  /**
   * Input-order peers whose attempt threw, returned a non-ACK, or was not reached before the
   * budget ended; `code` classifies typed failures.
   */
  readonly failedPeers: ReadonlyArray<{
    readonly peerId: string;
    readonly error: string;
    readonly code?: Rfc64PublicCatalogTransportErrorV1['code'];
  }>;
}

export interface DeliverRfc64PublicCatalogHeadInputV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Unique peer IDs, at most RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1. An empty list: nobody. */
  readonly peers: readonly string[];
}

/**
 * What a hand-off did. Nothing is delivered at hand-off, so both peer lists are empty; the
 * fan-out reports through {@link Rfc64CatalogHeadDeliveryOptionsV1.onDelivered}.
 */
export interface Rfc64CatalogHeadHandoffV1 extends AnnounceRfc64PublicCatalogHeadResultV1 {
  /**
   * - `queued`: the scope's owner sends this head to these peers, or a newer one handed off before
   *   its turn.
   * - `nobody`: the peer list is empty once this node is removed from it.
   * - `not-queued`: the owner is closed, every scope slot is taken, or the input is malformed. The
   *   head stays durable and reaches peers through replay.
   */
  readonly status: 'queued' | 'nobody' | 'not-queued';
}

/** One finished fan-out of a handed-off head. */
export interface Rfc64CatalogHeadDeliveryOutcomeV1 extends AnnounceRfc64PublicCatalogHeadResultV1 {
  /** Peers this node's own policy refused when the fan-out ran. Nothing was sent to them. */
  readonly refusedPeers: readonly string[];
  /** Earlier heads of the scope replaced before they were sent, since its last fan-out. */
  readonly supersededHeads: number;
  readonly durationMs: number;
  /** Why the head was not fanned out at all, for example its policy is no longer accepted. */
  readonly notDeliverable: string | null;
}

export interface Rfc64CatalogHeadDeliveryOptionsV1 {
  /** One announcement to one peer through the head transport, which rechecks the policy there. */
  readonly send: (
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    sendOptions: SendOptions,
  ) => Promise<void>;
  /** The authorizer the head transport itself asks; `null` is a refusal. */
  readonly authorize: (
    input: Rfc64CatalogAccessAuthorizationInputV1,
  ) => Promise<Rfc64CatalogAccessAuthorizationV1 | null>;
  /** Throws when a handed-off head may not be fanned out now. Runs when its fan-out starts. */
  readonly assertDeliverable: (
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    remotePeers: readonly string[],
  ) => void;
  /** Local libp2p identity, removed from every peer list. */
  readonly localPeerId?: string;
  /** Time budget of the sends of one whole fan-out, from the first send (ms). */
  readonly fanoutBudgetMs: number;
  /** Diagnostic-only observer of every finished hand-off fan-out. */
  readonly onDelivered?: (outcome: Rfc64CatalogHeadDeliveryOutcomeV1) => void;
  /**
   * Runs each hand-off fan-out, so its host can choose the lanes that the fan-out's own policy
   * reads take. Defaults to calling it directly.
   */
  readonly runFanout?: (fanout: () => Promise<void>) => Promise<void>;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
}

interface WaitingHeadV1 {
  readonly announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  readonly peers: readonly string[];
}

interface ScopeDeliveryV1 {
  /** Oldest first. The last one is the newest head; the ones before it are checkpoints. */
  readonly waiting: WaitingHeadV1[];
  /** Version of the head sent last, or of the one before the first head this owner was given. */
  sentVersion: bigint;
  superseded: number;
  run: Promise<void> | null;
}

type PeerAttemptV1 = Readonly<
  | { peerId: string; sent: true }
  | { peerId: string; sent: false; failure: unknown }
>;

interface FanoutSessionV1 {
  /** Aborts when the budget ends, the owner closes, or the awaiting caller's signal aborts. */
  readonly signal: AbortSignal;
  remainingMs(): number;
  /** True when the budget, not the close path or a caller, ended the fan-out. */
  budgetEnded(): boolean;
  end(): void;
}

export class Rfc64CatalogHeadDeliveryV1 {
  readonly #options: Rfc64CatalogHeadDeliveryOptionsV1;
  readonly #now: () => number;
  readonly #runFanout: (fanout: () => Promise<void>) => Promise<void>;
  /** The construction-time async context every scope owner starts in. */
  readonly #ownerContext = new AsyncResource('Rfc64CatalogHeadDeliveryV1');
  readonly #lifecycle = new AbortController();
  readonly #scopes = new Map<string, ScopeDeliveryV1>();
  readonly #announces = new Set<Promise<unknown>>();
  readonly #turnWaiters: Array<() => void> = [];
  #activeFanouts = 0;

  constructor(options: Rfc64CatalogHeadDeliveryOptionsV1) {
    this.#options = options;
    this.#now = options.now ?? (() => performance.now());
    this.#runFanout = options.runFanout ?? ((fanout) => fanout());
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
    const session = this.#beginFanout(signal);
    const sending = this.#sendAll(session, announcement, remotePeers).finally(session.end);
    this.#announces.add(sending);
    try {
      return describeAttemptsV1(announcement, await sending);
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
      return rfc64CatalogHeadHandoffV1('not-queued', input?.announcement);
    }
    if (head.peers.length === 0) return rfc64CatalogHeadHandoffV1('nobody', head.announcement);
    if (this.#lifecycle.signal.aborted) {
      return rfc64CatalogHeadHandoffV1('not-queued', head.announcement);
    }
    const key = scopeKeyV1(head.announcement);
    const version = BigInt(head.announcement.catalogVersion);
    const scope = this.#scopes.get(key);
    if (scope === undefined) {
      if (this.#scopes.size >= RFC64_CATALOG_HEAD_DELIVERY_MAX_SCOPES_V1) {
        return rfc64CatalogHeadHandoffV1('not-queued', head.announcement);
      }
      const created: ScopeDeliveryV1 = {
        waiting: [head],
        sentVersion: version - 1n,
        superseded: 0,
        run: null,
      };
      this.#scopes.set(key, created);
      created.run = this.#ownerContext.runInAsyncScope(() => this.#runScope(key, created));
      return rfc64CatalogHeadHandoffV1('queued', head.announcement);
    }
    this.#coalesce(scope, head, version);
    return rfc64CatalogHeadHandoffV1('queued', head.announcement);
  }

  /** Add `head` to a scope whose owner is busy, keeping what the module comment promises. */
  #coalesce(scope: ScopeDeliveryV1, head: WaitingHeadV1, version: bigint): void {
    const { waiting } = scope;
    const newest = waiting.at(-1);
    if (newest === undefined) {
      waiting.push(head);
      return;
    }
    if (version < BigInt(newest.announcement.catalogVersion)) {
      // Never trade the newest waiting head for an older one handed off late: its peers get the
      // newest instead.
      waiting[waiting.length - 1] = withPeersV1(newest, head.peers);
      scope.superseded += 1;
      return;
    }
    const sentBefore = waiting.length > 1
      ? BigInt(waiting.at(-2)!.announcement.catalogVersion)
      : scope.sentVersion;
    if (
      version - sentBefore > BigInt(RFC64_CATALOG_HEAD_DELIVERY_MAX_VERSION_STEP_V1)
      && waiting.length < RFC64_CATALOG_HEAD_DELIVERY_MAX_WAITING_HEADS_V1
    ) {
      // Replacing the waiting head would put more versions between two sent heads than a
      // receiver is sure to prove its way across: keep it as a checkpoint and send it first.
      waiting.push(head);
      return;
    }
    waiting[waiting.length - 1] = withPeersV1(head, newest.peers);
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
        const superseded = scope.superseded;
        scope.superseded = 0;
        if (head !== undefined) scope.sentVersion = BigInt(head.announcement.catalogVersion);
        let holdsTurn = true;
        const releaseTurn = (): void => {
          if (!holdsTurn) return;
          holdsTurn = false;
          this.#releaseTurn();
        };
        try {
          if (head !== undefined) {
            await this.#runFanout(() => this.#deliverHead(head, superseded, releaseTurn));
          }
        } catch {
          // A host that fails to run the fan-out drops this head only; the owner carries on.
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
   * One fan-out of one head. `onSendsStarted` is called once every send has been started, which
   * is when the fan-out stops needing its turn.
   */
  async #deliverHead(
    head: WaitingHeadV1,
    supersededHeads: number,
    onSendsStarted: () => void,
  ): Promise<void> {
    const startedAt = this.#now();
    const refusedPeers: string[] = [];
    const delivered: PeerAttemptV1[] = [];
    let notDeliverable: string | null = null;
    let session: FanoutSessionV1 | undefined;
    try {
      this.#options.assertDeliverable(head.announcement, head.peers);
      const decisions = await mapWithConcurrency(
        head.peers,
        ELIGIBILITY_CONCURRENCY_V1,
        // Once the owner is closing, no further decision is worth a read.
        async (peerId) => (
          this.#lifecycle.signal.aborted
            ? null
            : this.#isLocallyAuthorized(peerId, head.announcement)
        ),
      );
      const eligible = head.peers.filter((peerId, index) => {
        if (decisions[index] === false) refusedPeers.push(peerId);
        return decisions[index] === true;
      });
      // The budget is for the peers: it starts with the first send, so a slow local read during
      // selection cannot use up the time an eligible peer has to answer.
      session = this.#beginFanout();
      const attempts = await this.#sendAll(session, head.announcement, eligible, onSendsStarted);
      for (const attempt of attempts) {
        if (attempt.sent) {
          delivered.push(attempt);
          continue;
        }
        // A send the close path cut short is neither a refusal nor a failed delivery.
        if (this.#lifecycle.signal.aborted) continue;
        // A policy denial at send time is either the transport's own recheck (the peer stopped
        // being authorized after selection, and nothing was sent) or the remote peer's answer.
        // The current local decision tells them apart.
        if (
          attempt.failure instanceof Rfc64PublicCatalogTransportErrorV1
          && attempt.failure.code === 'catalog-transport-policy-denied'
          && !(await this.#isLocallyAuthorized(attempt.peerId, head.announcement))
        ) refusedPeers.push(attempt.peerId);
        else delivered.push(attempt);
      }
      if (this.#lifecycle.signal.aborted) notDeliverable = CLOSED_MESSAGE_V1;
    } catch (error) {
      notDeliverable = error instanceof Error ? error.message : String(error);
    } finally {
      session?.end();
    }
    try {
      this.#options.onDelivered?.(Object.freeze({
        ...describeAttemptsV1(head.announcement, delivered),
        refusedPeers: Object.freeze(refusedPeers),
        supersededHeads,
        durationMs: Math.max(0, this.#now() - startedAt),
        notDeliverable,
      }));
    } catch {
      // Observer failures never own delivery work.
    }
  }

  /** Sends in bounded waves under the session's one budget. Never rejects. */
  async #sendAll(
    session: FanoutSessionV1,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
    peers: readonly string[],
    onSendsStarted?: () => void,
  ): Promise<PeerAttemptV1[]> {
    // Filled by index as each send settles; every index below `next` is filled once all have.
    const attempts: PeerAttemptV1[] = [];
    const attempt = async (index: number): Promise<void> => {
      const peerId = peers[index]!;
      try {
        await this.#options.send(peerId, announcement, {
          timeoutMs: session.remainingMs(),
          signal: session.signal,
        });
        attempts[index] = { peerId, sent: true };
      } catch (failure) {
        attempts[index] = { peerId, sent: false, failure };
      }
    };
    const started: Promise<void>[] = [];
    let next = 0;
    while (next < peers.length && !session.signal.aborted) {
      const wave: Promise<void>[] = [];
      const waveEnd = Math.min(peers.length, next + RFC64_CATALOG_HEAD_FANOUT_WAVE_PEERS_V1);
      for (; next < waveEnd; next += 1) wave.push(attempt(next));
      started.push(...wave);
      if (next < peers.length) {
        await settledOrElapsedV1(wave, RFC64_CATALOG_HEAD_FANOUT_WAVE_INTERVAL_MS_V1);
      }
    }
    onSendsStarted?.();
    await Promise.all(started);
    if (session.budgetEnded()) {
      // Peers the budget ended before were asked for and did not get the head: report them.
      for (; next < peers.length; next += 1) {
        attempts[next] = { peerId: peers[next]!, sent: false, failure: session.signal.reason };
      }
    }
    return attempts.slice(0, next);
  }

  /** One abort controller and one timer for a whole fan-out; sources are followed, not composed. */
  #beginFanout(caller?: AbortSignal): FanoutSessionV1 {
    const budgetMs = this.#options.fanoutBudgetMs;
    const controller = new AbortController();
    const budgetEnded = new DOMException(
      `RFC-64 catalog head fan-out exceeded its ${budgetMs} ms budget`,
      'TimeoutError',
    );
    const deadlineAt = this.#now() + budgetMs;
    const timer = setTimeout(() => controller.abort(budgetEnded), budgetMs);
    timer.unref?.();
    const detachers: Array<() => void> = [];
    for (const source of [this.#lifecycle.signal, caller]) {
      if (source === undefined) continue;
      if (source.aborted) {
        controller.abort(source.reason);
        continue;
      }
      const onAbort = (): void => controller.abort(source.reason);
      source.addEventListener('abort', onAbort, { once: true });
      detachers.push(() => source.removeEventListener('abort', onAbort));
    }
    return {
      signal: controller.signal,
      remainingMs: () => Math.max(1, Math.ceil(deadlineAt - this.#now())),
      budgetEnded: () => controller.signal.reason === budgetEnded,
      end: () => {
        clearTimeout(timer);
        for (const detach of detachers.splice(0)) detach();
      },
    };
  }

  /** The decision the head transport makes before a send, without sending. Never cached. */
  async #isLocallyAuthorized(
    remotePeerId: string,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): Promise<boolean> {
    try {
      const authorization = await this.#options.authorize(Object.freeze({
        operation: 'announce-outbound',
        remotePeerId,
        networkId: announcement.networkId,
        contextGraphId: announcement.contextGraphId,
        policyDigest: announcement.policyDigest,
      }));
      return authorization !== null
        && (authorization.accessPolicy === 0 || authorization.accessPolicy === 1)
        && authorization.policyDigest === announcement.policyDigest;
    } catch {
      return false;
    }
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

/** Resolves when every promise of `wave` has settled or `intervalMs` has passed, whichever first. */
async function settledOrElapsedV1(
  wave: readonly Promise<void>[],
  intervalMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, intervalMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all(wave), elapsed]);
  } finally {
    clearTimeout(timer);
  }
}

const NO_PEERS_V1: readonly never[] = Object.freeze([]);

/** The receipt of a hand-off: nothing has been delivered yet, whatever its status. */
export function rfc64CatalogHeadHandoffV1(
  status: Rfc64CatalogHeadHandoffV1['status'],
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
): Rfc64CatalogHeadHandoffV1 {
  return Object.freeze({
    status,
    announcement,
    announcedPeers: NO_PEERS_V1,
    failedPeers: NO_PEERS_V1,
  });
}

function describeAttemptsV1(
  announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  attempts: readonly PeerAttemptV1[],
): AnnounceRfc64PublicCatalogHeadResultV1 {
  const announcedPeers: string[] = [];
  const failedPeers: Array<AnnounceRfc64PublicCatalogHeadResultV1['failedPeers'][number]> = [];
  for (const attempt of attempts) {
    if (attempt.sent) {
      announcedPeers.push(attempt.peerId);
      continue;
    }
    const { failure } = attempt;
    // Classify where the typed error still exists: the message is display text only.
    failedPeers.push(Object.freeze({
      peerId: attempt.peerId,
      error: failure instanceof Error ? failure.message : String(failure),
      ...(failure instanceof Rfc64PublicCatalogTransportErrorV1 ? { code: failure.code } : {}),
    }));
  }
  return Object.freeze({
    announcement,
    announcedPeers: Object.freeze(announcedPeers),
    failedPeers: Object.freeze(failedPeers),
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

/** `head` with the peers of a head it stands in for added after its own, up to the wire limit. */
function withPeersV1(head: WaitingHeadV1, morePeers: readonly string[]): WaitingHeadV1 {
  const peers = [...new Set([...head.peers, ...morePeers])]
    .slice(0, RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1);
  return peers.length === head.peers.length
    ? head
    : Object.freeze({ announcement: head.announcement, peers: Object.freeze(peers) });
}
