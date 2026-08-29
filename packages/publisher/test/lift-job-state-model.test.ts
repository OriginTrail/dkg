import { describe, expect, it } from 'vitest';
import {
  LIFT_JOB_STATES,
  createLiftJobFailureMetadata,
  type LiftJob,
  type LiftJobAccepted,
} from '../src/lift-job.js';
import { literal } from '../src/async-lift-control-plane.js';
import { decodeLiftJobPayload } from '../src/lift-job-payload-codec.js';
import { buildCanonicalLiftJobTransition } from '../src/lift-job-state-model.js';
import {
  KA_VM_BROADCAST_TX,
  KA_VM_INCLUSION,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
} from './_helpers/ka-vm-publish.js';

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
  expect(decodeLiftJobPayload(literal(JSON.stringify(job)))).toEqual({
    kind: 'canonical',
    job,
  });
}

describe('LiftJob canonical state model', () => {
  it('constructs and round-trips every writable lifecycle state through the durable decoder', () => {
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
