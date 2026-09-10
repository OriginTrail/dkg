import { describe, expect, it } from 'vitest';
import {
  LIFT_JOB_STATES,
  createLiftJobFailureMetadata,
  type LiftJob,
  type LiftJobAccepted,
  type LiftJobFailureMetadata,
  type LiftJobState,
  type PersistedLiftJob,
} from '../src/lift-job.js';
import { literal } from '../src/async-lift-control-plane.js';
import { decodeLiftJobPayload } from '../src/lift-job-payload-codec.js';
import { encodeCurrentLiftJobPayload } from '../src/lift-job-payload-version.js';
import {
  buildCanonicalLiftJobTransition,
  buildCanonicalRevertedLiftJobFailure,
} from '../src/lift-job-state-model.js';
import {
  KA_VM_BROADCAST_TX,
  KA_VM_INCLUSION,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
} from '../../../scripts/testing/ka-vm-publish.js';

const accepted: LiftJobAccepted = {
  jobId: 'job-state-model',
  jobSlug: 'music-social/albums/create/share-op-1',
  request: {
    jobType: 'knowledge-asset-vm-publish',
    knowledgeAssetVmPublish: kaVmPublishRequest(),
  },
  admission: { byAgentAddress: '0x1111111111111111111111111111111111111111' },
  status: 'accepted',
  timestamps: { acceptedAt: 1, updatedAt: 1 },
  retries: { retryCount: 0, maxRetries: 3 },
};

function expectCanonicalRoundTrip(job: LiftJob): void {
  expect(decodeLiftJobPayload(literal(encodeCurrentLiftJobPayload(job)))).toEqual({
    kind: 'canonical',
    job,
  });
}

function failureFor<State extends Exclude<LiftJobState, 'finalized' | 'failed'>>(
  state: State,
): LiftJobFailureMetadata & { readonly failedFromState: State } {
  const code = state === 'broadcast'
    ? 'rpc_unavailable'
    : state === 'included'
      ? 'confirmation_mismatch'
      : 'workspace_unavailable';
  return {
    ...createLiftJobFailureMetadata({
      failedFromState: state,
      code,
      message: `failure from ${state}`,
      errorPayloadRef: `urn:error:${state}`,
    }),
    failedFromState: state,
  };
}

