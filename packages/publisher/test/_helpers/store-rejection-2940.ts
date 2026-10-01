/**
 * GH#2940 — shared fixtures for the store-rejection suites (classification, post-dispatch recovery,
 * retry-lane controls). Each suite owns its own harness instance and resets it per test; only the
 * stateless builders and the harness-bound handler/assertion helpers live here.
 */
import { expect } from 'vitest';
import { StoreSchedulerBusyError } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import type { AsyncLiftPublisherConfig, RawLiftRequest } from '../../src/index.js';
import { hasBroadcastEvidence, isHeldForChainProof } from '../../src/async-lift-retry-disposition.js';
import {
  TX_HASH,
  confirmedPublishResult,
  expectFailed,
  type createAsyncLift2270Harness,
} from './async-lift-2270-harness.js';
import {
  KA_VM_KA_UAL,
  stageKnowledgeAssetShareSnapshot,
} from '../../../../scripts/testing/ka-vm-publish.js';

export type KaVmHandler = NonNullable<AsyncLiftPublisherConfig['knowledgeAssetVmPublishHandler']>;
export type RawExecutor = NonNullable<AsyncLiftPublisherConfig['publishExecutor']>;
export type FlushableStore = { flush?: () => Promise<void> };
export type InsertableStore = { insert: (...args: unknown[]) => Promise<unknown> };

export const RETRY_LANE = { retryBackoffBaseMs: 100, retryBackoffMaxMs: 250, rand: () => 0.5 } as const;

export function schedulerBusy(
  reason: 'queue_wait_timeout' | 'queue_full' = 'queue_wait_timeout',
): StoreSchedulerBusyError {
  return new StoreSchedulerBusyError(reason, 'normal', 'publisher.asyncLift.test', { storeOperation: 'query' });
}

/** What the EVM adapter does to a rejected write-ahead hook: a NEW plain Error, message only. */
export function adapterRewrap(hookError: unknown): Error {
  return new Error(
    `chain:writeahead hook failed before publish broadcast: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
  );
}

/** A legacy raw-lift request over the same staged KA share snapshot the VM-publish rows use. */
export function rawLiftRequest(): RawLiftRequest {
  return {
    swmId: 'swm-1',
    namespace: 'default',
    contextGraphId: 'music-social',
    shareOperationId: 'share-op-1',
    roots: [],
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: KA_VM_KA_UAL,
    assertionVersion: '1',
    publicTripleCount: 2,
    privateTripleCount: 0,
    scope: 'full',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'proof:owner:1' },
  };
}

/** The harness-bound helpers; call once per suite, after `createAsyncLift2270Harness()`. */
export function createStoreRejectionFixtures(h: ReturnType<typeof createAsyncLift2270Harness>) {
  async function stage(): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({ store: h.store });
  }

  /** A KA VM handler whose FIRST execute fails with `first()`; later attempts publish normally. */
  function failsOnceThenPublishes(
    first: () => unknown,
    attempts: { n: number },
  ): KaVmHandler {
    return {
      execute: async () => {
        attempts.n += 1;
        if (attempts.n === 1) throw first();
        return confirmedPublishResult();
      },
    };
  }

  /** A KA VM handler that fires the write-ahead, then throws `error` — the post-dispatch window. */
  function firesBroadcastThenThrows(error: unknown, attempts: { n: number }): KaVmHandler {
    return {
      execute: async (input) => {
        attempts.n += 1;
        await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7 });
        throw error;
      },
    };
  }

  /** The recoverable pre-dispatch shape every pre-dispatch row asserts. */
  function expectRecordedAsPreDispatchStoreRejection(failed: ReturnType<typeof expectFailed>, cause: Error): void {
    expect(failed.failure).toMatchObject({
      failedFromState: 'validated',
      code: 'workspace_unavailable',
      mode: 'retryable',
      retryable: true,
      resolution: 'reset_to_accepted',
    });
    // The fake `timeoutMs: 0` placeholder cannot exist for a class that is not a timeout at all.
    expect(failed.failure.timeout).toBeUndefined();
    // The inner error survives verbatim, `(lane: operation)` suffix included.
    expect(failed.failure.message).toContain(cause.message);
    expect(failed.broadcast).toBeUndefined();
    expect(hasBroadcastEvidence(failed)).toBe(false);
    expect(isHeldForChainProof(failed)).toBe(false);
  }

  return { stage, failsOnceThenPublishes, firesBroadcastThenThrows, expectRecordedAsPreDispatchStoreRejection };
}
