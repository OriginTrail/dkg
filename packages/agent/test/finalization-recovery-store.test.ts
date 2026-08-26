import { describe, expect, it } from 'vitest';
import {
  planFinalizationRecoveryVerifiedEvidenceTransition,
  type FinalizationRecoveryEntry,
  type FinalizationRecoveryVerifiedEvidenceCommit,
} from '../src/finalization-recovery-store.js';
import {
  RAW,
  TX_HASH,
  evidence,
} from './finalization-recovery-sqlite-test-helpers.js';

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
