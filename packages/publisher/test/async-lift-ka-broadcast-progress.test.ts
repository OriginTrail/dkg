import { beforeEach, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  type AsyncLiftPublisherConfig,
} from '../src/index.js';
import {
  CONTROL_LOCKED_JOB,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  jobSubject,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import {
  KA_VM_EXECUTOR_TX_HASH,
  KA_VM_KA_UAL,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

describe('KA async VM publish broadcast progress', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  let graphManager: GraphManager;

  beforeEach(() => {
    now = 1_000;
    ids = 0;
    store = new OxigraphStore();
    graphManager = new GraphManager(store);
  });

  function createPublisher(
    config: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator'> = {},
  ): TripleStoreAsyncLiftPublisher {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      ...config,
    });
  }

  async function stageShareSnapshot(): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({ store, graphManager });
  }

  it('persists KA broadcast tx hash when executor write-ahead fires before completion', async () => {
    const txHash = KA_VM_EXECUTOR_TX_HASH;
    let jobId = '';
    let statusDuringExecutor: Awaited<ReturnType<TripleStoreAsyncLiftPublisher['getStatus']>> = null;
    const publisher = createPublisher({
      knowledgeAssetVmPublishHandler: {
        execute: async (input) => {
          await input.publishOptions.onPhase?.(`chain:txsigned:tx-${txHash}`, 'start');
          statusDuringExecutor = await publisher.getStatus(jobId);
          throw new Error('process crashed after tx submit');
        },
      },
    });
    await stageShareSnapshot();

    jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');
    const recovered = await publisher.recover();
    const afterRecover = await publisher.getStatus(jobId);

    expect(statusDuringExecutor?.status).toBe('broadcast');
    expect(statusDuringExecutor?.broadcast?.txHash).toBe(txHash);
    expect(statusDuringExecutor?.broadcast?.walletId).toBe('wallet-1');
    expect(statusDuringExecutor?.broadcast?.merkleRoot).toBe(`0x${'12'.repeat(32)}`);
    expect(processed?.status).toBe('broadcast');
    expect(processed?.broadcast?.txHash).toBe(txHash);
    expect(recovered).toBe(0);
    expect(afterRecover?.status).toBe('broadcast');
    expect(afterRecover?.broadcast?.txHash).toBe(txHash);
  });

  it('does not reset tx-bearing KA broadcast jobs to accepted on recovery timeout', async () => {
    const txHash = `0x${'ef'.repeat(32)}` as `0x${string}`;
    const publisher = createPublisher({ recoveryLookupTimeoutMs: 10 });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: KA_VM_VALIDATION,
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash, walletId: 'wallet-1' },
    });
    now += 20;

    const recovered = await publisher.recover();
    const job = await publisher.getStatus(jobId);
    const lock = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);

    expect(recovered).toBe(1);
    expect(job?.status).toBe('failed');
    expect(job?.failure?.code).toBe('recovery_state_inconsistent');
    expect(job?.failure?.failedFromState).toBe('broadcast');
    expect(job?.failure?.message).toContain(txHash);
    expect(lock.type).toBe('bindings');
    if (lock.type !== 'bindings') return;
    expect(lock.bindings).toHaveLength(0);
  });

  it('finalizes confirmed KA broadcast and included jobs only after lifecycle-aware recovery succeeds', async () => {
    const txHash = `0x${'aa'.repeat(32)}` as `0x${string}`;
    const request = kaVmPublishRequest();
    const kaId = request.seal.reservedKaId!;
    // GH#1966: the production recovery resolver returns the graph-local queued UAL
    // (author + low-96 KA number) for named/graph-scoped KAs, not the contract/packed
    // receipt form. finalizeRecovered is stubbed here, so this proves the durable
    // recover() cycle finalizes exactly once and passes the resolver's graph-local
    // UAL through faithfully — validator acceptance of that form is covered by the
    // agent unit + e2e suites (named-ka-publish-recovery.test.ts, e2e-memory-layers).
    const ual = KA_VM_KA_UAL;
    const finalized: Array<{ jobId: string; status: string }> = [];
    const publisher = createPublisher({
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: {
          txHash,
          blockNumber: 42,
          blockHash: `0x${'ab'.repeat(32)}`,
          blockTimestamp: 2_000,
        },
        finalization: {
          mode: 'published',
          txHash,
          ual,
          batchId: kaId,
          startKAId: kaId,
          endKAId: kaId,
          publisherAddress: '0x4444444444444444444444444444444444444444',
        },
        publishProof: {
          merkleRoot: request.sealMerkleRoot,
          authorAddress: request.seal.authorAddress,
          txIndex: 4,
        },
      }),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('not used'); },
        finalizeRecovered: async (input) => {
          expect(input.job.broadcast.txHash).toBe(txHash);
          expect(input.request.intentKey).toBe(request.intentKey);
          expect(input.recovery.finalization.ual).toBe(ual);
          finalized.push({ jobId: input.job.jobId, status: input.job.status });
        },
      },
    });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: KA_VM_VALIDATION,
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash, walletId: 'wallet-1', merkleRoot: request.sealMerkleRoot },
    });

    expect(await publisher.recover()).toBe(1);
    const job = await publisher.getStatus(jobId);
    expect(finalized).toEqual([{ jobId, status: 'broadcast' }]);
    expect(job?.status).toBe('finalized');
    expect(job?.finalization?.ual).toBe(ual);
    expect(job?.recovery).toEqual({
      action: 'finalized_from_chain',
      recoveredFromStatus: 'broadcast',
      txHashChecked: txHash,
    });

    const includedJobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext('wallet-1');
    await publisher.update(includedJobId, 'validated', {
      validation: KA_VM_VALIDATION,
    });
    await publisher.update(includedJobId, 'broadcast', {
      broadcast: { txHash, walletId: 'wallet-1', merkleRoot: request.sealMerkleRoot },
    });
    await publisher.update(includedJobId, 'included', {
      inclusion: { txHash, blockNumber: 42 },
    });

    expect(await publisher.recover()).toBe(1);
    const includedJob = await publisher.getStatus(includedJobId);
    expect(finalized).toEqual([
      { jobId, status: 'broadcast' },
      { jobId: includedJobId, status: 'included' },
    ]);
    expect(includedJob?.status).toBe('finalized');
    expect(includedJob?.recovery?.recoveredFromStatus).toBe('included');

    // GH#1966: once finalized from the confirmed transaction, a further recovery
    // sweep must not re-process either job — no second on-chain submission.
    expect(await publisher.recover()).toBe(0);
    expect(finalized).toHaveLength(2);
  });

  it('keeps confirmed KA jobs tx-bearing while local lifecycle recovery is blocked', async () => {
    const txHash = `0x${'bb'.repeat(32)}` as `0x${string}`;
    const request = kaVmPublishRequest();
    const kaId = request.seal.reservedKaId!;
    let attempts = 0;
    const publisher = createPublisher({
      recoveryLookupTimeoutMs: 1,
      knowledgeAssetVmPublishRecoveryResolver: async () => ({
        inclusion: {
          txHash,
          blockNumber: 43,
          blockHash: `0x${'ab'.repeat(32)}`,
        },
        finalization: {
          mode: 'published',
          txHash,
          ual: KA_VM_KA_UAL,
          batchId: kaId,
          startKAId: kaId,
          endKAId: kaId,
          publisherAddress: '0x4444444444444444444444444444444444444444',
        },
        publishProof: {
          merkleRoot: request.sealMerkleRoot,
          authorAddress: request.seal.authorAddress,
          txIndex: 4,
        },
      }),
      knowledgeAssetVmPublishHandler: {
        execute: async () => { throw new Error('not used'); },
        finalizeRecovered: async () => {
          attempts += 1;
          throw new Error('SWM snapshot is still catching up');
        },
      },
    });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(request);
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: KA_VM_VALIDATION,
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash, walletId: 'wallet-1', merkleRoot: request.sealMerkleRoot },
    });
    now += 100;

    expect(await publisher.recover()).toBe(0);
    expect(await publisher.recover()).toBe(0);
    const job = await publisher.getStatus(jobId);
    expect(attempts).toBe(2);
    expect(job?.status).toBe('broadcast');
    expect(job?.broadcast?.txHash).toBe(txHash);
    expect(job?.failure).toBeUndefined();

    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type !== 'bindings') return;
    expect(lock.bindings).toEqual([{ job: jobSubject(jobId) }]);
  });

  it('keeps the legacy named-KA executor and preflight config API working', async () => {
    await stageShareSnapshot();
    const preflightCalls: unknown[] = [];
    const executorCalls: unknown[] = [];
    const publisher = createPublisher({
      knowledgeAssetVmPublishPreflight: async (input) => {
        preflightCalls.push(input);
        return { action: 'execute' };
      },
      knowledgeAssetVmPublishExecutor: async (input) => {
        executorCalls.push(input);
        return {
          kaId: 11n,
          ual: 'did:dkg:mock:31337/0xdef/11',
          merkleRoot: new Uint8Array([0xde, 0xf0]),
          kaManifest: [],
          status: 'confirmed',
          onChainResult: {
            batchId: 11n,
            startKAId: 11n,
            endKAId: 11n,
            txHash: '0xdef',
            blockNumber: 77,
            blockTimestamp: 1_700_000_077,
            publisherAddress: '0x2222222222222222222222222222222222222222',
          },
        };
      },
    });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('finalized');
    expect(preflightCalls).toHaveLength(2);
    expect(executorCalls).toHaveLength(1);
  });
});
