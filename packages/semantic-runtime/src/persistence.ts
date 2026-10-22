import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { RUNTIME_DATABASE_FILENAME, RUNTIME_DATABASE_SCHEMA_VERSION, SCHEMA_V1, SCHEMA_V2, SCHEMA_V3 } from './persistence-schema.js';
import { ApprovalRecord, CapabilityRecord, CommitRuntimeTransition, EffectRecord, EffectState, EffectTransitionRecord, ExecutionRecord, ExecutionStatus, PrepareEffectRecord, ProgramConfigurationRecord, RuntimeEventRecord, SnapshotRecord, SqlEffectRow, SqlExecutionRow, StrategyArtifactRecord } from './persistence-types.js';
import { EFFECT_TRANSITIONS, ZERO_HASH, assertDigestHex, bytesEqual, effectFromRow, effectTransitionHash, executionFromRow, requireValue, runtimeEventHash, snapshotStateHash } from './persistence-codec.js';

export class SemanticRuntimeStore {
  readonly databasePath: string;
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath);
    this.db.defaultSafeIntegers(true);
    this.configure();
    this.migrate();
    this.verifySchema();
    this.recoverDispatchingEffects();
  }

  static openInDataDirectory(dataDirectory: string): SemanticRuntimeStore {
    return new SemanticRuntimeStore(path.join(dataDirectory, RUNTIME_DATABASE_FILENAME));
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  programConfigurationRecords(): ProgramConfigurationRecord[] {
    const rows = this.db.prepare(`SELECT kind, context_graph_id, operation_iri, revision, payload, updated_by, updated_at
      FROM program_configuration ORDER BY kind, context_graph_id, operation_iri`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      kind: row.kind as ProgramConfigurationRecord['kind'], contextGraphId: String(row.context_graph_id), operationIri: String(row.operation_iri),
      revision: Number(row.revision), payload: row.payload === null ? null : String(row.payload),
      updatedBy: String(row.updated_by), updatedAt: Number(row.updated_at),
    }));
  }

  /** CAS and durable commit precede publishing the new in-process authority. */
  writeProgramConfiguration(record: Omit<ProgramConfigurationRecord, 'revision'>, expectedRevision: number): number {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER
      || (record.payload !== null && Buffer.byteLength(record.payload, 'utf8') > 262_144)) throw new Error('INVALID_PROGRAM_CONFIGURATION');
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT revision FROM program_configuration WHERE kind=? AND context_graph_id=? AND operation_iri=?')
        .get(record.kind, record.contextGraphId, record.operationIri) as { revision: bigint } | undefined;
      if (Number(row?.revision ?? 0) !== expectedRevision) throw new Error('PROGRAM_CONFIGURATION_CONFLICT');
      // Independent context-graph owners have independent configuration quotas.
      // Disabled grants/tombstones still occupy their graph's durable CAS slot.
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM program_configuration WHERE kind=? AND context_graph_id=?')
        .get(record.kind, record.contextGraphId) as { n: bigint };
      if (!row && count.n >= 256n) throw new Error('PROGRAM_CONFIGURATION_LIMIT');
      const revision = expectedRevision + 1;
      this.db.prepare(`INSERT INTO program_configuration(kind, context_graph_id, operation_iri, revision, payload, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(kind, context_graph_id, operation_iri) DO UPDATE SET
        revision=excluded.revision, payload=excluded.payload, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
        .run(record.kind, record.contextGraphId, record.operationIri, BigInt(revision), record.payload, record.updatedBy, BigInt(record.updatedAt));
      return revision;
    })();
  }

  registerStrategyArtifact(record: StrategyArtifactRecord): void {
    assertDigestHex(record.artifactHash, 'artifactHash');
    const expectedArtifactHash = createHash('sha256')
      .update('DKG-STRATEGY-PLAN-V1\0')
      .update(record.canonicalPlan)
      .digest('hex');
    if (record.artifactHash !== expectedArtifactHash) {
      throw new Error('strategy artifact hash does not match canonical plan bytes');
    }
    this.db.prepare(`
      INSERT INTO strategy_artifact (
        artifact_hash, strategy_id, version, canonical_plan, source_ref,
        signature, review_state, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(artifact_hash) DO NOTHING
    `).run(
      record.artifactHash,
      record.strategyId,
      record.version,
      Buffer.from(record.canonicalPlan),
      record.sourceRef,
      record.signature ? Buffer.from(record.signature) : null,
      record.reviewState,
      BigInt(record.createdAt),
    );
    const stored = this.db.prepare(`
      SELECT canonical_plan FROM strategy_artifact WHERE artifact_hash = ?
    `).get(record.artifactHash) as { canonical_plan: Buffer } | undefined;
    if (!stored || !bytesEqual(stored.canonical_plan, record.canonicalPlan)) {
      throw new Error('strategy artifact identity collision or persistence failure');
    }
  }

  strategyArtifact(artifactHash: string): StrategyArtifactRecord | null {
    const row = this.db.prepare(`
      SELECT artifact_hash, strategy_id, version, canonical_plan, source_ref,
             signature, review_state, created_at
      FROM strategy_artifact WHERE artifact_hash = ?
    `).get(artifactHash) as {
      artifact_hash: string;
      strategy_id: string;
      version: string;
      canonical_plan: Buffer;
      source_ref: string;
      signature: Buffer | null;
      review_state: StrategyArtifactRecord['reviewState'];
      created_at: bigint;
    } | undefined;
    return row ? {
      artifactHash: row.artifact_hash,
      strategyId: row.strategy_id,
      version: row.version,
      canonicalPlan: Uint8Array.from(row.canonical_plan),
      sourceRef: row.source_ref,
      signature: row.signature ? Uint8Array.from(row.signature) : undefined,
      reviewState: row.review_state,
      createdAt: Number(row.created_at),
    } : null;
  }

  createExecution(record: Omit<ExecutionRecord, 'nextEventSeq' | 'snapshotSeq' | 'stateDigest'>): void {
    this.db.prepare(`
      INSERT INTO execution (
        execution_id, plan_id, partition_id, status, graph_revision,
        policy_epoch, root_process_id, next_event_seq, snapshot_seq,
        lease_epoch, state_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, ?, NULL)
    `).run(
      record.executionId,
      record.planId,
      record.partitionId,
      record.status,
      record.graphRevision,
      record.policyEpoch,
      record.rootProcessId,
      record.leaseEpoch,
    );
  }

  execution(executionId: string): ExecutionRecord | null {
    const row = this.db.prepare(`SELECT * FROM execution WHERE execution_id = ?`).get(
      executionId,
    ) as SqlExecutionRow | undefined;
    return row ? executionFromRow(row) : null;
  }

  commitRuntimeTransition(input: CommitRuntimeTransition): RuntimeEventRecord {
    return this.db.transaction(() => {
      const execution = this.execution(input.executionId);
      if (!execution || execution.status !== 'active') {
        throw new Error('runtime transition requires an active durable execution');
      }
      if (execution.nextEventSeq !== input.expectedNextSeq) {
        throw new Error(
          `runtime event sequence mismatch: expected ${execution.nextEventSeq}, got ${input.expectedNextSeq}`,
        );
      }
      const previous = this.db.prepare(`
        SELECT event_hash FROM runtime_event
        WHERE execution_id = ? ORDER BY seq DESC LIMIT 1
      `).get(input.executionId) as { event_hash: Buffer } | undefined;
      const previousHash = previous?.event_hash ?? Buffer.from(ZERO_HASH);
      const eventHash = runtimeEventHash({
        executionId: input.executionId,
        seq: input.expectedNextSeq,
        eventId: input.eventId,
        eventType: input.eventType,
        cbor: input.eventCbor,
        previousHash,
      });
      this.db.prepare(`
        INSERT INTO runtime_event (
          execution_id, seq, event_id, event_type, cbor, event_hash, previous_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.executionId,
        input.expectedNextSeq,
        input.eventId,
        input.eventType,
        Buffer.from(input.eventCbor),
        Buffer.from(eventHash),
        previousHash,
      );

      let snapshotSeq = execution.snapshotSeq;
      if (input.snapshot) {
        const snapshotHash = snapshotStateHash(
          input.snapshot.partitionId,
          input.expectedNextSeq,
          input.snapshot.schemaVersion,
          input.snapshot.wasmAbiVersion,
          input.snapshot.cbor,
        );
        this.db.prepare(`
          INSERT INTO snapshot (
            partition_id, seq, schema_version, wasm_abi_version,
            state_hash, cbor, created_at, valid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          input.snapshot.partitionId,
          input.expectedNextSeq,
          BigInt(input.snapshot.schemaVersion),
          BigInt(input.snapshot.wasmAbiVersion),
          Buffer.from(snapshotHash),
          Buffer.from(input.snapshot.cbor),
          BigInt(input.snapshot.createdAt),
        );
        snapshotSeq = input.expectedNextSeq;
      }
      this.db.prepare(`
        UPDATE execution
        SET next_event_seq = ?, snapshot_seq = ?, state_digest = ?
        WHERE execution_id = ? AND next_event_seq = ?
      `).run(
        input.expectedNextSeq + 1n,
        snapshotSeq,
        Buffer.from(input.stateDigest),
        input.executionId,
        input.expectedNextSeq,
      );
      return {
        executionId: input.executionId,
        seq: input.expectedNextSeq,
        eventId: input.eventId,
        eventType: input.eventType,
        cbor: Uint8Array.from(input.eventCbor),
        eventHash,
        previousHash: Uint8Array.from(previousHash),
      };
    })();
  }

  runtimeEventsAfter(executionId: string, seq: bigint): RuntimeEventRecord[] {
    const rows = this.db.prepare(`
      SELECT execution_id, seq, event_id, event_type, cbor, event_hash, previous_hash
      FROM runtime_event WHERE execution_id = ? AND seq > ? ORDER BY seq ASC
    `).all(executionId, seq) as Array<{
      execution_id: string;
      seq: bigint;
      event_id: string;
      event_type: string;
      cbor: Buffer;
      event_hash: Buffer;
      previous_hash: Buffer;
    }>;
    return rows.map((row) => ({
      executionId: row.execution_id,
      seq: BigInt(row.seq),
      eventId: row.event_id,
      eventType: row.event_type,
      cbor: Uint8Array.from(row.cbor),
      eventHash: Uint8Array.from(row.event_hash),
      previousHash: Uint8Array.from(row.previous_hash),
    }));
  }

  hasRuntimeEvent(executionId: string, eventId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM runtime_event WHERE execution_id = ? AND event_id = ?
    `).get(executionId, eventId) !== undefined;
  }

  verifyRuntimeEventChain(executionId: string): void {
    const events = this.runtimeEventsAfter(executionId, 0n);
    let previous = Uint8Array.from(ZERO_HASH);
    let expectedSeq = 1n;
    for (const event of events) {
      if (event.seq !== expectedSeq || !bytesEqual(event.previousHash, previous)) {
        throw new Error(`runtime event chain ordering failure at sequence ${event.seq}`);
      }
      const expectedHash = runtimeEventHash({
        executionId,
        seq: event.seq,
        eventId: event.eventId,
        eventType: event.eventType,
        cbor: event.cbor,
        previousHash: previous,
      });
      if (!bytesEqual(expectedHash, event.eventHash)) {
        throw new Error(`runtime event chain hash failure at sequence ${event.seq}`);
      }
      previous = Uint8Array.from(event.eventHash);
      expectedSeq += 1n;
    }
  }

  newestValidSnapshot(partitionId: string): SnapshotRecord | null {
    const rows = this.db.prepare(`
      SELECT partition_id, seq, schema_version, wasm_abi_version,
             state_hash, cbor, created_at
      FROM snapshot
      WHERE partition_id = ? AND valid = 1
      ORDER BY seq DESC
    `).all(partitionId) as Array<{
      partition_id: string;
      seq: bigint;
      schema_version: bigint;
      wasm_abi_version: bigint;
      state_hash: Buffer;
      cbor: Buffer;
      created_at: bigint;
    }>;
    for (const row of rows) {
      const expected = snapshotStateHash(
        row.partition_id,
        BigInt(row.seq),
        Number(row.schema_version),
        Number(row.wasm_abi_version),
        row.cbor,
      );
      if (bytesEqual(expected, row.state_hash)) {
        return {
          partitionId: row.partition_id,
          seq: BigInt(row.seq),
          schemaVersion: Number(row.schema_version),
          wasmAbiVersion: Number(row.wasm_abi_version),
          stateHash: Uint8Array.from(row.state_hash),
          cbor: Uint8Array.from(row.cbor),
          createdAt: Number(row.created_at),
        };
      }
      this.db.prepare(`
        UPDATE snapshot SET valid = 0 WHERE partition_id = ? AND seq = ?
      `).run(row.partition_id, row.seq);
    }
    return null;
  }

  putCapability(record: CapabilityRecord): void {
    this.db.prepare(`
      INSERT INTO capability_ref (
        capability_id, execution_id, metadata_cbor, host_binding_key,
        policy_epoch, not_before, expires_at, one_shot, consumed_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.capabilityId,
      record.executionId,
      Buffer.from(record.metadataCbor),
      record.hostBindingKey,
      record.policyEpoch,
      BigInt(record.notBefore),
      BigInt(record.expiresAt),
      record.oneShot ? 1n : 0n,
      record.consumedAt === null ? null : BigInt(record.consumedAt),
      record.revokedAt === null ? null : BigInt(record.revokedAt),
    );
  }

  capability(capabilityId: string): CapabilityRecord | null {
    const row = this.db.prepare(`SELECT * FROM capability_ref WHERE capability_id = ?`).get(
      capabilityId,
    ) as {
      capability_id: string;
      execution_id: string;
      metadata_cbor: Buffer;
      host_binding_key: string;
      policy_epoch: bigint;
      not_before: bigint;
      expires_at: bigint;
      one_shot: bigint;
      consumed_at: bigint | null;
      revoked_at: bigint | null;
    } | undefined;
    return row ? {
      capabilityId: row.capability_id,
      executionId: row.execution_id,
      metadataCbor: Uint8Array.from(row.metadata_cbor),
      hostBindingKey: row.host_binding_key,
      policyEpoch: BigInt(row.policy_epoch),
      notBefore: Number(row.not_before),
      expiresAt: Number(row.expires_at),
      oneShot: row.one_shot === 1n,
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
      revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    } : null;
  }

  revokeCapability(capabilityId: string, revokedAt: number): boolean {
    return this.db.prepare(`
      UPDATE capability_ref SET revoked_at = ?
      WHERE capability_id = ? AND revoked_at IS NULL
    `).run(BigInt(revokedAt), capabilityId).changes === 1;
  }

  putApproval(record: ApprovalRecord): void {
    this.db.prepare(`
      INSERT INTO approval (
        approval_id, execution_id, effect_class, principal, request_digest,
        not_before, expires_at, one_shot, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.approvalId,
      record.executionId,
      record.effectClass,
      record.principal,
      Buffer.from(record.requestDigest),
      BigInt(record.notBefore),
      BigInt(record.expiresAt),
      record.oneShot ? 1n : 0n,
      record.consumedAt === null ? null : BigInt(record.consumedAt),
    );
  }

  approval(approvalId: string): ApprovalRecord | null {
    const row = this.db.prepare(`SELECT * FROM approval WHERE approval_id = ?`).get(
      approvalId,
    ) as {
      approval_id: string;
      execution_id: string;
      effect_class: string;
      principal: string;
      request_digest: Buffer;
      not_before: bigint;
      expires_at: bigint;
      one_shot: bigint;
      consumed_at: bigint | null;
    } | undefined;
    return row ? {
      approvalId: row.approval_id,
      executionId: row.execution_id,
      effectClass: row.effect_class,
      principal: row.principal,
      requestDigest: Uint8Array.from(row.request_digest),
      notBefore: Number(row.not_before),
      expiresAt: Number(row.expires_at),
      oneShot: row.one_shot === 1n,
      consumedAt: row.consumed_at === null ? null : Number(row.consumed_at),
    } : null;
  }

  prepareEffect(record: PrepareEffectRecord): EffectRecord {
    if (record.policyDecisionId !== record.authorization.decisionId) {
      throw new Error('effect policy decision reference does not match authorization record');
    }
    if (!record.idempotencyKey) throw new Error('effect idempotency key is required');
    return this.db.transaction(() => {
      const existing = this.effect(record.effectId);
      if (existing) {
        if (
          existing.executionId !== record.executionId
          || existing.idempotencyKey !== record.idempotencyKey
          || !bytesEqual(existing.requestDigest, record.requestDigest)
        ) {
          throw new Error('effect identity was reused for a different request digest');
        }
        return existing;
      }
      const execution = this.execution(record.executionId);
      if (!execution || execution.status !== 'active') {
        throw new Error('effect preparation requires an active execution');
      }
      const capability = this.capability(record.capabilityId);
      if (!capability || capability.executionId !== record.executionId) {
        throw new Error('effect capability is not bound to the execution');
      }
      const capabilityConsumption = this.db.prepare(`
        UPDATE capability_ref
        SET consumed_at = CASE WHEN one_shot = 1 THEN ? ELSE consumed_at END
        WHERE capability_id = ? AND execution_id = ?
          AND (one_shot = 0 OR consumed_at IS NULL)
      `).run(BigInt(record.preparedAt), record.capabilityId, record.executionId);
      if (capabilityConsumption.changes !== 1) {
        throw new Error('effect capability is absent or its one-shot grant was already consumed');
      }
      if (record.approvalId) {
        const result = this.db.prepare(`
          UPDATE approval SET consumed_at = CASE WHEN one_shot = 1 THEN ? ELSE consumed_at END
          WHERE approval_id = ? AND execution_id = ?
            AND (one_shot = 0 OR consumed_at IS NULL)
        `).run(BigInt(record.preparedAt), record.approvalId, record.executionId);
        if (result.changes !== 1) throw new Error('required approval is absent or already consumed');
      }
      this.db.prepare(`
        INSERT INTO authorization_decision (
          decision_id, execution_id, capability_id, policy_id, policy_epoch,
          facts_digest, principal, decision, reason_code, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'allow', ?, ?)
      `).run(
        record.authorization.decisionId,
        record.executionId,
        record.capabilityId,
        record.authorization.policyId,
        record.authorization.policyEpoch,
        Buffer.from(record.authorization.factsDigest),
        record.authorization.principal,
        record.authorization.reasonCode,
        BigInt(record.preparedAt),
      );
      this.db.prepare(`
        INSERT INTO effect (
          effect_id, execution_id, process_id, step_id, attempt_id,
          idempotency_key, idempotency_class, state, request_digest,
          normalized_input, capability_id, policy_decision_id, approval_id,
          adapter_id, adapter_version, reconciliation_rule, compensation_rule,
          verb, resource, budget_reservation, journal_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        record.effectId,
        record.executionId,
        record.processId,
        record.stepId,
        record.attemptId,
        record.idempotencyKey,
        record.idempotencyClass,
        Buffer.from(record.requestDigest),
        Buffer.from(record.normalizedInput),
        record.capabilityId,
        record.policyDecisionId,
        record.approvalId,
        record.adapterId,
        record.adapterVersion,
        record.reconciliationRule,
        record.compensationRule,
        record.verb,
        record.resource,
        record.budgetReservation,
      );
      this.insertEffectTransition(record.effectId, 1n, 'prepared', null, new Uint8Array(), record.preparedAt);
      return requireValue(this.effect(record.effectId), 'prepared effect was not persisted');
    })();
  }

  effect(effectId: string): EffectRecord | null {
    const row = this.db.prepare(`SELECT * FROM effect WHERE effect_id = ?`).get(
      effectId,
    ) as SqlEffectRow | undefined;
    return row ? effectFromRow(row) : null;
  }

  effectsForExecution(executionId: string): EffectRecord[] {
    return (this.db.prepare('SELECT * FROM effect WHERE execution_id = ? ORDER BY effect_id')
      .all(executionId) as SqlEffectRow[]).map(effectFromRow);
  }

  /** Private adapter continuation state, bound to the already authorized effect. */
  adapterCheckpoint(effectId: string): { version: number; payload: Uint8Array } | null {
    const row = this.db.prepare('SELECT version, payload FROM adapter_checkpoint WHERE effect_id = ?')
      .get(effectId) as { version: bigint; payload: Buffer } | undefined;
    return row ? { version: Number(row.version), payload: Uint8Array.from(row.payload) } : null;
  }

  writeAdapterCheckpoint(effectId: string, requestDigest: Uint8Array, payload: Uint8Array, expectedVersion: number): number {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || payload.byteLength > 32 * 1024 * 1024) {
      throw new Error('invalid adapter checkpoint bounds');
    }
    return this.db.transaction(() => {
      const effect = requireValue(this.effect(effectId), 'checkpoint effect does not exist');
      if (!bytesEqual(effect.requestDigest, requestDigest)) throw new Error('checkpoint request digest mismatch');
      const previous = this.adapterCheckpoint(effectId);
      if ((previous?.version ?? 0) !== expectedVersion) throw new Error('concurrent adapter checkpoint update');
      const version = expectedVersion + 1;
      this.db.prepare(`INSERT INTO adapter_checkpoint(effect_id, version, payload, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(effect_id) DO UPDATE SET version=excluded.version, payload=excluded.payload, updated_at=excluded.updated_at`)
        .run(effectId, version, Buffer.from(payload), Date.now());
      return version;
    })();
  }

  transitionEffect(
    effectId: string,
    next: EffectState,
    evidenceRef: string | null,
    cbor: Uint8Array,
    createdAt: number,
  ): EffectRecord {
    return this.db.transaction(() => {
      const current = requireValue(this.effect(effectId), 'effect does not exist');
      if (!EFFECT_TRANSITIONS[current.state].includes(next)) {
        throw new Error(`invalid effect transition ${current.state} -> ${next}`);
      }
      const version = current.journalVersion + 1n;
      const changed = this.db.prepare(`
        UPDATE effect SET state = ?, journal_version = ?
        WHERE effect_id = ? AND state = ? AND journal_version = ?
      `).run(next, version, effectId, current.state, current.journalVersion);
      if (changed.changes !== 1) throw new Error('concurrent effect transition conflict');
      this.insertEffectTransition(effectId, version, next, evidenceRef, cbor, createdAt);
      return requireValue(this.effect(effectId), 'effect disappeared after transition');
    })();
  }

  /** Reconciliation proof and terminal outcome commit together. A crash must
   * not strand an effect between the two individually valid transitions. */
  completeReconciliation(effectId: string, outcome: 'succeeded' | 'failed', evidenceRef: string,
    cbor: Uint8Array, createdAt: number): EffectRecord {
    return this.db.transaction(() => {
      this.transitionEffect(effectId, 'reconciled', evidenceRef, cbor, createdAt);
      return this.transitionEffect(effectId, outcome, evidenceRef, cbor, createdAt);
    })();
  }

  effectTransitions(effectId: string): EffectTransitionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM effect_transition WHERE effect_id = ? ORDER BY version ASC
    `).all(effectId) as Array<{
      effect_id: string;
      version: bigint;
      state: EffectState;
      evidence_ref: string | null;
      cbor: Buffer;
      created_at: bigint;
      previous_hash: Buffer;
      transition_hash: Buffer;
    }>;
    return rows.map((row) => ({
      effectId: row.effect_id,
      version: BigInt(row.version),
      state: row.state,
      evidenceRef: row.evidence_ref,
      cbor: Uint8Array.from(row.cbor),
      createdAt: Number(row.created_at),
      previousHash: Uint8Array.from(row.previous_hash),
      transitionHash: Uint8Array.from(row.transition_hash),
    }));
  }

  verifyEffectChain(effectId: string): void {
    let previous = Uint8Array.from(ZERO_HASH);
    let expectedVersion = 1n;
    for (const transition of this.effectTransitions(effectId)) {
      if (transition.version !== expectedVersion || !bytesEqual(transition.previousHash, previous)) {
        throw new Error(`effect transition ordering failure at version ${transition.version}`);
      }
      const expected = effectTransitionHash(transition, previous);
      if (!bytesEqual(expected, transition.transitionHash)) {
        throw new Error(`effect transition hash failure at version ${transition.version}`);
      }
      previous = Uint8Array.from(transition.transitionHash);
      expectedVersion += 1n;
    }
  }

  effectsInStates(states: readonly EffectState[]): EffectRecord[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM effect WHERE state IN (${placeholders}) ORDER BY effect_id
    `).all(...states) as SqlEffectRow[];
    return rows.map(effectFromRow);
  }

  setExecutionStatus(executionId: string, status: ExecutionStatus): void {
    if (this.db.prepare(`UPDATE execution SET status = ? WHERE execution_id = ?`).run(
      status,
      executionId,
    ).changes !== 1) {
      throw new Error('execution does not exist');
    }
  }

  private configure(): void {
    this.db.pragma('foreign_keys = ON');
    if (this.databasePath !== ':memory:') {
      const journalMode = this.db.pragma('journal_mode = WAL', { simple: true });
      if (String(journalMode).toLowerCase() !== 'wal') {
        throw new Error(`semantic runtime SQLite did not enter WAL mode: ${journalMode}`);
      }
    }
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    if (Number(this.db.pragma('foreign_keys', { simple: true })) !== 1) {
      throw new Error('semantic runtime SQLite foreign keys are disabled');
    }
    if (Number(this.db.pragma('synchronous', { simple: true })) !== 2) {
      throw new Error('semantic runtime SQLite synchronous=FULL was not applied');
    }
  }

  private migrate(): void {
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > RUNTIME_DATABASE_SCHEMA_VERSION) {
      throw new Error(
        `semantic runtime database schema ${version} is newer than supported ${RUNTIME_DATABASE_SCHEMA_VERSION}`,
      );
    }
    if (version === RUNTIME_DATABASE_SCHEMA_VERSION) return;
    this.db.transaction(() => {
      if (version < 1) this.db.exec(SCHEMA_V1);
      if (version < 2) this.db.exec(SCHEMA_V2);
      if (version < 3) this.db.exec(SCHEMA_V3);
      this.db.pragma(`user_version = ${RUNTIME_DATABASE_SCHEMA_VERSION}`);
    })();
  }

  private verifySchema(): void {
    const quickCheck = this.db.pragma('quick_check', { simple: true });
    if (quickCheck !== 'ok') throw new Error(`semantic runtime SQLite quick_check failed: ${quickCheck}`);
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version !== RUNTIME_DATABASE_SCHEMA_VERSION) {
      throw new Error(`semantic runtime database schema is ${version}, expected ${RUNTIME_DATABASE_SCHEMA_VERSION}`);
    }
  }

  private recoverDispatchingEffects(): void {
    const effects = this.effectsInStates(['dispatching', 'dispatched']);
    for (const effect of effects) {
      this.transitionEffect(
        effect.effectId,
        'unknown',
        'host-recovery-observed-ambiguous-dispatch',
        new Uint8Array(),
        Date.now(),
      );
    }
  }

  private insertEffectTransition(
    effectId: string,
    version: bigint,
    state: EffectState,
    evidenceRef: string | null,
    cbor: Uint8Array,
    createdAt: number,
  ): void {
    const previous = this.db.prepare(`
      SELECT transition_hash FROM effect_transition
      WHERE effect_id = ? ORDER BY version DESC LIMIT 1
    `).get(effectId) as { transition_hash: Buffer } | undefined;
    const previousHash = previous?.transition_hash ?? Buffer.from(ZERO_HASH);
    const transition: EffectTransitionRecord = {
      effectId,
      version,
      state,
      evidenceRef,
      cbor,
      createdAt,
      previousHash: Uint8Array.from(previousHash),
      transitionHash: new Uint8Array(),
    };
    const transitionHash = effectTransitionHash(transition, previousHash);
    this.db.prepare(`
      INSERT INTO effect_transition (
        effect_id, version, state, evidence_ref, cbor, created_at,
        previous_hash, transition_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      effectId,
      version,
      state,
      evidenceRef,
      Buffer.from(cbor),
      BigInt(createdAt),
      previousHash,
      Buffer.from(transitionHash),
    );
  }
}

export { RUNTIME_DATABASE_FILENAME } from './persistence-schema.js';
export { RUNTIME_DATABASE_SCHEMA_VERSION } from './persistence-schema.js';
export type { ExecutionStatus } from './persistence-types.js';
export type { EffectState } from './persistence-types.js';
export type { DurableIdempotencyClass } from './persistence-types.js';
export type { StrategyArtifactRecord } from './persistence-types.js';
export type { ExecutionRecord } from './persistence-types.js';
export type { RuntimeEventRecord } from './persistence-types.js';
export type { SnapshotRecord } from './persistence-types.js';
export type { CapabilityRecord } from './persistence-types.js';
export type { ApprovalRecord } from './persistence-types.js';
export type { PrepareEffectRecord } from './persistence-types.js';
export type { EffectRecord } from './persistence-types.js';
export type { EffectTransitionRecord } from './persistence-types.js';
export type { CommitRuntimeTransition } from './persistence-types.js';
export type { ProgramConfigurationRecord } from './persistence-types.js';
