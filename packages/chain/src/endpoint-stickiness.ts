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

export class EndpointStickiness {
  private state: StickyState = { kind: 'none' };

  constructor(private readonly cfg: StickinessConfig) {}

  /** Whether a preference is currently active (test/introspection helper). */
  hasPreference(): boolean {
    return this.state.kind === 'preferred';
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
  order<T extends StickyEndpoint>(canonical: T[], intent: StickinessIntent): T[] {
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
    if (this.cfg.now() >= pref.primaryProbeDueAt) {
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
  recordSuccess<T extends StickyEndpoint>(
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
}
