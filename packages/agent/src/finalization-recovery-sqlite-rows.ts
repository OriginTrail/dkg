import type { DatabaseSync } from 'node:sqlite';
import {
  finalizationEnvelopeFromRow,
  finalizationRecoveryRowToEntry,
} from './finalization-recovery-sqlite-codec.js';
import type { FinalizationRecoveryReceiveInput } from './finalization-recovery-store.js';

/** When an inbox or spool row was received and last changed, and its trusted publisher. */
export interface FinalizationRecoveryRowMetadata {
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly trustedPublisherPeerId?: string;
}

export interface PendingFinalizationRow {
  key: string;
  chain_id: string;
  context_graph_id: string;
  source_peer_id: string | null;
  trusted_publisher_peer_id: string | null;
  ual: string;
  tx_hash: string;
  assertion_version: string;
  merkle_root: string;
  ka_id: string;
  batch_id: string;
  target_context_graph_id: string | null;
  envelope_sha256: string;
  raw_envelope: Uint8Array;
  created_at: number;
  updated_at: number;
}

export function pendingRowToReceiveInput(
  row: PendingFinalizationRow,
): FinalizationRecoveryReceiveInput {
  const { raw } = finalizationEnvelopeFromRow(row as unknown as Record<string, unknown>);
  return {
    key: row.key,
    chainId: row.chain_id,
    contextGraphId: row.context_graph_id,
    ...(row.source_peer_id ? { sourcePeerId: row.source_peer_id } : {}),
    ual: row.ual,
    txHash: row.tx_hash,
    assertionVersion: row.assertion_version,
    merkleRoot: row.merkle_root,
    kaId: row.ka_id,
    batchId: row.batch_id,
    ...(row.target_context_graph_id
      ? { targetContextGraphId: row.target_context_graph_id }
      : {}),
    rawMessage: new Uint8Array(raw),
  };
}

export function insertLiveFinalizationWithinTransaction(
  database: DatabaseSync,
  input: FinalizationRecoveryReceiveInput,
  digest: string,
  metadata: FinalizationRecoveryRowMetadata,
): void {
  database.prepare(`
    INSERT INTO finalization_inbox_v1 (
      key, state, chain_id, context_graph_id, source_peer_id,
      trusted_publisher_peer_id, ual, tx_hash,
      assertion_version, merkle_root, ka_id, batch_id, target_context_graph_id,
      envelope_sha256, raw_envelope, created_at, updated_at
    ) VALUES (?, 'RECEIVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.key,
    input.chainId,
    input.contextGraphId,
    input.sourcePeerId ?? null,
    metadata.trustedPublisherPeerId ?? null,
    input.ual,
    input.txHash.toLowerCase(),
    input.assertionVersion,
    input.merkleRoot.toLowerCase(),
    input.kaId,
    input.batchId,
    input.targetContextGraphId ?? null,
    digest,
    Buffer.from(input.rawMessage),
    metadata.createdAt,
    metadata.updatedAt,
  );
}

export function insertPendingFinalizationWithinTransaction(
  database: DatabaseSync,
  input: FinalizationRecoveryReceiveInput,
  digest: string,
  metadata: FinalizationRecoveryRowMetadata,
): void {
  database.prepare(`
    INSERT INTO finalization_pending_v2 (
      key, chain_id, context_graph_id, source_peer_id,
      trusted_publisher_peer_id, ual, tx_hash,
      assertion_version, merkle_root, ka_id, batch_id, target_context_graph_id,
      envelope_sha256, raw_envelope, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.key,
    input.chainId,
    input.contextGraphId,
    input.sourcePeerId ?? null,
    metadata.trustedPublisherPeerId ?? null,
    input.ual,
    input.txHash.toLowerCase(),
    input.assertionVersion,
    input.merkleRoot.toLowerCase(),
    input.kaId,
    input.batchId,
    input.targetContextGraphId ?? null,
    digest,
    Buffer.from(input.rawMessage),
    metadata.createdAt,
    metadata.updatedAt,
  );
}

/**
 * Move a RECEIVED live entry back to the deferred spool through the same
 * write as an ordinary deferral. Returns false when the entry is not a
 * RECEIVED live entry or the spool already holds its key.
 *
 * The spool row keeps the entry's receipt time, trusted publisher and last
 * update. Both tables expire a row `rawTtlMs` after its last update, so
 * parking leaves the entry's expiry where it was in the live inbox.
 *
 * The retry state stays behind: the spool has no columns for it, and adding
 * one would make the exact schema check of a node rolled back to an earlier
 * release refuse the database. When there is room again, promotion admits
 * the entry like any deferred one: due at once, with no attempts and no
 * failure streak. If it keeps failing the same way, the stable-failure
 * backoff resumes after FINALIZATION_RECOVERY_STABLE_FAILURE_THRESHOLD
 * failures on the ordinary backoff, so each parking costs at most that many
 * extra attempts. The receipt time still bounds the retry window: an entry
 * readmitted after its window is rejected as soon as its streak reaches the
 * threshold again. The attempts made before parking stop counting toward the
 * attempt budget; a stable failure makes at most one per
 * FINALIZATION_RECOVERY_STABLE_FAILURE_RETRY_MS, so few are forgiven.
 */
export function parkLiveFinalizationWithinTransaction(
  database: DatabaseSync,
  key: string,
): boolean {
  const row = database.prepare(
    `SELECT * FROM finalization_inbox_v1 WHERE key = ? AND state = 'RECEIVED'`,
  ).get(key);
  if (
    !row
    || database.prepare('SELECT 1 FROM finalization_pending_v2 WHERE key = ?').get(key)
  ) return false;
  const entry = finalizationRecoveryRowToEntry(row);
  insertPendingFinalizationWithinTransaction(database, entry, entry.envelopeSha256, {
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    trustedPublisherPeerId: entry.trustedPublisherPeerId,
  });
  database.prepare('DELETE FROM finalization_inbox_v1 WHERE key = ?').run(key);
  return true;
}
