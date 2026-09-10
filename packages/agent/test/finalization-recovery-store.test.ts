import { describe, expect, it } from 'vitest';
import {
  planFinalizationRecoveryAttempt,
  planFinalizationRecoveryVerifiedEvidenceTransition,
  type FinalizationRecoveryEntry,
  type FinalizationRecoveryVerifiedEvidenceCommit,
} from '../src/finalization-recovery-store.js';
import {
  RAW,
  TX_HASH,
  evidence,
} from './finalization-recovery-sqlite-test-helpers.js';
import {
  finalizationEnvelopeSha256,
  finalizationRecoveryRowToEntry,
} from '../src/finalization-recovery-sqlite-codec.js';

function entry(
  overrides: Partial<FinalizationRecoveryEntry> = {},
): FinalizationRecoveryEntry {
  return {
    key: 'entry-1',
    state: 'RECEIVED',
    chainId: 'base:84532',
    contextGraphId: 'graph',
    sourcePeerId: '12D3KooWPublisher',
    publisherUpgradePending: false,
    ual: 'did:dkg:base:84532/0x1111111111111111111111111111111111111111/7',
    txHash: TX_HASH,
    assertionVersion: '1',
    merkleRoot: `0x${'01'.repeat(32)}`,
    kaId: '7',
    batchId: '7',
    targetContextGraphId: '42',
    envelopeSha256: '00'.repeat(32),
    rawMessage: RAW,
    generation: 0,
    attemptCount: 0,
    failureStreak: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('finalization recovery verified-evidence transition planner', () => {
  it('preserves generation and retry state for original-placement evidence', () => {
    const verifiedEvidence = evidence();
    expect(planFinalizationRecoveryVerifiedEvidenceTransition(
      entry({
        state: 'REORGED',
        generation: 2,
        attemptCount: 3,
        failureSignature: 'receipt-pending',
        failureStreak: 2,
        nextAttemptAt: 5_000,
        lastError: 'receipt lookup pending',
      }),
      2,
      { evidence: verifiedEvidence, placement: 'original' },
    )).toEqual({
      status: 'update',
      fields: {
        state: 'VERIFIED',
        verifiedEvidence,
        generation: 2,
        attemptCount: 3,
        failureSignature: 'receipt-pending',
        failureStreak: 2,
        nextAttemptAt: 5_000,
        lastError: 'receipt lookup pending',
      },
    });
  });

  it('advances generation and resets retry state for a moved generation-0 receipt', () => {
    const verifiedEvidence = evidence({
      blockNumber: 124,
      blockHash: `0x${'ef'.repeat(32)}`,
      txIndex: 7,
    });
    expect(planFinalizationRecoveryVerifiedEvidenceTransition(
      entry({
        attemptCount: 3,
        nextAttemptAt: 5_000,
        lastError: 'receipt lookup pending',
        failureSignature: 'receipt-pending',
        failureStreak: 2,
      }),
      0,
      {
        evidence: verifiedEvidence,
        placement: 'canonical-moved',
        reason: 'independently recovered canonical receipt moved',
      },
    )).toEqual({
      status: 'update',
      fields: {
        state: 'VERIFIED',
        verifiedEvidence,
        generation: 1,
        attemptCount: 0,
        nextAttemptAt: null,
        lastError: 'independently recovered canonical receipt moved',
        failureSignature: null,
        failureStreak: 0,
      },
    });
  });

  it('returns existing only for the same committed evidence', () => {
    const verifiedEvidence = evidence();
    const current = entry({
      state: 'VERIFIED',
      verifiedEvidence,
    });
    expect(planFinalizationRecoveryVerifiedEvidenceTransition(
      current,
      0,
      { evidence: verifiedEvidence, placement: 'original' },
    )).toEqual({ status: 'existing', entry: current });
    expect(planFinalizationRecoveryVerifiedEvidenceTransition(
      current,
      0,
      {
        evidence: evidence({ blockHash: `0x${'ef'.repeat(32)}` }),
        placement: 'original',
      },
    )).toEqual({ status: 'conflict' });
  });

  it.each([
    [
      'stale generation',
      entry({ generation: 1 }),
      0,
      { evidence: evidence(), placement: 'original' },
    ],
    [
      'moved evidence after a prior reorg',
      entry({ state: 'REORGED', generation: 1 }),
      1,
      {
        evidence: evidence({ blockNumber: 124 }),
        placement: 'canonical-moved',
        reason: 'second generation advance',
      },
    ],
    [
      'terminal source state',
      entry({ state: 'SETTLED' }),
      0,
      { evidence: evidence(), placement: 'original' },
    ],
    [
      'transaction mismatch',
      entry(),
      0,
      {
        evidence: evidence({ transactionHash: `0x${'ef'.repeat(32)}` }),
        placement: 'original',
      },
    ],
    [
      'assertion mismatch',
      entry(),
      0,
      { evidence: evidence({ assertionVersion: '2' }), placement: 'original' },
    ],
  ] satisfies Array<[
    string,
    FinalizationRecoveryEntry,
    number,
    FinalizationRecoveryVerifiedEvidenceCommit,
  ]>)('rejects %s', (_case, current, generation, commit) => {
    expect(planFinalizationRecoveryVerifiedEvidenceTransition(
      current,
      generation,
      commit,
    )).toEqual({ status: 'conflict' });
  });

  it('does not depend on block hash equality for immutable identity checks', () => {
    expect(planFinalizationRecoveryVerifiedEvidenceTransition(
      entry(),
      0,
      {
        evidence: evidence({ blockHash: `0x${'ef'.repeat(32)}` }),
        placement: 'original',
      },
    ).status).toBe('update');
  });
});

describe('finalization recovery attempt planner', () => {
  const stablePolicy = {
    mode: 'stable-failure' as const,
    retryDelayMs: 100,
    failureCode: 'processing-deferred' as const,
    stableFailureThreshold: 3,
    stableFailureRetryMs: 10_000,
    retryDeadlineAt: 20_000,
  };

  it('keys consecutive failures by code rather than diagnostic wording', () => {
    const first = planFinalizationRecoveryAttempt(
      entry(),
      'first wording',
      stablePolicy,
      1_000,
    );
    const second = planFinalizationRecoveryAttempt(
      entry({ ...first }),
      'equivalent wording after an edit',
      stablePolicy,
      1_100,
    );
    const changed = planFinalizationRecoveryAttempt(
      entry({ ...second }),
      'unrelated transient failure',
      {
        ...stablePolicy,
        failureCode: 'store-scheduler-busy',
      },
      1_200,
    );

    expect(first).toMatchObject({ failureSignature: 'processing-deferred', failureStreak: 1 });
    expect(second).toMatchObject({
      lastError: 'equivalent wording after an edit',
      failureSignature: 'processing-deferred',
      failureStreak: 2,
    });
    expect(changed).toMatchObject({
      failureSignature: 'store-scheduler-busy',
      failureStreak: 1,
      nextAttemptAt: 1_300,
    });
  });

  it('caps only a terminally actionable stable failure at its deadline', () => {
    const belowThreshold = planFinalizationRecoveryAttempt(
      entry({ createdAt: 1_000 }),
      'old but not stable',
      { ...stablePolicy, retryDeadlineAt: 2_000 },
      10_000,
    );
    expect(belowThreshold.nextAttemptAt).toBe(10_100);

    const stable = planFinalizationRecoveryAttempt(
      entry({
        failureSignature: 'processing-deferred',
        failureStreak: 2,
      }),
      'still deferred',
      {
        ...stablePolicy,
        stableFailureRetryMs: 6_000,
        retryDeadlineAt: 2_000,
      },
      1_900,
    );
    expect(stable).toMatchObject({ failureStreak: 3, nextAttemptAt: 2_000 });
  });

  it('preserves future backoff for settled retries after the live window', () => {
    expect(planFinalizationRecoveryAttempt(
      entry({ state: 'SETTLED', createdAt: 1_000 }),
      'receipt still pending',
      { mode: 'ordinary', retryDelayMs: 1_000 },
      10_000,
    )).toMatchObject({
      failureSignature: null,
      failureStreak: 0,
      nextAttemptAt: 11_000,
    });
  });

  it('rejects a current-schema row with a missing failure streak', () => {
    expect(() => finalizationRecoveryRowToEntry({
      key: 'entry-1',
      state: 'RECEIVED',
      chain_id: 'base:84532',
      context_graph_id: 'graph',
      source_peer_id: null,
      trusted_publisher_peer_id: null,
      publisher_upgrade_pending: 0,
      ual: entry().ual,
      tx_hash: TX_HASH,
      assertion_version: '1',
      merkle_root: `0x${'01'.repeat(32)}`,
      ka_id: '7',
      batch_id: '7',
      target_context_graph_id: null,
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
      next_attempt_at: null,
      last_error: null,
      created_at: 1_000,
      updated_at: 1_000,
    })).toThrow('invalid failure_streak');
  });
});
