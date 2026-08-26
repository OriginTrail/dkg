import type { DatabaseSync } from 'node:sqlite';
import {
  type FinalizationRecoveryEntry,
  type FinalizationRecoveryHealth,
  type FinalizationRecoveryVerifiedEvidenceCommit,
  type FinalizationRecoveryReceiveInput,
  type FinalizationRecoveryReceiveResult,
  type FinalizationRecoverySettledPublisherUpgradeResult,
  type FinalizationRecoveryState,
  type FinalizationRecoveryStore,
  type FinalizationRecoveryVerifyResult,
} from './finalization-recovery-store.js';
import {
  finalizationEnvelopeFromRow,
  finalizationEnvelopeSha256,
  finalizationRecoveryRowToEntry,
  sameFinalizationRecoveryEvidence,
} from './finalization-recovery-sqlite-codec.js';
import {
  fsyncFinalizationRecoveryDatabase,
  openFinalizationRecoveryDatabase,
} from './finalization-recovery-sqlite-schema.js';
import {
  hasFinalizationRecoveryCapacity,
  hasFinalizationRecoveryDeferredCapacity,
  pruneFinalizationRecoveryRowsWithinTransaction,
  readFinalizationRecoveryCapacity,
  readFinalizationRecoveryDeferredCapacity,
  resolveFinalizationRecoveryRetentionPolicy,
  type FinalizationRecoveryRetentionPolicy,
  type SqliteFinalizationRecoveryStoreOptions,
} from './finalization-recovery-sqlite-policy.js';

export type {
  SqliteFinalizationRecoveryStoreOptions,
} from './finalization-recovery-sqlite-policy.js';

const DUE_FINALIZATION_SQL_PREDICATE = `
  (
    state IN ('RECEIVED','VERIFIED','REORGED')
    OR (
      state = 'SETTLED'
      AND (publisher_upgrade_pending = 1 OR next_attempt_at IS NOT NULL)
    )
  )
  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
`;

function sameFinalizationRecoveryIdentity(
  existing: FinalizationRecoveryEntry,
  input: FinalizationRecoveryReceiveInput,
): boolean {
  return existing.chainId === input.chainId
    && existing.contextGraphId === input.contextGraphId
    && existing.ual === input.ual
    && existing.txHash.toLowerCase() === input.txHash.toLowerCase()
    && existing.assertionVersion === input.assertionVersion
    && existing.merkleRoot.toLowerCase() === input.merkleRoot.toLowerCase()
    && existing.kaId === input.kaId
    && existing.batchId === input.batchId
    && existing.targetContextGraphId === input.targetContextGraphId;
}

