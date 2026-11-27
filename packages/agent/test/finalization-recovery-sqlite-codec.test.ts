import { describe, expect, it } from 'vitest';
import { finalizationEnvelopeSha256, finalizationRecoveryRowToEntry } from '../src/finalization-recovery-sqlite-codec.js';
import { RAW, evidence } from './finalization-recovery-sqlite-test-helpers.js';

function sqliteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'entry-1',
    state: 'RECEIVED',
    chain_id: 'base:84532',
    context_graph_id: 'graph',
    source_peer_id: '12D3KooWPublisher',
    trusted_publisher_peer_id: null,
    publisher_upgrade_pending: 0,
    ual: 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7',
    tx_hash: `0x${'ab'.repeat(32)}`,
    assertion_version: '1',
    merkle_root: `0x${'01'.repeat(32)}`,
    ka_id: '7',
    batch_id: '7',
    target_context_graph_id: '42',
    block_number: null,
    block_hash: null,
    tx_index: null,
    publisher_address: null,
    author_address: null,
    envelope_sha256: finalizationEnvelopeSha256(RAW),
    raw_envelope: RAW,
    verified_evidence_json: null,
    generation: 0,
    attempt_count: 0,
    failure_signature: null,
    failure_streak: 0,
    next_attempt_at: null,
    last_error: null,
    created_at: 1_000,
    updated_at: 1_000,
    ...overrides,
  };
}

describe('SQLite finalization recovery row codec', () => {
  it.each([
    ['VERIFIED', null, 'verified row has no evidence'],
    ['SETTLED', null, 'verified row has no evidence'],
    ['RECEIVED', JSON.stringify(evidence()), 'unverified row has verified evidence'],
    ['REORGED', JSON.stringify(evidence()), 'reorged row retains stale verified evidence'],
  ] as const)('fails closed for %s evidence mismatch', (state, verifiedEvidence, message) => {
    expect(() => finalizationRecoveryRowToEntry(sqliteRow({
      state,
      verified_evidence_json: verifiedEvidence,
    }))).toThrow(message);
  });

});
