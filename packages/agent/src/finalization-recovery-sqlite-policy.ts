import type { DatabaseSync } from 'node:sqlite';
import type {
  FinalizationRecoveryReceiveInput,
} from './finalization-recovery-store.js';

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PER_PEER = 32;
const DEFAULT_MAX_PER_CONTEXT_GRAPH = 64;
const DEFAULT_MAX_DEFERRED_ENTRIES = 1_024;
const DEFAULT_MAX_DEFERRED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DEFERRED_PER_PEER = 256;
const DEFAULT_MAX_DEFERRED_PER_CONTEXT_GRAPH = 512;
const DEFAULT_RAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_ENTRIES = 128;
const DEFAULT_MAX_TERMINAL_BYTES = 16 * 1024 * 1024;
// Matches FINALIZATION_RECOVERY_STABLE_FAILURE_THRESHOLD: the streak at which a
// failure counts as stable and its retries slow to the stable-failure cadence.
const DEFAULT_DISPLACE_AFTER_FAILURE_STREAK = 3;
const DEFAULT_DISPLACE_MIN_AGE_MS = 5 * 60 * 1000;
// A local copy that cannot be prepared for the finalization. The chain-promote
// sweep and durable sync repair such an asset without the inbox entry.
const DEFAULT_DISPLACEABLE_FAILURE_SIGNATURES = Object.freeze(['workspace-unavailable']);
const MAX_DISPLACEMENTS_PER_ADMISSION = 8;

/** A live entry rejected to make room for another finalization. */
export interface FinalizationRecoveryDisplacement {
  readonly key: string;
  readonly ual: string;
  readonly contextGraphId: string;
  readonly failureSignature: string;
  readonly failureStreak: number;
  readonly lastError: string | null;
  readonly admittedKey: string;
  readonly admittedUal: string;
}

export interface SqliteFinalizationRecoveryStoreOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEnvelopeBytes?: number;
  maxPerPeer?: number;
  maxPerContextGraph?: number;
  maxDeferredEntries?: number;
  maxDeferredBytes?: number;
  maxDeferredPerPeer?: number;
  maxDeferredPerContextGraph?: number;
  rawTtlMs?: number;
  terminalTtlMs?: number;
  maxTerminalEntries?: number;
  maxTerminalBytes?: number;
  /** Consecutive identical failures after which a live entry may be displaced. */
  displaceAfterFailureStreak?: number;
  /** Minimum age of a live entry before it may be displaced. */
  displaceMinAgeMs?: number;
  /** Failure signatures whose entries may be displaced. */
  displaceableFailureSignatures?: readonly string[];
  /** Called after a live entry has been displaced to admit another. */
  onDisplaced?: (displacement: FinalizationRecoveryDisplacement) => void;
  now?: () => number;
}

export interface FinalizationRecoveryRetentionPolicy {
  maxEntries: number;
  maxTotalBytes: number;
  maxEnvelopeBytes: number;
  maxPerPeer: number;
  maxPerContextGraph: number;
  maxDeferredEntries: number;
  maxDeferredBytes: number;
  maxDeferredPerPeer: number;
  maxDeferredPerContextGraph: number;
  rawTtlMs: number;
  terminalTtlMs: number;
  maxTerminalEntries: number;
  maxTerminalBytes: number;
  displaceAfterFailureStreak: number;
  displaceMinAgeMs: number;
  displaceableFailureSignatures: readonly string[];
  now: () => number;
}