interface PendingFinalizationRow {
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

function pendingRowToReceiveInput(row: PendingFinalizationRow): FinalizationRecoveryReceiveInput {
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

function samePendingFinalization(
  row: PendingFinalizationRow,
  input: FinalizationRecoveryReceiveInput,
  digest: string,
): boolean {
  return row.envelope_sha256 === digest
    && Buffer.from(row.raw_envelope).equals(Buffer.from(input.rawMessage))
    && row.chain_id === input.chainId
    && row.context_graph_id === input.contextGraphId
    && row.ual === input.ual
    && row.tx_hash.toLowerCase() === input.txHash.toLowerCase()
    && row.assertion_version === input.assertionVersion
    && row.merkle_root.toLowerCase() === input.merkleRoot.toLowerCase()
    && row.ka_id === input.kaId
    && row.batch_id === input.batchId
    && (row.target_context_graph_id ?? undefined) === input.targetContextGraphId;
}

export class SqliteFinalizationRecoveryStore implements FinalizationRecoveryStore {
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #mutationTail: Promise<void> = Promise.resolve();
  readonly #policy: FinalizationRecoveryRetentionPolicy;

  private constructor(
    readonly databasePath: string,
    private readonly database: DatabaseSync,
    options: SqliteFinalizationRecoveryStoreOptions,
  ) {
    this.#policy = resolveFinalizationRecoveryRetentionPolicy(options);
  }

  static async open(
    dataDir: string,
    options: SqliteFinalizationRecoveryStoreOptions = {},
  ): Promise<SqliteFinalizationRecoveryStore> {
    const opened = await openFinalizationRecoveryDatabase(dataDir);
    return new SqliteFinalizationRecoveryStore(
      opened.databasePath,
      opened.database,
      options,
    );
  }

  get closed(): boolean {
    return this.#closed;
  }

  async get(key: string): Promise<FinalizationRecoveryEntry | undefined> {
    if (this.#closed || this.#closing) return undefined;
    await this.#mutationTail;
    if (this.#closed) return undefined;
    const row = this.database.prepare(
      'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
    ).get(key);
    return row ? finalizationRecoveryRowToEntry(row) : undefined;
  }

  private insertLiveWithinTransaction(
    input: FinalizationRecoveryReceiveInput,
    digest: string,
    createdAt: number,
    updatedAt = createdAt,
    trustedPublisherPeerId?: string,
  ): void {
    this.database.prepare(`
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
      trustedPublisherPeerId ?? null,
      input.ual,
      input.txHash.toLowerCase(),
      input.assertionVersion,
      input.merkleRoot.toLowerCase(),
      input.kaId,
      input.batchId,
      input.targetContextGraphId ?? null,
      digest,
      Buffer.from(input.rawMessage),
      createdAt,
      updatedAt,
    );
  }

  private insertPendingWithinTransaction(
    input: FinalizationRecoveryReceiveInput,
    digest: string,
    now: number,
  ): void {
    this.database.prepare(`
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
      null,
      input.ual,
      input.txHash.toLowerCase(),
      input.assertionVersion,
      input.merkleRoot.toLowerCase(),
      input.kaId,
      input.batchId,
      input.targetContextGraphId ?? null,
      digest,
      Buffer.from(input.rawMessage),
      now,
      now,
    );
  }

  receive(input: FinalizationRecoveryReceiveInput): Promise<FinalizationRecoveryReceiveResult> {
    if (this.#closed || this.#closing) return Promise.resolve({ status: 'closed' });
    return this.mutate(() => {
      if (this.#closed) return { status: 'closed' };
      if (input.rawMessage.byteLength > this.#policy.maxEnvelopeBytes) {
        return { status: 'capacity' };
      }
      this.prune();
      const existingRow = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(input.key);
      const digest = finalizationEnvelopeSha256(input.rawMessage);
      if (existingRow) {
        const existing = finalizationRecoveryRowToEntry(existingRow);
        const sameEnvelope = existing.envelopeSha256 === digest
          && Buffer.from(existing.rawMessage).equals(Buffer.from(input.rawMessage));
        if (existing.state === 'REORGED') {
          return sameEnvelope && sameFinalizationRecoveryIdentity(existing, input)
            ? { status: 'existing', entry: existing }
            : { status: 'conflict' };
        }
        if (existing.state === 'SETTLED') {
          return sameEnvelope && sameFinalizationRecoveryIdentity(existing, input)
            ? { status: 'existing', entry: existing }
            : { status: 'conflict' };
        }
        if (
          !sameEnvelope
          || existing.chainId !== input.chainId
          || existing.contextGraphId !== input.contextGraphId
          || existing.ual !== input.ual
          || existing.txHash.toLowerCase() !== input.txHash.toLowerCase()
        ) return { status: 'conflict' };
        return { status: 'existing', entry: existing };
      }
      const pendingRow = this.database.prepare(
        'SELECT * FROM finalization_pending_v2 WHERE key = ?',
      ).get(input.key) as PendingFinalizationRow | undefined;
      if (pendingRow) {
        try {
          pendingRowToReceiveInput(pendingRow);
          return samePendingFinalization(pendingRow, input, digest)
            ? { status: 'pending' }
            : { status: 'conflict' };
        } catch {
          this.database.prepare(
            'DELETE FROM finalization_pending_v2 WHERE key = ?',
          ).run(pendingRow.key);
          return { status: 'conflict' };
        }
      }
      const now = this.#policy.now();
      if (!hasFinalizationRecoveryCapacity(this.database, this.#policy, input)) {
        if (!hasFinalizationRecoveryDeferredCapacity(this.database, this.#policy, input)) {
          return { status: 'capacity' };
        }
        this.transaction(() => {
          this.insertPendingWithinTransaction(input, digest, now);
        });
        return { status: 'pending' };
      }
      this.transaction(() => {
        this.insertLiveWithinTransaction(input, digest, now);
      });
      const row = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(input.key);
      if (!row) throw new Error('Finalization inbox insert returned no row');
      return { status: 'inserted', entry: finalizationRecoveryRowToEntry(row) };
    });
  }

  promotePending(limit: number): Promise<number> {
    if (this.#closed || this.#closing) return Promise.resolve(0);
    const boundedLimit = Math.max(1, Math.trunc(limit));
    return this.mutate(() => {
      if (this.#closed) return 0;
      let promoted = 0;
      this.transaction(() => {
        const now = this.#policy.now();
        this.pruneWithinTransaction(now);
        const rows = this.database.prepare(`
          SELECT * FROM finalization_pending_v2
          ORDER BY created_at ASC, key ASC
          LIMIT ?
        `).all(this.#policy.maxDeferredEntries) as unknown as PendingFinalizationRow[];
        for (const row of rows) {
          if (promoted >= boundedLimit) break;
          let input: FinalizationRecoveryReceiveInput;
          try {
            input = pendingRowToReceiveInput(row);
          } catch {
            this.database.prepare(
              'DELETE FROM finalization_pending_v2 WHERE key = ?',
            ).run(row.key);
            continue;
          }
          if (!hasFinalizationRecoveryCapacity(this.database, this.#policy, input)) {
            continue;
          }
          this.insertLiveWithinTransaction(
            input,
            row.envelope_sha256,
            row.created_at,
            now,
            row.trusted_publisher_peer_id ?? undefined,
          );
          this.database.prepare(
            'DELETE FROM finalization_pending_v2 WHERE key = ?',
          ).run(row.key);
          promoted += 1;
        }
      });
      return promoted;
    });
  }

  recordPendingTrustedPublisher(
    key: string,
    publisherPeerId: string,
  ): Promise<boolean> {
    if (
      this.#closed
      || this.#closing
      || publisherPeerId.length === 0
      || publisherPeerId.trim() !== publisherPeerId
    ) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      const result = this.database.prepare(`
        UPDATE finalization_pending_v2
        SET trusted_publisher_peer_id = ?, updated_at = ?
        WHERE key = ?
          AND (
            trusted_publisher_peer_id IS NULL
            OR trusted_publisher_peer_id = ?
          )
      `).run(publisherPeerId, this.#policy.now(), key, publisherPeerId);
      return result.changes > 0;
    });
  }

  recordTrustedPublisher(
    key: string,
    generation: number,
    publisherPeerId: string,
  ): Promise<boolean> {
    if (
      this.#closed
      || this.#closing
      || publisherPeerId.length === 0
      || publisherPeerId.trim() !== publisherPeerId
    ) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      const now = this.#policy.now();
      const result = this.database.prepare(`
        UPDATE finalization_inbox_v1
        SET trusted_publisher_peer_id = ?, updated_at = ?
        WHERE key = ? AND generation = ?
          AND state IN ('RECEIVED','VERIFIED','REORGED')
          AND (
            trusted_publisher_peer_id IS NULL
            OR trusted_publisher_peer_id = ?
          )
      `).run(publisherPeerId, now, key, generation, publisherPeerId);
      return result.changes > 0;
    });
  }

  recordSettledPublisherUpgrade(
    key: string,
    generation: number,
    publisherPeerId: string,
  ): Promise<FinalizationRecoverySettledPublisherUpgradeResult> {
    if (this.#closed || this.#closing) return Promise.resolve({ status: 'closed' });
    if (
      publisherPeerId.length === 0
      || publisherPeerId.trim() !== publisherPeerId
    ) return Promise.resolve({ status: 'conflict' });
    return this.mutate(() => {
      if (this.#closed) return { status: 'closed' };
      const row = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(key);
      if (!row) return { status: 'missing' };
      const current = finalizationRecoveryRowToEntry(row);
      if (
        current.state !== 'SETTLED'
        || current.generation !== generation
        || (
          current.trustedPublisherPeerId !== undefined
          && current.trustedPublisherPeerId !== publisherPeerId
        )
      ) return { status: 'conflict' };
      if (current.publisherUpgradePending) {
        return { status: 'existing', entry: current };
      }
      const result = this.database.prepare(`
        UPDATE finalization_inbox_v1
        SET trusted_publisher_peer_id = ?,
            publisher_upgrade_pending = 1,
            updated_at = ?
        WHERE key = ? AND generation = ? AND state = 'SETTLED'
          AND publisher_upgrade_pending = 0
          AND (
            trusted_publisher_peer_id IS NULL
            OR trusted_publisher_peer_id = ?
          )
      `).run(
        publisherPeerId,
        this.#policy.now(),
        key,
        generation,
        publisherPeerId,
      );
      if (result.changes === 0) return { status: 'conflict' };
      const updated = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(key);
      if (!updated) return { status: 'missing' };
      return {
        status: 'recorded',
        entry: finalizationRecoveryRowToEntry(updated),
      };
    });
  }

  rearmSettledWithTrustedPublisher(
    key: string,
    generation: number,
    publisherPeerId: string,
    lastError: string,
  ): Promise<boolean> {
    if (
      this.#closed
      || this.#closing
      || publisherPeerId.length === 0
      || publisherPeerId.trim() !== publisherPeerId
    ) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      let changed = false;
      this.transaction(() => {
        const now = this.#policy.now();
        const result = this.database.prepare(`
          UPDATE finalization_inbox_v1
          SET state = 'REORGED',
              trusted_publisher_peer_id = ?,
              block_number = NULL,
              block_hash = NULL,
              tx_index = NULL,
              publisher_address = NULL,
              author_address = NULL,
              verified_evidence_json = NULL,
              generation = generation + 1,
              attempt_count = 0,
              next_attempt_at = NULL,
              last_error = ?,
              updated_at = ?
          WHERE key = ? AND generation = ? AND state = 'SETTLED'
            AND publisher_upgrade_pending = 1
            AND trusted_publisher_peer_id = ?
        `).run(
          publisherPeerId,
          lastError,
          now,
          key,
          generation,
          publisherPeerId,
        );
        changed = result.changes > 0;
      });
      return changed;
    });
  }

  commitVerifiedEvidence(
    key: string,
    generation: number,
    commit: FinalizationRecoveryVerifiedEvidenceCommit,
  ): Promise<FinalizationRecoveryVerifyResult> {
    if (this.#closed || this.#closing) return Promise.resolve({ status: 'closed' });
    return this.mutate(() => {
      if (this.#closed) return { status: 'closed' };
      return this.commitVerifiedEvidenceWithinTransaction(
        key,
        generation,
        commit,
      );
    });
  }

  private commitVerifiedEvidenceWithinTransaction(
    key: string,
    generation: number,
    commit: FinalizationRecoveryVerifiedEvidenceCommit,
  ): FinalizationRecoveryVerifyResult {
    const { evidence } = commit;
    let outcome: FinalizationRecoveryVerifyResult = { status: 'conflict' };
    this.transaction(() => {
      const row = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(key);
      if (!row) {
        outcome = { status: 'missing' };
        return;
      }
      const current = finalizationRecoveryRowToEntry(row);
      if (current.generation !== generation) return;
      if (current.verifiedEvidence) {
        outcome = sameFinalizationRecoveryEvidence(current.verifiedEvidence, evidence)
          ? { status: 'existing', entry: current }
          : { status: 'conflict' };
        return;
      }
      if (
        (current.state !== 'RECEIVED' && current.state !== 'REORGED')
        || (
          commit.placement === 'canonical-moved'
          && (current.state !== 'RECEIVED' || generation !== 0)
        )
        || current.txHash.toLowerCase() !== evidence.transactionHash.toLowerCase()
        || current.assertionVersion !== evidence.assertionVersion
      ) return;

      const updatePlan = commit.placement === 'canonical-moved'
        ? {
            generation: generation + 1,
            attemptCount: 0,
            nextAttemptAt: null,
            lastError: commit.reason,
          }
        : {
            generation,
            attemptCount: current.attemptCount,
            nextAttemptAt: current.nextAttemptAt ?? null,
            lastError: current.lastError ?? null,
          };
      const update = this.database.prepare(`
        UPDATE finalization_inbox_v1
        SET state = 'VERIFIED',
            block_number = ?,
            block_hash = ?,
            tx_index = ?,
            publisher_address = ?,
            author_address = ?,
            verified_evidence_json = ?,
            generation = ?,
            attempt_count = ?,
            next_attempt_at = ?,
            last_error = ?,
            updated_at = ?
        WHERE key = ? AND generation = ? AND state = ?
          AND verified_evidence_json IS NULL
      `).run(
        evidence.blockNumber,
        evidence.blockHash,
        evidence.txIndex,
        evidence.publisherAddress,
        evidence.authorAddress ?? null,
        JSON.stringify(evidence),
        updatePlan.generation,
        updatePlan.attemptCount,
        updatePlan.nextAttemptAt,
        updatePlan.lastError,
        this.#policy.now(),
        key,
        generation,
        current.state,
      );
      if (update.changes === 0) return;
      const updated = this.database.prepare(
        'SELECT * FROM finalization_inbox_v1 WHERE key = ?',
      ).get(key);
      if (!updated) {
        outcome = { status: 'missing' };
        return;
      }
      const entry = finalizationRecoveryRowToEntry(updated);
      if (
        entry.generation === updatePlan.generation
        && entry.verifiedEvidence
        && sameFinalizationRecoveryEvidence(entry.verifiedEvidence, evidence)
      ) outcome = { status: 'verified', entry };
    });
    return outcome;
  }

  markReorged(key: string, generation: number, lastError: string): Promise<boolean> {
    if (this.#closed || this.#closing) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      let changed = false;
      this.transaction(() => {
        const now = this.#policy.now();
        const result = this.database.prepare(`
          UPDATE finalization_inbox_v1
          SET state = 'REORGED',
              block_number = NULL,
              block_hash = NULL,
              tx_index = NULL,
              publisher_address = NULL,
              author_address = NULL,
              verified_evidence_json = NULL,
              generation = generation + 1,
              attempt_count = 0,
              next_attempt_at = NULL,
              last_error = ?,
              updated_at = ?
          WHERE key = ? AND generation = ? AND state IN ('RECEIVED','VERIFIED','SETTLED')
        `).run(lastError, now, key, generation);
        changed = result.changes > 0;
      });
      return changed;
    });
  }

  clearSettledRetry(key: string, generation: number): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve();
    return this.mutate(() => {
      if (this.#closed) return;
      this.database.prepare(`
        UPDATE finalization_inbox_v1
        SET attempt_count = 0,
            next_attempt_at = NULL,
            last_error = NULL,
            updated_at = ?
        WHERE key = ? AND generation = ? AND state = 'SETTLED'
      `).run(this.#policy.now(), key, generation);
    });
  }

  rejectSettled(key: string, generation: number, lastError: string): Promise<boolean> {
    if (this.#closed || this.#closing) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      let changed = false;
      this.transaction(() => {
        const now = this.#policy.now();
        const result = this.database.prepare(`
          UPDATE finalization_inbox_v1
          SET state = 'REJECTED',
              publisher_upgrade_pending = 0,
              next_attempt_at = NULL,
              last_error = ?,
              updated_at = ?
          WHERE key = ? AND generation = ? AND state = 'SETTLED'
        `).run(lastError, now, key, generation);
        changed = result.changes > 0;
        this.pruneWithinTransaction(now);
      });
      return changed;
    });
  }

  isAttemptDue(entry: FinalizationRecoveryEntry): boolean {
    return entry.nextAttemptAt === undefined || entry.nextAttemptAt <= this.#policy.now();
  }

  async listDue(limit: number): Promise<FinalizationRecoveryEntry[]> {
    if (this.#closed || this.#closing) return [];
    if (!Number.isFinite(limit)) return [];
    const boundedLimit = Math.min(
      this.#policy.maxEntries,
      Math.max(0, Math.trunc(limit)),
    );
    if (boundedLimit === 0) return [];
    await this.#mutationTail;
    if (this.#closed) return [];
    const now = this.#policy.now();
    return this.database.prepare(`
      SELECT * FROM finalization_inbox_v1
      WHERE ${DUE_FINALIZATION_SQL_PREDICATE}
      ORDER BY COALESCE(next_attempt_at, updated_at), updated_at, key
      LIMIT ?
    `).all(now, boundedLimit).map(finalizationRecoveryRowToEntry);
  }

  async listForKnowledgeAsset(input: {
    chainId: string;
    contextGraphId: string;
    ual: string;
    kaId: string;
  }): Promise<FinalizationRecoveryEntry[]> {
    if (this.#closed || this.#closing) return [];
    await this.#mutationTail;
    if (this.#closed) return [];
    // Future-due SETTLED rows must remain visible so reconciliation can keep
    // the current ordinal pending without issuing another receipt RPC early.
    return this.database.prepare(`
      SELECT * FROM finalization_inbox_v1
      WHERE chain_id = ? AND context_graph_id = ? AND ual = ? AND ka_id = ?
        AND state IN ('RECEIVED','VERIFIED','REORGED','SETTLED')
      ORDER BY created_at, key
    `).all(
      input.chainId,
      input.contextGraphId,
      input.ual,
      input.kaId,
    )
      .map(finalizationRecoveryRowToEntry);
  }

  /** Bounded diagnostic/test snapshot; raw bytes never cross the HTTP status surface. */
  async list(): Promise<FinalizationRecoveryEntry[]> {
    if (this.#closed || this.#closing) return [];
    await this.#mutationTail;
    if (this.#closed) return [];
    return this.database.prepare(
      'SELECT * FROM finalization_inbox_v1 ORDER BY created_at, key',
    ).all().map(finalizationRecoveryRowToEntry);
  }

  transition(
    key: string,
    generation: number,
    state: 'SETTLED' | 'SUPERSEDED' | 'REJECTED' | 'UNSUPPORTED',
    lastError?: string,
  ): Promise<boolean> {
    if (this.#closed || this.#closing) return Promise.resolve(false);
    return this.mutate(() => {
      if (this.#closed) return false;
      let changed = false;
      this.transaction(() => {
        const now = this.#policy.now();
        const result = this.database.prepare(`
          UPDATE finalization_inbox_v1
          SET state = ?,
              publisher_upgrade_pending = 0,
              attempt_count = CASE WHEN ? = 'SETTLED' THEN 0 ELSE attempt_count END,
              last_error = ?,
              next_attempt_at = NULL,
              updated_at = ?
          WHERE key = ? AND generation = ?
            AND state IN ('RECEIVED','VERIFIED','REORGED')
        `).run(state, state, lastError ?? null, now, key, generation);
        changed = result.changes > 0;
        this.pruneWithinTransaction(now);
      });
      return changed;
    });
  }

  recordAttempt(
    key: string,
    generation: number,
    lastError?: string,
    retryDelayMs?: number,
  ): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve();
    return this.mutate(() => {
      if (this.#closed) return;
      const now = this.#policy.now();
      const nextAttemptAt = retryDelayMs === undefined ? null : now + retryDelayMs;
      this.database.prepare(`
        UPDATE finalization_inbox_v1
        SET attempt_count = attempt_count + 1,
            last_error = ?,
            next_attempt_at = CASE
              WHEN ? IS NULL THEN next_attempt_at
              WHEN next_attempt_at IS NULL THEN ?
              ELSE MAX(next_attempt_at, ?)
            END,
            updated_at = ?
        WHERE key = ? AND generation = ?
          AND state IN ('RECEIVED','VERIFIED','REORGED','SETTLED')
      `).run(
        lastError ?? null,
        nextAttemptAt,
        nextAttemptAt,
        nextAttemptAt,
        now,
        key,
        generation,
      );
    });
  }

  async health(): Promise<FinalizationRecoveryHealth> {
    if (this.#closing) {
      return {
        available: false,
        closed: false,
        degradedReason: 'closing',
        stateCounts: {},
        livePayloadBytes: 0,
        dueEntries: 0,
      };
    }
    await this.#mutationTail;
    if (this.#closed) {
      return {
        available: false,
        closed: true,
        degradedReason: 'closed',
        stateCounts: {},
        livePayloadBytes: 0,
        dueEntries: 0,
      };
    }
    const counts = this.database.prepare(
      'SELECT state, COUNT(*) AS count FROM finalization_inbox_v1 GROUP BY state',
    ).all();
    const stateCounts: Partial<Record<FinalizationRecoveryState, number>> = {};
    for (const row of counts) stateCounts[String(row.state) as FinalizationRecoveryState] = Number(row.count);
    const now = this.#policy.now();
    const due = this.database.prepare(`
      SELECT COUNT(*) AS count, MIN(created_at) AS oldest
      FROM finalization_inbox_v1
      WHERE ${DUE_FINALIZATION_SQL_PREDICATE}
    `).get(now) as { count: number | bigint; oldest: number | bigint | null };
    const capacity = readFinalizationRecoveryCapacity(this.database, this.#policy);
    const deferred = readFinalizationRecoveryDeferredCapacity(this.database);
    return {
      available: true,
      closed: false,
      ready: !capacity.capacityExhausted,
      ...(capacity.capacityExhausted ? { degradedReason: 'capacity-exhausted' } : {}),
      stateCounts,
      livePayloadBytes: capacity.livePayloadBytes,
      dueEntries: Number(due.count),
      deferredEntries: deferred.entries,
      deferredPayloadBytes: deferred.payloadBytes,
      ...(due.oldest === null
        ? {}
        : { oldestDueAgeMs: Math.max(0, now - Number(due.oldest)) }),
      ...(capacity.oldest === undefined
        ? {}
        : { oldestPendingAgeMs: Math.max(0, now - capacity.oldest) }),
      ...(deferred.oldest === undefined
        ? {}
        : { oldestDeferredAgeMs: Math.max(0, now - deferred.oldest) }),
    };
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#closed) return;
    this.#closing = true;
    this.#closePromise = (async () => {
      await this.#mutationTail;
      try {
        this.database.exec('PRAGMA busy_timeout = 0');
        // Compaction is not a durability boundary: FULL commits make the WAL
        // recoverable. A live prepared statement can make checkpointing return
        // SQLITE_LOCKED, so connection close remains the mandatory boundary.
        try { this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* retain WAL */ }
        this.database.close();
        this.#closed = true;
        fsyncFinalizationRecoveryDatabase(this.databasePath);
      } finally {
        this.#closing = false;
      }
    })();
    return this.#closePromise;
  }

  private mutate<T>(operation: () => T): Promise<T> {
    const run = this.#mutationTail.catch(() => undefined).then(operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private transaction(operation: () => void): void {
    let open = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      open = true;
      operation();
      this.database.exec('COMMIT');
      open = false;
    } catch (error) {
      if (open) {
        try { this.database.exec('ROLLBACK'); } catch { /* retain transaction failure */ }
      }
      throw error;
    }
  }

  private prune(): void {
    const now = this.#policy.now();
    this.transaction(() => {
      this.pruneWithinTransaction(now);
    });
  }

  private pruneWithinTransaction(now: number): void {
    pruneFinalizationRecoveryRowsWithinTransaction(
      this.database,
      this.#policy,
      now,
    );
  }
}

export async function openSqliteFinalizationRecoveryStore(
  dataDir: string,
  options: SqliteFinalizationRecoveryStoreOptions = {},
): Promise<SqliteFinalizationRecoveryStore> {
  return SqliteFinalizationRecoveryStore.open(dataDir, options);
}
