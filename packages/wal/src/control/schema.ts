export const WAL_CONTROL_SCHEMA_VERSION = 1;
export const WAL_ROLLBACK_SCHEMA_VERSION = 1;

export const WAL_CONTROL_SCHEMA_SQL = `
  CREATE TABLE wal_control_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 1)
  );
  INSERT INTO wal_control_schema(singleton, version) VALUES (1, ${WAL_CONTROL_SCHEMA_VERSION});

  CREATE TABLE rollback_guard (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    guard_id BLOB NOT NULL CHECK (length(guard_id) = 16),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  );

  CREATE TABLE wal_objects (
    object_id BLOB PRIMARY KEY CHECK (length(object_id) = 32),
    namespace_id BLOB NOT NULL CHECK (length(namespace_id) = 32),
    writer_id BLOB NOT NULL CHECK (length(writer_id) = 20),
    writer_epoch BLOB NOT NULL CHECK (length(writer_epoch) = 8),
    sequence BLOB NOT NULL CHECK (length(sequence) = 8),
    previous_object_id BLOB CHECK (previous_object_id IS NULL OR length(previous_object_id) = 32),
    payload_length INTEGER NOT NULL CHECK (payload_length >= 0),
    canonical_length INTEGER NOT NULL CHECK (canonical_length > 0),
    origin TEXT NOT NULL CHECK (origin IN ('LOCAL', 'REMOTE', 'GENESIS', 'SNAPSHOT')),
    admitted_at_ms INTEGER NOT NULL CHECK (admitted_at_ms >= 0),
    FOREIGN KEY (object_id) REFERENCES objects(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_object_id) REFERENCES wal_objects(object_id) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (namespace_id, writer_id, writer_epoch, sequence)
  ) WITHOUT ROWID;
  CREATE INDEX wal_objects_by_lane ON wal_objects(namespace_id, writer_id, writer_epoch, sequence);

  CREATE TABLE object_ranges (
    object_id BLOB NOT NULL CHECK (length(object_id) = 32),
    range_offset INTEGER NOT NULL CHECK (range_offset >= 0),
    range_length INTEGER NOT NULL CHECK (range_length > 0),
    total_length INTEGER NOT NULL CHECK (total_length > 0),
    relative_path TEXT NOT NULL,
    provider_peer_id BLOB,
    received_at_ms INTEGER NOT NULL CHECK (received_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > received_at_ms),
    PRIMARY KEY (object_id, range_offset, range_length)
  ) WITHOUT ROWID;
  CREATE INDEX object_ranges_expiry ON object_ranges(expires_at_ms);

  CREATE TABLE set_commitment_nodes (
    namespace_id BLOB NOT NULL CHECK (length(namespace_id) = 32),
    writer_id BLOB NOT NULL CHECK (length(writer_id) = 20),
    writer_epoch BLOB NOT NULL CHECK (length(writer_epoch) = 8),
    root_hash BLOB NOT NULL CHECK (length(root_hash) = 32),
    node_key BLOB NOT NULL,
    node_bytes BLOB NOT NULL,
    object_count BLOB NOT NULL CHECK (length(object_count) = 8),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (namespace_id, writer_id, writer_epoch, root_hash, node_key)
  ) WITHOUT ROWID;

  CREATE TABLE checkpoints (
    checkpoint_id BLOB PRIMARY KEY CHECK (length(checkpoint_id) = 32),
    canonical_bytes BLOB NOT NULL,
    namespace_id BLOB NOT NULL CHECK (length(namespace_id) = 32),
    writer_id BLOB NOT NULL CHECK (length(writer_id) = 20),
    writer_epoch BLOB NOT NULL CHECK (length(writer_epoch) = 8),
    checkpoint_number BLOB NOT NULL CHECK (length(checkpoint_number) = 8),
    object_set_root BLOB NOT NULL CHECK (length(object_set_root) = 32),
    root_node_key BLOB NOT NULL DEFAULT X'' CHECK (length(root_node_key) = 0),
    object_count BLOB NOT NULL CHECK (length(object_count) = 8),
    max_sequence BLOB NOT NULL CHECK (length(max_sequence) = 8),
    compaction_floor BLOB NOT NULL CHECK (length(compaction_floor) = 8),
    tip_object_id BLOB CHECK (tip_object_id IS NULL OR length(tip_object_id) = 32),
    previous_checkpoint_id BLOB CHECK (previous_checkpoint_id IS NULL OR length(previous_checkpoint_id) = 32),
    policy_object_id BLOB CHECK (policy_object_id IS NULL OR length(policy_object_id) = 32),
    baseline_snapshot_object_id BLOB CHECK (baseline_snapshot_object_id IS NULL OR length(baseline_snapshot_object_id) = 32),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    FOREIGN KEY (tip_object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (previous_checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE RESTRICT,
    FOREIGN KEY (policy_object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (baseline_snapshot_object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (namespace_id, writer_id, writer_epoch, object_set_root, root_node_key)
      REFERENCES set_commitment_nodes(namespace_id, writer_id, writer_epoch, root_hash, node_key)
      ON DELETE RESTRICT,
    UNIQUE (namespace_id, writer_id, writer_epoch, checkpoint_number)
  ) WITHOUT ROWID;

  CREATE TABLE author_lanes (
    namespace_id BLOB NOT NULL CHECK (length(namespace_id) = 32),
    writer_id BLOB NOT NULL CHECK (length(writer_id) = 20),
    writer_epoch BLOB NOT NULL CHECK (length(writer_epoch) = 8),
    next_sequence BLOB NOT NULL CHECK (length(next_sequence) = 8),
    next_checkpoint_number BLOB NOT NULL CHECK (length(next_checkpoint_number) = 8),
    previous_object_id BLOB CHECK (previous_object_id IS NULL OR length(previous_object_id) = 32),
    current_checkpoint_id BLOB NOT NULL CHECK (length(current_checkpoint_id) = 32),
    current_set_root BLOB NOT NULL CHECK (length(current_set_root) = 32),
    root_node_key BLOB NOT NULL DEFAULT X'' CHECK (length(root_node_key) = 0),
    object_count BLOB NOT NULL CHECK (length(object_count) = 8),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
    PRIMARY KEY (namespace_id, writer_id, writer_epoch),
    FOREIGN KEY (previous_object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (current_checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE RESTRICT,
    FOREIGN KEY (namespace_id, writer_id, writer_epoch, current_set_root, root_node_key)
      REFERENCES set_commitment_nodes(namespace_id, writer_id, writer_epoch, root_hash, node_key)
      ON DELETE RESTRICT
  ) WITHOUT ROWID;

  CREATE TABLE iblt_cache (
    head_id BLOB NOT NULL CHECK (length(head_id) = 32),
    reconciliation_seed BLOB NOT NULL CHECK (length(reconciliation_seed) = 32),
    first_symbol_index BLOB NOT NULL CHECK (length(first_symbol_index) = 8),
    symbol_count INTEGER NOT NULL CHECK (symbol_count > 0),
    canonical_bytes BLOB NOT NULL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
    PRIMARY KEY (head_id, reconciliation_seed, first_symbol_index)
  ) WITHOUT ROWID;
  CREATE INDEX iblt_cache_expiry ON iblt_cache(expires_at_ms);

  CREATE TABLE vectors (
    vector_id BLOB PRIMARY KEY CHECK (length(vector_id) = 32),
    collection_id BLOB NOT NULL CHECK (length(collection_id) = 32),
    vector_epoch BLOB NOT NULL CHECK (length(vector_epoch) = 8),
    vector_number BLOB NOT NULL CHECK (length(vector_number) = 8),
    canonical_bytes BLOB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('VERIFIED', 'CURRENT', 'EXPIRED', 'REVOKED')),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) WITHOUT ROWID;
  CREATE UNIQUE INDEX one_current_vector_per_collection ON vectors(collection_id) WHERE status = 'CURRENT';

  CREATE TABLE idempotency (
    namespace_id BLOB NOT NULL CHECK (length(namespace_id) = 32),
    writer_id BLOB NOT NULL CHECK (length(writer_id) = 20),
    idempotency_key TEXT NOT NULL,
    request_digest BLOB NOT NULL CHECK (length(request_digest) = 32),
    object_id BLOB NOT NULL CHECK (length(object_id) = 32),
    checkpoint_id BLOB NOT NULL CHECK (length(checkpoint_id) = 32),
    status TEXT NOT NULL CHECK (status IN ('COMMITTED', 'MATERIALIZATION_PENDING', 'MATERIALIZED')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (namespace_id, writer_id, idempotency_key),
    FOREIGN KEY (object_id) REFERENCES wal_objects(object_id) ON DELETE RESTRICT,
    FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(checkpoint_id) ON DELETE RESTRICT
  ) WITHOUT ROWID;

  CREATE TABLE admission (
    object_id BLOB PRIMARY KEY CHECK (length(object_id) = 32),
    state TEXT NOT NULL CHECK (state IN ('STAGED', 'ADMITTED', 'BLOCKED', 'QUARANTINED')),
    proof_bytes BLOB,
    closure_bytes BLOB,
    provider_peer_id BLOB,
    reason_code TEXT,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) WITHOUT ROWID;
  CREATE INDEX admission_state ON admission(state, updated_at_ms);

  CREATE TABLE materialization (
    logical_key BLOB PRIMARY KEY CHECK (length(logical_key) = 32),
    desired_heads_digest BLOB NOT NULL CHECK (length(desired_heads_digest) = 32),
    desired_state_digest BLOB NOT NULL CHECK (length(desired_state_digest) = 32),
    applied_heads_digest BLOB CHECK (applied_heads_digest IS NULL OR length(applied_heads_digest) = 32),
    applied_state_digest BLOB CHECK (applied_state_digest IS NULL OR length(applied_state_digest) = 32),
    status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPLIED', 'BLOCKED')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    retry_at_ms INTEGER NOT NULL CHECK (retry_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) WITHOUT ROWID;

  CREATE TABLE peer_state (
    peer_id BLOB PRIMARY KEY,
    success_count INTEGER NOT NULL CHECK (success_count >= 0),
    failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
    backoff_until_ms INTEGER NOT NULL CHECK (backoff_until_ms >= 0),
    availability_hint BLOB,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) WITHOUT ROWID;

  CREATE TABLE retry_queue (
    queue_key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload BLOB NOT NULL,
    priority INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts > 0),
    available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= 0),
    lease_until_ms INTEGER,
    state TEXT NOT NULL CHECK (state IN ('READY', 'LEASED', 'BLOCKED')),
    last_error TEXT,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  );
  CREATE INDEX retry_queue_ready ON retry_queue(state, available_at_ms, priority DESC, created_at_ms);

  CREATE TABLE quarantine (
    entry_id BLOB PRIMARY KEY CHECK (length(entry_id) = 32),
    provider_peer_id BLOB NOT NULL,
    reason_code TEXT NOT NULL,
    relative_path TEXT,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms)
  ) WITHOUT ROWID;
  CREATE INDEX quarantine_by_peer ON quarantine(provider_peer_id, expires_at_ms);

  CREATE TABLE gc_queue (
    target_id BLOB PRIMARY KEY CHECK (length(target_id) = 32),
    relative_path TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
    eligible_at_ms INTEGER NOT NULL CHECK (eligible_at_ms >= 0),
    state TEXT NOT NULL CHECK (state IN ('PENDING', 'BLOCKED')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
  ) WITHOUT ROWID;
  CREATE INDEX gc_queue_eligible ON gc_queue(state, eligible_at_ms);
`;

export const WAL_ROLLBACK_SCHEMA_SQL = `
  CREATE TABLE rollback_schema (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL CHECK (version >= 1)
  );
  INSERT INTO rollback_schema(singleton, version) VALUES (1, ${WAL_ROLLBACK_SCHEMA_VERSION});

  CREATE TABLE guard (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    guard_id BLOB NOT NULL CHECK (length(guard_id) = 16)
  );

  CREATE TABLE high_water (
    collection_id BLOB PRIMARY KEY CHECK (length(collection_id) = 32),
    vector_epoch BLOB NOT NULL CHECK (length(vector_epoch) = 8),
    vector_number BLOB NOT NULL CHECK (length(vector_number) = 8),
    vector_id BLOB NOT NULL CHECK (length(vector_id) = 32),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) WITHOUT ROWID;
`;
