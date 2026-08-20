/**
 * GH#2270 — the shared harness for the async-lift retry specs.
 *
 * The suite grew past a thousand lines in one file and was split along its seams (the automatic
 * lane / the failed-job policy / admission and cleanup). This module is what the three files
 * share: a deterministic clock and id generator, the publishers they build over one store, and
 * the four failure fixtures — a corrupt head (pre-send, allow-listed), an unmet quorum (pre-send,
 * no txHash), a recorded broadcast (the landed-tx-unrecorded shape) and a terminal revert.
 *
 * State lives in the harness rather than in each file's closure, so `advance`/`freshStore` are the
 * only two places a row can move the clock or the store.
 */
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  QuorumUnmetError,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
  type KnowledgeAssetVmPublishRequest,
  type LiftJob,
  type LiftJobHex,
} from '../../src/index.js';
import type { PersistedFailedJob } from '../../src/async-lift-publisher-utils.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from './ka-vm-publish.js';

/** The one transaction hash every evidence-bearing fixture persists. */
export const TX_HASH = `0x${'ab'.repeat(32)}` as LiftJobHex;

/** GH#2273 corrupt-head error: the structured code the precondition classifier keys on. */
export function corruptHeadError(): Error {
  return Object.assign(
    new Error('Corrupt graph-scoped SWM head for did:dkg:test/1: head carries 2 shareOperationId values (op-a, storage-ack-b)'),
    { code: 'KA_WORKSPACE_HEAD_CORRUPT' },
  );
}

export function confirmedPublishResult() {
  return {
    kaId: 11n,
    ual: 'did:dkg:mock:31337/0xdef/11',
    merkleRoot: new Uint8Array([0xde, 0xf0]),
    kaManifest: [],
    status: 'confirmed' as const,
    onChainResult: {
      batchId: 11n,
      startKAId: 11n,
      endKAId: 11n,
      txHash: '0xdef',
      blockNumber: 77,
      blockTimestamp: 1700000077,
      publisherAddress: '0x2222222222222222222222222222222222222222',
    },
  };
}

/** Scheduled delay of the retry, measured the way the pre-existing backoff rows measure it. */
export function scheduledDelay(job: LiftJob): number | undefined {
  return job.timestamps.nextRetryAt === undefined
    ? undefined
    : job.timestamps.nextRetryAt - job.timestamps.updatedAt;
}

export function expectFailed(job: LiftJob | null): PersistedFailedJob {
  if (!job || job.status !== 'failed') {
    throw new Error(`expected a failed job, got ${job?.status ?? 'null'}`);
  }
  return job;
}

export function createAsyncLift2270Harness() {
  let now = 1_000;
  let ids = 0;
  let store = new OxigraphStore();

  const createPublisher = (
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher => new TripleStoreAsyncLiftPublisher(store, {
    now: () => ++now,
    idGenerator: () => `job-${++ids}`,
    ...config,
  });

  /** A publisher whose claim-time preflight always rejects with a corrupt head. */
  const createCorruptHeadPublisher = (
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator' | 'knowledgeAssetVmPublishHandler'> = {},
  ): TripleStoreAsyncLiftPublisher => createPublisher({
    ...config,
    knowledgeAssetVmPublishHandler: {
      preflight: async () => {
        throw corruptHeadError();
      },
      execute: async () => {
        throw new Error('executor must not run for a corrupt-head preflight');
      },
    },
  });

  const failWithCorruptHead = async (
    publisher: TripleStoreAsyncLiftPublisher,
    walletId: string,
  ): Promise<LiftJob> => {
    const processed = await publisher.processNext(walletId);
    if (!processed || processed.status !== 'failed') {
      throw new Error(`expected a failed job, got ${processed?.status ?? 'null'}`);
    }
    if (processed.failure.code !== 'workspace_unavailable') {
      throw new Error(`expected workspace_unavailable, got ${processed.failure.code}`);
    }
    return processed;
  };

  /**
   * The landed-transaction-recorded-locally-as-failed shape: a durably recorded broadcast txHash
   * plus the broadcast-phase catch-all code (`rpc_unavailable`, `reset_to_accepted`).
   *
   * Like its siblings it drives the job it enqueued via `claimNext`, which takes the OLDEST
   * accepted job — so a caller must not leave another job sitting in 'accepted'.
   */
  const failAfterRecordedTxHash = async (
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest = kaVmPublishRequest(),
  ): Promise<PersistedFailedJob> => {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const walletId = `wallet-tx-${jobId}`;
    await publisher.claimNext(walletId);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error('RPC endpoint temporarily unavailable'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  };

  /** A pre-send-safe failure: quorum is collected before the publish tx is signed, so no txHash. */
  const failWithUnmetQuorum = async (
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest = kaVmPublishRequest(),
  ): Promise<PersistedFailedJob> => {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext(`wallet-quorum-${jobId}`);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  };

  /**
   * A TERMINAL (non-retryable) broadcast-phase failure. `recordTxHash` decides whether it carries
   * transaction evidence — the only difference that matters to the chain-proof hold.
   */
  const failWithRevert = async (
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest,
    options: { readonly recordTxHash: boolean },
  ): Promise<PersistedFailedJob> => {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const walletId = `wallet-revert-${jobId}`;
    await publisher.claimNext(walletId);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    if (options.recordTxHash) {
      await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });
    }
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error('execution reverted'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  };

  /** A confirmation-phase failure recorded from 'included' — a job that certainly sent a tx. */
  const failFromIncluded = async (
    publisher: TripleStoreAsyncLiftPublisher,
    request: KnowledgeAssetVmPublishRequest = kaVmPublishRequest(),
  ): Promise<PersistedFailedJob> => {
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    const walletId = `wallet-inc-${jobId}`;
    await publisher.claimNext(walletId);
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId } });
    await publisher.update(jobId, 'included', {
      broadcast: { txHash: TX_HASH, walletId },
      inclusion: { txHash: TX_HASH, blockNumber: 42 },
    });
    return expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error('on-chain confirmation mismatch'),
      failedFromState: 'included',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    }));
  };

  return {
    /** Fresh clock, ids and store — call from `beforeEach`. */
    reset(): void {
      now = 1_000;
      ids = 0;
      store = new OxigraphStore();
    },
    /** A brand-new store mid-row, for rows that loop over independent scenarios. */
    freshStore(): void {
      store = new OxigraphStore();
    },
    /** Move the injected clock, the only way a row makes a scheduled retry due. */
    advance(ms: number): void {
      now += ms;
    },
    get store(): OxigraphStore {
      return store;
    },
    createPublisher,
    createCorruptHeadPublisher,
    failWithCorruptHead,
    failAfterRecordedTxHash,
    failWithUnmetQuorum,
    failWithRevert,
    failFromIncluded,
  };
}
