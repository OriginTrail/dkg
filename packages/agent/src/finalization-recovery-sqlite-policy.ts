import type { DatabaseSync } from 'node:sqlite';
import {
  FINALIZATION_RECOVERY_STABLE_FAILURE_THRESHOLD,
  type FinalizationRecoveryFailureCode,
  type FinalizationRecoveryReceiveInput,
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
const DEFAULT_DISPLACE_MIN_AGE_MS = 5 * 60 * 1000;
// The local copy could not be prepared for the finalization.
const DEFAULT_DISPLACEABLE_FAILURE_SIGNATURES: readonly FinalizationRecoveryFailureCode[] =
  Object.freeze(['workspace-unavailable']);

export interface FinalizationRecoveryRetentionOptions {
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
  /** Failure signatures whose entries may be displaced; empty disables displacement. */
  displaceableFailureSignatures?: readonly FinalizationRecoveryFailureCode[];
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
  displaceableFailureSignatures: readonly FinalizationRecoveryFailureCode[];
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
  options: FinalizationRecoveryRetentionOptions,
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
      FINALIZATION_RECOVERY_STABLE_FAILURE_THRESHOLD,
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
  input: Pick<FinalizationRecoveryReceiveInput, 'contextGraphId' | 'sourcePeerId'> & {
    readonly rawMessage: { readonly byteLength: number };
  },
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

export type FinalizationRecoveryCapacityShortfall = 'total' | 'context-graph' | 'peer';

/** The first live-inbox limit `input` would exceed, if any. */
export function finalizationRecoveryCapacityShortfall(
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
