
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

export interface SqlExecutionRow {
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

export interface SqlEffectRow {
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

export interface ProgramConfigurationRecord {
  kind: 'binding' | 'route';
  contextGraphId: string;
  operationIri: string;
  revision: number;
  /** Null is a durable route-removal tombstone. */
  payload: string | null;
  updatedBy: string;
  updatedAt: number;
}
