// SPDX-License-Identifier: Apache-2.0

/**
 * The targets of the announced-head lane of the catalog service: when the lane
 * pulls a retained head again, how long a head it gave up on stays quiet, and
 * how a retained target is merged, evicted, or found satisfied by a hint.
 *
 * A pass that leaves an announced head unapplied keeps it for a re-pull. When
 * no provider serves the head, every pass finds the same older head, and the
 * receiver may replay that head under a receiver lease of its graph (a graph
 * with a late legacy SWM marker replays its applied head). Pulled at a fixed
 * interval, such a head took a node-wide lease turn every few seconds for
 * its whole budget, and the next re-announcement of the same head, on a
 * connect or a scoped replay, started a fresh budget. So:
 * - the delay before a re-pull doubles with each pass the head stayed
 *   unapplied, from the configured interval up to
 *   {@link RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1};
 * - a head whose budget ran out stays quiet for
 *   {@link RFC64_ANNOUNCED_HEAD_QUIET_MS_V1}: a hint for that exact head from
 *   a provider the lane already tried starts no pull. Any other head of the
 *   scope, and the same head from another provider, is pulled as before. An
 *   announced version is not verified, so it must not silence the scope.
 * The ambient lane still schedules every hint, and the catalog's replay
 * cadence still recovers a head that is served later.
 */

import type { Rfc64PublicCatalogCurrentHeadScopeV1 } from './public-catalog-current-head-discovery-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from './public-catalog-transport-v1.js';
import { rfc64ReceiverHeadKeyV1 } from './public-catalog-receiver-task-lifecycle-v1.js';

/**
 * Delay armed AFTER a re-pull pass completes, before the next pass may start.
 * Not a period: successive passes for a retained head are separated by the
 * pass duration plus at least this interval, doubled for each earlier pass
 * that left the head unapplied.
 */
export const DEFAULT_ANNOUNCED_CURRENT_HEAD_RETRY_INTERVAL_MS_V1 = 5_000;

/**
 * Passes that leave an announced head unapplied before the target is dropped.
 * This bounds attempts, not wall-clock time. A pass is cheap only when it fails
 * fast: against unreachable providers discovery alone spans up to two waves of
 * the transport timeout (20 s at the defaults), and a discovered but not-found
 * head then awaits the receiver's whole failover chain (`maxProvidersPerHead x
 * maxAttempts` reconciles with exponential backoff). With the default interval
 * and the doubling delay, the twelfth pass comes about 15 minutes after the
 * first even when every pass fails instantly; size alerting on the abandoned
 * record accordingly.
 */
export const DEFAULT_ANNOUNCED_CURRENT_HEAD_MAX_PULL_ATTEMPTS_V1 = 12;

/** The longest delay between two re-pulls of one retained head. */
export const RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1 = 120_000;

/** How long hints for a head whose pull budget ran out start no pull. */
export const RFC64_ANNOUNCED_HEAD_QUIET_MS_V1 = 15 * 60_000;

/** Heads remembered as quiet at once; the oldest is forgotten first. */
const MAX_QUIET_HEADS_V1 = 1_024;

export interface Rfc64AnnouncedHeadRetryScheduleOptionsV1 {
  /** Delay before the first re-pull of a head. */
  readonly intervalMs: number;
  readonly maxDelayMs?: number;
  readonly quietMs?: number;
  readonly now?: () => number;
}

export class Rfc64AnnouncedHeadRetryScheduleV1 {
  readonly #intervalMs: number;
  readonly #maxDelayMs: number;
  readonly #quietMs: number;
  readonly #now: () => number;
  /** By exact head identity: the providers that were tried, and until when. */
  readonly #quietByHead = new Map<string, Readonly<{ providers: ReadonlySet<string>; until: number }>>();

  constructor(options: Readonly<Rfc64AnnouncedHeadRetryScheduleOptionsV1>) {
    this.#intervalMs = options.intervalMs;
    this.#maxDelayMs = Math.max(
      options.intervalMs,
      options.maxDelayMs ?? RFC64_ANNOUNCED_HEAD_MAX_RETRY_DELAY_MS_V1,
    );
    this.#quietMs = options.quietMs ?? RFC64_ANNOUNCED_HEAD_QUIET_MS_V1;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Heads that are quiet now or were when last looked at. */
  get quietHeads(): number {
    return this.#quietByHead.size;
  }

  /** Whether a retained head is due for its re-pull now. */
  isDue(retryAt: number): boolean {
    return this.#now() >= retryAt;
  }

  /** When a head that `attempts` passes left unapplied is pulled next. */
  retryAt(attempts: number): number {
    const doublings = Math.min(Math.max(0, attempts - 1), 30);
    return this.#now() + Math.min(this.#maxDelayMs, this.#intervalMs * 2 ** doublings);
  }

  /**
   * The lane spent its pull budget on this exact head, pulled from these
   * providers. Providers of an earlier budget that are still quiet stay so.
   */
  quiet(
    announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
    providers: Iterable<string>,
  ): void {
    const head = exactHeadIdentityV1(announcement);
    const earlier = this.#quietByHead.get(head);
    const stillQuiet = earlier !== undefined && this.#now() < earlier.until ? earlier.providers : [];
    this.#quietByHead.delete(head);
    if (this.#quietByHead.size >= MAX_QUIET_HEADS_V1) {
      const oldest = this.#quietByHead.keys().next().value;
      if (oldest !== undefined) this.#quietByHead.delete(oldest);
    }
    this.#quietByHead.set(head, Object.freeze({
      providers: new Set([...stillQuiet, ...providers]),
      until: this.#now() + this.#quietMs,
    }));
  }

  /** True while hints for this exact head from every one of these providers start no pull. */
  isQuietFromAll(
    announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
    providers: Iterable<string>,
  ): boolean {
    for (const provider of providers) {
      if (!this.isQuiet(announcement, provider)) return false;
    }
    return true;
  }

  /** True while a hint for this exact head from this provider must start no pull. */
  isQuiet(
    announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
    remotePeerId: string,
  ): boolean {
    const head = exactHeadIdentityV1(announcement);
    const quiet = this.#quietByHead.get(head);
    if (quiet === undefined) return false;
    if (this.#now() >= quiet.until) {
      this.#quietByHead.delete(head);
      return false;
    }
    return quiet.providers.has(remotePeerId);
  }
}

