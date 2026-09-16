import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export const RUNTIME_DATABASE_FILENAME = 'semantic-runtime.sqlite';
export const RUNTIME_DATABASE_SCHEMA_VERSION = 1;

export type ExecutionStatus = 'active' | 'paused' | 'completed' | 'failed' | 'quarantined';
export type EffectState =
  | 'prepared'
  | 'dispatching'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'reconciling'
  | 'reconciled'
  | 'manual_review_required'
  | 'compensation_pending'
  | 'compensated';

export type DurableIdempotencyClass =
  | 'pure_read'
  | 'naturally_idempotent'
  | 'idempotent_with_key'
  | 'conditionally_idempotent'
  | 'compensatable'
  | 'non_repeatable';

export interface StrategyArtifactRecord {
  artifactHash: string;
  strategyId: string;
  version: string;
  canonicalPlan: Uint8Array;
  sourceRef: string;
  signature?: Uint8Array;
  reviewState: 'draft' | 'reviewed' | 'approved' | 'revoked';
  createdAt: number;
}

export interface ExecutionRecord {
  executionId: string;
  planId: string;
  partitionId: string;
  status: ExecutionStatus;
  graphRevision: string;
  policyEpoch: bigint;
  rootProcessId: string;
  nextEventSeq: bigint;
  snapshotSeq: bigint;
  leaseEpoch: bigint;
  stateDigest: Uint8Array | null;
}

export interface RuntimeEventRecord {
  executionId: string;
  seq: bigint;
  eventId: string;
  eventType: string;
  cbor: Uint8Array;
  eventHash: Uint8Array;
  previousHash: Uint8Array;
}

export interface SnapshotRecord {
  partitionId: string;
  seq: bigint;
  schemaVersion: number;
  wasmAbiVersion: number;
  stateHash: Uint8Array;
  cbor: Uint8Array;
  createdAt: number;
}

export interface CapabilityRecord {
  capabilityId: string;
  executionId: string;
  metadataCbor: Uint8Array;
  hostBindingKey: string;
  policyEpoch: bigint;
  notBefore: number;
  expiresAt: number;
  oneShot: boolean;
  consumedAt: number | null;
  revokedAt: number | null;
}

export interface ApprovalRecord {
  approvalId: string;
  executionId: string;
  effectClass: string;
  principal: string;
  requestDigest: Uint8Array;
  notBefore: number;
  expiresAt: number;
  oneShot: boolean;
  consumedAt: number | null;
}

export interface PrepareEffectRecord {
  effectId: string;
  executionId: string;
  processId: string;
  stepId: string;
  attemptId: string;
  idempotencyKey: string;
  idempotencyClass: DurableIdempotencyClass;
  requestDigest: Uint8Array;
  normalizedInput: Uint8Array;
  capabilityId: string;
  policyDecisionId: string;
  approvalId: string | null;
  adapterId: string;
  adapterVersion: string;
  verb: string;
  resource: string;
  reconciliationRule: string;
  compensationRule: string | null;
  budgetReservation: bigint;
  preparedAt: number;
  authorization: {
    decisionId: string;
    policyId: string;
    policyEpoch: bigint;
    factsDigest: Uint8Array;
    principal: string;
    reasonCode: string;
  };
}

export interface EffectRecord extends Omit<PrepareEffectRecord, 'preparedAt' | 'authorization'> {
  state: EffectState;
  journalVersion: bigint;
}

export interface EffectTransitionRecord {
  effectId: string;
  version: bigint;
  state: EffectState;
  evidenceRef: string | null;
  cbor: Uint8Array;
  createdAt: number;
  previousHash: Uint8Array;
  transitionHash: Uint8Array;
}

export interface CommitRuntimeTransition {
  executionId: string;
  expectedNextSeq: bigint;
  eventId: string;
  eventType: string;
  eventCbor: Uint8Array;
  stateDigest: Uint8Array;
  snapshot?: {
    partitionId: string;
    schemaVersion: number;
    wasmAbiVersion: number;
    cbor: Uint8Array;
    createdAt: number;
  };
}

interface SqlExecutionRow {
  execution_id: string;
  plan_id: string;
  partition_id: string;
  status: ExecutionStatus;
  graph_revision: string;
  policy_epoch: number | bigint;
  root_process_id: string;
  next_event_seq: number | bigint;
  snapshot_seq: number | bigint;
  lease_epoch: number | bigint;
  state_digest: Buffer | null;
}

interface SqlEffectRow {
  effect_id: string;
  execution_id: string;
  process_id: string;
  step_id: string;
  attempt_id: string;
  idempotency_key: string;
  idempotency_class: DurableIdempotencyClass;
  state: EffectState;
  request_digest: Buffer;
  normalized_input: Buffer;
  capability_id: string;
  policy_decision_id: string;
  approval_id: string | null;
  adapter_id: string;
  adapter_version: string;
  verb: string;
  resource: string;
  reconciliation_rule: string;
  compensation_rule: string | null;
  budget_reservation: number | bigint;
  journal_version: number | bigint;
}

