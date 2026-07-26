import { describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE,
  PUBLISHER_NOT_AUTHORIZED_FOR_CG_MESSAGE_PREFIX,
} from '@origintrail-official/dkg-core';
import {
  isPermanentAuthorCapabilityFailure,
  mapPublishExceptionToLiftJobFailure,
  mapPublishResultToLiftJobSuccess,
} from '../src/async-lift-publish-result.js';
import { PublisherNotAuthorizedForContextGraphError } from '@origintrail-official/dkg-chain';
import { QuorumUnmetError } from '../src/ack-errors.js';
import { isOccupyingLifecycleJob } from '../src/async-lift-publisher-utils.js';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from './_helpers/ka-vm-publish.js';

describe('async lift publish result mapping', () => {
  it('maps tentative canonical publish into included LiftJob state', () => {
    const mapped = mapPublishResultToLiftJobSuccess({
      walletId: 'wallet-1',
      publicByteSize: 123,
      publishResult: {
        kaId: 1n,
        ual: 'did:dkg:mock:31337/0xabc/1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'tentative',
        onChainResult: {
          batchId: 7n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: '0xabc',
          blockNumber: 10,
          blockTimestamp: 1700000000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      },
    });

    expect(mapped.status).toBe('included');
    expect(mapped.broadcast.txHash).toBe('0xabc');
    expect(mapped.broadcast.walletId).toBe('wallet-1');
    expect(mapped.broadcast.merkleRoot).toBe('0xabcd');
    expect(mapped.broadcast.publicByteSize).toBe(123);
    expect(mapped.inclusion.txHash).toBe('0xabc');
    expect(mapped.inclusion.blockNumber).toBe(10);
    expect(mapped.inclusion.blockTimestamp).toBe(1700000000);
    expect(mapped.finalization).toBeUndefined();
  });

  it('maps confirmed canonical publish into finalized LiftJob state', () => {
    const mapped = mapPublishResultToLiftJobSuccess({
      walletId: 'wallet-1',
      publishResult: {
        kaId: 1n,
        ual: 'did:dkg:mock:31337/0xabc/1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'confirmed',
        onChainResult: {
          batchId: 7n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: '0xabc',
          blockNumber: 10,
          blockTimestamp: 1700000000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      },
    });

    expect(mapped.status).toBe('finalized');
    expect(mapped.finalization?.ual).toBe('did:dkg:mock:31337/0xabc/1');
    expect(mapped.finalization?.batchId).toBe('7');
    expect(mapped.finalization?.startKAId).toBe('1');
    expect(mapped.finalization?.endKAId).toBe('1');
    expect(mapped.finalization?.publisherAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('maps tentative canonical publish without chain details into local finalized LiftJob state', () => {
    const mapped = mapPublishResultToLiftJobSuccess({
      walletId: 'wallet-1',
      publishResult: {
        kaId: 0n,
        ual: 'did:dkg:mock:31337/0xabc/t1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'tentative',
      },
    });

    expect(mapped.status).toBe('finalized');
    expect(mapped.broadcast).toBeUndefined();
    expect(mapped.inclusion).toBeUndefined();
    expect(mapped.finalization).toEqual({
      mode: 'local',
      ual: 'did:dkg:mock:31337/0xabc/t1',
    });
  });

  it('rejects failed canonical publish results in the success mapper', () => {
    expect(() =>
      mapPublishResultToLiftJobSuccess({
        walletId: 'wallet-1',
        publishResult: {
          kaId: 1n,
          ual: 'did:dkg:mock:31337/0xabc/1',
          merkleRoot: new Uint8Array([0xab, 0xcd]),
          kaManifest: [],
          status: 'failed',
          onChainResult: {
            batchId: 7n,
            txHash: '0xabc',
            blockNumber: 10,
            blockTimestamp: 1700000000,
            publisherAddress: '0x1111111111111111111111111111111111111111',
          },
        },
      }),
    ).toThrow('Async lift publish result cannot map failed canonical publish into success state');
  });

  it('classifies submit timeout exceptions as retryable broadcast failures', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('RPC submit timed out after 30s'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:submit-timeout',
      timeout: {
        timeoutMs: 30_000,
        timeoutAt: 123,
        handling: 'check_chain_then_finalize_or_reset',
      },
    });

    expect(failure.code).toBe('tx_submit_timeout');
    expect(failure.phase).toBe('broadcast');
    expect(failure.retryable).toBe(true);
    expect(failure.timeout).toEqual({
      timeoutMs: 30_000,
      timeoutAt: 123,
      handling: 'check_chain_then_finalize_or_reset',
    });
  });

  it('classifies typed ACK quorum failures separately from RPC outages', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:quorum-unmet',
    });

    expect(failure.code).toBe('quorum_unmet');
    expect(failure.retryable).toBe(true);
    expect(failure.resolution).toBe('reset_to_accepted');
  });

  it('recognizes a rewrapped quorum failure from its legacy message', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('QuorumUnmetError(collected=0/3, dialled=0)'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:rewrapped-quorum-unmet',
    });

    expect(failure.code).toBe('quorum_unmet');
    expect(failure.retryable).toBe(true);
    expect(failure.resolution).toBe('reset_to_accepted');
  });

  it('drops submit-timeout metadata from a quorum failure with legacy timeout text', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new QuorumUnmetError({
        collected: 2,
        required: 3,
        dialled: 3,
        legacyMessage: 'storage_ack_timeout: only 2/3 ACKs received',
      }),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:quorum-timeout',
      timeout: {
        timeoutMs: 30_000,
        timeoutAt: 123,
        handling: 'check_chain_then_finalize_or_reset',
      },
    });

    expect(failure.code).toBe('quorum_unmet');
    expect(failure.retryable).toBe(true);
    expect(failure.timeout).toBeUndefined();
  });

  it('classifies a NO_FUNDED_PUBLISHER_WALLET error as a TERMINAL insufficient_funds failure (not retryable)', () => {
    // The funded-wallet-selection error message intentionally does NOT contain
    // the literal "insufficient funds" substring; without code-based
    // recognition it would fall through to the retryable rpc_unavailable
    // default and retry an unfundable job forever.
    const err = Object.assign(
      new Error('No operational wallet has enough funds to publish to Verifiable Memory — fund a wallet and retry.'),
      { code: 'NO_FUNDED_PUBLISHER_WALLET' },
    );
    const failure = mapPublishExceptionToLiftJobFailure({
      error: err,
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:no-funded-wallet',
    });

    expect(failure.code).toBe('insufficient_funds');
    expect(failure.retryable).toBe(false);
  });

  it('classifies PUBLISH_AUTHOR_NOT_CUSTODIAL as a TERMINAL authority_forbidden failure (not retryable)', () => {
    // GH#1786: the async worker discovers mid-publish that it cannot re-sign this author's
    // UpdateAuthorAttestation. That is PERMANENT — before this mapping it fell through to the
    // retryable rpc_unavailable default and the queue reset a job that can never finalize,
    // the same forever-retry trap #1013/#1121 fixed for unfundable publishes.
    const err = Object.assign(
      new Error(
        'cannot re-sign UpdateAuthorAttestation for author 0xA32f1cc125401B55911678847426759094055B2d — '
        + 'no custodial key on file and it is not the publisher EOA.',
      ),
      { code: 'PUBLISH_AUTHOR_NOT_CUSTODIAL' },
    );
    const failure = mapPublishExceptionToLiftJobFailure({
      error: err,
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:author-not-custodial',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.retryable).toBe(false);
    expect(failure.resolution).toBe('fail_job');
    // 'validation' even though this mapper only sees the broadcast origin: `phase` names the
    // CONCERN that failed, not the state. Author capability is a validation concern wherever
    // it surfaces — the same way wallet_claim_timeout stays a 'broadcast' concern when raised
    // from 'accepted'. `failedFromState` is what says where the job stopped.
    expect(failure.phase).toBe('validation');
  });

  it('classifies a code-stripped non-custodial author error (message marker only) as terminal', () => {
    // Same robustness as the funds path below: a re-wrap can drop .code but keep the message.
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error(
        'publishFromFinalizedAssertion (update path): cannot re-sign UpdateAuthorAttestation for author 0xabc — '
        + 'no custodial key on file and it is not the publisher EOA.',
      ),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:author-not-custodial-nocode',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.retryable).toBe(false);
    expect(failure.phase).toBe('validation');
  });

  it('classifies a code-stripped funds error (message marker only) as terminal insufficient_funds from broadcast', () => {
    // A re-wrap could drop .code but preserve the message — the marker fallback
    // must still keep it terminal (mirrors the daemon + node-ui robustness).
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('No operational wallet has enough funds to publish to Verifiable Memory — fund a wallet and retry.'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:no-funded-wallet-msg',
    });

    expect(failure.code).toBe('insufficient_funds');
    expect(failure.retryable).toBe(false);
  });

  // GH#1786 — the ONE predicate behind three decisions: the failed-from STATE (no send
  // happened, so 'validated'), the failure code on that validated path, and the failure code
  // on the broadcast fallback. A drifted copy would change the outcome depending on where the
  // error surfaced, so it is pinned directly here as well as through each call site.
  describe('isPermanentAuthorCapabilityFailure', () => {
    it('recognizes the coded refusal and the code-stripped message', () => {
      expect(isPermanentAuthorCapabilityFailure(
        Object.assign(new Error('wrapped and reworded'), { code: 'PUBLISH_AUTHOR_NOT_CUSTODIAL' }),
      )).toBe(true);
      expect(isPermanentAuthorCapabilityFailure(
        new Error('publishFromFinalizedAssertion (update path): cannot re-sign UpdateAuthorAttestation for author 0xabc'),
      )).toBe(true);
    });

    it('does not claim unrelated publish failures', () => {
      expect(isPermanentAuthorCapabilityFailure(new Error('RPC submit timed out after 30s'))).toBe(false);
      expect(isPermanentAuthorCapabilityFailure(
        new Error('No operational wallet has enough funds to publish to Verifiable Memory'),
      )).toBe(false);
    });

    it('is throw-safe on hostile error values', () => {
      // This predicate now gates a failure-RECORDING path (the failed-from state), not just
      // classification, so an error whose `.code` getter throws — or which is not an Error at
      // all — must not blow up mid-record. Centralizing on the guarded fact reader is what
      // gives the state decision this property; its previous inline copy read `.code` raw.
      const hostile = { get code(): never { throw new Error('boom'); }, message: 'x' };
      expect(() => isPermanentAuthorCapabilityFailure(hostile)).not.toThrow();
      expect(isPermanentAuthorCapabilityFailure(hostile)).toBe(false);
      expect(isPermanentAuthorCapabilityFailure(Object.create(null))).toBe(false);
      expect(isPermanentAuthorCapabilityFailure(undefined)).toBe(false);
      expect(isPermanentAuthorCapabilityFailure(null)).toBe(false);
      // ...and still recognizes it when only a hostile-ish shape carries the marker.
      expect(isPermanentAuthorCapabilityFailure(
        { message: 'cannot re-sign UpdateAuthorAttestation for author 0xabc' },
      )).toBe(true);
    });
  });

  it('classifies confirmation mismatches on included jobs', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('confirmation mismatch detected'),
      failedFromState: 'included',
      errorPayloadRef: 'urn:error:confirmation-mismatch',
    });

    expect(failure.code).toBe('confirmation_mismatch');
    expect(failure.phase).toBe('confirmation');
    expect(failure.retryable).toBe(false);
  });

  it('falls back to a terminal confirmation failure for unknown included-phase errors', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('unexpected included-phase issue'),
      failedFromState: 'included',
      errorPayloadRef: 'urn:error:unknown-included',
    });

    expect(failure.code).toBe('confirmation_mismatch');
    expect(failure.phase).toBe('confirmation');
    expect(failure.retryable).toBe(false);
  });

});

