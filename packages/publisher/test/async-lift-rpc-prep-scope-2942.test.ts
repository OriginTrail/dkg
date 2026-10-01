/**
 * GH#2942 — where the typed-transient-RPC rule applies, and what it must not touch.
 *
 * Companion to async-lift-rpc-prep-retry-2942 (the core rows). This file pins the edges the
 * adversarial review of the plan found:
 *
 *   E. a `claimed`-origin failure (the initial preflight) is routed by the typed cause alone —
 *      nothing can have been dispatched before validation — and the keyword chain's TERMINAL
 *      `canonicalization_failed` no longer swallows a transient outage;
 *   F. the ONE wrapper the publisher owns (`RpcPreconditionError`, around the cold-start chain
 *      reads that precede ACK collection) is unwrapped by exactly one level;
 *   G. a second-generation attempt: the job carries an earlier attempt's hash in its recovery
 *      record. Recording a later pre-hook failure keeps that evidence — the job stays HELD while
 *      the hash is unaccounted, and rides the retry lane once the dispatcher accounted for it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveLiftJobClaim, LiftJob } from '../src/index.js';
import { RpcPreconditionError } from '../src/index.js';
import { hasBroadcastEvidence, isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import {
  DEFAULT_CONTROL_GRAPH_URI,
  jobSubject,
  serializeJob,
} from '../src/async-lift-control-plane.js';
import { TX_HASH, confirmedPublishResult, createAsyncLift2270Harness, expectFailed } from './_helpers/async-lift-2270-harness.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, createStoreRejectionFixtures } from './_helpers/store-rejection-2940.js';
import { exhaustedWithoutKeywords, preparationExhausted } from './_helpers/rpc-prep-failure-2942.js';

describe('GH#2942 typed transient RPC failure: scope edges', () => {
  const h = createAsyncLift2270Harness();
  const { stage, failsOnceThenPublishes } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

  // ---------------------------------------------------------------------------------------------
  // E. claimed-origin: the initial preflight.
  // ---------------------------------------------------------------------------------------------
  describe('E. a failure raised while the job is still claimed', () => {
    function preflightFailsOnce(make: () => unknown, executes: { n: number }) {
      let preflights = 0;
      return {
        preflight: async () => {
          preflights += 1;
          if (preflights === 1) throw make();
          return { action: 'execute' as const };
        },
        execute: async () => {
          executes.n += 1;
          return confirmedPublishResult();
        },
      };
    }

    it('records a typed transient exhaustion with no keyword as retryable, and retries the SAME job', async () => {
      const executes = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: preflightFailsOnce(exhaustedWithoutKeywords, executes),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(failed.failure).toMatchObject({
        failedFromState: 'claimed',
        code: 'workspace_unavailable',
        retryable: true,
        resolution: 'reset_to_accepted',
      });
      expect(failed.timestamps.nextRetryAt).toBeDefined();
      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(executes.n).toBe(1);
    });

    it('still records the same message WITHOUT the typed contract as the legacy terminal failure', async () => {
      // The discriminator: identical text, no code. Typed precedence is what changed the outcome.
      const executes = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: preflightFailsOnce(() => new Error(exhaustedWithoutKeywords().message), executes),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(failed.failure.failedFromState).toBe('claimed');
      expect(failed.failure.code).toBe('canonicalization_failed');
      expect(failed.failure.retryable).toBe(false);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
    });

    it('requires the persisted record to still be claimed: a caller-reported claimed origin on a validated record keeps the legacy chain', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const claimed = await publisher.claimNext('wallet-1');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      const session = publisher.openClaimSession(claimed as ActiveLiftJobClaim);

      const failed = expectFailed(await session.recordExecutionFailure('claimed', exhaustedWithoutKeywords()));

      expect(failed.failure.code).toBe('canonicalization_failed');
    });
  });

  // ---------------------------------------------------------------------------------------------
  // F. RpcPreconditionError: exactly one level.
  // ---------------------------------------------------------------------------------------------
  describe('F. the ACK-precondition wrapper', () => {
    const precondition = (cause: unknown) => new RpcPreconditionError({
      method: 'getEvmChainId',
      message: 'chain id read failed',
      url: 'https://rpc.example/v2/SECRET-API-KEY',
      cause,
    });

    it('unwraps the typed transient cause it carries and recovers as the SAME job, without the keyed URL', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(() => precondition(exhaustedWithoutKeywords()), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(failed.failure).toMatchObject({ failedFromState: 'validated', code: 'workspace_unavailable' });
      expect(failed.failure.message).not.toContain('SECRET-API-KEY');
      expect(failed.failure.message).toContain('rpc.example');
      h.advance(100);
      const finalized = await publisher.processNext('wallet-2');
      expect(finalized?.jobId).toBe(jobId);
      expect(finalized?.status).toBe('finalized');
    });

    it.each([
      ['a wrapper whose cause is not a typed transport failure', () => precondition(new Error('connection reset'))],
      ['a wrapper with no cause', () => precondition(undefined)],
      ['a wrapper around a typed failure that names a transaction', () => precondition(Object.assign(new Error('x'), { code: 'RPC_ENDPOINTS_EXHAUSTED', txHash: TX_HASH }))],
      ['a SECOND wrapper level around the typed failure', () => new Error('outer', { cause: precondition(exhaustedWithoutKeywords()) })],
    ])('does not qualify %s', async (_label, make) => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: failsOnceThenPublishes(make, attempts),
      });
      await stage();
      await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.failure.code).not.toBe('workspace_unavailable');
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------------------------
  // G. Second generation: an earlier attempt's hash rides in the recovery record.
  // ---------------------------------------------------------------------------------------------
  describe('G. a retried job that carries an earlier attempt\'s hash', () => {
    /** A VALIDATED job whose recovery record carries a hash from an earlier (reset) attempt. */
    async function validatedWithInheritedHash(
      publisher: ReturnType<typeof h.createPublisher>,
      options: { readonly accounted: boolean },
    ) {
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const claimed = await publisher.claimNext('wallet-1');
      if (!claimed) throw new Error('expected a claim');
      await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
      const validated = await publisher.getStatus(jobId) as LiftJob;
      const carried = {
        ...validated,
        recovery: {
          action: 'reset_to_accepted',
          recoveredFromStatus: 'broadcast',
          txHashChecked: TX_HASH,
          walletIdChecked: 'wallet-1',
          operationKind: 'create',
          ...(options.accounted ? { txHashAccounted: true } : {}),
        },
      } as unknown as LiftJob;
      await h.store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
      await h.store.insert(serializeJob(carried, DEFAULT_CONTROL_GRAPH_URI));
      return { session: publisher.openClaimSession(claimed as ActiveLiftJobClaim), jobId };
    }

    it('keeps an UNACCOUNTED inherited hash: recorded pre-send, but HELD and never scheduled', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      const { session } = await validatedWithInheritedHash(publisher, { accounted: false });

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        preparationExhausted(),
        { neverDispatched: true },
      ));

      expect(failed.failure.failedFromState).toBe('validated');
      expect(failed.failure.code).toBe('workspace_unavailable');
      // The earlier attempt's hash is still an open question, so the job is evidence-bearing …
      expect(failed.recovery?.txHashChecked).toBe(TX_HASH);
      expect(hasBroadcastEvidence(failed)).toBe(true);
      expect(isHeldForChainProof(failed)).toBe(true);
      // … and therefore never enters the retry lane, whatever its code says.
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      h.advance(60_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect(publisher.describeConfiguredRetryState(failed)).toMatchObject({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
      });
    });

    it('rides the retry lane once the dispatcher has ACCOUNTED for the inherited hash', async () => {
      const publisher = h.createPublisher(RETRY_LANE);
      const { session, jobId } = await validatedWithInheritedHash(publisher, { accounted: true });

      const failed = expectFailed(await session.recordExecutionFailure(
        'broadcast',
        preparationExhausted(),
        { neverDispatched: true },
      ));

      expect(failed.failure.failedFromState).toBe('validated');
      expect(failed.recovery?.txHashChecked).toBe(TX_HASH);
      expect(isHeldForChainProof(failed)).toBe(false);
      expect(failed.timestamps.nextRetryAt).toBeDefined();
      h.advance(100);
      expect((await publisher.claimNext('wallet-2'))?.jobId).toBe(jobId);
    });
  });
});
