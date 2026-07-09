// SPDX-License-Identifier: Apache-2.0

/**
 * `EndpointStickiness` — the transport-ordering preference state machine extracted
 * from `RpcFailoverClient` (Mechanism B, #1340 retry residual + #1337 policy-read
 * fail-close). It owns the "prefer the last-good backend, re-probe the primary at
 * most once per TTL" decision as a single, typed, testable unit so the four
 * per-endpoint failover loops don't each hand-wire the ordering + outcome
 * bookkeeping.
 *
 * It is PURE TRANSPORT-ORDERING state — it never signs, broadcasts, holds a WAL /
 * serializer / nonce, or gates a return. It only decides which endpoint each loop
 * TRIES FIRST and remembers where the last op succeeded. Callers pass a
 * {@link StickinessIntent} describing the operation; the state machine encodes all
 * the transition rules that were previously scattered boolean parameters:
 *
 *   State: `none` | `preferred{ url, source: 'read' | 'write', primaryProbeDueAt }`
 *     - `source` distinguishes a preference proven by a READ from one proven by a
 *       nonce-critical POPULATE. A read-established backend may lag the signer's
 *       pending-nonce state, so a `nonceWrite` (populate) MUST NOT start there —
 *       it re-derives nonce from canonical (primary-first = authoritative) until a
 *       populate proves the backend.
 *
 *   Intents:
 *     - `stickyRead`      — a normal read: prefer the last-good backend (either source).
 *     - `transparentRead` — a TIP-sensitive read (current head / latest block):
 *       canonical order AND no state mutation (a lagging preferred would make the
 *       tip non-monotonic; and it must not clear a preference the heavy paths rely on).
 *     - `nonceWrite`      — `populateAndSign`: prefer ONLY a WRITE-proven backend.
 *     - `write`           — `broadcast` / `getReceipt`: nonce-free, prefer the
 *       last-good backend; BUT if the primary takes over a write as a fallback
 *       (the preferred backend failed the write op), the preferred backend's nonce
 *       view is now stale, so downgrade `source` write→read.
 *
 * All methods are synchronous, so concurrent ops on one instance can only observe
 * a slightly stale order, never torn state.
 */

/** Minimal endpoint shape the ordering needs — keyed on `rpcUrl` (survives a live
 *  provider-pool rebind, unlike a positional index). */
export interface StickyEndpoint {
  rpcUrl: string;
}

export type StickinessIntent = 'stickyRead' | 'transparentRead' | 'nonceWrite' | 'write';

type StickyState =
  | { kind: 'none' }
  | { kind: 'preferred'; url: string; source: 'read' | 'write'; primaryProbeDueAt: number };

export interface StickinessConfig {
  /** Monotonic-ish clock (ms). Injected for deterministic cadence tests. */
  now: () => number;
  /** Primary re-probe cadence (ms). */
  ttlMs: number;
  /** LIVE kill-switch predicate — resolved at the CONFIG boundary (e.g. the
   *  adapter reads `DKG_DISABLE_RPC_STICKINESS`), so the transport core has no
   *  process-global dependency. */
  isEnabled: () => boolean;
  /** Optional host-only observability hook fired once per establishment edge. */
  onEstablished?: (rpcUrl: string) => void;
}

/**
 * ONE bound attempt in a failover pass: the endpoint to try, plus its outcome
 * recorders with the endpoint, its position (triedFirst = index 0), and the
 * (canonical, intent) pair ALL captured at creation. A loop iterates the entries
 * {@link EndpointStickiness.attempts} returns and, on the entry it actually ran,
 * calls the NULLARY `recordSuccess()` / `recordFailure()`. Nothing is threaded
 * back in, so a loop cannot record against the wrong endpoint, a stale index, or a
 * mismatched canonical/intent — the invariant is structural, not just documented.
 */
export interface StickyAttempt<T extends StickyEndpoint> {
  /** The endpoint to try for this attempt (preferred-first ordering). */
  readonly endpoint: T;
  /** Record that THIS endpoint served the op (triedFirst bound at creation). */
  recordSuccess(): void;
  /** Record that THIS endpoint FAILED (real error → failover); de-prefers it if preferred. */
  recordFailure(): void;
}

export class EndpointStickiness {
  private state: StickyState = { kind: 'none' };

  constructor(private readonly cfg: StickinessConfig) {}

