
export const RUNTIME_DATABASE_FILENAME = 'semantic-runtime.sqlite';
export const RUNTIME_DATABASE_SCHEMA_VERSION = 3;

export const SCHEMA_V1 = `
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

export const SCHEMA_V2 = `
  CREATE TABLE adapter_checkpoint (
    effect_id TEXT PRIMARY KEY REFERENCES effect(effect_id),
    version INTEGER NOT NULL CHECK(version > 0),
    payload BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export const SCHEMA_V3 = `
  CREATE TABLE program_configuration (
    kind TEXT NOT NULL CHECK(kind IN ('binding','route')),
    context_graph_id TEXT NOT NULL,
    operation_iri TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    payload TEXT,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(kind, context_graph_id, operation_iri)
  );
`;