export interface FinalizationRecoveryCapacitySnapshot {
  liveEntries: number;
  livePayloadBytes: number;
  oldest?: number;
  capacityExhausted: boolean;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

export function resolveFinalizationRecoveryRetentionPolicy(
  options: SqliteFinalizationRecoveryStoreOptions,
): FinalizationRecoveryRetentionPolicy {
  return {
    maxEntries: positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES),
    maxTotalBytes: positiveInteger(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
    maxEnvelopeBytes: positiveInteger(
      options.maxEnvelopeBytes,
      DEFAULT_MAX_ENVELOPE_BYTES,
    ),
    maxPerPeer: positiveInteger(options.maxPerPeer, DEFAULT_MAX_PER_PEER),
    maxPerContextGraph: positiveInteger(
      options.maxPerContextGraph,
      DEFAULT_MAX_PER_CONTEXT_GRAPH,
    ),
    maxDeferredEntries: positiveInteger(
      options.maxDeferredEntries,
      DEFAULT_MAX_DEFERRED_ENTRIES,
    ),
    maxDeferredBytes: positiveInteger(
      options.maxDeferredBytes,
      DEFAULT_MAX_DEFERRED_BYTES,
    ),
    maxDeferredPerPeer: positiveInteger(
      options.maxDeferredPerPeer,
      DEFAULT_MAX_DEFERRED_PER_PEER,
    ),
    maxDeferredPerContextGraph: positiveInteger(
      options.maxDeferredPerContextGraph,
      DEFAULT_MAX_DEFERRED_PER_CONTEXT_GRAPH,
    ),
    rawTtlMs: positiveInteger(options.rawTtlMs, DEFAULT_RAW_TTL_MS),
    terminalTtlMs: positiveInteger(options.terminalTtlMs, DEFAULT_TERMINAL_TTL_MS),
    maxTerminalEntries: positiveInteger(
      options.maxTerminalEntries,
      DEFAULT_MAX_TERMINAL_ENTRIES,
    ),
    maxTerminalBytes: positiveInteger(
      options.maxTerminalBytes,
      DEFAULT_MAX_TERMINAL_BYTES,
    ),
    displaceAfterFailureStreak: positiveInteger(
      options.displaceAfterFailureStreak,
      DEFAULT_DISPLACE_AFTER_FAILURE_STREAK,
    ),
    displaceMinAgeMs: Number.isSafeInteger(options.displaceMinAgeMs)
      && (options.displaceMinAgeMs ?? -1) >= 0
      ? options.displaceMinAgeMs!
      : DEFAULT_DISPLACE_MIN_AGE_MS,
    displaceableFailureSignatures: Object.freeze([
      ...(options.displaceableFailureSignatures ?? DEFAULT_DISPLACEABLE_FAILURE_SIGNATURES),
    ]),
    now: options.now ?? Date.now,
  };
}

/**
 * Free live capacity for `input` by rejecting entries that keep failing the
 * same way.
 *
 * A live entry whose local copy cannot be prepared keeps its slot for the
 * whole retry window, and its retries keep it clear of the raw TTL. Enough of
 * them fill a publisher's or a Context Graph's quota, and every later
 * finalization from that publisher is parked behind them. When `input` finds
 * no capacity, this rejects the oldest RECEIVED entry that has failed with a
 * displaceable signature at least `displaceAfterFailureStreak` times in a row
 * and is at least `displaceMinAgeMs` old, preferring one from the same peer,
 * then from the same Context Graph. The asset is left to chain reconciliation.
 * Verified, reorged and still-retrying entries are never displaced, and every
 * cap still applies. Returns the displaced entries in order; the caller checks
 * capacity again.
 */
export function displaceStableFailuresWithinTransaction(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
  now: number,
  replacingKey?: string,
): FinalizationRecoveryDisplacement[] {
  const displaced: FinalizationRecoveryDisplacement[] = [];
  const signatures = policy.displaceableFailureSignatures;
  if (signatures.length === 0) return displaced;
  const placeholders = signatures.map(() => '?').join(', ');
  const candidates = (scope: string) => database.prepare(`
    SELECT key, ual, context_graph_id, failure_signature, failure_streak, last_error
    FROM finalization_inbox_v1
    WHERE state = 'RECEIVED'
      AND publisher_upgrade_pending = 0
      AND failure_streak >= ?
      AND failure_signature IN (${placeholders})
      AND created_at <= ?
      AND key != ?
      ${scope}
    ORDER BY (source_peer_id IS ?) DESC, (context_graph_id = ?) DESC, created_at ASC, key ASC
    LIMIT 1
  `);
  const reject = database.prepare(`
    UPDATE finalization_inbox_v1
    SET state = 'REJECTED',
        publisher_upgrade_pending = 0,
        failure_signature = NULL,
        failure_streak = 0,
        last_error = ?,
        next_attempt_at = NULL,
        updated_at = ?
    WHERE key = ? AND state = 'RECEIVED'
  `);
  while (displaced.length < MAX_DISPLACEMENTS_PER_ADMISSION) {
    const shortfall = finalizationRecoveryCapacityShortfall(database, policy, input, replacingKey);
    if (shortfall === undefined) break;
    // Only an entry that counts against the exhausted limit frees it.
    const scoped = shortfall === 'peer'
      ? { clause: 'AND source_peer_id = ?', values: [input.sourcePeerId ?? null] }
      : shortfall === 'context-graph'
        ? { clause: 'AND context_graph_id = ?', values: [input.contextGraphId] }
        : { clause: '', values: [] };
    const row = candidates(scoped.clause).get(
      policy.displaceAfterFailureStreak,
      ...signatures,
      now - policy.displaceMinAgeMs,
      input.key,
      ...scoped.values,
      input.sourcePeerId ?? null,
      input.contextGraphId,
    ) as {
      key: string;
      ual: string;
      context_graph_id: string;
      failure_signature: string;
      failure_streak: number;
      last_error: string | null;
    } | undefined;
    if (!row) break;
    const reason = `displaced to admit ${input.ual} after ${row.failure_streak} `
      + `consecutive ${row.failure_signature} failures`
      + (row.last_error ? `: ${row.last_error}` : '');
    if (reject.run(reason, now, row.key).changes === 0) break;
    displaced.push({
      key: row.key,
      ual: row.ual,
      contextGraphId: row.context_graph_id,
      failureSignature: row.failure_signature,
      failureStreak: Number(row.failure_streak),
      lastError: row.last_error,
      admittedKey: input.key,
      admittedUal: input.ual,
    });
  }
  return displaced;
}

export function pruneFinalizationRecoveryRowsWithinTransaction(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  now: number,
): void {
  database.prepare(
    `DELETE FROM finalization_inbox_v1
     WHERE state IN ('RECEIVED','REORGED') AND updated_at < ?`,
  ).run(now - policy.rawTtlMs);
  database.prepare(
    `DELETE FROM finalization_pending_v2 WHERE updated_at < ?`,
  ).run(now - policy.rawTtlMs);
  database.prepare(
    `DELETE FROM finalization_inbox_v1
     WHERE state IN ('SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED')
       AND publisher_upgrade_pending = 0
       AND updated_at < ?`,
  ).run(now - policy.terminalTtlMs);
  database.prepare(`
    DELETE FROM finalization_inbox_v1
    WHERE key IN (
      SELECT key FROM (
        SELECT key,
               ROW_NUMBER() OVER (ORDER BY updated_at DESC, key DESC) AS row_number,
               SUM(length(raw_envelope)) OVER (
                 ORDER BY updated_at DESC, key DESC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative_bytes
        FROM finalization_inbox_v1
        WHERE state IN ('SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED')
          AND publisher_upgrade_pending = 0
      )
      WHERE row_number > ? OR cumulative_bytes > ?
    )
  `).run(policy.maxTerminalEntries, policy.maxTerminalBytes);
}

export function hasFinalizationRecoveryDeferredCapacity(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
): boolean {
  const total = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes
    FROM finalization_pending_v2
  `).get();
  if (
    Number(total?.count ?? 0) >= policy.maxDeferredEntries
    || Number(total?.bytes ?? 0) + input.rawMessage.byteLength > policy.maxDeferredBytes
  ) return false;
  const graph = database.prepare(`
    SELECT COUNT(*) AS count FROM finalization_pending_v2
    WHERE context_graph_id = ?
  `).get(input.contextGraphId);
  if (Number(graph?.count ?? 0) >= policy.maxDeferredPerContextGraph) return false;
  if (input.sourcePeerId) {
    const peer = database.prepare(`
      SELECT COUNT(*) AS count FROM finalization_pending_v2
      WHERE source_peer_id = ?
    `).get(input.sourcePeerId);
    if (Number(peer?.count ?? 0) >= policy.maxDeferredPerPeer) return false;
  }
  return true;
}

export function readFinalizationRecoveryDeferredCapacity(
  database: DatabaseSync,
): { entries: number; payloadBytes: number; oldest?: number } {
  const row = database.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(length(raw_envelope)), 0) AS bytes,
           MIN(created_at) AS oldest
    FROM finalization_pending_v2
  `).get();
  const oldest = typeof row?.oldest === 'number' ? row.oldest : undefined;
  return {
    entries: Number(row?.count ?? 0),
    payloadBytes: Number(row?.bytes ?? 0),
    ...(oldest === undefined ? {} : { oldest }),
  };
}