// #1689 — a curated-CG publish-policy rejection is a PERMANENT authorization
// failure raised at PLAN time (before a signer is picked, before any tx is
// signed). It used to fall through to the retryable `rpc_unavailable` default,
// which made every corrected re-publish silently RE-ACCEPT the same poisoned job
// and burn retryCount toward maxRetries while failing identically. The message
// contains none of the substrings `classifyPublishFailureCode` matches, so the
// structured code is the only sound signal.
describe('#1689 publish-authorization rejection is terminal', () => {
  // Built from the exported core constants, never a copied literal, so a change
  // to the cross-package contract fails HERE rather than silently un-pinning.
  const AUTHZ_MESSAGE =
    `${PUBLISHER_NOT_AUTHORIZED_FOR_CG_MESSAGE_PREFIX}: neither the paying wallet `
    + '0x2222222222222222222222222222222222222222 nor the attested author '
    + '0x1111111111111111111111111111111111111111 is an authorized publisher for '
    + 'context graph 75.';

  it('maps the structured code from broadcast to a TERMINAL authority_forbidden failure', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: Object.assign(new Error(AUTHZ_MESSAGE), { code: PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE }),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:cg-publish-authz',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.mode).toBe('terminal');
    expect(failure.retryable).toBe(false);
    expect(failure.resolution).toBe('fail_job');
    // The failure is attributed to 'broadcast' (the state the job fails from)
    // while its PHASE stays 'validation' (what actually failed) — widening
    // LIFT_JOB_FAILURE_ALLOWED_STATES.authority_forbidden is what makes the
    // metadata constructor accept that pairing instead of throwing.
    expect(failure.failedFromState).toBe('broadcast');
    expect(failure.phase).toBe('validation');
    expect(failure.timeout).toBeUndefined();
  });

  it('recognizes a code-stripped re-wrap from its message marker alone', () => {
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error(AUTHZ_MESSAGE),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:cg-publish-authz-rewrapped',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.retryable).toBe(false);
    expect(failure.resolution).toBe('fail_job');
  });

  it('does NOT hijack included-phase failures (authority_forbidden is not legal there)', () => {
    // Guards the state gate: forcing the code from 'included' would throw inside
    // createLiftJobFailureMetadata, so the mapper must fall back to the classifier.
    const failure = mapPublishExceptionToLiftJobFailure({
      error: Object.assign(new Error(AUTHZ_MESSAGE), { code: PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE }),
      failedFromState: 'included',
      errorPayloadRef: 'urn:error:cg-publish-authz-included',
    });

    expect(failure.code).toBe('confirmation_mismatch');
  });

  it('classifies the REAL dkg-chain error class, not just a hand-built stand-in', () => {
    // Every other row here builds the error from the dkg-core constants, which is
    // deliberate — it keeps them independent of chain's wording. But it also means
    // they cannot catch dkg-chain drifting away from the contract. This row closes
    // that gap from the consumer side by classifying the ACTUAL error class the
    // adapter throws, so a change to its `code` field breaks here rather than
    // silently in production. GH#1689 has TWO throw sites (the pinned gate and,
    // since the pool branch was made structured, the unpinned one) and both raise
    // this class.
    // The message deliberately OMITS the marker prefix. With the real prefix the
    // row would still pass through the message fallback even if `.code` broke, so
    // it would not prove what it claims — this isolates the structured-code path
    // as the only thing that can classify it.
    const error = new PublisherNotAuthorizedForContextGraphError(
      'context graph publish policy declined this publish',
      {
        contextGraphId: 75n,
        payerAddress: '0x2222222222222222222222222222222222222222',
        attestedAuthorAddress: '0x1111111111111111111111111111111111111111',
        attestedAuthorConsidered: true,
        minLifecycleVersion: '10.1.7',
      },
    );
    // The class must carry the shared code — this is the whole cross-package contract.
    expect(error.code).toBe(PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE);

    const failure = mapPublishExceptionToLiftJobFailure({
      error,
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:cg-publish-authz-real-class',
    });

    expect(failure.code).toBe('authority_forbidden');
    expect(failure.retryable).toBe(false);
    expect(failure.resolution).toBe('fail_job');
  });

  it('classifies the POOL-path rejection — the second throw site — by code AND by message', () => {
    // #1689 gained a second throw site when the unpinned/pool branch was made
    // structured: an authorization rejection can now arrive from the sync/pool
    // path where it previously arrived untyped and fell to `rpc_unavailable`.
    // Its wording differs from the pinned branch — it names the POOL rather than
    // one paying wallet, because a pool rejection weighed every operational
    // wallet — so the new text is pinned here explicitly rather than assumed to
    // behave like the pinned-branch message.
    const poolMessage =
      `${PUBLISHER_NOT_AUTHORIZED_FOR_CG_MESSAGE_PREFIX}: neither any of the 2 operational `
      + 'wallets in the signer pool nor the attested author '
      + '0x1111111111111111111111111111111111111111 is an authorized publisher for '
      + 'context graph 7.';

    // (a) the real class, carrying the pool shape (`payerPoolAddresses`).
    const poolError = new PublisherNotAuthorizedForContextGraphError(poolMessage, {
      contextGraphId: 7n,
      payerAddress: '0x2222222222222222222222222222222222222222',
      payerPoolAddresses: [
        '0x2222222222222222222222222222222222222222',
        '0x3333333333333333333333333333333333333333',
      ],
      attestedAuthorAddress: '0x1111111111111111111111111111111111111111',
      attestedAuthorConsidered: true,
      minLifecycleVersion: '10.1.7',
    });
    expect(mapPublishExceptionToLiftJobFailure({
      error: poolError,
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:cg-publish-authz-pool',
    })).toMatchObject({ code: 'authority_forbidden', retryable: false, resolution: 'fail_job' });

    // (b) the same wording after a re-wrap that dropped `.code` — a plain Error
    // carrying only the message, which is what the fallback exists for. What this
    // proves precisely: the pool wording still carries the marker prefix, and is
    // not hijacked by the `isNoFundedWallet` branch that is evaluated BEFORE it.
    // It does NOT police the forbidden substrings (`timeout`, `revert`, …): once
    // the prefix matches, `authority_forbidden` is chosen before
    // `classifyPublishFailureCode` is ever reached, so those only matter if the
    // prefix is lost too. Chain-side asserts the substrings; this asserts the marker.
    expect(mapPublishExceptionToLiftJobFailure({
      error: new Error(poolMessage),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:cg-publish-authz-pool-rewrapped',
    })).toMatchObject({ code: 'authority_forbidden', retryable: false, resolution: 'fail_job' });
  });

  it('leaves an unrelated broadcast error on the retryable rpc_unavailable default', () => {
    // Negative control: the new branch must not widen into the general default.
    const failure = mapPublishExceptionToLiftJobFailure({
      error: new Error('socket hang up while talking to the RPC endpoint'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:generic-rpc',
    });

    expect(failure.code).toBe('rpc_unavailable');
    expect(failure.retryable).toBe(true);
    expect(failure.resolution).toBe('reset_to_accepted');
  });

  // The user-visible consequence, driven through the real queue rather than
  // asserted from the classifier alone: the poisoned job must stop OCCUPYING its
  // lifecycle subject, so a corrected re-publish is admitted as a FRESH job.
  describe('behavioural end state: the failed job no longer occupies its lifecycle subject', () => {
    let now = 1_000;
    let ids = 0;

    function createPublisher(store: OxigraphStore): TripleStoreAsyncLiftPublisher {
      return new TripleStoreAsyncLiftPublisher(store, {
        now: () => ++now,
        idGenerator: () => `job-${++ids}`,
      });
    }

    /** Drive a KA VM-publish job to 'validated', then fail it exactly the way the
     *  real lane does for a plan-time rejection: the job is still 'validated' (the
     *  write-ahead broadcast recorder was never reached, so no tx exists), while
     *  the failure is attributed to 'broadcast'. */
    async function failWith(error: unknown): Promise<{
      publisher: TripleStoreAsyncLiftPublisher;
      jobId: string;
    }> {
      now = 1_000;
      ids = 0;
      const publisher = createPublisher(new OxigraphStore());
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await publisher.claimNext('wallet-1');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      await publisher.recordPublishFailure(jobId, {
        error,
        failedFromState: 'broadcast',
        errorPayloadRef: `urn:dkg:publisher:error:${jobId}`,
      });
      return { publisher, jobId };
    }

    it('records fail_job and admits a corrected re-publish as a NEW job', async () => {
      const { publisher, jobId } = await failWith(
        Object.assign(new Error(AUTHZ_MESSAGE), { code: PUBLISHER_NOT_AUTHORIZED_FOR_CG_CODE }),
      );

      const failed = await publisher.getStatus(jobId);
      expect(failed?.status).toBe('failed');
      if (!failed || !('failure' in failed)) throw new Error('expected a failed job');
      expect(failed.failure.code).toBe('authority_forbidden');
      expect(failed.failure.retryable).toBe(false);
      expect(failed.failure.resolution).toBe('fail_job');
      // Retries REMAIN — occupancy must be decided by retryability, not exhaustion.
      expect(failed.retries.retryCount).toBeLessThan(failed.retries.maxRetries);
      expect(isOccupyingLifecycleJob(failed)).toBe(false);

      const republishedJobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expect(republishedJobId).not.toBe(jobId);
      expect((await publisher.getStatus(republishedJobId))?.status).toBe('accepted');
    });

    it('counterfactual: the pre-fix rpc_unavailable classification re-accepts the SAME job', async () => {
      // The exact bug. Same request, same lane — only the failure code differs.
      const { publisher, jobId } = await failWith(new Error('socket hang up while talking to the RPC endpoint'));

      const failed = await publisher.getStatus(jobId);
      if (!failed || !('failure' in failed)) throw new Error('expected a failed job');
      expect(failed.failure.code).toBe('rpc_unavailable');
      expect(isOccupyingLifecycleJob(failed)).toBe(true);

      const republishedJobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expect(republishedJobId).toBe(jobId); // re-accepted, not fresh
    });
  });
});
