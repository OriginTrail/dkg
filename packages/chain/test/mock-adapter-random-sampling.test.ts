/**
 * MockChainAdapter — Random Sampling unit tests.
 *
 * Exercises the in-memory state machine that backs the proofing-service
 * unit tests in Slice 3:
 *  - period rollover via __advanceProofPeriod
 *  - getNodeChallenge null when no challenge exists
 *  - createChallenge happy path produces a NodeChallenge + cgId
 *  - typed retry-next-period errors (NoEligible*)
 *  - submitProof on the wrong chunk surfaces MerkleRootMismatchError
 *  - getNodeEpochProofPeriodScore reflects a successful submit
 *  - "challenge no longer active" once the period rolls over
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockChainAdapter } from '../src/mock-adapter.js';
import {
  NoEligibleContextGraphError,
  NoEligibleKnowledgeCollectionError,
  MerkleRootMismatchError,
  ChallengeNoLongerActiveError,
} from '../src/chain-adapter.js';

const LEAF0 = ('0x' + '01'.repeat(32)) as `0x${string}`;

async function freshAdapter(): Promise<MockChainAdapter> {
  const a = new MockChainAdapter();
  await a.ensureProfile();
  a.__registerKC({
    kcId: 42n,
    contextGraphId: 7n,
    merkleRootHex: '0x' + 'ab'.repeat(32),
    chunks: [{ chunkId: 0n, chunk: LEAF0 }],
  });
  return a;
}

describe('MockChainAdapter random sampling — read paths', () => {
  it('getActiveProofPeriodStatus returns the in-memory cursor as valid by default', async () => {
    const a = new MockChainAdapter();
    const status = await a.getActiveProofPeriodStatus();
    expect(status.activeProofPeriodStartBlock).toBe(1n);
    expect(status.isValid).toBe(true);
  });

  it('getNodeChallenge returns null when no challenge has been created', async () => {
    const a = new MockChainAdapter();
    expect(await a.getNodeChallenge(99n)).toBeNull();
  });

  it('__advanceProofPeriod bumps the start block in 100-block strides', async () => {
    const a = new MockChainAdapter();
    expect((await a.getActiveProofPeriodStatus()).activeProofPeriodStartBlock).toBe(1n);
    a.__advanceProofPeriod();
    expect((await a.getActiveProofPeriodStatus()).activeProofPeriodStartBlock).toBe(101n);
    a.__advanceProofPeriod();
    expect((await a.getActiveProofPeriodStatus()).activeProofPeriodStartBlock).toBe(201n);
  });

  it('__setPeriodIsValid lets tests model the brief between-periods gap', async () => {
    const a = new MockChainAdapter();
    a.__setPeriodIsValid(false);
    expect((await a.getActiveProofPeriodStatus()).isValid).toBe(false);
  });
});

describe('MockChainAdapter random sampling — createChallenge', () => {
  it('happy path returns the freshly-stored Challenge + cgId from the registered KC', async () => {
    const a = await freshAdapter();
    const result = await a.createChallenge();
    expect(result.success).toBe(true);
    expect(result.contextGraphId).toBe(7n);
    expect(result.challenge.knowledgeCollectionId).toBe(42n);
    expect(result.challenge.chunkId).toBe(0n);
    expect(result.challenge.solved).toBe(false);
    expect(result.challenge.activeProofPeriodStartBlock).toBe(1n);

    const stored = await a.getNodeChallenge(await a.getIdentityId());
    expect(stored?.knowledgeCollectionId).toBe(42n);
  });

  it('throws NoEligibleContextGraphError when no KC has been registered', async () => {
    const a = new MockChainAdapter();
    await a.ensureProfile();
    await expect(a.createChallenge()).rejects.toBeInstanceOf(NoEligibleContextGraphError);
  });

  it('__forceNoEligible("cg") forces a single retry-next-period throw, then resets', async () => {
    const a = await freshAdapter();
    a.__forceNoEligible('cg');
    await expect(a.createChallenge()).rejects.toBeInstanceOf(NoEligibleContextGraphError);
    // Reset is one-shot — next call succeeds against the registered KC.
    const result = await a.createChallenge();
    expect(result.contextGraphId).toBe(7n);
  });

  it('__forceNoEligible("kc") surfaces NoEligibleKnowledgeCollectionError', async () => {
    const a = await freshAdapter();
    a.__forceNoEligible('kc');
    await expect(a.createChallenge()).rejects.toBeInstanceOf(NoEligibleKnowledgeCollectionError);
  });

  it('rejects a second createChallenge in the same period with the contract-equivalent message', async () => {
    const a = await freshAdapter();
    await a.createChallenge();
    await expect(a.createChallenge()).rejects.toThrow(
      /unsolved challenge already exists/i,
    );
  });

  it('round-robins across registered KCs over successive periods', async () => {
    const a = await freshAdapter();
    a.__registerKC({
      kcId: 43n,
      contextGraphId: 9n,
      merkleRootHex: '0x' + 'cd'.repeat(32),
      chunks: [{ chunkId: 0n, chunk: ('0x' + '03'.repeat(32)) as `0x${string}` }],
    });

    const r1 = await a.createChallenge();
    a.__advanceProofPeriod();
    const r2 = await a.createChallenge();

    const ids = new Set([r1.challenge.knowledgeCollectionId, r2.challenge.knowledgeCollectionId]);
    expect(ids.size).toBe(2);
  });
});

describe('MockChainAdapter random sampling — submitProof', () => {
  it('happy path solves the challenge and credits a non-zero score', async () => {
    const a = await freshAdapter();
    const idId = await a.getIdentityId();
    const created = await a.createChallenge();

    const submit = await a.submitProof(LEAF0, []);
    expect(submit.success).toBe(true);

    const score = await a.getNodeEpochProofPeriodScore(
      idId,
      created.challenge.epoch,
      created.challenge.activeProofPeriodStartBlock,
    );
    expect(score).toBeGreaterThan(0n);

    const stored = await a.getNodeChallenge(idId);
    expect(stored?.solved).toBe(true);
  });

  it('wrong chunk surfaces MerkleRootMismatchError (non-retryable for this period)', async () => {
    const a = await freshAdapter();
    await a.createChallenge();
    await expect(a.submitProof(('0x' + '02'.repeat(32)) as `0x${string}`, [])).rejects.toBeInstanceOf(MerkleRootMismatchError);
  });

  it('after period rollover, submitProof throws ChallengeNoLongerActiveError', async () => {
    const a = await freshAdapter();
    await a.createChallenge();
    a.__advanceProofPeriod();
    await expect(a.submitProof(LEAF0, [])).rejects.toBeInstanceOf(ChallengeNoLongerActiveError);
  });

  it('submitProof without a prior challenge throws (mock fallback message)', async () => {
    const a = new MockChainAdapter();
    await a.ensureProfile();
    await expect(a.submitProof(('0x' + 'ff'.repeat(32)) as `0x${string}`, [])).rejects.toThrow(/no active challenge/i);
  });
});
