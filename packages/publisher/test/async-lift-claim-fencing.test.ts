import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import { GRAPH_KA_CONTENT_SCOPE_VERSION } from '@origintrail-official/dkg-core';
import {
  createLiftJobFailureMetadata,
  StaleLiftJobClaimError,
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import type { LiftJob, LiftJobBroadcast, RawLiftRequest } from '../src/lift-job.js';
import {
  AsyncLiftClaimCoordinator,
  classifyLiftJobOwnershipMode,
  type LiftJobOwnershipMode,
} from '../src/async-lift-claim-session.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  KA_VM_KA_UAL,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';
import {
  CONTROL_PAYLOAD,
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  jobSubject,
  literal,
  serializeJob,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('async-lift claim fencing', () => {
  let now: number;
  let ids: number;
  let claimTokens: number;
  let store: OxigraphStore;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    claimTokens = 0;
    store = new OxigraphStore();
  });

  function createPublisher(config: AsyncLiftPublisherConfig = {}): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => now,
      idGenerator: () => `job-${++ids}`,
      claimTokenGenerator: () => `claim-${++claimTokens}`,
      ...config,
    });
  }

  async function stageSnapshot(): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({
      store,
      graphManager: new GraphManager(store),
    });
  }

  function rawLiftRequest(): RawLiftRequest {
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

  function gateNextSweepInventory(): {
    captured: Promise<void>;
    release(): void;
  } {
    const captured = deferred();
    const release = deferred();
    const originalQuery = store.query.bind(store);
    let gated = false;
    store.query = async (...args) => {
      const result = await originalQuery(...args);
      if (!gated && args[1]?.source === 'publisher.asyncLift.walletLock.sweep') {
        gated = true;
        captured.resolve();
        await release.promise;
      }
      return result;
    };
    return { captured: captured.promise, release: release.resolve };
  }

  it('binds a transaction scope to the job re-read under its lock', async () => {
    const publisher = createPublisher();
    const firstId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-a',
      now: () => now,
    });
    const secondId = await seedLegacyRawLiftTestJob(store, {
      ...rawLiftRequest(),
      shareOperationId: 'share-op-2',
    }, {
      idGenerator: () => 'job-b',
      now: () => now,
    });
    const firstBefore = await publisher.getStatus(firstId);
    const secondBefore = await publisher.getStatus(secondId);
    if (!secondBefore) throw new Error('expected second job');
    const coordinator = (publisher as unknown as {
      claimCoordinator: AsyncLiftClaimCoordinator;
    }).claimCoordinator;

    await expect(coordinator.runJobTransaction(firstId, async (transaction) => {
      if (transaction.kind !== 'present') throw new Error('expected first job');
      // The scope is bound to job-a even though job-b has the same broad LiftJob type.
      return await transaction.scope.commit(secondBefore, 'reaccept');
    })).rejects.toThrow('cannot replace LiftJob job-a with job-b');

    expect(await publisher.getStatus(firstId)).toEqual(firstBefore);
    expect(await publisher.getStatus(secondId)).toEqual(secondBefore);
  });

  it('rejects an illegal same-job transition at the coordinator persistence boundary', async () => {
    const publisher = createPublisher();
    const jobId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-illegal-transition',
      now: () => now,
    });
    const before = await publisher.getStatus(jobId);
    if (!before || before.status !== 'accepted') throw new Error('expected accepted job');
    const illegal: LiftJobBroadcast = {
      ...before,
      status: 'broadcast',
      claim: {
        walletId: 'wallet-a',
        claimToken: 'claim-illegal',
        claimLeaseExpiresAt: now + 60_000,
      },
      validation: KA_VM_VALIDATION,
      broadcast: {
        txHash: KA_VM_EXECUTOR_TX_HASH,
        walletId: 'wallet-a',
        nonce: 4,
      },
      timestamps: {
        ...before.timestamps,
        claimedAt: now,
        validatedAt: now,
        broadcastAt: now,
        updatedAt: now,
      },
    };
    const coordinator = (publisher as unknown as {
      claimCoordinator: AsyncLiftClaimCoordinator;
    }).claimCoordinator;

    await expect(coordinator.runJobTransaction(jobId, async (transaction) => {
      if (transaction.kind !== 'present') throw new Error('expected job');
      return await transaction.scope.commit(illegal, 'broadcast');
    })).rejects.toThrow(
      'Invalid LiftJob transition: accepted -> broadcast. Allowed: claimed, failed',
    );

    expect(await publisher.getStatus(jobId)).toEqual(before);
  });

  it('closes a transaction scope after removing its job', async () => {
    const publisher = createPublisher();
    const jobId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-removed-scope',
      now: () => now,
    });
    const coordinator = (publisher as unknown as {
      claimCoordinator: AsyncLiftClaimCoordinator;
    }).claimCoordinator;

    await coordinator.runJobTransaction(jobId, async (transaction) => {
      if (transaction.kind !== 'present') throw new Error('expected job');
      const { current, scope } = transaction;
      await scope.commitRemoval();
      await expect(scope.commit(current, 'reaccept')).rejects.toThrow(
        `LiftJob transition scope for ${jobId} is closed`,
      );
    });

    expect(await publisher.getStatus(jobId)).toBeNull();
  });

  it('classifies every lift-job state through one ownership policy', async () => {
    const publisher = createPublisher();
    const jobId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-ownership-matrix',
      now: () => now,
    });
    const accepted = await publisher.getStatus(jobId);
    if (!accepted || accepted.status !== 'accepted') throw new Error('expected accepted job');
    const claimed = await publisher.claimNext('wallet-a');
    if (!claimed) throw new Error('expected claimed job');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    const validated = await publisher.getStatus(jobId);
    if (!validated || validated.status !== 'validated') throw new Error('expected validated job');
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-a', nonce: 4 },
    });
    const broadcast = await publisher.getStatus(jobId);
    if (!broadcast || broadcast.status !== 'broadcast') throw new Error('expected broadcast job');

    const included = {
      ...broadcast,
      status: 'included',
      inclusion: { txHash: KA_VM_EXECUTOR_TX_HASH, blockNumber: 7 },
    } satisfies LiftJob;
    const finalized = {
      ...included,
      status: 'finalized',
      finalization: { txHash: KA_VM_EXECUTOR_TX_HASH },
    } satisfies LiftJob;
    const heldFailure = {
      ...broadcast,
      status: 'failed',
      failure: createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'rpc_unavailable',
        message: 'RPC result unknown',
        errorPayloadRef: 'urn:error:rpc-unknown',
      }),
    } satisfies LiftJob;
    const releasedFailure = {
      ...broadcast,
      status: 'failed',
      failure: createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'tx_reverted',
        message: 'Transaction reverted',
        errorPayloadRef: 'urn:error:tx-reverted',
      }),
    } satisfies LiftJob;
    const signerlessHeldFailure = {
      ...validated,
      status: 'failed',
      failure: createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'rpc_unavailable',
        message: 'Legacy transaction signer was not persisted',
        errorPayloadRef: 'urn:error:legacy-signer-unknown',
      }),
      recovery: {
        action: 'reset_to_accepted',
        recoveredFromStatus: 'broadcast',
        txHashChecked: `0x${'ab'.repeat(32)}`,
      },
    } as LiftJob;
    const cases = [
      ['accepted', accepted, 'released'],
      ['claimed', claimed, 'lease-bound'],
      ['validated', validated, 'lease-bound'],
      ['broadcast', broadcast, 'proof-bound'],
      ['included', included, 'proof-bound'],
      ['finalized', finalized, 'released'],
      ['failed-held', heldFailure, 'proof-bound'],
      ['failed-held-without-signer', signerlessHeldFailure, 'lease-bound'],
      ['failed-proven-ineffective', releasedFailure, 'released'],
    ] satisfies ReadonlyArray<readonly [string, LiftJob, LiftJobOwnershipMode]>;

    expect(Object.fromEntries(
      cases.map(([name, job]) => [name, classifyLiftJobOwnershipMode(job)]),
    )).toEqual(Object.fromEntries(
      cases.map(([name, , expected]) => [name, expected]),
    ));
  });

  it('leases a signer-less legacy proof hold only until its claim expires', async () => {
    const publisher = createPublisher();
    const jobId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-signerless-proof-hold',
      now: () => now,
    });
    await publisher.claimNext('wallet-a');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    const validated = await publisher.getStatus(jobId);
    if (!validated || validated.status !== 'validated') throw new Error('expected validated job');
    const held = {
      ...validated,
      status: 'failed',
      failure: createLiftJobFailureMetadata({
        failedFromState: 'broadcast',
        code: 'rpc_unavailable',
        message: 'Legacy transaction signer was not persisted',
        errorPayloadRef: 'urn:error:legacy-signer-unknown',
      }),
      recovery: {
        action: 'reset_to_accepted',
        recoveredFromStatus: 'broadcast',
        txHashChecked: `0x${'cd'.repeat(32)}`,
      },
    } as LiftJob;
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(held, DEFAULT_CONTROL_GRAPH_URI));
    const coordinator = (publisher as unknown as {
      claimCoordinator: AsyncLiftClaimCoordinator;
    }).claimCoordinator;

    expect(classifyLiftJobOwnershipMode(held)).toBe('lease-bound');
    await expect(coordinator.sweepStaleOwnership()).resolves.toEqual([]);

    now += 5 * 60_000 + 1;
    await expect(coordinator.sweepStaleOwnership()).resolves.toEqual(['wallet-a']);
    const persisted = await publisher.getStatus(jobId);
    expect(persisted).toMatchObject({
      status: 'failed',
      recovery: {
        txHashChecked: `0x${'cd'.repeat(32)}`,
      },
    });
    expect(persisted?.recovery && 'walletIdChecked' in persisted.recovery).toBe(false);
  });

  it('fails closed when an active wallet lock points to a malformed job payload', async () => {
    const publisher = createPublisher();
    const jobId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      idGenerator: () => 'job-corrupt-active',
      now: () => now,
    });
    await publisher.claimNext('wallet-a');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-a', nonce: 4 },
    });
    const valid = await publisher.getStatus(jobId);
    if (!valid || valid.status !== 'broadcast') throw new Error('expected broadcast job');
    await seedLegacyRawLiftTestJob(store, {
      ...rawLiftRequest(),
      shareOperationId: 'share-op-waiting',
    }, {
      idGenerator: () => 'job-waiting',
      now: () => now,
    });

    const corrupt = serializeJob(valid, DEFAULT_CONTROL_GRAPH_URI).map((entry) =>
      entry.predicate === CONTROL_PAYLOAD
        ? { ...entry, object: literal('{not-json') }
        : entry,
    );
    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(corrupt);

    await expect(publisher.getStatus(jobId)).rejects.toThrow('Malformed persisted LiftJob payload');
    await expect(publisher.recover()).rejects.toThrow('Malformed persisted LiftJob payload');
    await expect(publisher.clearTerminalJob(jobId)).resolves.toEqual({
      outcome: 'rejected',
      reason: 'malformed',
    });
    await expect(publisher.claimNext('wallet-a')).rejects.toThrow(
      'Malformed persisted LiftJob payload',
    );

    await store.deleteByPattern({ subject: jobSubject(jobId), graph: DEFAULT_CONTROL_GRAPH_URI });
    await store.insert(serializeJob(valid, DEFAULT_CONTROL_GRAPH_URI));
    await expect(publisher.claimNext('wallet-a')).resolves.toBeNull();
    expect(await publisher.getStatus(jobId)).toMatchObject({
      status: 'broadcast',
      broadcast: { txHash: KA_VM_EXECUTOR_TX_HASH, walletId: 'wallet-a' },
    });
  });

  it('does not recover a live pre-broadcast claim owned by another publisher instance', async () => {
    const executor = createPublisher();
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = await executor.claimNext('wallet-a');
    expect(claimed?.status).toBe('claimed');

    // The recovery/control instance has no in-memory processing epoch for the executor.
    // The durable, unexpired claim lock is therefore the cross-instance ownership authority.
    expect(await recovery.recover()).toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: {
        walletId: 'wallet-a',
        claimToken: claimed?.claim?.claimToken,
      },
    });
  });

  it('mints a fresh token for a same-wallet reclaim even when the clock does not advance', async () => {
    const publisher = createPublisher();
    await stageSnapshot();

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const firstClaim = await publisher.claimNext('wallet-a');
    if (!firstClaim) throw new Error('expected first claim');
    const staleSession = publisher.openClaimSession(firstClaim);
    await staleSession.recordExecutionFailure('claimed', new Error('workspace unavailable'));
    await expect(staleSession.recordExecutionFailure('claimed', new Error('overwrite attempt')))
      .rejects.toBeInstanceOf(StaleLiftJobClaimError);

    expect(await publisher.retry({ status: 'failed' })).toBe(1);
    const replacement = await publisher.claimNext('wallet-a');
    expect(replacement).toMatchObject({ jobId, claim: { walletId: 'wallet-a' } });
    expect(replacement?.claim.claimToken).not.toBe(firstClaim.claim.claimToken);
    expect(now).toBe(1_000);

    await expect(staleSession.update('validated', { validation: KA_VM_VALIDATION }))
      .rejects.toBeInstanceOf(StaleLiftJobClaimError);
    expect(await publisher.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { claimToken: replacement?.claim.claimToken },
    });
  });

  it('ends claim-session authority after finalization releases the wallet', async () => {
    const publisher = createPublisher();
    await stageSnapshot();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claim = await publisher.claimNext('wallet-a');
    if (!claim) throw new Error('expected claim');
    const session = publisher.openClaimSession(claim);

    await session.update('validated', { validation: KA_VM_VALIDATION });
    await session.update('finalized', { finalization: { mode: 'noop' } });
    await expect(session.update('finalized', { finalization: { mode: 'local' } }))
      .rejects.toBeInstanceOf(StaleLiftJobClaimError);
    expect(await publisher.getStatus(jobId)).toMatchObject({
      status: 'finalized',
      finalization: { mode: 'noop' },
    });
  });

  it('does not let an expired worker fail a job reclaimed by the same wallet', async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const staleExecutor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightEntered.resolve();
          await releasePreflight.promise;
          throw new Error('stale canonicalization failure');
        },
        execute: async () => {
          throw new Error('execute must not run after stale preflight');
        },
        finalizeRecovered: async () => {},
      },
    });
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await staleExecutor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const staleRun = staleExecutor.processNext('wallet-a');
    await preflightEntered.promise;
    const staleClaimToken = (await recovery.getStatus(jobId))?.claim?.claimToken;

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const replacement = await recovery.claimNext('wallet-a');
    expect(replacement).toMatchObject({ status: 'claimed', claim: { walletId: 'wallet-a' } });
    expect(replacement?.claim?.claimToken).not.toBe(staleClaimToken);

    releasePreflight.resolve();
    await expect(staleRun).resolves.toMatchObject({
      jobId,
      status: 'claimed',
      claim: { walletId: 'wallet-a', claimToken: replacement?.claim?.claimToken },
    });
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-a', claimToken: replacement?.claim?.claimToken },
    });
  });

  it('does not let a stale epoch clear a replacement worker processing marker', async () => {
    const firstEntered = deferred();
    const secondEntered = deferred();
    const releaseFirst = deferred();
    const releaseSecond = deferred();
    let preflightCalls = 0;
    const executor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightCalls += 1;
          if (preflightCalls === 1) {
            firstEntered.resolve();
            await releaseFirst.promise;
          } else {
            secondEntered.resolve();
            await releaseSecond.promise;
          }
          return { action: 'noop' };
        },
        execute: async () => {
          throw new Error('execute must not run for a no-op');
        },
        finalizeRecovered: async () => {},
      },
    });
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const firstRun = executor.processNext('wallet-a');
    await firstEntered.promise;

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const secondRun = executor.processNext('wallet-b');
    await secondEntered.promise;
    const replacement = await executor.getStatus(jobId);
    expect(replacement).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-b' },
    });

    // Let the stale frame unwind after the replacement has installed its own processing epoch.
    releaseFirst.resolve();
    await expect(firstRun).resolves.toMatchObject({
      jobId,
      claim: { claimToken: replacement?.claim?.claimToken },
    });

    // Expire the replacement's durable lease. Local recovery must still skip it while its process
    // frame is active; if the stale finally deleted by job ID, this would reset the job now.
    now += 5 * 60_000 + 1;
    expect(await executor.recover()).toBe(0);
    expect(await executor.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { claimToken: replacement?.claim?.claimToken },
    });

    releaseSecond.resolve();
    await expect(secondRun).resolves.toMatchObject({ jobId, status: 'accepted' });
  });

  it('recovers an expired unchanged worker claim without requiring an independent recovery pass', async () => {
    const preflightEntered = deferred();
    const releasePreflight = deferred();
    const executor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {
          preflightEntered.resolve();
          await releasePreflight.promise;
        },
        execute: async () => {
          throw new Error('execute must not run after the claim expires');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const run = executor.processNext('wallet-a');
    await preflightEntered.promise;
    const originalToken = (await executor.getStatus(jobId))?.claim?.claimToken;

    now += 5 * 60_000 + 1;
    releasePreflight.resolve();

    await expect(run).resolves.toMatchObject({ jobId, status: 'accepted' });
    expect(await executor.getStatus(jobId)).toMatchObject({ jobId, status: 'accepted' });
    const replacement = await executor.claimNext('wallet-b');
    expect(replacement).toMatchObject({ jobId, status: 'claimed', claim: { walletId: 'wallet-b' } });
    expect(replacement?.claim.claimToken).not.toBe(originalToken);
  });

  it('always releases the processing marker when claim execution escapes with a persistence fault', async () => {
    let failNextJobWrite = false;
    let jobId = '';
    const originalReplaceSubject = store.replaceSubject.bind(store);
    store.replaceSubject = async (...args) => {
      if (failNextJobWrite && args[1].includes(jobId)) {
        failNextJobWrite = false;
        throw new Error('injected job persistence fault');
      }
      await originalReplaceSubject(...args);
    };
    const publisher = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {},
        execute: async () => {
          // The business failure is converted to a durable FAILED transition. Fail that write so
          // processClaim must leave through its fault path, where marker cleanup is the invariant.
          failNextJobWrite = true;
          throw new Error('executor business failure');
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageSnapshot();
    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    await expect(publisher.processNext('wallet-a')).rejects.toThrow('injected job persistence fault');

    // An unreleased in-memory marker makes recovery skip this job forever in this instance. Once
    // its durable lease expires, successful recovery therefore proves the finally cleanup ran.
    now += 5 * 60_000 + 1;
    await expect(publisher.recover()).resolves.toBe(1);
    expect(await publisher.getStatus(jobId)).toMatchObject({ jobId, status: 'accepted' });
  });

  it('preserves the durable broadcast when publish-result persistence faults after send', async () => {
    let failNextJobWrite = false;
    let jobId = '';
    const originalReplaceSubject = store.replaceSubject.bind(store);
    store.replaceSubject = async (...args) => {
      if (failNextJobWrite && args[1].includes(jobId)) {
        failNextJobWrite = false;
        throw new Error('injected post-send result persistence fault');
      }
      await originalReplaceSubject(...args);
    };
    const publisher = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {},
        execute: async (input) => {
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            nonce: 7,
            operationKind: 'create',
          });
          // The pre-send WAL is durable. Fault the next job write, which is the successful
          // result's broadcast -> included transition, after the transaction may be on-chain.
          failNextJobWrite = true;
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
              txHash: KA_VM_EXECUTOR_TX_HASH,
              blockNumber: 77,
              blockTimestamp: 1700000077,
              publisherAddress: '0x2222222222222222222222222222222222222222',
            },
          };
        },
        finalizeRecovered: async () => {},
      },
    });
    await stageSnapshot();
    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    await expect(publisher.processNext('wallet-a'))
      .rejects.toThrow('injected post-send result persistence fault');

    expect(await publisher.getStatus(jobId)).toMatchObject({
      jobId,
      status: 'broadcast',
      broadcast: {
        txHash: KA_VM_EXECUTOR_TX_HASH,
        nonce: 7,
        operationKind: 'create',
      },
    });
    expect((await publisher.getStatus(jobId))?.failure).toBeUndefined();
  });

  it('does not let an expired worker write or send after another wallet reclaims the job', async () => {
    const executeEntered = deferred();
    const releaseExecute = deferred();
    let sends = 0;
    const staleExecutor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => {},
        execute: async (input) => {
          // Reach the real send boundary while this worker still owns the validated claim.
          executeEntered.resolve();
          await releaseExecute.promise;
          await input.publishOptions.onBeforeBroadcast?.({
            txHash: KA_VM_EXECUTOR_TX_HASH,
            nonce: 7,
            operationKind: 'create',
          });
          sends += 1;
          throw Object.assign(new Error('insufficient funds'), { code: 'INSUFFICIENT_FUNDS' });
        },
        finalizeRecovered: async () => {},
      },
    });
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await staleExecutor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const staleRun = staleExecutor.processNext('wallet-a');
    await executeEntered.promise;
    expect(await recovery.getStatus(jobId)).toMatchObject({ status: 'validated' });

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const replacement = await recovery.claimNext('wallet-b');
    expect(replacement).toMatchObject({ status: 'claimed', claim: { walletId: 'wallet-b' } });

    releaseExecute.resolve();
    await expect(staleRun).resolves.toMatchObject({
      jobId,
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: replacement?.claim?.claimToken },
    });
    expect(sends).toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: replacement?.claim?.claimToken },
    });
  });

  it('fences a stale raw-lift worker before its write-ahead or send', async () => {
    const executeEntered = deferred();
    const releaseExecute = deferred();
    let sends = 0;
    const staleExecutor = createPublisher({
      publishExecutor: async (input) => {
        executeEntered.resolve();
        await releaseExecute.promise;
        await input.publishOptions.onBeforeBroadcast?.({ txHash: KA_VM_EXECUTOR_TX_HASH });
        sends += 1;
        throw new Error('stale raw-lift send must not happen');
      },
    });
    const recovery = createPublisher();
    await stageSnapshot();
    const jobId = await seedLegacyRawLiftTestJob(store, rawLiftRequest(), {
      now: () => now,
      idGenerator: () => `job-${++ids}`,
    });

    const staleRun = staleExecutor.processNext('wallet-a');
    await executeEntered.promise;
    expect(await recovery.getStatus(jobId)).toMatchObject({ status: 'validated' });

    now += 5 * 60_000 + 1;
    expect(await recovery.recover()).toBe(1);
    const replacement = await recovery.claimNext('wallet-b');
    expect(replacement).toMatchObject({ jobId, status: 'claimed', claim: { walletId: 'wallet-b' } });

    releaseExecute.resolve();
    await expect(staleRun).resolves.toMatchObject({
      jobId,
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: replacement?.claim.claimToken },
    });
    expect(sends).toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: replacement?.claim.claimToken },
    });
  });

  it('keeps no-op validation and finalization in one owned transition', async () => {
    const validatedLockWrite = deferred();
    const releaseValidatedLockWrite = deferred();
    const originalReplaceSubject = store.replaceSubject.bind(store);
    let walletWrites = 0;
    store.replaceSubject = async (...args) => {
      if (
        args[0] === DEFAULT_WALLET_LOCK_GRAPH_URI
        && args[1] === walletLockSubject('wallet-a')
        && ++walletWrites === 2
      ) {
        validatedLockWrite.resolve();
        await releaseValidatedLockWrite.promise;
      }
      await originalReplaceSubject(...args);
    };

    const executor = createPublisher({
      knowledgeAssetVmPublishHandler: {
        preflight: async () => ({ action: 'noop' }),
        execute: async () => {
          throw new Error('execute must not run for a no-op');
        },
      },
    });
    const recovery = createPublisher();
    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const run = executor.processNext('wallet-a');
    await validatedLockWrite.promise;

    now += 5 * 60_000 + 1;
    const sweep = gateNextSweepInventory();
    const recoveryRun = recovery.recover();
    await sweep.captured;
    sweep.release();
    // Let recovery queue for the job transition lock while the no-op session still owns it.
    await Promise.resolve();
    releaseValidatedLockWrite.resolve();

    await expect(run).resolves.toMatchObject({ jobId, status: 'finalized' });
    await expect(recoveryRun).resolves.toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'finalized',
      validation: { swmQuadCount: 0 },
      finalization: { mode: 'noop' },
    });
  });

  it('does not hold the global claim lock while wallet sweep inventory is paused', async () => {
    const executor = createPublisher();
    const recovery = createPublisher();
    await stageSnapshot();

    const expiredJobId = await executor.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'expired-albums', intentKey: `sha256:${'01'.repeat(32)}` }),
    );
    await executor.claimNext('wallet-a');
    const unrelatedJobId = await executor.enqueueKnowledgeAssetVmPublish(
      kaVmPublishRequest({ name: 'unrelated-albums', intentKey: `sha256:${'02'.repeat(32)}` }),
    );
    now += 5 * 60_000 + 1;

    const sweep = gateNextSweepInventory();
    const recoveryRun = recovery.recover();
    await sweep.captured;

    // Inventory I/O is outside the global claim mutex, so this unrelated wallet can claim now.
    const unrelatedClaim = await executor.claimNext('wallet-b');
    expect(unrelatedClaim).toMatchObject({
      jobId: unrelatedJobId,
      status: 'claimed',
      claim: { walletId: 'wallet-b' },
    });

    sweep.release();
    await expect(recoveryRun).resolves.toBe(1);
    expect(await recovery.getStatus(expiredJobId)).toMatchObject({ status: 'accepted' });
    expect(await recovery.getStatus(unrelatedJobId)).toMatchObject({
      status: 'claimed',
      claim: { walletId: 'wallet-b', claimToken: unrelatedClaim?.claim.claimToken },
    });
  });

  it('preserves a wallet lock refreshed after stale sweep inventory was captured', async () => {
    const executor = createPublisher();
    const recovery = createPublisher();
    await stageSnapshot();

    const jobId = await executor.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = await executor.claimNext('wallet-a');
    expect(claimed).not.toBeNull();

    // Start a worker transition just before expiry. Gate its wallet-lock replace after the job
    // record already carries the renewed lease, leaving the old expiry visible to sweep inventory.
    now += 5 * 60_000 - 1;
    const walletWriteEntered = deferred();
    const releaseWalletWrite = deferred();
    const originalReplaceSubject = store.replaceSubject.bind(store);
    let gateWalletWrite = true;
    store.replaceSubject = async (...args) => {
      if (
        gateWalletWrite
        && args[0] === DEFAULT_WALLET_LOCK_GRAPH_URI
        && args[1] === walletLockSubject('wallet-a')
      ) {
        gateWalletWrite = false;
        walletWriteEntered.resolve();
        await releaseWalletWrite.promise;
      }
      await originalReplaceSubject(...args);
    };

    const renewal = executor.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    await walletWriteEntered.promise;
    now += 2;

    const sweep = gateNextSweepInventory();
    const recoveryRun = recovery.recover();
    await sweep.captured;

    releaseWalletWrite.resolve();
    await renewal;
    sweep.release();

    await expect(recoveryRun).resolves.toBe(0);
    expect(await recovery.getStatus(jobId)).toMatchObject({
      status: 'validated',
      claim: { walletId: 'wallet-a', claimToken: claimed?.claim.claimToken },
    });
    const lockRows = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-a')}> ?predicate ?job .
      }
    }`);
    expect(lockRows.type).toBe('bindings');
    if (lockRows.type === 'bindings') expect(lockRows.bindings.length).toBeGreaterThan(0);
  });
});
