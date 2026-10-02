/**
 * GH#2940 — post-dispatch behaviour: a store rejection AFTER the write-ahead recorded a hash must
 * keep the chain-proof behaviour bit for bit (B), and the existing chain-proof lane must resolve it
 * exactly as it resolves any held job (B2): finalize the SAME job once, or keep holding and never
 * resend. Classification rows are in async-lift-store-rejection-2940; shared fixtures in
 * test/_helpers/store-rejection-2940.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { TripleStoreAsyncLiftPublisher } from '../src/index.js';
import type { AsyncKnowledgeAssetVmPublishRecoveryEvidence, AsyncLiftChainProofResolution, LiftJobHex } from '../src/index.js';
import { isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import { TX_HASH, createAsyncLift2270Harness, expectFailed } from './_helpers/async-lift-2270-harness.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, adapterRewrap, createStoreRejectionFixtures, rawLiftRequest, schedulerBusy } from './_helpers/store-rejection-2940.js';
import type { FlushableStore, InsertableStore } from './_helpers/store-rejection-2940.js';

describe('GH#2940 store-scheduler rejection vs transaction-submission timeout: post-dispatch recovery', () => {
  const h = createAsyncLift2270Harness();
  const { stage, firesBroadcastThenThrows } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

  // ---------------------------------------------------------------------------------------------
  // B. Possibly dispatched → chain-proof behaviour, bit for bit.
  // ---------------------------------------------------------------------------------------------
  describe('B. a rejection after the write-ahead recorded a transaction', () => {
    it('leaves a KA VM job in broadcast with its evidence — never failed, reset, or resent', async () => {
      const attempts = { n: 0 };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: firesBroadcastThenThrows(schedulerBusy(), attempts),
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const processed = await publisher.processNext('wallet-1');

      expect(processed?.status).toBe('broadcast');
      expect(processed?.status).not.toBe('failed');
      expect(processed && 'broadcast' in processed ? processed.broadcast?.txHash : undefined).toBe(TX_HASH);
      // No resolver is wired, so recovery cannot settle it — and it must not guess.
      expect(await publisher.recover()).toBe(0);
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      const held = await publisher.getStatus(jobId);
      expect(held?.status).toBe('broadcast');
      expect(attempts.n).toBe(1);
    });

    it('holds a raw-lift failure for chain proof: pending_chain_proof, never auto-retried, never reset by retry()', async () => {
      const attempts = { n: 0 };
      const rawRequest = rawLiftRequest();
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        publishExecutor: async (input) => {
          attempts.n += 1;
          await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
          throw schedulerBusy();
        },
      });
      await stage();
      const jobId = await seedLegacyRawLiftTestJob(h.store, rawRequest, {
        now: () => 1_000,
        idGenerator: () => 'raw-job-1',
      });

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      // Evidence-bearing: failed from `broadcast` WITH the hash the write-ahead recorded.
      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.broadcast?.txHash).toBe(TX_HASH);
      expect(isHeldForChainProof(failed)).toBe(true);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(publisher.describeConfiguredRetryState(failed)).toMatchObject({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
      });
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect(await publisher.retryDetailed()).toMatchObject({ retried: 0, blockedPendingRecovery: 1 });
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect(attempts.n).toBe(1);
    });

    it('stays held when the write-ahead rollback ITSELF is rejected and the record is still broadcast+hash', async () => {
      // The corner that makes the persisted-status conjunct load-bearing. The write-ahead commit
      // succeeded, the flush was rejected, and the ROLLBACK write was rejected too: the store now
      // holds `broadcast` + the signed hash although the recorder reports `rolled-back-pre-send`.
      // Recording this failure "from validated" would discard that evidence — it must degrade to
      // today's held failure instead, and must never throw out of failure recording.
      const attempts = { n: 0 };
      const store = h.store as unknown as FlushableStore & InsertableStore;
      const originalInsert = store.insert.bind(store);
      let armed = false;
      let rollbackInsertRejected = false;
      store.flush = async () => {
        armed = true;
        throw schedulerBusy();
      };
      store.insert = async (...args: unknown[]) => {
        if (armed && !rollbackInsertRejected) {
          rollbackInsertRejected = true;
          throw schedulerBusy();
        }
        return await originalInsert(...args);
      };
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        knowledgeAssetVmPublishHandler: {
          execute: async (input) => {
            attempts.n += 1;
            try {
              await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
            } catch (hookError) {
              throw adapterRewrap(hookError);
            }
            throw new Error('unreachable: send after a failed write-ahead');
          },
        },
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      const failed = expectFailed(await publisher.processNext('wallet-1'));

      expect(rollbackInsertRejected).toBe(true);
      expect(failed.failure.failedFromState).toBe('broadcast');
      expect(failed.broadcast?.txHash).toBe(TX_HASH);
      expect(failed.failure.code).not.toBe('workspace_unavailable');
      expect(isHeldForChainProof(failed)).toBe(true);
      expect(failed.timestamps.nextRetryAt).toBeUndefined();
      expect(publisher.describeConfiguredRetryState(failed)).toMatchObject({
        autoRetryEligible: false,
        waitingReason: 'pending_chain_proof',
      });
      h.advance(10_000);
      expect(await publisher.claimNext('wallet-2')).toBeNull();
      expect((await publisher.getStatus(jobId))?.status).toBe('failed');
      expect(attempts.n).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // B2. The existing chain-proof lane resolves a post-dispatch store rejection exactly as it
  // resolves any held job: finalize the SAME job when the chain carries the publish, keep holding
  // (never resend) when it establishes nothing. These rows exercise that lane with the store
  // rejection as the cause; the verdict matrix itself lives in the 2270 dispatcher suite.
  // ---------------------------------------------------------------------------------------------
  describe('B2. post-dispatch store rejection under chain-proof recovery', () => {
    const AUTHOR = '0x1111111111111111111111111111111111111111' as LiftJobHex;
    const MERKLE_ROOT = `0x${'12'.repeat(32)}` as LiftJobHex;
    const RECOVERED: AsyncLiftChainProofResolution = {
      status: 'recovered',
      recovery: {
        inclusion: { txHash: TX_HASH, blockNumber: 77 },
        finalization: {
          mode: 'published',
          txHash: TX_HASH,
          ual: 'did:dkg:evm:31337/0xabc/7',
          batchId: '7',
          startKAId: '7',
          endKAId: '7',
          publisherAddress: AUTHOR,
        },
      },
    };
    const kaVmRecoveryEvidence = (): AsyncKnowledgeAssetVmPublishRecoveryEvidence => ({
      inclusion: { txHash: TX_HASH, blockNumber: 77, blockHash: `0x${'bc'.repeat(32)}` as LiftJobHex },
      finalization: {
        mode: 'published',
        txHash: TX_HASH,
        ual: 'did:dkg:evm:31337/0xabc/7',
        batchId: '7',
        startKAId: '7',
        endKAId: '7',
        publisherAddress: AUTHOR,
      },
      publishProof: { merkleRoot: MERKLE_ROOT, authorAddress: AUTHOR, txIndex: 4 },
    });
    const UNRESOLVED = ['pending-mempool', 'pending-awaiting-confirmation', 'unrecognized', 'inconclusive'] as const;

    function recovering(
      verdict: AsyncLiftChainProofResolution,
      attempts: { n: number },
      lookups: { n: number },
      config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
    ) {
      return h.createPublisher({
        ...RETRY_LANE,
        chainProofResolver: async () => {
          lookups.n += 1;
          return verdict;
        },
        knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
        knowledgeAssetVmPublishHandler: {
          ...firesBroadcastThenThrows(schedulerBusy(), attempts),
          finalizeRecovered: async () => undefined,
        },
        ...config,
      });
    }

    it('finalizes the SAME job once when the chain carries the publish — and never resends', async () => {
      const attempts = { n: 0 };
      const lookups = { n: 0 };
      const publisher = recovering(RECOVERED, attempts, lookups);
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      expect((await publisher.processNext('wallet-1'))?.status).toBe('broadcast');

      expect(await publisher.recover()).toBe(1);

      const finalized = await publisher.getStatus(jobId);
      expect(finalized?.status).toBe('finalized');
      expect(finalized?.jobId).toBe(jobId);
      expect(attempts.n).toBe(1);
      expect(lookups.n).toBeGreaterThan(0);
      // Idempotent: a second pass finds nothing left to settle.
      expect(await publisher.recover()).toBe(0);
      expect(attempts.n).toBe(1);
    });

    it.each(UNRESOLVED)('keeps holding on a %s verdict: no reset, no resend', async (status) => {
      const attempts = { n: 0 };
      const lookups = { n: 0 };
      const publisher = recovering({ status } as AsyncLiftChainProofResolution, attempts, lookups);
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      await publisher.processNext('wallet-1');

      expect(await publisher.recover()).toBe(0);
      h.advance(60_000);
      expect(await publisher.recover()).toBe(0);

      const held = await publisher.getStatus(jobId);
      expect(held?.status).toBe('broadcast');
      expect(held && 'broadcast' in held ? held.broadcast?.txHash : undefined).toBe(TX_HASH);
      expect(attempts.n).toBe(1);
      expect(lookups.n).toBeGreaterThan(0);
    });

    it('settles a job whose post-dispatch BOOKKEEPING store read was rejected, once', async () => {
      // The observed production shape: the write-ahead durably recorded 'broadcast', then a later
      // store read inside the worker fails on scheduler saturation and the fault escapes
      // `processNext`. Nothing is recorded as a failure; the job stays 'broadcast' with its hash
      // and only reconciliation can settle it.
      let failNextQuery = false;
      const saturated = new Proxy(h.store, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (prop === 'query' && typeof value === 'function') {
            return async (...args: unknown[]) => {
              if (failNextQuery) {
                failNextQuery = false;
                throw schedulerBusy();
              }
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as typeof h.store;
      const attempts = { n: 0 };
      let now = 5_000;
      const publisher = new TripleStoreAsyncLiftPublisher(saturated, {
        now: () => ++now,
        idGenerator: () => 'job-bookkeeping',
        chainProofResolver: async () => RECOVERED,
        knowledgeAssetVmPublishRecoveryResolver: async () => kaVmRecoveryEvidence(),
        knowledgeAssetVmPublishHandler: {
          execute: async (input) => {
            attempts.n += 1;
            await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
            failNextQuery = true;
            throw new Error('socket hang up mid-send');
          },
          finalizeRecovered: async () => undefined,
        },
      });
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

      // The typed rejection escapes `processNext` (it is a local persistence fault, not a
      // publish failure) — it is NOT recorded as a failure of any code.
      await expect(publisher.processNext('wallet-1')).rejects.toBeInstanceOf(StoreSchedulerBusyError);
      const held = await publisher.getStatus(jobId);
      expect(held?.status).toBe('broadcast');
      expect(held && 'broadcast' in held ? held.broadcast?.txHash : undefined).toBe(TX_HASH);

      expect(await publisher.recover()).toBe(1);
      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
      expect(attempts.n).toBe(1);
    });

    it('holds a raw-lift failure and finalizes it from the chain without a second send', async () => {
      const attempts = { n: 0 };
      const rawRequest = rawLiftRequest();
      const publisher = h.createPublisher({
        ...RETRY_LANE,
        chainProofResolver: async () => RECOVERED,
        publishExecutor: async (input) => {
          attempts.n += 1;
          await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
          throw schedulerBusy();
        },
      });
      await stage();
      const jobId = await seedLegacyRawLiftTestJob(h.store, rawRequest, {
        now: () => 1_000,
        idGenerator: () => 'raw-job-1',
      });
      const failed = expectFailed(await publisher.processNext('wallet-1'));
      expect(isHeldForChainProof(failed)).toBe(true);

      expect(await publisher.recover()).toBe(1);

      expect((await publisher.getStatus(jobId))?.status).toBe('finalized');
      expect(attempts.n).toBe(1);
    });
  });
});