describe('LiftJob canonical state model', () => {
  it('uses the shared per-state constructor for transitions and durable round-trips', () => {
    const claimed = buildCanonicalLiftJobTransition(
      accepted,
      'claimed',
      { claim: { walletId: 'wallet-1' } },
      2,
    );
    const validated = buildCanonicalLiftJobTransition(
      claimed,
      'validated',
      { validation: KA_VM_VALIDATION },
      3,
    );
    const broadcast = buildCanonicalLiftJobTransition(
      validated,
      'broadcast',
      { broadcast: KA_VM_BROADCAST_TX },
      4,
    );
    const included = buildCanonicalLiftJobTransition(
      broadcast,
      'included',
      { inclusion: { ...KA_VM_INCLUSION, txHash: KA_VM_BROADCAST_TX.txHash } },
      5,
    );
    const finalized = buildCanonicalLiftJobTransition(
      included,
      'finalized',
      {
        finalization: {
          mode: 'published',
          txHash: KA_VM_BROADCAST_TX.txHash,
          ual: kaVmPublishRequest().kaUal,
        },
      },
      6,
    );
    const failed = buildCanonicalLiftJobTransition(
      broadcast,
      'failed',
      {
        failure: createLiftJobFailureMetadata({
          failedFromState: 'broadcast',
          code: 'rpc_unavailable',
          message: 'RPC outcome unknown',
          errorPayloadRef: 'urn:error:state-model',
        }),
      },
      7,
    );
    const states: readonly LiftJob[] = [
      accepted,
      claimed,
      validated,
      broadcast,
      included,
      finalized,
      failed,
    ];

    expect(states.map(({ status }) => status)).toEqual(LIFT_JOB_STATES);
    for (const job of states) expectCanonicalRoundTrip(job);
    expect(claimed.timestamps).toMatchObject({ acceptedAt: 1, claimedAt: 2, updatedAt: 2 });
    expect(failed.timestamps).toMatchObject({ broadcastAt: 4, failedAt: 7, updatedAt: 7 });
  });

  it.each(['noop', 'local'] as const)(
    'round-trips the %s finalization variant without chain progress',
    (mode) => {
      const claimed = buildCanonicalLiftJobTransition(
        accepted,
        'claimed',
        { claim: { walletId: 'wallet-1' } },
        2,
      );
      const validated = buildCanonicalLiftJobTransition(
        claimed,
        'validated',
        { validation: KA_VM_VALIDATION },
        3,
      );
      const finalized = buildCanonicalLiftJobTransition(
        validated,
        'finalized',
        { finalization: { mode } },
        4,
      );

      expect(finalized).not.toHaveProperty('broadcast');
      expect(finalized).not.toHaveProperty('inclusion');
      expectCanonicalRoundTrip(finalized);
    },
  );

  it('constructs every allowed failure edge as its exact canonical variant', () => {
    const claimed = buildCanonicalLiftJobTransition(
      accepted,
      'claimed',
      { claim: { walletId: 'wallet-1' } },
      2,
    );
    const validated = buildCanonicalLiftJobTransition(
      claimed,
      'validated',
      { validation: KA_VM_VALIDATION },
      3,
    );
    const broadcast = buildCanonicalLiftJobTransition(
      validated,
      'broadcast',
      { broadcast: KA_VM_BROADCAST_TX },
      4,
    );
    const included = buildCanonicalLiftJobTransition(
      broadcast,
      'included',
      { inclusion: KA_VM_INCLUSION },
      5,
    );

    for (const [source, now] of [
      [accepted, 10],
      [claimed, 11],
      [validated, 12],
      [broadcast, 13],
      [included, 14],
    ] as const) {
      const failed = buildCanonicalLiftJobTransition(
        source,
        'failed',
        { failure: failureFor(source.status) },
        now,
      );
      expect(failed.failure.failedFromState).toBe(source.status);
      expectCanonicalRoundTrip(failed);
    }
  });

  it.each(['noop', 'local'] as const)(
    'refuses %s finalization after transaction evidence has been recorded',
    (mode) => {
      const claimed = buildCanonicalLiftJobTransition(
        accepted,
        'claimed',
        { claim: { walletId: 'wallet-1' } },
        2,
      );
      const validated = buildCanonicalLiftJobTransition(
        claimed,
        'validated',
        { validation: KA_VM_VALIDATION },
        3,
      );
      const broadcast = buildCanonicalLiftJobTransition(
        validated,
        'broadcast',
        { broadcast: KA_VM_BROADCAST_TX },
        4,
      );

      expect(() => buildCanonicalLiftJobTransition(
        broadcast,
        'failed',
        {
          failure: createLiftJobFailureMetadata({
            failedFromState: 'claimed',
            code: 'workspace_unavailable',
            message: 'wrong failure origin',
            errorPayloadRef: 'urn:error:wrong-origin',
          }),
        },
        5,
      )).toThrow(/cannot discard broadcast transaction evidence/);

      const included = buildCanonicalLiftJobTransition(
        broadcast,
        'included',
        { inclusion: KA_VM_INCLUSION },
        5,
      );
      expect(() => buildCanonicalLiftJobTransition(
        included,
        'finalized',
        { finalization: { mode } },
        6,
      )).toThrow(/cannot discard broadcast transaction evidence/);

      expect(() => buildCanonicalLiftJobTransition(
        included,
        'failed',
        {
          inclusion: { ...included.inclusion, blockTimestamp: 2 },
          failure: failureFor('included'),
        },
        6,
      )).toThrow(/cannot change inclusion\.blockTimestamp/);
    },
  );

  it('normalizes reverted legacy failures with the richest retained transaction evidence', () => {
    const claimed = buildCanonicalLiftJobTransition(
      accepted,
      'claimed',
      { claim: { walletId: 'wallet-1' } },
      2,
    );
    const validated = buildCanonicalLiftJobTransition(
      claimed,
      'validated',
      { validation: KA_VM_VALIDATION },
      3,
    );
    const broadcast = buildCanonicalLiftJobTransition(
      validated,
      'broadcast',
      { broadcast: KA_VM_BROADCAST_TX },
      4,
    );
    const included = buildCanonicalLiftJobTransition(
      broadcast,
      'included',
      { inclusion: KA_VM_INCLUSION },
      5,
    );
    const legacy: PersistedLiftJob = {
      ...included,
      status: 'failed',
      failure: failureFor('claimed'),
    };
    const reverted = buildCanonicalRevertedLiftJobFailure(
      legacy,
      createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'tx_reverted',
        message: 'receipt proved the retained transaction reverted',
        errorPayloadRef: 'urn:error:reverted-legacy',
      }),
      6,
    );

    expect(reverted).toMatchObject({
      status: 'failed',
      broadcast: included.broadcast,
      inclusion: included.inclusion,
      failure: { failedFromState: 'included', code: 'tx_reverted' },
      timestamps: { failedAt: 6, updatedAt: 6 },
    });
    expect(reverted).not.toHaveProperty('recovery');
    expectCanonicalRoundTrip(reverted!);
  });

  it('keeps immutable and destination-forbidden fields fail-closed at transition construction', () => {
    expect(() => buildCanonicalLiftJobTransition(
      accepted,
      'claimed',
      {
        claim: { walletId: 'wallet-1' },
        validation: KA_VM_VALIDATION,
      } as never,
      2,
    )).toThrow(/validation is forbidden for status claimed/);

    expect(() => buildCanonicalLiftJobTransition(
      accepted,
      'claimed',
      {
        jobId: 'different-job',
        claim: { walletId: 'wallet-1' },
      } as never,
      2,
    )).toThrow(/jobId is immutable and cannot be changed/);
  });

  it.each([
    ['erased recovery', undefined],
    ['changed tx hash', {
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: `0x${'cd'.repeat(32)}`,
      txHashAccounted: true,
      operationKind: 'create',
      walletIdChecked: 'wallet-recovery',
      nonceChecked: 7,
    }],
    ['changed wallet', {
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: `0x${'ab'.repeat(32)}`,
      txHashAccounted: true,
      operationKind: 'create',
      walletIdChecked: 'wallet-other',
      nonceChecked: 7,
    }],
    ['changed nonce', {
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: `0x${'ab'.repeat(32)}`,
      txHashAccounted: true,
      operationKind: 'create',
      walletIdChecked: 'wallet-recovery',
      nonceChecked: 8,
    }],
    ['changed operation kind', {
      action: 'reset_to_accepted',
      recoveredFromStatus: 'broadcast',
      txHashChecked: `0x${'ab'.repeat(32)}`,
      txHashAccounted: true,
      operationKind: 'update',
      walletIdChecked: 'wallet-recovery',
      nonceChecked: 7,
    }],
  ] as const)('rejects %s when recovery is the only transaction evidence carrier', (_label, recovery) => {
    const recoveredAccepted: LiftJobAccepted = {
      ...accepted,
      recovery: {
        action: 'reset_to_accepted',
        recoveredFromStatus: 'broadcast',
        txHashChecked: `0x${'ab'.repeat(32)}`,
        txHashAccounted: true,
        operationKind: 'create',
        walletIdChecked: 'wallet-recovery',
        nonceChecked: 7,
      },
    };

    expect(() => buildCanonicalLiftJobTransition(
      recoveredAccepted,
      'claimed',
      { claim: { walletId: 'wallet-1' }, recovery } as never,
      2,
    )).toThrow(/transition cannot change checked recovery/);
  });

  it('does not carry reset provenance into an accepted-origin failure', () => {
    const recoveredAccepted: LiftJobAccepted = {
      ...accepted,
      recovery: {
        action: 'reset_to_accepted',
        recoveredFromStatus: 'claimed',
      },
    };

    expect(() => buildCanonicalLiftJobTransition(
      recoveredAccepted,
      'failed',
      {
        failure: createLiftJobFailureMetadata({
          failedFromState: 'accepted',
          code: 'workspace_unavailable',
          message: 'workspace unavailable before claim',
          errorPayloadRef: 'urn:error:accepted-state-model',
        }),
      },
      2,
    )).toThrow(/recovery is forbidden for status failed/);
  });
});
