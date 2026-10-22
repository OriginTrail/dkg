import { createHash } from 'node:crypto';
import { EffectRecord, EffectState, EffectTransitionRecord, ExecutionRecord, SqlEffectRow, SqlExecutionRow } from './persistence-types.js';

export const ZERO_HASH = new Uint8Array(32);

export const EFFECT_TRANSITIONS: Readonly<Record<EffectState, readonly EffectState[]>> = {
  prepared: ['dispatching'],
  dispatching: ['dispatched', 'succeeded', 'failed', 'unknown'],
  dispatched: ['succeeded', 'failed', 'unknown'],
  succeeded: ['compensation_pending'],
  failed: ['compensation_pending'],
  unknown: ['reconciling'],
  reconciling: ['reconciled', 'manual_review_required', 'unknown'],
  reconciled: ['succeeded', 'failed', 'manual_review_required'],
  manual_review_required: ['reconciling'],
  compensation_pending: ['compensated', 'manual_review_required'],
  compensated: [],
};

export function executionFromRow(row: SqlExecutionRow): ExecutionRecord {
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

export function effectFromRow(row: SqlEffectRow): EffectRecord {
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

export function runtimeEventHash(input: {
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

export function snapshotStateHash(
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

export function effectTransitionHash(
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

export function digestParts(...parts: Array<string | Uint8Array>): Uint8Array {
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

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

export function assertDigestHex(value: string, name: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be lowercase SHA-256 hex`);
}

export function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