const ZERO_HASH = new Uint8Array(32);

const EFFECT_TRANSITIONS: Readonly<Record<EffectState, readonly EffectState[]>> = {
  prepared: ['dispatching'],
  dispatching: ['dispatched', 'succeeded', 'failed', 'unknown'],
  dispatched: ['succeeded', 'failed', 'unknown'],
  succeeded: ['compensation_pending'],
  failed: ['compensation_pending'],
  unknown: ['reconciling'],
  reconciling: ['reconciled', 'manual_review_required'],
  reconciled: ['succeeded', 'failed', 'manual_review_required'],
  manual_review_required: [],
  compensation_pending: ['compensated', 'manual_review_required'],
  compensated: [],
};

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
      this.db.exec(SCHEMA_V1);
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

function executionFromRow(row: SqlExecutionRow): ExecutionRecord {
  return {
    executionId: row.execution_id,
    planId: row.plan_id,
    partitionId: row.partition_id,
    status: row.status,
    graphRevision: row.graph_revision,
    policyEpoch: BigInt(row.policy_epoch),
    rootProcessId: row.root_process_id,
    nextEventSeq: BigInt(row.next_event_seq),
    snapshotSeq: BigInt(row.snapshot_seq),
    leaseEpoch: BigInt(row.lease_epoch),
    stateDigest: row.state_digest ? Uint8Array.from(row.state_digest) : null,
  };
}

function effectFromRow(row: SqlEffectRow): EffectRecord {
  return {
    effectId: row.effect_id,
    executionId: row.execution_id,
    processId: row.process_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    idempotencyKey: row.idempotency_key,
    idempotencyClass: row.idempotency_class,
    state: row.state,
    requestDigest: Uint8Array.from(row.request_digest),
    normalizedInput: Uint8Array.from(row.normalized_input),
    capabilityId: row.capability_id,
    policyDecisionId: row.policy_decision_id,
    approvalId: row.approval_id,
    adapterId: row.adapter_id,
    adapterVersion: row.adapter_version,
    verb: row.verb,
    resource: row.resource,
    reconciliationRule: row.reconciliation_rule,
    compensationRule: row.compensation_rule,
    budgetReservation: BigInt(row.budget_reservation),
    journalVersion: BigInt(row.journal_version),
  };
}

function runtimeEventHash(input: {
  executionId: string;
  seq: bigint;
  eventId: string;
  eventType: string;
  cbor: Uint8Array;
  previousHash: Uint8Array;
}): Uint8Array {
  return digestParts(
    'DKG-SEMANTIC-RUNTIME-EVENT-V1\0',
    input.previousHash,
    input.executionId,
    input.seq.toString(),
    input.eventId,
    input.eventType,
    input.cbor,
  );
}

function snapshotStateHash(
  partitionId: string,
  seq: bigint,
  schemaVersion: number,
  wasmAbiVersion: number,
  cbor: Uint8Array,
): Uint8Array {
  return digestParts(
    'DKG-SEMANTIC-RUNTIME-SNAPSHOT-V1\0',
    partitionId,
    seq.toString(),
    String(schemaVersion),
    String(wasmAbiVersion),
    cbor,
  );
}

function effectTransitionHash(
  transition: Pick<
    EffectTransitionRecord,
    'effectId' | 'version' | 'state' | 'evidenceRef' | 'cbor' | 'createdAt'
  >,
  previousHash: Uint8Array,
): Uint8Array {
  return digestParts(
    'DKG-SEMANTIC-RUNTIME-EFFECT-TRANSITION-V1\0',
    previousHash,
    transition.effectId,
    transition.version.toString(),
    transition.state,
    transition.evidenceRef ?? '',
    String(transition.createdAt),
    transition.cbor,
  );
}

