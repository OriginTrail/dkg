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
 * This is ordering only, like the stickiness it sits beside. A remembered
 * endpoint is tried after the others, never dropped, so a pass still reaches
 * every endpoint; and the memory lapses, so an endpoint that serves the read
 * again is used again. It holds no preference of its own and changes none.
 */

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
  /** `label` and endpoint URL → when the refusal stops counting. Oldest first. */
  readonly #until = new Map<string, number>();

  constructor(config: EndpointReadRefusalsConfig) {
    this.#now = config.now;
    this.#ttlMs = config.ttlMs ?? ENDPOINT_READ_REFUSAL_TTL_MS;
    this.#maxEntries = config.maxEntries ?? ENDPOINT_READ_REFUSAL_MAX_ENTRIES;
  }

  /** Remember that `rpcUrl` refused the read `label`. */
  record(label: string, rpcUrl: string): void {
    const key = refusalKey(label, rpcUrl);
    // Re-inserted so the map stays ordered by when each refusal was last seen.
    this.#until.delete(key);
    this.#until.set(key, this.#now() + this.#ttlMs);
    while (this.#until.size > this.#maxEntries) {
      const oldest = this.#until.keys().next();
      if (oldest.done) break;
      this.#until.delete(oldest.value);
    }
  }

  /**
   * `attempts` for the read `label`, with the endpoints that refused it moved
   * behind the others. Relative order is otherwise kept, and the entries are
   * the same objects, so whatever each one carries stays bound to its endpoint.
   */
  order<T extends { readonly endpoint: { readonly rpcUrl: string } }>(label: string, attempts: T[]): T[] {
    if (this.#until.size === 0 || attempts.length <= 1) return attempts;
    const served: T[] = [];
    const refused: T[] = [];
    for (const attempt of attempts) {
      (this.#refuses(label, attempt.endpoint.rpcUrl) ? refused : served).push(attempt);
    }
    return refused.length === 0 || served.length === 0 ? attempts : [...served, ...refused];
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
