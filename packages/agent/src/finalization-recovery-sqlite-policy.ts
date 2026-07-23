import type { DatabaseSync } from 'node:sqlite';
import type {
  FinalizationRecoveryReceiveInput,
} from './finalization-recovery-store.js';

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ENVELOPE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PER_PEER = 32;
const DEFAULT_MAX_PER_CONTEXT_GRAPH = 64;
const DEFAULT_RAW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TERMINAL_ENTRIES = 128;
const DEFAULT_MAX_TERMINAL_BYTES = 16 * 1024 * 1024;

export interface SqliteFinalizationRecoveryStoreOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxEnvelopeBytes?: number;
  maxPerPeer?: number;
  maxPerContextGraph?: number;
  rawTtlMs?: number;
  terminalTtlMs?: number;
  maxTerminalEntries?: number;
  maxTerminalBytes?: number;
  now?: () => number;
}

export interface FinalizationRecoveryRetentionPolicy {
  maxEntries: number;
  maxTotalBytes: number;
  maxEnvelopeBytes: number;
  maxPerPeer: number;
  maxPerContextGraph: number;
  rawTtlMs: number;
  terminalTtlMs: number;
  maxTerminalEntries: number;
  maxTerminalBytes: number;
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
    `DELETE FROM finalization_inbox_v1
     WHERE state IN ('SETTLED','SUPERSEDED','REJECTED','UNSUPPORTED') AND updated_at < ?`,
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
      )
      WHERE row_number > ? OR cumulative_bytes > ?
    )
  `).run(policy.maxTerminalEntries, policy.maxTerminalBytes);
}

export function hasFinalizationRecoveryCapacity(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
  replacingKey?: string,
): boolean {
  const live = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes
    FROM finalization_inbox_v1
    WHERE state IN ('RECEIVED','VERIFIED','REORGED')
      AND (? IS NULL OR key != ?)
  `).get(replacingKey ?? null, replacingKey ?? null);
  if (
    Number(live?.count ?? 0) >= policy.maxEntries
    || Number(live?.bytes ?? 0) + input.rawMessage.byteLength > policy.maxTotalBytes
  ) return false;
  const graphCount = database.prepare(`
    SELECT COUNT(*) AS count FROM finalization_inbox_v1
    WHERE state IN ('RECEIVED','VERIFIED','REORGED')
      AND context_graph_id = ? AND (? IS NULL OR key != ?)
  `).get(input.contextGraphId, replacingKey ?? null, replacingKey ?? null);
  if (Number(graphCount?.count ?? 0) >= policy.maxPerContextGraph) return false;
  if (input.sourcePeerId) {
    const peerCount = database.prepare(`
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE state IN ('RECEIVED','VERIFIED','REORGED')
        AND source_peer_id = ? AND (? IS NULL OR key != ?)
    `).get(input.sourcePeerId, replacingKey ?? null, replacingKey ?? null);
    if (Number(peerCount?.count ?? 0) >= policy.maxPerPeer) return false;
  }
  return true;
}

export function readFinalizationRecoveryCapacity(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
): FinalizationRecoveryCapacitySnapshot {
  const live = database.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(length(raw_envelope)), 0) AS bytes,
           MIN(created_at) AS oldest
    FROM finalization_inbox_v1 WHERE state IN ('RECEIVED','VERIFIED','REORGED')
  `).get();
  const liveEntries = Number(live?.count ?? 0);
  const livePayloadBytes = Number(live?.bytes ?? 0);
  const oldest = typeof live?.oldest === 'number' ? live.oldest : undefined;
  const graphCapacity = database.prepare(`
    SELECT COALESCE(MAX(count), 0) AS count FROM (
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE state IN ('RECEIVED','VERIFIED','REORGED')
      GROUP BY context_graph_id
    )
  `).get();
  const peerCapacity = database.prepare(`
    SELECT COALESCE(MAX(count), 0) AS count FROM (
      SELECT COUNT(*) AS count FROM finalization_inbox_v1
      WHERE state IN ('RECEIVED','VERIFIED','REORGED') AND source_peer_id IS NOT NULL
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
