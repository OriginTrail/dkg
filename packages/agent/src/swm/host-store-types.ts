/**
 * Types and default limits of the SWM host-mode store (host-mode-store.ts).
 *
 * Everything here is plain data: the entry and stats shapes the store returns,
 * the options it takes, the startup reconcile report, the per-CG metadata it
 * persists in `<key>.meta`, and the default retention limits. `host-mode-store.ts`
 * re-exports the public ones, so importers keep reading them from there.
 */

export interface SwmHostModeEntry {
  /** Monotonic per-store sequence number assigned at append time. */
  seqno: number;
  /** UNIX epoch milliseconds when the entry was written. */
  timestampMs: number;
  /** Raw gossip envelope bytes as received from libp2p. Opaque to the core. */
  envelopeBytes: Uint8Array;
}

export interface SwmHostModeStoreLimits {
  /** Max bytes retained per CG. Older entries are evicted FIFO. */
  perCgByteCap: number;
  /** Time-to-live in milliseconds. Entries older than this are pruned. */
  ttlMs: number;
}

export interface SwmHostModeStoreOptions {
  /** Filesystem directory under which per-CG logs are written. */
  dataDir: string;
  /** Limits applied to unregistered (pre-registration) CGs. */
  unregisteredLimits: SwmHostModeStoreLimits;
  /** Limits applied to on-chain registered CGs. */
  registeredLimits: SwmHostModeStoreLimits;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional callback fired by `init()` after the orphan-log
   * reconciliation pass. Receives the per-startup totals so the
   * agent can surface them through its own logging facade. Pure
   * observability — the store itself does not log.
   */
  onStartupReconcile?: (report: SwmHostModeStartupReconcileReport) => void;
}

/**
 * Summary of the orphan-log sweep performed by `init()`. A `.log`
 * file without a matching `.meta` cannot be served via catchup (no
 * cleartext `contextGraphId` to dispatch on), pruned (the prune
 * path keys off meta files), or reported in stats — those bytes are
 * dead storage that accumulate after a crash between `appendFile`
 * (durable) and `persistMeta` (durable) for a brand-new CG's first
 * envelope. We delete orphans at init to recover the disk.
 */
export interface SwmHostModeStartupReconcileReport {
  orphanLogsRemoved: number;
  orphanBytesRemoved: number;
  /**
   * Codex PR #619 follow-up: split out so operators can tell the
   * difference between "log without meta" reaping (data already lost
   * before reconcile ran) and "meta failed to parse" reaping
   * (meta itself was the casualty; paired log was already reaped via
   * the orphan-logs pass). Optional for backwards compat with the
   * pre-fix report shape.
   */
  corruptMetasRemoved?: number;
  /**
   * Number of leftover `<log|meta>.tmp-*` files (a crash between creating
   * the temp file and renaming it over its target) swept by this pass.
   * Reported only when non-zero; never folded into the orphan-log totals
   * above and never fires `onStartupReconcile` on its own.
   */
  staleTempFilesRemoved?: number;
}

export interface SwmHostModeStats {
  /** Number of distinct CGs that have at least one stored entry. */
  cgCount: number;
  /** Total stored bytes (sum across CGs) on disk. */
  totalBytes: number;
  /** Total stored entries (sum across CGs). */
  totalEntries: number;
  /**
   * Per-CG breakdown. Keys are the raw contextGraphIds (not the
   * hashed on-disk filenames). Tests and operators that need to
   * assert "ciphertext was stored for CG X" must consume this
   * field rather than the global totals — those can be polluted
   * by ciphertext from other CGs the same core happens to host
   * (Codex PR #610 R3 caught the false-positive risk in the
   * SCENARIO D devnet assertion).
   */
  perCg: Record<string, { entries: number; bytes: number; registered: boolean }>;
}

export const DEFAULT_UNREGISTERED_LIMITS: SwmHostModeStoreLimits = {
  perCgByteCap: 1 * 1024 * 1024,
  ttlMs: 6 * 60 * 60 * 1000,
};

export const DEFAULT_REGISTERED_LIMITS: SwmHostModeStoreLimits = {
  perCgByteCap: 64 * 1024 * 1024,
  ttlMs: 30 * 24 * 60 * 60 * 1000,
};

/** The per-CG metadata the store keeps in `<key>.meta` and in its in-memory cache. */
export interface CgMetaState {
  seqno: number;
  registered: boolean;
  contextGraphId: string;
  /**
   * OT-RFC-38 LU-6 B3 — true when the agent has actively engaged
   * host-mode for this CG (subscribed to its SWM gossip topic in
   * opaque-ciphertext mode). Persisted so a restart can re-engage
   * the gossip handler before the chain-event poller catches up
   * (chain events outside the lookback window would otherwise be
   * silently lost, stranding hosted CGs without an apply path).
   *
   * Distinct from `registered` (which tracks on-chain registration
   * for limits + rate-limit purposes). A CG can be host-mode
   * subscribed but unregistered (pre-registration auto-host via
   * beacon) and vice-versa (registered but the curator revoked
   * this core via off-protocol means — the next reconcile loop
   * will clear `hostModeSubscribed`).
   */
  hostModeSubscribed?: boolean;
}
