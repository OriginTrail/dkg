import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  LiftJob,
  LiftJobAccepted,
  LiftJobBigInt,
  LiftJobBroadcast,
  LiftJobFailed,
  LiftJobFailedFromBroadcast,
  LiftJobFailedFromIncluded,
  LiftJobFinalized,
  LiftJobFinalizationMetadata,
  LiftJobRequest,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
  LiftRequest,
  KnowledgeAssetVmPublishJobRequest,
  RawLiftJobRequest,
  RawLiftRequest,
} from '../src/lift-job.js';
import {
  LIFT_AUTHORITY_TYPES,
  LIFT_JOB_IMMUTABLE_FIELDS,
  LIFT_JOB_MUTABLE_PERSISTED_FIELDS,
  LIFT_JOB_PROGRESS_METADATA_FIELDS,
  LIFT_REQUEST_IMMUTABLE_FIELDS,
  LIFT_TRANSITION_TYPES,
  createLiftJobFailureMetadata,
} from '../src/lift-job.js';
import {
  createKnowledgeAssetVmPublishSnapshotMetadata,
  createKnowledgeAssetVmPublishSnapshotRequest,
  normalizePersistedLiftJobRequest,
} from '../src/async-lift-publisher-utils.js';
import { literal } from '../src/async-lift-control-plane.js';
import { decodeLiftJobPayload } from '../src/lift-job-payload-codec.js';

const ROOTLESS_UAL = 'did:dkg:31337/0x1111111111111111111111111111111111111111/7';

function rawJobRequest(request: RawLiftRequest): RawLiftJobRequest {
  return { jobType: 'lift', lift: request };
}

function seal() {
  return {
    merkleRoot: `0x${'12'.repeat(32)}` as const,
    authorAddress: '0x1111111111111111111111111111111111111111' as const,
    signature: {
      r: `0x${'34'.repeat(32)}` as const,
      vs: `0x${'56'.repeat(32)}` as const,
    },
    schemeVersion: 1,
    reservedKaId: '7' as const,
  };
}

function rawLift(overrides: Partial<RawLiftRequest> = {}): RawLiftRequest {
  return {
    swmId: 'ws-1',
    shareOperationId: 'op-1',
    roots: ['urn:local:/rihana'],
    contextGraphId: 'music-social',
    namespace: 'aloha',
    scope: 'person-profile',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'proof:namespace:aloha' },
    ...overrides,
  };
}

function kaVmPublish(
  overrides: Partial<KnowledgeAssetVmPublishJobRequest['knowledgeAssetVmPublish']> = {},
): KnowledgeAssetVmPublishJobRequest['knowledgeAssetVmPublish'] {
  return {
    contextGraphId: 'music-social',
    name: 'albums',
    shareOperationId: 'op-1',
    roots: [],
    contentScopeVersion: 2,
    kaUal: ROOTLESS_UAL,
    assertionVersion: '1',
    publicTripleCount: 1,
    privateTripleCount: 0,
    seal: seal(),
    sealChainId: '31337',
    sealKav10Address: '0x2222222222222222222222222222222222222222',
    sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
    sealMerkleRoot: `0x${'12'.repeat(32)}`,
    intentKey: `sha256:${'ab'.repeat(32)}`,
    ...overrides,
  };
}

