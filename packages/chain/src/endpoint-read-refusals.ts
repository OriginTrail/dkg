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
 * This owns only refusal classification, expiry, bounded memory and the note
 * of an endpoint that served instead. EndpointStickiness owns the full attempt
 * plan and binds outcomes only after applying these constraints.
 *
 * It supplies ordering constraints only: the ordering owner tries a refusing
 * endpoint after the others, never drops it, and still covers every endpoint.
 * The memory lapses, so an endpoint that serves the read again is used again.
 */

import type { StickyEndpoint } from './endpoint-stickiness.js';
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
  readonly kind: 'ordinary' | 'substitute';
  /** Called only when the transport actually enters this attempt. */
  recordStart(): void;
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

  /** Immutable inputs to the ordering owner; expiry is resolved once per pass. */
  constraints(label: string, rpcUrls: readonly string[]) {
    return {
      refusing: new Set(rpcUrls.filter(rpcUrl => this.#refuses(label, rpcUrl))),
      servedInstead: this.#servedInstead.get(label),
    };
  }

  recordSuccess(label: string, rpcUrl: string, kind: ReadAttempt<StickyEndpoint>['kind']): void {
    if (kind === 'substitute') this.#rememberServedInstead(label, rpcUrl);
    else this.#until.delete(refusalKey(label, rpcUrl));
  }

  recordFailure(label: string, rpcUrl: string, error: unknown, kind: ReadAttempt<StickyEndpoint>['kind']): void {
    this.#rememberRefusal(label, rpcUrl, error);
    if (kind === 'substitute' && this.#servedInstead.get(label) === rpcUrl) {
      this.#servedInstead.delete(label);
    }
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