/** One announced scope whose current head the lane pulls. */
export interface AnnouncedCurrentHeadTargetV1 {
  readonly scope: Readonly<Rfc64PublicCatalogCurrentHeadScopeV1>;
  readonly remotePeerIds: Set<string>;
  /** Highest policy-admitted announcement for the scope; drives the applied check. */
  announcement: Rfc64PublicCatalogHeadAnnouncementV1;
  /** Completed acceleration passes that left `announcement` unapplied. */
  attempts: number;
  /** When a retained target is due for its re-pull; 0 for one never pulled. */
  retryAt: number;
  /**
   * A hint has asked for a pull this target has not had yet. Cleared when a
   * pass takes the target, and NOT set again when the pass retains it: the
   * timed re-pull is the lane's own business, not work a caller is waiting on.
   */
  pullRequested: boolean;
}

/**
 * Re-insert a target the pass left unapplied. It merges into any fresher hint
 * that arrived during the pass; otherwise it must fit under `maxScopes`, which
 * admission enforced only against the targets the pass took, so fresh hints
 * may have refilled the map meanwhile. Retained work is older than any fresh
 * hint: when the map is full the most-attempted retained entry yields
 * (`onEvicted`), and an entry the lane has not pulled yet never does. Returns
 * false when this target is the one that yields.
 */
export function retainAnnouncedCurrentHeadTargetV1(
  targets: Map<string, AnnouncedCurrentHeadTargetV1>,
  key: string,
  target: AnnouncedCurrentHeadTargetV1,
  limits: Readonly<{ maxScopes: number; maxProviders: number }>,
  onEvicted: (victim: AnnouncedCurrentHeadTargetV1) => void,
): boolean {
  const current = targets.get(key);
  if (current !== undefined) {
    const order = compareCatalogVersionsV1(
      current.announcement.catalogVersion,
      target.announcement.catalogVersion,
    );
    // A hint that came during the pass with neither a newer head nor another
    // provider repeats what this pass pulled: the target keeps its delay.
    if (order <= 0 && [...current.remotePeerIds].every((peerId) => target.remotePeerIds.has(peerId))) {
      current.pullRequested = false;
      current.retryAt = target.retryAt;
    }
    for (const remotePeerId of target.remotePeerIds) {
      if (current.remotePeerIds.size >= limits.maxProviders) break;
      current.remotePeerIds.add(remotePeerId);
    }
    if (order < 0) {
      current.announcement = target.announcement;
      current.attempts = target.attempts;
    } else if (order === 0) {
      current.attempts = Math.max(current.attempts, target.attempts);
    }
    return true;
  }
  if (targets.size >= limits.maxScopes) {
    // `attempts` is 0 exactly for an entry never pulled, and this target has
    // at least one, so a fresh hint can never be selected here.
    let victim: [string, AnnouncedCurrentHeadTargetV1] | undefined;
    let victimAttempts = target.attempts;
    for (const entry of targets) {
      if (entry[1].attempts > victimAttempts) {
        victim = entry;
        victimAttempts = entry[1].attempts;
      }
    }
    if (victim === undefined) return false;
    targets.delete(victim[0]);
    onEvicted(victim[1]);
  }
  targets.set(key, target);
  return true;
}

/**
 * Whether a hint whose head is known to be satisfied satisfies a retained
 * target of its scope as well: no hint has asked for the target since its
 * last pull, and the hint names a newer version of the scope (the durable head
 * supersedes the target) or exactly the target's head.
 */
export function hintSettlesRetainedAnnouncedHeadV1(
  target: Readonly<AnnouncedCurrentHeadTargetV1>,
  announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
): boolean {
  if (target.pullRequested) return false;
  const order = compareCatalogVersionsV1(
    announcement.catalogVersion,
    target.announcement.catalogVersion,
  );
  return order > 0
    || (order === 0 && exactHeadIdentityV1(announcement) === exactHeadIdentityV1(target.announcement));
}

/** Every field that names one exact head: the receiver's own exact-head key. */
export function exactHeadIdentityV1(
  announcement: Readonly<Rfc64PublicCatalogHeadAnnouncementV1>,
): string {
  return rfc64ReceiverHeadKeyV1(announcement);
}

/** A retained re-pull target dropped so the announced-scope map stays under its cap. */
export function announcedCurrentHeadRetainCapacityErrorV1(cause: unknown): Error {
  return new Error(
    'RFC-64 announced current-head re-pull dropped: retained-scope capacity exhausted',
    cause === null ? {} : { cause },
  );
}

/** Numeric order of two validated decimal catalog versions. */
export function compareCatalogVersionsV1(left: string, right: string): -1 | 0 | 1 {
  const l = BigInt(left);
  const r = BigInt(right);
  return l < r ? -1 : l > r ? 1 : 0;
}

export function announcedCurrentHeadScopeKeyV1(
  scope: Readonly<Rfc64PublicCatalogCurrentHeadScopeV1>,
): string {
  return [
    scope.networkId,
    scope.contextGraphId,
    scope.subGraphName ?? '',
    scope.authorAddress,
    scope.catalogEra,
  ].join('\n');
}