  /** Whether a preference is currently active (test/introspection helper). */
  hasPreference(): boolean {
    return this.state.kind === 'preferred';
  }

  /**
   * Build the preferred-first list of BOUND {@link StickyAttempt}s for `intent`
   * over `canonical`. `order()` runs EXACTLY once here (it may re-arm the TTL
   * re-probe — it must not run twice per loop entry); each entry captures its own
   * endpoint + position (triedFirst = index 0) + the SAME (canonical, intent), so
   * a loop records via the nullary `recordSuccess()`/`recordFailure()` on the entry
   * it ran and cannot drift the endpoint, index, canonical, or intent apart.
   *
   * This is the SOLE public API for DRIVING a failover pass — `order`,
   * `recordSuccess`, and `recordFailure` are `private` below precisely so the
   * mismatched hand-threaded path these entries prevent is not merely discouraged
   * but unavailable. (`hasPreference` stays public as a read-only introspection
   * helper; it can't cause drift.)
   */
  attempts<T extends StickyEndpoint>(canonical: T[], intent: StickinessIntent): StickyAttempt<T>[] {
    return this.order(canonical, intent).map((endpoint, i) => ({
      endpoint,
      recordSuccess: () => this.recordSuccess(endpoint, canonical, intent, i === 0),
      recordFailure: () => this.recordFailure(endpoint, intent),
    }));
  }

  /**
   * Decide the per-op iteration order over `canonical` (the live configured order,
   * index 0 = primary). Returns canonical unless a compatible preference is active
   * and inside the current re-probe window, in which case the preferred endpoint is
   * MOVED to the front (spliced out + unshifted — never duplicated, so fall-through
   * still visits every endpoint exactly once). A `transparentRead` always uses
   * canonical; a `nonceWrite` uses canonical unless the preference is WRITE-proven.
   * When the re-probe deadline has passed this op probes the primary first AND
   * re-arms the deadline `+ttlMs` (at most one primary re-stall per TTL).
   */
  private order<T extends StickyEndpoint>(canonical: T[], intent: StickinessIntent): T[] {
    if (intent === 'transparentRead' || !this.cfg.isEnabled() || this.state.kind !== 'preferred') {
      return canonical;
    }
    const pref = this.state; // narrowed to the 'preferred' variant
    // A nonce-critical populate must not START on a backend proven only by a READ
    // (it may lag the signer's pending nonce → a stale-nonce sign → phantom
    // `nonce too low` success). Fall back to canonical (authoritative nonce).
    if (intent === 'nonceWrite' && pref.source !== 'write') return canonical;
    const idx = canonical.findIndex((e) => e.rpcUrl === pref.url);
    // idx < 0: preferred no longer configured (pool rebind dropped it).
    // idx === 0: preferred IS the primary — canonical already tries it first.
    if (idx <= 0) return canonical;
    // The TTL re-probe is a READ-recovery mechanism (only `stickyRead`): it
    // periodically re-tries the configured primary so a recovered primary resumes
    // serving reads. It must NOT redirect ANY write — a primary can be
    // transport-healthy while still behind the block/txpool state that advanced the
    // signer nonce, so (a) a `nonceWrite` populate there would sign a stale/duplicate
    // nonce, and (b) a `write` broadcast/receipt there would split a backup-signed tx
    // across endpoints and a lagging primary could reject the backup's nonce
    // terminally before the loop reaches the backup. Writes therefore keep the
    // write-proven backend past the TTL; they return to the primary only once a READ
    // re-probe CLEARS the preference on primary recovery (or the backend fails, see
    // recordFailure).
    if (intent === 'stickyRead' && this.cfg.now() >= pref.primaryProbeDueAt) {
      // Re-probe the configured primary this op; schedule the next re-probe one TTL
      // out so we don't re-stall on it again until then.
      this.state = { ...pref, primaryProbeDueAt: this.cfg.now() + this.cfg.ttlMs };
      return canonical;
    }
    const reordered = canonical.slice();
    const [preferred] = reordered.splice(idx, 1);
    reordered.unshift(preferred);
    return reordered;
  }