type FinalizationRecoveryCapacityShortfall = 'total' | 'context-graph' | 'peer';

function finalizationRecoveryCapacityShortfall(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
  replacingKey?: string,
): FinalizationRecoveryCapacityShortfall | undefined {
  const live = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes
    FROM finalization_inbox_v1
    WHERE (state IN ('RECEIVED','VERIFIED','REORGED') OR publisher_upgrade_pending = 1)
      AND (? IS NULL OR key != ?)
  `).get(replacingKey ?? null, replacingKey ?? null);
  if (
    Number(live?.count ?? 0) >= policy.maxEntries
    || Number(live?.bytes ?? 0) + input.rawMessage.byteLength > policy.maxTotalBytes
  ) return 'total';
  const graphCount = database.prepare(`
    SELECT COUNT(*) AS count FROM finalization_inbox_v1
    WHERE (state IN ('RECEIVED','VERIFIED','REORGED') OR publisher_upgrade_pending = 1)
      AND context_graph_id = ? AND (? IS NULL OR key != ?)
  `).get(input.contextGraphId, replacingKey ?? null, replacingKey ?? null);
  if (Number(graphCount?.count ?? 0) >= policy.maxPerContextGraph) return 'context-graph';
  if (input.sourcePeerId) {
    const peerCount = database.prepare(`
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE (state IN ('RECEIVED','VERIFIED','REORGED') OR publisher_upgrade_pending = 1)
        AND source_peer_id = ? AND (? IS NULL OR key != ?)
    `).get(input.sourcePeerId, replacingKey ?? null, replacingKey ?? null);
    if (Number(peerCount?.count ?? 0) >= policy.maxPerPeer) return 'peer';
  }
  return undefined;
}

export function hasFinalizationRecoveryCapacity(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
  replacingKey?: string,
): boolean {
  return finalizationRecoveryCapacityShortfall(database, policy, input, replacingKey) === undefined;
}

export function readFinalizationRecoveryCapacity(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
): FinalizationRecoveryCapacitySnapshot {
  const live = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes,
           MIN(created_at) AS oldest
    FROM finalization_inbox_v1
    WHERE state IN ('RECEIVED','VERIFIED','REORGED') OR publisher_upgrade_pending = 1
  `).get();
  const liveEntries = Number(live?.count ?? 0);
  const livePayloadBytes = Number(live?.bytes ?? 0);
  const oldest = typeof live?.oldest === 'number' ? live.oldest : undefined;
  const graphCapacity = database.prepare(`
    SELECT COALESCE(MAX(count), 0) AS count FROM (
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE state IN ('RECEIVED','VERIFIED','REORGED') OR publisher_upgrade_pending = 1
      GROUP BY context_graph_id
    )
  `).get();
  const peerCapacity = database.prepare(`
    SELECT COALESCE(MAX(count), 0) AS count FROM (
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE (state IN ('RECEIVED','VERIFIED','REORGED') OR publisher_upgrade_pending = 1)
        AND source_peer_id IS NOT NULL
      GROUP BY source_peer_id
    )
  `).get();
  return {
    liveEntries,
    livePayloadBytes,
    ...(oldest === undefined ? {} : { oldest }),
    capacityExhausted: liveEntries >= policy.maxEntries
      || livePayloadBytes >= policy.maxTotalBytes
      || Number(graphCapacity?.count ?? 0) >= policy.maxPerContextGraph
      || Number(peerCapacity?.count ?? 0) >= policy.maxPerPeer,
  };
}
