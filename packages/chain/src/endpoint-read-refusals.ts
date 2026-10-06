// SPDX-License-Identifier: Apache-2.0

/**
 * `EndpointReadRefusals` — remembers which endpoint refused which read, so the
 * read stops starting there.
 *
 * An endpoint can serve most requests and refuse one kind by policy: a public
 * endpoint that answers every receipt lookup with HTTP 403, for example. That
 * refusal says something about the request, not about the endpoint's health.
 * Endpoint stickiness has one preference for all reads, so a read of that kind
 * keeps being sent to the preferred endpoint, is refused, and fails over: one
 * wasted request per read, for as long as the preference points there.
 *
 * This builds the attempts of one pass from the stickiness order, and owns
 * what each outcome means for both memories:
 *
 *  - No endpoint of the pass refused this read: the stickiness order and its
 *    outcome recorders, unchanged.
 *  - An endpoint further down refused it: that endpoint goes last. The endpoint
 *    stickiness starts at is still tried first, so every outcome still means
 *    what it meant, and the recorders are the ones stickiness bound.
 *  - The endpoint stickiness starts at refused it: the pass goes to the others
 *    and tells stickiness nothing. What stickiness learns from a later endpoint
 *    serving a read is that the one it prefers failed, or returned nothing, and
 *    here that one was not asked. Its preference, and whether that preference
 *    is proven for writes, stay as they are. The read keeps its own note of the
 *    endpoint that served it instead and starts there next time.
 *
 * It is ordering only, like the stickiness it sits beside: a refusing endpoint
 * is tried after the others, never dropped, so a pass still reaches every
 * endpoint; and the memory lapses, so an endpoint that serves the read again is
 * used again.
 */

import type { StickyAttempt, StickyEndpoint } from './endpoint-stickiness.js';
import { errorStatus } from './evm-adapter-errors.js';

/** How long a refusal keeps an endpoint behind the others for that read. */
export const ENDPOINT_READ_REFUSAL_TTL_MS = 10 * 60_000;

/** Entries kept. Read labels are code-owned, so this is a ceiling, not a working size. */
export const ENDPOINT_READ_REFUSAL_MAX_ENTRIES = 256;

/**
 * True when the endpoint refused the request itself: HTTP 401 or 403. A
 * throttle (429), a server error or a network failure says nothing about
 * whether the endpoint serves this kind of read.
 */
export function isEndpointPolicyRefusal(err: unknown): boolean {
  const status = errorStatus(err);
  return status === 401 || status === 403;
}

/** One attempt of a read pass: the endpoint to try and what its outcome is recorded as. */
export interface ReadAttempt<T extends StickyEndpoint> {
  readonly endpoint: T;
  /** This endpoint served the read. */
  recordSuccess(): void;
  /** This endpoint failed the read with `error`, and the pass moves on. */
  recordFailure(error: unknown): void;
}

export interface EndpointReadRefusalsConfig {
  /** Monotonic-ish clock (ms). Injected for deterministic tests. */
  now: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

export class EndpointReadRefusals {
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  /** Endpoint URL and read label → when the refusal stops counting. Oldest first. */
  readonly #until = new Map<string, number>();
  /** Read label → the endpoint that last served it in place of the one stickiness starts at. */
  readonly #servedInstead = new Map<string, string>();

  constructor(config: EndpointReadRefusalsConfig) {
    this.#now = config.now;
    this.#ttlMs = config.ttlMs ?? ENDPOINT_READ_REFUSAL_TTL_MS;
    this.#maxEntries = config.maxEntries ?? ENDPOINT_READ_REFUSAL_MAX_ENTRIES;
  }

  /**
   * The attempts of one pass of the read `label`. `preferredFirst` is the
   * stickiness order with its bound outcome recorders. With `remember` false
   * the pass is that order as it stands and nothing is remembered: a
   * tip-sensitive read, or endpoint ordering switched off.
   */
  attempts<T extends StickyEndpoint>(
    label: string,
    preferredFirst: StickyAttempt<T>[],
    remember = true,
  ): ReadAttempt<T>[] {
    if (!remember) {
      return preferredFirst.map((attempt) => ({
        endpoint: attempt.endpoint,
        recordSuccess: () => attempt.recordSuccess(),
        recordFailure: () => attempt.recordFailure(),
      }));
    }
    const bound = (attempt: StickyAttempt<T>): ReadAttempt<T> => ({
      endpoint: attempt.endpoint,
      recordSuccess: () => {
        this.#until.delete(refusalKey(label, attempt.endpoint.rpcUrl));
        attempt.recordSuccess();
      },
      recordFailure: (error) => {
        this.#rememberRefusal(label, attempt.endpoint.rpcUrl, error);
        attempt.recordFailure();
      },
    });
    const refusing = preferredFirst.filter((attempt) => this.#refuses(label, attempt.endpoint.rpcUrl));
    if (refusing.length === 0 || refusing.length === preferredFirst.length) {
      return preferredFirst.map(bound);
    }
    const others = preferredFirst.filter((attempt) => !refusing.includes(attempt));
    if (!refusing.includes(preferredFirst[0]!)) {
      return [...others, ...refusing].map(bound);
    }
    const instead = this.#servedInstead.get(label);
    const first = others.find((attempt) => attempt.endpoint.rpcUrl === instead);
    return [
      ...(first ? [first, ...others.filter((attempt) => attempt !== first)] : others).map(
        (attempt): ReadAttempt<T> => ({
          endpoint: attempt.endpoint,
          recordSuccess: () => this.#rememberServedInstead(label, attempt.endpoint.rpcUrl),
          recordFailure: (error) => {
            this.#rememberRefusal(label, attempt.endpoint.rpcUrl, error);
            if (this.#servedInstead.get(label) === attempt.endpoint.rpcUrl) {
              this.#servedInstead.delete(label);
            }
          },
        }),
      ),
      // Reached only when no other endpoint answered. It is asked like any
      // endpoint stickiness starts at, and recorded like one.
      ...refusing.map(bound),
    ];
  }

  #rememberRefusal(label: string, rpcUrl: string, error: unknown): void {
    if (!isEndpointPolicyRefusal(error)) return;
    this.#put(this.#until, refusalKey(label, rpcUrl), this.#now() + this.#ttlMs);
  }

  #rememberServedInstead(label: string, rpcUrl: string): void {
    this.#put(this.#servedInstead, label, rpcUrl);
  }

  /** Set `key`, most recently seen last, and drop the oldest entries over the ceiling. */
  #put<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > this.#maxEntries) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }

  #refuses(label: string, rpcUrl: string): boolean {
    const key = refusalKey(label, rpcUrl);
    const until = this.#until.get(key);
    if (until === undefined) return false;
    if (this.#now() < until) return true;
    this.#until.delete(key);
    return false;
  }
}

function refusalKey(label: string, rpcUrl: string): string {
  // A URL holds no line break, so the pair cannot be read two ways.
  return `${rpcUrl}\n${label}`;
}