  /**
   * Record that `endpoint` served the op (intent) successfully, `triedFirst` = it
   * was the first endpoint attempted (loop index 0). No-op for `transparentRead`
   * or when disabled. Encodes every transition:
   *   - primary succeeded, tried FIRST → CLEAR (a genuine canonical/TTL re-probe
   *     proved the primary healthy again).
   *   - primary succeeded as a WRITE fallback → the preferred backend failed the
   *     write op and the tx moved to the primary, so the backend's nonce view is
   *     stale → downgrade `source` write→read (keeps the read-preference, but the
   *     next `nonceWrite` re-derives nonce from canonical). NOT for reads (a read
   *     reaching the primary as a fallback doesn't advance the nonce, and
   *     downgrading could break a legitimate read-your-write allowance re-read).
   *   - a backend succeeded → establish (arm the deadline + fire `onEstablished`)
   *     or silently re-point; `source` = 'write' for a populate, else 'read'. A
   *     later populate on the SAME preferred upgrades 'read'→'write'.
   */
  private recordSuccess<T extends StickyEndpoint>(
    endpoint: T,
    canonical: T[],
    intent: StickinessIntent,
    triedFirst: boolean,
  ): void {
    if (intent === 'transparentRead' || !this.cfg.isEnabled()) return;
    const primaryUrl = canonical[0]?.rpcUrl;
    const isPopulate = intent === 'nonceWrite';
    const isWriteOp = intent === 'nonceWrite' || intent === 'write';
    if (endpoint.rpcUrl === primaryUrl) {
      if (triedFirst) {
        this.state = { kind: 'none' };
      } else if (isWriteOp && this.state.kind === 'preferred' && this.state.source === 'write') {
        this.state = { ...this.state, source: 'read' };
      }
      return;
    }
    if (this.state.kind !== 'preferred') {
      this.state = {
        kind: 'preferred',
        url: endpoint.rpcUrl,
        source: isPopulate ? 'write' : 'read',
        primaryProbeDueAt: this.cfg.now() + this.cfg.ttlMs,
      };
      this.cfg.onEstablished?.(endpoint.rpcUrl);
    } else if (this.state.url !== endpoint.rpcUrl) {
      // Re-point to a different backup (the old one also degraded, or was dropped
      // by a live pool rebind). Keep an in-window deadline (a hop within an ongoing
      // degradation episode, already counted at establishment — no new
      // `onEstablished`), BUT if the carried-over deadline has already EXPIRED, arm
      // a fresh one: otherwise a rebind that swaps in a new backup while the old
      // deadline is stale would re-probe the primary on EVERY subsequent op (the
      // collapse-to-index-0 this cadence exists to prevent).
      const primaryProbeDueAt = this.cfg.now() >= this.state.primaryProbeDueAt
        ? this.cfg.now() + this.cfg.ttlMs
        : this.state.primaryProbeDueAt;
      this.state = { ...this.state, url: endpoint.rpcUrl, source: isPopulate ? 'write' : 'read', primaryProbeDueAt };
    } else if (isPopulate && this.state.source !== 'write') {
      // Same preferred backend, now PROVEN nonce-safe by a populate → upgrade.
      // Never DOWNGRADE on a read (a read hitting the write-proven backend doesn't
      // un-prove its nonce view).
      this.state = { ...this.state, source: 'write' };
    }
  }

  /**
   * Record that `endpoint` FAILED the op (errored → triggered failover), so the
   * failover loop is moving on to the next endpoint. If the failed endpoint is the
   * current preferred, DE-PREFER it (drop to `none`): a degraded/hanging preferred
   * backup must not keep being tried first, or every subsequent op re-stalls on it
   * until the TTL re-probe — reintroducing the very fail-close this cadence exists
   * to prevent, just with the backup as the staller. A later success re-establishes
   * the new last-good backend. No-op for `transparentRead` (non-mutating) or when
   * the failed endpoint isn't the preferred (e.g. a re-probe where the PRIMARY
   * fails is expected and must not disturb the preference). This is called ONLY on
   * a real error/failover, NOT on a benign `null` (e.g. getReceipt's not-yet-mined
   * null continues the loop without a failover), so a healthy-but-empty backup
   * stays preferred.
   */
  private recordFailure<T extends StickyEndpoint>(endpoint: T, intent: StickinessIntent): void {
    if (intent === 'transparentRead' || !this.cfg.isEnabled()) return;
    if (this.state.kind === 'preferred' && this.state.url === endpoint.rpcUrl) {
      this.state = { kind: 'none' };
    }
  }
}
