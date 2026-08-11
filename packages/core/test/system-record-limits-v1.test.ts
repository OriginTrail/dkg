import { describe, expect, it } from 'vitest';

import * as limits from '../src/system-record-limits-v1.js';

describe('frozen system-record V1 limits', () => {
  it('pins transport, object, tree, closure, and applied-state ceilings', () => {
    expect(limits.SYSTEM_RECORD_PROTOCOL_V1).toBe('/dkg/system-records/1.0.0');
    expect(limits.SYSTEM_RECORD_MAX_HEADER_BYTES).toBe(8 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES).toBe(1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_FRAME_BYTES).toBe(1_056_772);
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_PATH_DEPTH).toBe(2);
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_CHILD_INDEX).toBe(255);
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_RECORDS).toBe(262_144);
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_LEAVES).toBe(2_048);
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_OBJECTS).toBe(2_065);
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_RECORDS).toBe(
      limits.SYSTEM_RECORD_MAX_INVENTORY_LEAVES * limits.SYSTEM_RECORD_LEAF_MIN_ROWS,
    );
    expect(limits.SYSTEM_RECORD_MAX_INVENTORY_OBJECTS).toBe(
      limits.SYSTEM_RECORD_MAX_INVENTORY_LEAVES
      + Math.ceil(limits.SYSTEM_RECORD_MAX_INVENTORY_LEAVES / limits.SYSTEM_RECORD_INTERNAL_MIN_ENTRIES)
      + 1,
    );
    expect(limits.SYSTEM_RECORD_MAX_TREE_HEIGHT).toBe(3);
    expect(limits.SYSTEM_RECORD_MAX_TREE_UPDATE_OBJECTS).toBe(6);
    expect(limits.SYSTEM_RECORD_MAX_TREE_UPDATE_BYTES).toBe(1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_CLOSURE_OBJECTS).toBe(32);
    expect(limits.SYSTEM_RECORD_MAX_CLOSURE_BYTES).toBe(3 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_FRAME_BYTES).toBe(
      4 + limits.SYSTEM_RECORD_MAX_HEADER_BYTES + limits.SYSTEM_RECORD_MAX_FRAME_PAYLOAD_BYTES,
    );
    expect(limits.SYSTEM_RECORD_MAX_APPLIED_STATE_BYTES).toBe(64 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_BYTES).toBe(512 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_APPLIED_AGGREGATE_QUADS).toBe(5_000_000);
    expect(limits.SYSTEM_RECORD_MAX_ATOMIC_SPARQL_REQUEST_BYTES).toBe(4 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ATOMIC_INSPECTION_RESPONSE_BYTES).toBe(4 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ATOMIC_RESERVED_INSPECTION_RESPONSE_BYTES).toBe(1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ATOMIC_PREPARED_BYTES).toBe(8 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ATOMIC_TRANSIENT_BYTES).toBe(12 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_APPLY_TIMEOUT_MS).toBe(1_000);
    expect(limits.SYSTEM_RECORD_INSPECTION_TIMEOUT_MS).toBe(1_000);
    expect(limits.SYSTEM_RECORD_REQUIRED_DISPATCH_BUDGET_MS).toBe(1_500);
  });

  it('pins aggregate cache, activation, runtime, continuation, and journal ceilings', () => {
    expect(limits.SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_OBJECTS).toBe(25_000);
    expect(limits.SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_BYTES).toBe(1024 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ADVERTISED_CLOSURE_REFERENCES).toBe(262_144);
    expect(limits.SYSTEM_RECORD_MAX_CONFLICT_SIDECARS).toBe(1_024);
    expect(limits.SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_REFERENCES).toBe(17_408);
    expect(limits.SYSTEM_RECORD_MAX_CONFLICT_SIDECAR_AGGREGATE_BYTES).toBe(128 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ACTIVATION_RECORDS).toBe(512);
    expect(limits.SYSTEM_RECORD_MAX_ACTIVATION_BUNDLE_BYTES).toBe(128 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ACTIVATION_CLOSURE_BYTES).toBe(256 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_ACTIVATION_REFERENCES).toBe(32_768);
    expect(limits.SYSTEM_RECORD_MAX_RUNTIME_ACCOUNTED_BYTES).toBe(64 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_OBJECT_CACHE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_OBJECT_CACHE_OBJECTS).toBe(50_000);
    expect(limits.SYSTEM_RECORD_MAX_CONTINUATION_SLICES).toBe(512);
    expect(limits.SYSTEM_RECORD_CONTINUATION_TIMEOUT_MS).toBe(30 * 60 * 1_000);
    expect(limits.SYSTEM_RECORD_PROVIDER_EXCHANGE_TIMEOUT_MS).toBe(3_000);
    expect(limits.SYSTEM_RECORD_NEGATIVE_MEMO_TTL_MS).toBe(30_000);
    expect(limits.SYSTEM_RECORD_MAX_NEGATIVE_MEMO_ENTRIES).toBe(1_024);
    expect(limits.SYSTEM_RECORD_NEGATIVE_MEMO_ENTRY_BASE_BYTES).toBe(128);
    expect(limits.SYSTEM_RECORD_MAX_PUBLICATION_JOURNAL_REFERENCES).toBe(110);
    expect(limits.SYSTEM_RECORD_MAX_PUBLICATION_JOURNAL_BYTES).toBe(64 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_CACHE_LIVE_METADATA_BYTES).toBe(32 * 1024 * 1024);
    expect(limits.SYSTEM_RECORD_MAX_CACHE_RESERVE_METADATA_BYTES).toBe(32 * 1024 * 1024);
  });

  it('pins the owned-subject, conflict-slot, and sidecar-envelope ceilings', () => {
    expect(limits.SYSTEM_RECORD_MAX_OWNED_SUBJECTS).toBe(2_048);
    expect(limits.SYSTEM_RECORD_MAX_CONFLICT_DIGESTS).toBe(16);
    expect(limits.SYSTEM_RECORD_MAX_CONFLICT_ENTRIES).toBe(8);
    expect(limits.SYSTEM_RECORD_MAX_SIDECAR_OBJECTS).toBe(17);
    expect(limits.SYSTEM_RECORD_MAX_SIDECAR_BYTES).toBe(1_064_960);
  });
});