describe('LiftJob request and record types', () => {
  it('defines immutable request and job field groups', () => {
    expect(LIFT_TRANSITION_TYPES).toEqual(['CREATE', 'MUTATE', 'REVOKE']);
    expect(LIFT_AUTHORITY_TYPES).toEqual(['owner', 'multisig', 'quorum', 'capability']);
    expect(LIFT_REQUEST_IMMUTABLE_FIELDS).toEqual([
      'jobType',
      'lift',
      'knowledgeAssetVmPublish',
    ]);
    expect(LIFT_JOB_IMMUTABLE_FIELDS).toEqual([
      'jobId',
      'jobSlug',
      'request',
      'admission',
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
      swmId: 'ws-1',
      shareOperationId: 'op-1',
      roots: ['urn:local:/rihana'],
      contextGraphId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:namespace:aloha' },
    };

    const accepted: LiftJobAccepted = {
      jobId: 'job-1',
      jobSlug: 'music-social/person-profile/create/op-1/rihana',
      request: rawJobRequest(request),
      status: 'accepted',
      timestamps: { acceptedAt: 1, updatedAt: 1 },
      retries: { retryCount: 0, maxRetries: 10 },
    };

    expect(accepted.request.lift.authority.proofRef).toBe('proof:namespace:aloha');
    expect(accepted.retries.maxRetries).toBe(10);
  });

  it('models raw lift requests and persisted job payloads as exclusive variants', () => {
    const raw: RawLiftRequest = rawLift();
    const rawJob: RawLiftJobRequest = {
      jobType: 'lift',
      lift: raw,
    };
    const ka: KnowledgeAssetVmPublishJobRequest = {
      jobType: 'knowledge-asset-vm-publish',
      knowledgeAssetVmPublish: kaVmPublish(),
    };

    expectTypeOf(raw).toMatchTypeOf<LiftRequest>();
    expectTypeOf(rawJob).toMatchTypeOf<LiftJobRequest>();
    expectTypeOf(ka).toMatchTypeOf<LiftJobRequest>();

    // @ts-expect-error Raw persisted jobs must carry their raw lift payload under `lift`.
    const invalidRaw: RawLiftJobRequest = { jobType: 'lift', knowledgeAssetVmPublish: ka.knowledgeAssetVmPublish };
    // @ts-expect-error KA publish jobs cannot carry raw lift placeholder fields.
    const invalidKa: KnowledgeAssetVmPublishJobRequest = { jobType: 'knowledge-asset-vm-publish', lift: raw };
    expect(invalidRaw).toBeDefined();
    expect(invalidKa).toBeDefined();
  });

  it('models KA VM publish snapshot validation without raw-lift placeholder fields', () => {
    const request = kaVmPublish({
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a', 'peer-b'],
      entityProofs: true,
    });

    const snapshot = createKnowledgeAssetVmPublishSnapshotRequest(request);
    const metadata = createKnowledgeAssetVmPublishSnapshotMetadata(request);

    expectTypeOf(snapshot).toMatchTypeOf<LiftPublishSnapshotRequest>();
    expectTypeOf(metadata).toMatchTypeOf<LiftPublishRequestMetadata>();
    expect(snapshot).toMatchObject({
      contextGraphId: 'music-social',
      shareOperationId: 'op-1',
      roots: [],
      contentScopeVersion: 2,
      kaUal: ROOTLESS_UAL,
      assertionVersion: '1',
      publicTripleCount: 1,
      privateTripleCount: 0,
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a', 'peer-b'],
      entityProofs: true,
      seal: request.seal,
    });
    for (const rawOnlyField of ['jobType', 'swmId', 'namespace', 'scope', 'transitionType', 'authority']) {
      expect(snapshot).not.toHaveProperty(rawOnlyField);
    }
    expect(metadata).toEqual({
      scope: 'vm-publish',
      transitionType: 'CREATE',
      authority: {
        type: 'owner',
        proofRef: 'urn:dkg:knowledge-assets:music-social:albums:op-1:vm-publish',
      },
    });
  });

  it('normalizes persisted lift job request envelopes through a deep schema boundary', () => {
    expect(normalizePersistedLiftJobRequest(rawLift())).toEqual(rawJobRequest(rawLift({ jobType: 'lift' })));
    expect(normalizePersistedLiftJobRequest(rawJobRequest(rawLift()))).toEqual(rawJobRequest(rawLift({ jobType: 'lift' })));
    expect(normalizePersistedLiftJobRequest({
      jobType: 'knowledge-asset-vm-publish',
      knowledgeAssetVmPublish: kaVmPublish({ clearSharedMemoryAfter: false }),
    })).toEqual({
      jobType: 'knowledge-asset-vm-publish',
      knowledgeAssetVmPublish: kaVmPublish({ clearSharedMemoryAfter: false }),
    });
  });

  it('rejects malformed persisted raw and KA job payloads at the read boundary', () => {
    expect(() =>
      normalizePersistedLiftJobRequest({
        jobType: 'lift',
        lift: {
          ...rawLift(),
          transitionType: 'UPSERT',
        },
      }),
    ).toThrow(/request\.lift\.transitionType must be one of: CREATE, MUTATE, REVOKE/);

    expect(() =>
      normalizePersistedLiftJobRequest({
        jobType: 'knowledge-asset-vm-publish',
        knowledgeAssetVmPublish: {
          ...kaVmPublish(),
          roots: 'all',
        },
      }),
    ).toThrow(/request\.knowledgeAssetVmPublish\.roots must be an array of strings/);

    expect(() =>
      normalizePersistedLiftJobRequest({
        jobType: 'knowledge-asset-vm-publish',
        knowledgeAssetVmPublish: {
          ...kaVmPublish(),
          seal: {
            ...seal(),
            signature: undefined,
          },
        },
      }),
    ).toThrow(/request\.knowledgeAssetVmPublish\.seal\.signature must be an object/);
  });

  it('classifies each persisted payload once as canonical, compatibility, unknown, or malformed', () => {
    const accepted: LiftJobAccepted = {
      jobId: 'job-codec',
      jobSlug: 'music-social/person-profile/create/op-codec/rihana',
      request: rawJobRequest(rawLift({ shareOperationId: 'op-codec' })),
      status: 'accepted',
      timestamps: { acceptedAt: 1, updatedAt: 1 },
      retries: { retryCount: 0, maxRetries: 3 },
    };
    const encode = (value: unknown): string => literal(JSON.stringify(value));

    const canonical = decodeLiftJobPayload(encode(accepted));
    expect(canonical.kind).toBe('canonical');
    if (canonical.kind === 'canonical') {
      expect(canonical.job).toEqual({
        ...accepted,
        request: normalizePersistedLiftJobRequest(accepted.request),
      });
    }

    const legacyBroadcast = {
      ...accepted,
      status: 'broadcast',
      claim: { walletId: 'wallet-legacy' },
    };
    const compatibility = decodeLiftJobPayload(encode(legacyBroadcast));
    expect(compatibility.kind).toBe('compatibility');
    if (compatibility.kind === 'compatibility') {
      expect(compatibility.job.status).toBe('broadcast');
      expect(compatibility.job.broadcast).toBeUndefined();
    }

    const unknown = decodeLiftJobPayload(encode({ ...accepted, status: 'future-state' }));
    expect(unknown.kind).toBe('unknown');
    if (unknown.kind === 'unknown') expect(unknown.job.status).toBe('future-state');

    const malformed = decodeLiftJobPayload(encode({ ...accepted, claim: { walletId: 'injected' } }));
    expect(malformed).toMatchObject({ kind: 'malformed', reason: expect.stringContaining('claim is forbidden') });
  });

  it('rejects unknown durable keys at both the root and nested metadata boundaries', () => {
    const accepted: LiftJobAccepted = {
      jobId: 'job-strict-codec',
      jobSlug: 'music-social/person-profile/create/op-strict-codec/rihana',
      request: rawJobRequest(rawLift({ shareOperationId: 'op-strict-codec' })),
      status: 'accepted',
      timestamps: { acceptedAt: 1, updatedAt: 1 },
      retries: { retryCount: 0, maxRetries: 3 },
    };
    const encode = (value: unknown): string => literal(JSON.stringify(value));

    expect(decodeLiftJobPayload(encode({ ...accepted, futurePolicy: 2 }))).toMatchObject({
      kind: 'malformed',
      reason: 'payload.futurePolicy is unsupported',
    });
    expect(decodeLiftJobPayload(encode({
      ...accepted,
      retries: { ...accepted.retries, futurePolicy: 2 },
    }))).toMatchObject({
      kind: 'malformed',
      reason: 'retries.futurePolicy is unsupported',
    });
  });

  it('accepts only documented failed compatibility shapes, not arbitrary cross-state mixtures', () => {
    const accepted: LiftJobAccepted = {
      jobId: 'job-failed-codec',
      jobSlug: 'music-social/person-profile/create/op-failed-codec/rihana',
      request: rawJobRequest(rawLift({ shareOperationId: 'op-failed-codec' })),
      status: 'accepted',
      timestamps: { acceptedAt: 1, claimedAt: 2, validatedAt: 3, broadcastAt: 4, failedAt: 5, updatedAt: 5 },
      retries: { retryCount: 1, maxRetries: 3 },
    };
    const validation = {
      canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
      canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
      swmQuadCount: 1,
      authorityProofRef: 'proof:owner:codec',
      transitionType: 'CREATE' as const,
    };
    const broadcast = { txHash: `0x${'ab'.repeat(32)}`, walletId: 'wallet-codec' };
    const failure = createLiftJobFailureMetadata({
      failedFromState: 'broadcast',
      code: 'rpc_unavailable',
      message: 'legacy RPC result unknown',
      errorPayloadRef: 'urn:error:codec',
    });
    const encode = (value: unknown): string => literal(JSON.stringify(value));

    const documented = decodeLiftJobPayload(encode({
      ...accepted,
      status: 'failed',
      claim: { walletId: 'wallet-codec' },
      broadcast,
      failure,
    }));
    expect(documented.kind).toBe('compatibility');

    const progressClearedRetry = decodeLiftJobPayload(encode({
      ...accepted,
      status: 'failed',
      failure: { ...failure, failedFromState: 'validated' },
    }));
    expect(progressClearedRetry.kind).toBe('compatibility');
    if (progressClearedRetry.kind === 'compatibility') {
      expect(progressClearedRetry.job).not.toHaveProperty('claim');
      expect(progressClearedRetry.job).not.toHaveProperty('validation');
      expect(progressClearedRetry.job).not.toHaveProperty('broadcast');
    }

    const unrelated = decodeLiftJobPayload(encode({
      ...accepted,
      status: 'failed',
      claim: { walletId: 'wallet-codec' },
      validation,
      broadcast,
      failure: { ...failure, failedFromState: 'accepted' },
    }));
    expect(unrelated).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('claim is forbidden'),
    });
  });

  it('requires broadcast jobs to carry claim, validation, and tx metadata', () => {
    const job: LiftJobBroadcast = {
      jobId: 'job-2',
      jobSlug: 'music-social/person-profile/mutate/op-2/rihana',
      request: rawJobRequest({
        swmId: 'ws-2',
        shareOperationId: 'op-2',
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'MUTATE',
        authority: { type: 'quorum', proofRef: 'proof:quorum:1' },
        priorVersion: 'did:dkg:mock:31337/0x123/42',
      }),
      status: 'broadcast',
      timestamps: { acceptedAt: 1, claimedAt: 2, validatedAt: 3, broadcastAt: 4, updatedAt: 4 },
      retries: { retryCount: 1, maxRetries: 3, lastRetryReason: 'startup recovery' },
      claim: { walletId: 'wallet-1', claimLeaseExpiresAt: 999 },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 12,
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
      jobSlug: 'music-social/person-profile/create/op-3/rihana',
      request: rawJobRequest({
        swmId: 'ws-3',
        shareOperationId: 'op-3',
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:1' },
      }),
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
        swmQuadCount: 8,
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
      jobSlug: 'music-social/person-profile/create/op-3/rihana',
      request: finalized.request,
      status: 'failed',
      timestamps: { acceptedAt: 1, claimedAt: 2, broadcastAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 2, maxRetries: 3, lastRetryReason: 'rpc timeout' },
      claim: { walletId: 'wallet-2' },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 8,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
      broadcast: { txHash: '0x222', walletId: 'wallet-2' },
      failure: createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'rpc_unavailable',
        message: 'RPC submit timeout',
        errorPayloadRef: 'urn:dkg:publisher:error:job-4',
        stackTraceRef: 'urn:dkg:publisher:error:job-4:stack',
        rpcResponseRef: 'urn:dkg:publisher:error:job-4:rpc',
      }),
      recovery: {
        recoveredFromStatus: 'broadcast',
        action: 'reset_to_accepted',
        txHashChecked: '0x222',
      },
    };

    expect(finalized.finalization.batchId).toBe('99');
    expect(BigInt(finalized.finalization.batchId!)).toBe(99n);
    expectTypeOf<LiftJobFinalizationMetadata['batchId']>()
      .toEqualTypeOf<LiftJobBigInt | undefined>();
    expect(failed.failure.errorPayloadRef).toBe('urn:dkg:publisher:error:job-4');
  });

  it('rejects opaque finalization identifiers at the durable runtime boundary', () => {
    const finalized: LiftJobFinalized = {
      jobId: 'job-opaque-finalization',
      jobSlug: 'music-social/person-profile/create/op-opaque/rihana',
      request: rawJobRequest(rawLift({ shareOperationId: 'op-opaque' })),
      status: 'finalized',
      timestamps: { acceptedAt: 1, finalizedAt: 2, updatedAt: 2 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-opaque' },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 1,
        authorityProofRef: 'proof:owner:opaque',
        transitionType: 'CREATE',
      },
      finalization: { mode: 'local' },
    };
    const opaque = {
      ...finalized,
      finalization: { ...finalized.finalization, batchId: 'batch-opaque' },
    };

    expect(decodeLiftJobPayload(literal(JSON.stringify(opaque)))).toMatchObject({
      kind: 'malformed',
      reason: expect.stringContaining('finalization.batchId must be serialized integer text'),
    });
  });

  it('supports chain-driven recovery from included jobs', () => {
    const failed: LiftJobFailedFromIncluded = {
      jobId: 'job-5',
      jobSlug: 'music-social/person-profile/create/op-5/rihana',
      request: rawJobRequest({
        swmId: 'ws-5',
        shareOperationId: 'op-5',
        roots: ['urn:local:/rihana'],
        contextGraphId: 'music-social',
        namespace: 'aloha',
        scope: 'person-profile',
        transitionType: 'CREATE',
        authority: { type: 'owner', proofRef: 'proof:owner:5' },
      }),
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, includedAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-5' },
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 4,
        authorityProofRef: 'proof:owner:5',
        transitionType: 'CREATE',
      },
      broadcast: { txHash: '0x555', walletId: 'wallet-5' },
      inclusion: { txHash: '0x555', blockNumber: 15 },
      failure: createLiftJobFailureMetadata({
        failedFromState: 'included',
        code: 'finality_timeout',
        message: 'finality watcher interrupted',
        errorPayloadRef: 'urn:dkg:publisher:error:job-5',
        timeout: {
          timeoutMs: 60000,
          timeoutAt: 4,
          handling: 'check_chain_then_finalize_or_reset',
        },
      }),
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
      swmId: 'ws-x',
      shareOperationId: 'op-x',
      roots: ['urn:local:/rihana'],
      contextGraphId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:x' },
    };
    const baseJobRequest = rawJobRequest(baseRequest);

    const baseValidation = {
      canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
      canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
      swmQuadCount: 1,
      authorityProofRef: 'proof:owner:x',
      transitionType: 'CREATE' as const,
    };

    // @ts-expect-error failed jobs from broadcast require validation metadata
    const invalidMissingValidation: LiftJobFailed = {
      jobId: 'job-invalid-1',
      jobSlug: 'music-social/person-profile/create/op-x/rihana',
      request: baseJobRequest,
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, failedAt: 3, updatedAt: 3 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-x' },
      broadcast: { txHash: '0xaaa', walletId: 'wallet-x' },
      failure: {
        failedFromState: 'broadcast',
        phase: 'broadcast',
        mode: 'retryable',
        retryable: true,
        resolution: 'reset_to_accepted',
        code: 'rpc_unavailable',
        message: 'oops',
        errorPayloadRef: 'urn:error:1',
      },
    };

    // @ts-expect-error reset_to_accepted cannot recover from included
    const invalidRecoveryState: LiftJobFailed = {
      jobId: 'job-invalid-2',
      jobSlug: 'music-social/person-profile/create/op-x/rihana',
      request: baseJobRequest,
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, includedAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-x' },
      validation: baseValidation,
      broadcast: { txHash: '0xbbb', walletId: 'wallet-x' },
      inclusion: { txHash: '0xbbb', blockNumber: 1 },
      failure: {
        failedFromState: 'included',
        phase: 'confirmation',
        mode: 'timeout',
        retryable: true,
        resolution: 'check_chain_then_finalize_or_reset',
        code: 'finality_timeout',
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
      jobSlug: 'music-social/person-profile/create/op-x/rihana',
      request: baseJobRequest,
      status: 'failed',
      timestamps: { acceptedAt: 1, broadcastAt: 2, includedAt: 3, failedAt: 4, updatedAt: 4 },
      retries: { retryCount: 0, maxRetries: 3 },
      claim: { walletId: 'wallet-x' },
      validation: baseValidation,
      broadcast: { txHash: '0xccc', walletId: 'wallet-x' },
      inclusion: { txHash: '0xccc', blockNumber: 1 },
      failure: {
        failedFromState: 'included',
        phase: 'confirmation',
        mode: 'timeout',
        retryable: false,
        resolution: 'check_chain_then_finalize_or_reset',
        code: 'finality_timeout',
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
