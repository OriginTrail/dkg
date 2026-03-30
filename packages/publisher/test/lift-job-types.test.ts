import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  LiftJob,
  LiftJobAccepted,
  LiftJobBroadcast,
  LiftJobFailed,
  LiftJobFailedFromBroadcast,
  LiftJobFailedFromIncluded,
  LiftJobFinalized,
  LiftRequest,
} from '../src/lift-job.js';
import {
  LIFT_AUTHORITY_TYPES,
  LIFT_JOB_IMMUTABLE_FIELDS,
  LIFT_JOB_MUTABLE_PERSISTED_FIELDS,
  LIFT_JOB_PROGRESS_METADATA_FIELDS,
  LIFT_REQUEST_IMMUTABLE_FIELDS,
  LIFT_TRANSITION_TYPES,
} from '../src/lift-job.js';

describe('LiftJob request and record types', () => {
  it('defines immutable request and job field groups', () => {
    expect(LIFT_TRANSITION_TYPES).toEqual(['CREATE', 'MUTATE', 'REVOKE']);
    expect(LIFT_AUTHORITY_TYPES).toEqual(['owner', 'multisig', 'quorum', 'capability']);
    expect(LIFT_REQUEST_IMMUTABLE_FIELDS).toEqual([
      'workspaceId',
      'workspaceOperationId',
      'roots',
      'paranetId',
      'namespace',
      'scope',
      'transitionType',
      'authority',
      'priorVersion',
    ]);
    expect(LIFT_JOB_IMMUTABLE_FIELDS).toEqual([
      'jobId',
      'request',
      'timestamps.acceptedAt',
      'retries.maxRetries',
    ]);
    expect(LIFT_JOB_PROGRESS_METADATA_FIELDS).toEqual([
      'claim',
      'validation',
      'broadcast',
      'inclusion',
      'finalization',
      'failure',
      'recovery',
    ]);
    expect(LIFT_JOB_MUTABLE_PERSISTED_FIELDS).toEqual([
      'status',
      'timestamps',
      'retries',
      'claim',
      'validation',
      'broadcast',
      'inclusion',
      'finalization',
      'failure',
      'recovery',
      'controlPlane',
    ]);
  });

  it('models accepted jobs with immutable request data and retry metadata', () => {
    const request: LiftRequest = {
      workspaceId: 'ws-1',
      workspaceOperationId: 'op-1',
      roots: ['urn:local:/rihana'],
      paranetId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:namespace:aloha' },
    };

    const accepted: LiftJobAccepted = {
      jobId: 'job-1',
      request,
      status: 'accepted',
      timestamps: { acceptedAt: 1, updatedAt: 1 },
      retries: { retryCount: 0, maxRetries: 3 },
    };

    expect(accepted.request.authority.proofRef).toBe('proof:namespace:aloha');
    expect(accepted.retries.maxRetries).toBe(3);
  });

  it('requires broadcast jobs to carry claim, validation, and tx metadata', () => {
    const job: LiftJobBroadcast = {
      jobId: 'job-2',
      request: {
        workspaceId: 'ws-2',
        workspaceOperationId: 'op-2',
        roots: ['urn:local:/rihana'],
        paranetId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'MUTATE',
        authority: { type: 'quorum', proofRef: 'proof:quorum:1' },
        priorVersion: 'did:dkg:mock:31337/0x123/42',
      },
      status: 'broadcast',
      timestamps: { acceptedAt: 1, claimedAt: 2, validatedAt: 3, broadcastAt: 4, updatedAt: 4 },
      retries: { retryCount: 1, maxRetries: 3, lastRetryReason: 'startup recovery' },
      claim: { walletId: 'wallet-1', claimLeaseExpiresAt: 999 },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 12,
        authorityProofRef: 'proof:quorum:1',
        transitionType: 'MUTATE',
        priorVersion: 'did:dkg:mock:31337/0x123/42',
      },
      broadcast: { txHash: '0xabc', walletId: 'wallet-1', merkleRoot: '0xdef' },
    };

    expect(job.broadcast.txHash).toBe('0xabc');
    expect(job.validation.priorVersion).toBe('did:dkg:mock:31337/0x123/42');
  });

  it('captures finalization and failure payload references for persistence', () => {
    const finalized: LiftJobFinalized = {
      jobId: 'job-3',
      request: {
        workspaceId: 'ws-3',
        workspaceOperationId: 'op-3',
        roots: ['urn:local:/rihana'],
        paranetId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      },
      status: 'finalized',
      timestamps: {
        acceptedAt: 1,
        claimedAt: 2,
        validatedAt: 3,
        broadcastAt: 4,
        includedAt: 5,
        finalizedAt: 6,
        updatedAt: 6,
      },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-2' },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 8,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
      broadcast: { txHash: '0x111', walletId: 'wallet-2' },
      inclusion: { txHash: '0x111', blockNumber: 10 },
      finalization: {
        txHash: '0x111',
        ual: 'did:dkg:mock:31337/0x1111111111111111111111111111111111111111/1',
        batchId: '99',
        startKAId: '1',
        endKAId: '1',
        publisherAddress: '0x1111111111111111111111111111111111111111',
      },
    };

    const failed: LiftJobFailedFromBroadcast = {
      jobId: 'job-4',
      request: finalized.request,
      status: 'failed',
      timestamps: { acceptedAt: 1, claimedAt: 2, broadcastAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 2, maxRetries: 3, lastRetryReason: 'rpc timeout' },
      claim: { walletId: 'wallet-2' },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 8,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
      broadcast: { txHash: '0x222', walletId: 'wallet-2' },
      failure: {
        failedFromState: 'broadcast',
        retryable: true,
        message: 'RPC submit timeout',
        errorPayloadRef: 'urn:dkg:publisher:error:job-4',
        stackTraceRef: 'urn:dkg:publisher:error:job-4:stack',
        rpcResponseRef: 'urn:dkg:publisher:error:job-4:rpc',
      },
      recovery: {
        recoveredFromStatus: 'broadcast',
        action: 'reset_to_accepted',
        txHashChecked: '0x222',
      },
    };

    expect(finalized.finalization.batchId).toBe('99');
    expect(failed.failure.errorPayloadRef).toBe('urn:dkg:publisher:error:job-4');
  });

  it('supports chain-driven recovery from included jobs', () => {
    const failed: LiftJobFailedFromIncluded = {
      jobId: 'job-5',
      request: {
        workspaceId: 'ws-5',
        workspaceOperationId: 'op-5',
        roots: ['urn:local:/rihana'],
        paranetId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:5' },
      },
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, includedAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-5' },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 4,
        authorityProofRef: 'proof:owner:5',
        transitionType: 'CREATE',
      },
      broadcast: { txHash: '0x555', walletId: 'wallet-5' },
      inclusion: { txHash: '0x555', blockNumber: 15 },
      failure: {
        failedFromState: 'included',
        retryable: false,
        message: 'finality watcher interrupted',
        errorPayloadRef: 'urn:dkg:publisher:error:job-5',
      },
      recovery: {
        recoveredFromStatus: 'included',
        action: 'finalized_from_chain',
        txHashChecked: '0x555',
      },
    };

    expect(failed.recovery?.action).toBe('finalized_from_chain');
    expect(failed.failure.failedFromState).toBe('included');
  });

  it('keeps failed union compatible with runtime narrowing', () => {
    expectTypeOf<LiftJobFailed>().toMatchTypeOf<LiftJobFailedFromBroadcast | LiftJobFailedFromIncluded>();
  });

  it('rejects impossible recovery combinations at compile time', () => {
    const baseRequest: LiftRequest = {
      workspaceId: 'ws-x',
      workspaceOperationId: 'op-x',
      roots: ['urn:local:/rihana'],
      paranetId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:x' },
    };

    const baseValidation = {
      canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
      canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
      workspaceQuadCount: 1,
      authorityProofRef: 'proof:owner:x',
      transitionType: 'CREATE' as const,
    };

    // @ts-expect-error failed jobs from broadcast require validation metadata
    const invalidMissingValidation: LiftJobFailed = {
      jobId: 'job-invalid-1',
      request: baseRequest,
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, failedAt: 3, updatedAt: 3 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-x' },
      broadcast: { txHash: '0xaaa', walletId: 'wallet-x' },
      failure: {
        failedFromState: 'broadcast',
        retryable: true,
        message: 'oops',
        errorPayloadRef: 'urn:error:1',
      },
    };

    // @ts-expect-error reset_to_accepted cannot recover from included
    const invalidRecoveryState: LiftJobFailed = {
      jobId: 'job-invalid-2',
      request: baseRequest,
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, includedAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-x' },
      validation: baseValidation,
      broadcast: { txHash: '0xbbb', walletId: 'wallet-x' },
      inclusion: { txHash: '0xbbb', blockNumber: 1 },
      failure: {
        failedFromState: 'included',
        retryable: true,
        message: 'oops',
        errorPayloadRef: 'urn:error:2',
      },
      recovery: {
        action: 'reset_to_accepted',
        recoveredFromStatus: 'included',
        txHashChecked: '0xbbb',
      },
    };

    // @ts-expect-error finalized_from_chain requires txHashChecked
    const invalidMissingTxHash: LiftJobFailed = {
      jobId: 'job-invalid-3',
      request: baseRequest,
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, includedAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-x' },
      validation: baseValidation,
      broadcast: { txHash: '0xccc', walletId: 'wallet-x' },
      inclusion: { txHash: '0xccc', blockNumber: 1 },
      failure: {
        failedFromState: 'included',
        retryable: false,
        message: 'oops',
        errorPayloadRef: 'urn:error:3',
      },
      recovery: {
        action: 'finalized_from_chain',
        recoveredFromStatus: 'included',
      },
    };

    void [invalidMissingValidation, invalidRecoveryState, invalidMissingTxHash];
  });

  it('exposes a discriminated LiftJob union for runtime transitions', () => {
    expectTypeOf<LiftJob>().toMatchTypeOf<LiftJobAccepted | LiftJobBroadcast | LiftJobFailed | LiftJobFinalized>();
  });
});
