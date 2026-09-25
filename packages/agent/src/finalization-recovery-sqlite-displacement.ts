import type { DatabaseSync } from 'node:sqlite';
import {
  finalizationRecoveryCapacityShortfall,
  hasFinalizationRecoveryCapacity,
  hasFinalizationRecoveryDeferredCapacity,
  type FinalizationRecoveryRetentionPolicy,
} from './finalization-recovery-sqlite-policy.js';
import type { FinalizationRecoveryReceiveInput } from './finalization-recovery-store.js';

const MAX_DISPLACEMENTS_PER_ADMISSION = 8;

/** A live entry moved back to the deferred spool to admit a new finalization. */
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

interface DisplaceableRow {
  key: string;
  ual: string;
  context_graph_id: string;
  source_peer_id: string | null;
  failure_signature: string;
  failure_streak: number;
  last_error: string | null;
  envelope_bytes: number;
}

/**
 * Make room in the live inbox for a newly received finalization by parking
 * entries that keep failing the same way.
 *
 * A live entry whose local copy cannot be prepared keeps its slot for the
 * whole retry window, so enough of them fill a publisher's or a Context
 * Graph's quota and every later finalization is parked behind them. When
 * `input` finds no live capacity, the oldest RECEIVED entry that counts
 * against the exhausted limit, has failed with a displaceable signature at
 * least `displaceAfterFailureStreak` times in a row and is at least
 * `displaceMinAgeMs` old moves back to the deferred spool with its original
 * receipt time. Nothing becomes terminal: the parked entry is admitted again
 * when the live inbox has room, within its original retry window.
 *
 * All or nothing: when parking cannot make room for `input` (no displaceable
 * entry counts against the exhausted limit, or the deferred spool is full),
 * the inbox is left unchanged and `undefined` is returned.
 */
export function admitByParkingStableFailuresWithinTransaction(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
  now: number,
): FinalizationRecoveryDisplacement[] | undefined {
  if (policy.displaceableFailureSignatures.length === 0) return undefined;
  database.exec('SAVEPOINT finalization_displacement');
  try {
    const displaced = parkStableFailures(database, policy, input, now);
    if (
      displaced.length > 0
      && hasFinalizationRecoveryCapacity(database, policy, input)
    ) {
      database.exec('RELEASE finalization_displacement');
      return displaced;
    }
    database.exec('ROLLBACK TO finalization_displacement');
    database.exec('RELEASE finalization_displacement');
    return undefined;
  } catch (error) {
    try {
      database.exec('ROLLBACK TO finalization_displacement');
      database.exec('RELEASE finalization_displacement');
    } catch { /* the enclosing transaction rolls back */ }
    throw error;
  }
}

function parkStableFailures(
  database: DatabaseSync,
  policy: FinalizationRecoveryRetentionPolicy,
  input: FinalizationRecoveryReceiveInput,
  now: number,
): FinalizationRecoveryDisplacement[] {
  const signatures = policy.displaceableFailureSignatures;
  const placeholders = signatures.map(() => '?').join(', ');
  const candidate = (scope: string) => database.prepare(`
    SELECT key, ual, context_graph_id, source_peer_id, failure_signature, failure_streak,
           last_error, length(raw_envelope) AS envelope_bytes
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
  // The parked row keeps its receipt time, so the deferred spool's raw TTL
  // ends its retry window where the live inbox would have.
  const park = database.prepare(`
    INSERT OR IGNORE INTO finalization_pending_v2 (
      key, chain_id, context_graph_id, source_peer_id, trusted_publisher_peer_id,
      ual, tx_hash, assertion_version, merkle_root, ka_id, batch_id,
      target_context_graph_id, envelope_sha256, raw_envelope, created_at, updated_at
    )
    SELECT key, chain_id, context_graph_id, source_peer_id, trusted_publisher_peer_id,
           ual, tx_hash, assertion_version, merkle_root, ka_id, batch_id,
           target_context_graph_id, envelope_sha256, raw_envelope, created_at, created_at
    FROM finalization_inbox_v1
    WHERE key = ? AND state = 'RECEIVED'
  `);
  const removeLive = database.prepare(`
    DELETE FROM finalization_inbox_v1 WHERE key = ? AND state = 'RECEIVED'
  `);
  const displaced: FinalizationRecoveryDisplacement[] = [];
  while (displaced.length < MAX_DISPLACEMENTS_PER_ADMISSION) {
    const shortfall = finalizationRecoveryCapacityShortfall(database, policy, input);
    if (shortfall === undefined) break;
    // Only an entry that counts against the exhausted limit frees it.
    const scoped = shortfall === 'peer'
      ? { clause: 'AND source_peer_id = ?', values: [input.sourcePeerId ?? null] }
      : shortfall === 'context-graph'
        ? { clause: 'AND context_graph_id = ?', values: [input.contextGraphId] }
        : { clause: '', values: [] };
    const row = candidate(scoped.clause).get(
      policy.displaceAfterFailureStreak,
      ...signatures,
      now - policy.displaceMinAgeMs,
      input.key,
      ...scoped.values,
      input.sourcePeerId ?? null,
      input.contextGraphId,
    ) as DisplaceableRow | undefined;
    if (!row) break;
    const parkedInput = {
      contextGraphId: row.context_graph_id,
      ...(row.source_peer_id ? { sourcePeerId: row.source_peer_id } : {}),
      rawMessage: { byteLength: Number(row.envelope_bytes) },
    };
    if (!hasFinalizationRecoveryDeferredCapacity(database, policy, parkedInput)) break;
    if (park.run(row.key).changes !== 1) break;
    removeLive.run(row.key);
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