function digestParts(...parts: Array<string | Uint8Array>): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) {
    if (typeof part === 'string') {
      const bytes = Buffer.from(part, 'utf8');
      hash.update(Buffer.from(String(bytes.byteLength)));
      hash.update(Buffer.from([0]));
      hash.update(bytes);
    } else {
      hash.update(Buffer.from(String(part.byteLength)));
      hash.update(Buffer.from([0]));
      hash.update(part);
    }
  }
  return Uint8Array.from(hash.digest());
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function assertDigestHex(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase SHA-256 hex`);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

const SCHEMA_V1 = `
  CREATE TABLE strategy_artifact (
    artifact_hash TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    version TEXT NOT NULL,
    canonical_plan BLOB NOT NULL,
    source_ref TEXT NOT NULL,
    signature BLOB,
    review_state TEXT NOT NULL CHECK(review_state IN ('draft','reviewed','approved','revoked')),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE execution (
    execution_id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES strategy_artifact(artifact_hash),
    partition_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','paused','completed','failed','quarantined')),
    graph_revision TEXT NOT NULL,
    policy_epoch INTEGER NOT NULL,
    root_process_id TEXT NOT NULL,
    next_event_seq INTEGER NOT NULL CHECK(next_event_seq >= 1),
    snapshot_seq INTEGER NOT NULL CHECK(snapshot_seq >= 0),
    lease_epoch INTEGER NOT NULL CHECK(lease_epoch >= 0),
    state_digest BLOB
  );

  CREATE TABLE runtime_event (
    execution_id TEXT NOT NULL REFERENCES execution(execution_id),
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    cbor BLOB NOT NULL,
    event_hash BLOB NOT NULL CHECK(length(event_hash) = 32),
    previous_hash BLOB NOT NULL CHECK(length(previous_hash) = 32),
    PRIMARY KEY(execution_id, seq),
    UNIQUE(execution_id, event_id)
  );

  CREATE TABLE snapshot (
    partition_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    wasm_abi_version INTEGER NOT NULL,
    state_hash BLOB NOT NULL CHECK(length(state_hash) = 32),
    cbor BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    valid INTEGER NOT NULL CHECK(valid IN (0,1)),
    PRIMARY KEY(partition_id, seq)
  );

  CREATE TABLE capability_ref (
    capability_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES execution(execution_id),
    metadata_cbor BLOB NOT NULL,
    host_binding_key TEXT NOT NULL,
    policy_epoch INTEGER NOT NULL,
    not_before INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    one_shot INTEGER NOT NULL CHECK(one_shot IN (0,1)),
    consumed_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE approval (
    approval_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES execution(execution_id),
    effect_class TEXT NOT NULL,
    principal TEXT NOT NULL,
    request_digest BLOB NOT NULL CHECK(length(request_digest) = 32),
    not_before INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    one_shot INTEGER NOT NULL CHECK(one_shot IN (0,1)),
    consumed_at INTEGER
  );

  CREATE TABLE authorization_decision (
    decision_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES execution(execution_id),
    capability_id TEXT NOT NULL REFERENCES capability_ref(capability_id),
    policy_id TEXT NOT NULL,
    policy_epoch INTEGER NOT NULL,
    facts_digest BLOB NOT NULL CHECK(length(facts_digest) = 32),
    principal TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
    reason_code TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE effect (
    effect_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL REFERENCES execution(execution_id),
    process_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    idempotency_class TEXT NOT NULL CHECK(idempotency_class IN (
      'pure_read','naturally_idempotent','idempotent_with_key',
      'conditionally_idempotent','compensatable','non_repeatable'
    )),
    state TEXT NOT NULL CHECK(state IN (
      'prepared','dispatching','dispatched','succeeded','failed','unknown',
      'reconciling','reconciled','manual_review_required',
      'compensation_pending','compensated'
    )),
    request_digest BLOB NOT NULL CHECK(length(request_digest) = 32),
    normalized_input BLOB NOT NULL,
    capability_id TEXT NOT NULL REFERENCES capability_ref(capability_id),
    policy_decision_id TEXT NOT NULL REFERENCES authorization_decision(decision_id),
    approval_id TEXT REFERENCES approval(approval_id),
    adapter_id TEXT NOT NULL,
    adapter_version TEXT NOT NULL,
    verb TEXT NOT NULL,
    resource TEXT NOT NULL,
    reconciliation_rule TEXT NOT NULL,
    compensation_rule TEXT,
    budget_reservation INTEGER NOT NULL,
    journal_version INTEGER NOT NULL CHECK(journal_version >= 1),
    UNIQUE(execution_id, idempotency_key)
  );

  CREATE TABLE effect_transition (
    effect_id TEXT NOT NULL REFERENCES effect(effect_id),
    version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
      'prepared','dispatching','dispatched','succeeded','failed','unknown',
      'reconciling','reconciled','manual_review_required',
      'compensation_pending','compensated'
    )),
    evidence_ref TEXT,
    cbor BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    previous_hash BLOB NOT NULL CHECK(length(previous_hash) = 32),
    transition_hash BLOB NOT NULL CHECK(length(transition_hash) = 32),
    PRIMARY KEY(effect_id, version)
  );

  CREATE TABLE projection_checkpoint (
    projection_id TEXT PRIMARY KEY,
    partition_id TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    graph_revision TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX runtime_event_execution_idx ON runtime_event(execution_id, seq);
  CREATE INDEX snapshot_partition_idx ON snapshot(partition_id, seq DESC);
  CREATE INDEX effect_state_idx ON effect(state, execution_id);
  CREATE INDEX effect_transition_idx ON effect_transition(effect_id, version);
`;
