import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { GraphManager, OxigraphStore, PrivateContentStore } from '@origintrail-official/dkg-storage';
import { EVMChainAdapter } from '@origintrail-official/dkg-chain';
import {
  GRAPH_KA_CONTENT_SCOPE_VERSION,
  TypedEventBus,
  generateEd25519Keypair,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';
import { createEVMAdapter, getSharedContext, createProvider, takeSnapshot, revertSnapshot, createTestContextGraph, HARDHAT_KEYS } from '../../chain/test/evm-test-context.js';
import { mintTokens } from '../../chain/test/hardhat-harness.js';
import { wrapPublisherForTest } from './_helpers/seal.js';
import { makeTestKaAllocator } from './_helpers/ka-allocator.js';
import { hardhatACKProvider } from './_helpers/acks.js';
import {
  DKGPublisher,
  QuorumUnmetError,
  TripleStoreAsyncLiftPublisher,
  createLiftJobFailureMetadata,
  type AsyncLiftPublisherConfig,
  type AsyncLiftPublisherRecoveryResult,
  type LiftRequest,
  type Publisher,
} from '../src/index.js';
import {
  CONTROL_JOB_SLUG,
  CONTROL_ACCEPTED_AT,
  CONTROL_AUTHORITY_PROOF_REF,
  CONTROL_HAS_REQUEST,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_MAX_RETRIES,
  CONTROL_WALLET_ID,
  CONTROL_CONTEXT_GRAPH_ID,
  CONTROL_PAYLOAD,
  CONTROL_REQUEST_TYPE,
  CONTROL_ROOT,
  CONTROL_SCOPE,
  CONTROL_SHARE_OPERATION_ID,
  CONTROL_SUB_GRAPH_NAME,
  CONTROL_STATUS,
  CONTROL_SWM_ID,
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  requestSubject,
  jobSubject,
  literal,
  serializeWalletLock,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';
import { withLegacyRawLiftTestSeeder } from './_helpers/legacy-raw-lift.js';
import {
  KA_VM_KA_UAL,
  KA_VM_VALIDATION,
  kaVmPublishRequest,
  stageKnowledgeAssetShareSnapshot,
} from './_helpers/ka-vm-publish.js';

describe('TripleStoreAsyncLiftPublisher', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;
  let CONTEXT_GRAPH: string;
  let _fileSnapshot: string;
  let _kav10Address: string;
  let _provider: ethers.JsonRpcProvider;
  const _author = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
  const ROOTLESS_UAL = KA_VM_KA_UAL;

  function makeTestPublisher(opts: ConstructorParameters<typeof DKGPublisher>[0]): DKGPublisher {
    // OT-RFC-43 Option-1: wire a KA-number allocator so the real EVM adapter
    // gets a packed reservedKaId per mint.
    return wrapPublisherForTest(new DKGPublisher({ kaAllocator: makeTestKaAllocator(), ...opts }), {
      author: _author,
      ctx: { provider: _provider, kav10Address: _kav10Address },
      // RC11 / PR1: real 3-of-N ACK quorum (self-signed ACK fallback gone)
      v10ACKProvider: hardhatACKProvider(_kav10Address),
    });
  }

  beforeAll(async () => {
    _fileSnapshot = await takeSnapshot();
    const { hubAddress } = getSharedContext();
    const provider = createProvider();
    const coreOp = new ethers.Wallet(HARDHAT_KEYS.CORE_OP);
    await mintTokens(provider, hubAddress, HARDHAT_KEYS.DEPLOYER, coreOp.address, ethers.parseEther('50000000'));
    // Public CG (accessPolicy 0): these tests publish PLAINTEXT to exercise
    // async-lift lifecycle/SWM/recovery/provenance mechanics, not curated
    // ciphertext-commitment semantics, so they must not require a ciphertext commitment.
    const cgId = await createTestContextGraph(undefined, undefined, 0);
    CONTEXT_GRAPH = cgId.toString();
    _provider = provider;
    const chain = createEVMAdapter(HARDHAT_KEYS.CORE_OP);
    _kav10Address = await chain.getKnowledgeAssetsLifecycleAddress();
  });
  afterAll(async () => {
    await revertSnapshot(_fileSnapshot);
  });

  const request = (): LiftRequest => ({
    swmId: 'swm-1',
    shareOperationId: 'op-1',
    roots: ['urn:local:/rihana'],
    contextGraphId: 'music-social',
    namespace: 'aloha',
    scope: 'person-profile',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'proof:owner:1' },
  });

  async function stageRootlessSnapshot(shareOperationId: string): Promise<void> {
    await stageKnowledgeAssetShareSnapshot({
      store,
      shareOperationId,
      assertionVersion: 1,
      accessPolicy: 'public',
    });
  }

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_000;
    ids = 0;
  });

  function createPublisher(
    options: {
      recoveryResult?: AsyncLiftPublisherRecoveryResult | null;
      config?: Omit<AsyncLiftPublisherConfig, 'now' | 'idGenerator' | 'chainRecoveryResolver'>;
    } = {},
  ) {
    const clock = () => ++now;
    const nextId = () => `job-${++ids}`;
    const publisher = new TripleStoreAsyncLiftPublisher(store, {
      now: clock,
      idGenerator: nextId,
      chainRecoveryResolver:
        options.recoveryResult === undefined ? undefined : async () => options.recoveryResult ?? null,
      ...options.config,
    });
    return withLegacyRawLiftTestSeeder(publisher, store, {
      now: clock,
      idGenerator: nextId,
      maxRetries: options.config?.maxRetries,
      graphUri: options.config?.graphUri,
    });
  }

  function confirmedPublishResult() {
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

  async function readLockExpiresAt(walletId: string): Promise<number> {
    const result = await store.query(`SELECT ?expiresAt WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject(walletId)}> <${CONTROL_LOCK_EXPIRES_AT}> ?expiresAt .
      }
    }`);

    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') {
      throw new Error('Expected bindings result for wallet lock expiry');
    }

    const value = result.bindings[0]?.['expiresAt'];
    expect(value).toBeDefined();
    const match = value?.match(/^"(-?\d+)"/);
    if (!match) {
      throw new Error(`Unexpected expiresAt literal: ${value}`);
    }
    return Number.parseInt(match[1] as string, 10);
  }

  it('restores accepted legacy records without mutating workspace data', async () => {
    const publisher = createPublisher();
    const privateStore = new PrivateContentStore(store, new GraphManager(store));
    await privateStore.storePrivateTriplesForOperation('music-social', 'op-1', 'urn:local:/rihana', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/secret', object: '"legacy"', graph: '' },
    ]);

    const jobId = await publisher.seedLegacyRawLift(request());
    const job = await publisher.getStatus(jobId);

    expect(jobId).toBe('job-1');
    expect(job?.status).toBe('accepted');
    expect(job?.jobSlug).toBe('music-social/person-profile/create/op-1/rihana');
    expect(job?.request).toMatchObject({
      jobType: 'lift',
      lift: {
        contextGraphId: 'music-social',
        swmId: 'swm-1',
        shareOperationId: 'op-1',
      },
    });
    expect(job?.retries.maxRetries).toBe(10);
    const workspaceMutation = await store.query(
      'ASK { GRAPH <did:dkg:context-graph:music-social/_shared_memory> { ?s ?p ?o } }',
    );
    expect(workspaceMutation).toMatchObject({ type: 'boolean', value: false });
  });

  it('does not expose a raw-root enqueue path on the concrete runtime publisher', async () => {
    const runtimePublisher = new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `runtime-job-${++ids}`,
    });

    expect((runtimePublisher as unknown as { lift?: unknown }).lift).toBeUndefined();
    await expect(runtimePublisher.list()).resolves.toEqual([]);
  });

  it('normalizes and processes legacy persisted raw lift job payloads', async () => {
    const executorCalls: unknown[] = [];
    const publisher = createPublisher({
      config: {
        publishExecutor: async (input) => {
          executorCalls.push(input);
          return confirmedPublishResult();
        },
      },
    });
    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const share = await dkgPublisher.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });
    const legacyRequest = {
      ...request(),
      shareOperationId: share.shareOperationId,
    };
    const jobId = await publisher.seedLegacyRawLift(legacyRequest);
    const stored = await publisher.getStatus(jobId);
    expect(stored?.request.jobType).toBe('lift');
    if (!stored) throw new Error('expected stored job');

    await store.deleteByPattern({
      subject: jobSubject(jobId),
      predicate: CONTROL_PAYLOAD,
      graph: DEFAULT_CONTROL_GRAPH_URI,
    });
    await store.insert([{
      subject: jobSubject(jobId),
      predicate: CONTROL_PAYLOAD,
      object: literal(JSON.stringify({ ...stored, request: legacyRequest })),
      graph: DEFAULT_CONTROL_GRAPH_URI,
    }]);

    const normalized = await publisher.getStatus(jobId);
    expect(normalized?.request).toMatchObject({
      jobType: 'lift',
      lift: {
        contextGraphId: 'music-social',
        shareOperationId: share.shareOperationId,
        roots: ['urn:local:/rihana'],
      },
    });

    const processed = await publisher.processNext('wallet-1');
    expect(processed?.status).toBe('finalized');
    expect(executorCalls).toHaveLength(1);
  });

  it('enqueues named knowledge asset VM publish jobs', async () => {
    const publisher = createPublisher();

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      subGraphName: 'research',
      publishEpochs: 3,
      clearSharedMemoryAfter: false,
      publisherNodeIdentityIdOverride: '42',
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a', 'peer-b'],
      entityProofs: false,
    }));
    const job = await publisher.getStatus(jobId);

    expect(jobId).toBe('job-1');
    expect(job?.status).toBe('accepted');
    expect(job?.jobSlug).toBe('music-social/knowledge-assets/albums/vm-publish/share-op-1/no-roots');
    expect(job?.request.jobType).toBe('knowledge-asset-vm-publish');
    expect(job?.request.knowledgeAssetVmPublish).toEqual({
      contextGraphId: 'music-social',
      name: 'albums',
      subGraphName: 'research',
      shareOperationId: 'share-op-1',
      roots: [],
      contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
      kaUal: ROOTLESS_UAL,
      assertionVersion: '1',
      publicTripleCount: 2,
      privateTripleCount: 0,
      seal: {
        merkleRoot: `0x${'12'.repeat(32)}`,
        authorAddress: '0x1111111111111111111111111111111111111111',
        signature: {
          r: `0x${'34'.repeat(32)}`,
          vs: `0x${'56'.repeat(32)}`,
        },
        schemeVersion: 1,
        reservedKaId: ((BigInt('0x1111111111111111111111111111111111111111') << 96n) | 7n).toString(),
      },
      sealChainId: '31337',
      sealKav10Address: '0x2222222222222222222222222222222222222222',
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
      sealMerkleRoot: `0x${'12'.repeat(32)}`,
      intentKey: 'sha256:' + 'ab'.repeat(32),
      wmCurrentAssertion: '12'.repeat(32),
      swmCurrentAssertion: '12'.repeat(32),
      kaNumber: '7',
      reservedUal: ROOTLESS_UAL,
      accessPolicy: 'allowList',
      allowedPeers: ['peer-a', 'peer-b'],
      entityProofs: false,
      publishEpochs: 3,
      clearSharedMemoryAfter: false,
      publisherNodeIdentityIdOverride: '42',
    });
    expect((job?.request as any).scope).toBeUndefined();
    expect((job?.request as any).namespace).toBeUndefined();
    expect((job?.request as any).authority).toBeUndefined();
  });

  it('rejects unsupported entity proofs before persisting a graph-scoped job', async () => {
    const publisher = createPublisher();

    await expect(
      publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({ entityProofs: true })),
    ).rejects.toThrow(/does not support entityProofs/);
    expect(await publisher.list()).toEqual([]);
  });

  it('rejects duplicate active knowledge asset VM publish jobs', async () => {
    const publisher = createPublisher();

    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      subGraphName: 'research',
    }));

    await expect(
      publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        subGraphName: 'research',
      })),
    ).resolves.toBe('job-1');

    await expect(
      publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        subGraphName: 'research',
        shareOperationId: 'share-op-2',
        intentKey: 'sha256:' + 'cd'.repeat(32),
      })),
    ).rejects.toMatchObject({
      name: 'AsyncLiftJobConflictError',
      code: 'ASYNC_LIFT_JOB_CONFLICT',
      existingJobId: 'job-1',
    });
  });

  it('preserves callerAgentAddress across the persisted queue round-trip (GH#1778)', async () => {
    // The enqueuing caller (curator) is distinct from the resolved author
    // (member) and must survive the strict persisted-job parser, or the async
    // worker's CG auto-registration loses the operator identity it stamps the
    // curator with.
    const publisher = createPublisher();
    const member = `0x${'22'.repeat(20)}`;
    const curator = `0x${'11'.repeat(20)}`;
    const job = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      agentAddress: member,
      callerAgentAddress: curator,
      subGraphName: 'research',
    }));
    const persisted = (await publisher.getStatus(job))?.request.knowledgeAssetVmPublish;
    expect(persisted?.agentAddress).toBe(member);
    expect(persisted?.callerAgentAddress).toBe(curator);
  });

  it('scopes active knowledge asset VM publish duplicate detection by agent address', async () => {
    const publisher = createPublisher();
    const agentA = `0x${'aa'.repeat(20)}`;
    const agentAUpper = `0x${'AA'.repeat(20)}`;
    const agentB = `0x${'bb'.repeat(20)}`;

    const jobA = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      agentAddress: agentA,
      subGraphName: 'research',
    }));

    await expect(
      publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        agentAddress: agentAUpper,
        subGraphName: 'research',
      })),
    ).resolves.toBe(jobA);

    const jobB = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      agentAddress: agentB,
      subGraphName: 'research',
      shareOperationId: 'share-op-2',
      intentKey: 'sha256:' + 'cd'.repeat(32),
    }));

    expect(jobB).toBe('job-2');
    expect((await publisher.getStatus(jobA))?.request.knowledgeAssetVmPublish.agentAddress).toBe(agentA);
    expect((await publisher.getStatus(jobB))?.request.knowledgeAssetVmPublish.agentAddress).toBe(agentB);

    await expect(
      publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
        agentAddress: agentA,
        subGraphName: 'research',
        shareOperationId: 'share-op-3',
        intentKey: 'sha256:' + 'ef'.repeat(32),
      })),
    ).rejects.toMatchObject({
      name: 'AsyncLiftJobConflictError',
      code: 'ASYNC_LIFT_JOB_CONFLICT',
      existingJobId: jobA,
    });
  });

  it('reaccepts a compatible retryable failed knowledge asset VM publish when enqueued again', async () => {
    const publisher = createPublisher();
    const intent = kaVmPublishRequest({ subGraphName: 'research' });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(intent);
    const claimed = await publisher.claimNext('wallet-1');
    expect(claimed?.jobId).toBe(jobId);
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: [],
        canonicalRootMap: {},
        swmQuadCount: 2,
        authorityProofRef: 'urn:dkg:publish-async:share-op-1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: {
        txHash: `0x${'ab'.repeat(32)}`,
        walletId: 'wallet-1',
        merkleRoot: intent.sealMerkleRoot,
      },
    });
    const failed = await publisher.recordPublishFailure(jobId, {
      error: new Error('RPC endpoint temporarily unavailable'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:dkg:test:error:rpc-unavailable',
    });
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') throw new Error('expected failed job');
    expect(failed.failure.retryable).toBe(true);
    expect(failed.timestamps.nextRetryAt).toBeUndefined();

    await expect(publisher.enqueueKnowledgeAssetVmPublish(intent)).resolves.toBe(jobId);
    const reaccepted = await publisher.getStatus(jobId);
    expect(reaccepted?.status).toBe('accepted');
    expect(reaccepted?.retries.retryCount).toBe(1);
    expect(reaccepted?.retries.lastRetryReason).toBe('rpc_unavailable');
    expect(reaccepted?.timestamps.lastRetriedAt).toBeDefined();

    const claimedAgain = await publisher.claimNext('wallet-2');
    expect(claimedAgain?.jobId).toBe(jobId);
    expect(claimedAgain?.status).toBe('claimed');
  });

  it('claims due quorum retries with exponential backoff and a durable max cap', async () => {
    const publisher = createPublisher({
      config: {
        retryBackoffBaseMs: 100,
        retryBackoffMaxMs: 250,
      },
    });
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    const validation = {
      canonicalRoots: [],
      canonicalRootMap: {},
      swmQuadCount: 2,
      authorityProofRef: 'urn:dkg:publish-async:share-op-1',
      transitionType: 'CREATE' as const,
    };
    await publisher.update(jobId, 'validated', { validation });

    const failQuorum = () => publisher.recordPublishFailure(jobId, {
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:dkg:test:error:quorum-unmet',
    });
    const failed = await failQuorum();
    expect(failed.status).toBe('failed');
    if (failed.status !== 'failed') throw new Error('expected failed job');
    expect(failed.failure.code).toBe('quorum_unmet');
    expect((failed.timestamps.nextRetryAt ?? 0) - failed.timestamps.updatedAt).toBe(100);

    expect(await publisher.claimNext('wallet-2')).toBeNull();
    now += 100;
    const firstRetry = await publisher.claimNext('wallet-2');
    expect(firstRetry?.jobId).toBe(jobId);
    expect(firstRetry?.retries.retryCount).toBe(1);
    expect(firstRetry?.retries.lastRetryReason).toBe('quorum_unmet');
    expect(firstRetry?.timestamps.nextRetryAt).toBeUndefined();

    await publisher.update(jobId, 'validated', { validation });
    const failedAgain = await failQuorum();
    expect((failedAgain.timestamps.nextRetryAt ?? 0) - failedAgain.timestamps.updatedAt).toBe(200);

    now += 200;
    const secondRetry = await publisher.claimNext('wallet-3');
    expect(secondRetry?.retries.retryCount).toBe(2);
    await publisher.update(jobId, 'validated', { validation });
    const failedAtCap = await failQuorum();
    expect((failedAtCap.timestamps.nextRetryAt ?? 0) - failedAtCap.timestamps.updatedAt).toBe(250);
  });

  it('processes knowledge asset VM publish jobs through the lifecycle executor', async () => {
    const calls: unknown[] = [];
    const publisher = createPublisher({
      config: {
        knowledgeAssetVmPublishHandler: {
          execute: async (input) => {
            calls.push(input);
            return confirmedPublishResult();
          },
        },
      },
    });
    const shareOperationId = 'rootless-execution-op';
    await stageRootlessSnapshot(shareOperationId);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
      clearSharedMemoryAfter: true,
    }));
    const processed = await publisher.processNext('wallet-1');

    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('finalized');
    expect(processed?.finalization?.ual).toBe('did:dkg:mock:31337/0xdef/11');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
        walletId: 'wallet-1',
        request: {
          contextGraphId: 'music-social',
          name: 'albums',
          shareOperationId,
          roots: [],
          contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
          kaUal: ROOTLESS_UAL,
          assertionVersion: '1',
          publicTripleCount: 2,
          privateTripleCount: 0,
          seal: {
            merkleRoot: `0x${'12'.repeat(32)}`,
            authorAddress: '0x1111111111111111111111111111111111111111',
            signature: {
              r: `0x${'34'.repeat(32)}`,
              vs: `0x${'56'.repeat(32)}`,
            },
            schemeVersion: 1,
          },
          sealChainId: '31337',
          sealKav10Address: '0x2222222222222222222222222222222222222222',
          sealFinalizedAtIso: '2026-01-01T00:00:00.000Z',
          sealMerkleRoot: `0x${'12'.repeat(32)}`,
          intentKey: 'sha256:' + 'ab'.repeat(32),
          wmCurrentAssertion: '12'.repeat(32),
          swmCurrentAssertion: '12'.repeat(32),
          kaNumber: '7',
          reservedUal: ROOTLESS_UAL,
          clearSharedMemoryAfter: true,
        },
        validation: {
          canonicalRoots: [],
          swmQuadCount: 2,
          transitionType: 'CREATE',
        },
        resolved: {
          publisherPeerId: 'peer-1',
        },
        publishOptions: {
          publisherPeerId: 'peer-1',
          quads: expect.arrayContaining([
            { subject: 'urn:album:one', predicate: 'http://schema.org/name', object: '"One"', graph: '' },
            { subject: 'urn:album:two', predicate: 'http://schema.org/name', object: '"Two"', graph: '' },
          ]),
        },
      });
    expect((calls[0] as { publishOptions: { quads: unknown[] } }).publishOptions.quads).toHaveLength(2);
  });

  it('finalizes knowledge asset VM publish jobs as no-op when execution preflight says already published', async () => {
    let executorCalls = 0;
    const preflightCalls: unknown[] = [];
    const publisher = createPublisher({
      config: {
        knowledgeAssetVmPublishHandler: {
          preflight: async (input) => {
            preflightCalls.push(input);
            return { action: 'noop', reason: 'already-published' };
          },
          execute: async () => {
            executorCalls++;
            throw new Error('executor should not run for preflight no-op');
          },
        },
      },
    });
    const shareOperationId = 'rootless-noop-op';
    await stageRootlessSnapshot(shareOperationId);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
    }));
    const processed = await publisher.processNext('wallet-1');
    const reloaded = await publisher.getStatus(jobId);

    expect(preflightCalls).toHaveLength(1);
    expect(executorCalls).toBe(0);
    expect(processed?.status).toBe('finalized');
    expect(processed?.finalization?.mode).toBe('noop');
    expect(reloaded?.status).toBe('finalized');
    expect(reloaded?.finalization?.mode).toBe('noop');
  });

  it('fails stale knowledge asset VM publish jobs before executor invocation', async () => {
    let executorCalls = 0;
    const publisher = createPublisher({
      config: {
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            throw Object.assign(
              new Error('queued VM publish intent is stale'),
              { code: 'PUBLISH_INTENT_STALE' },
            );
          },
          execute: async () => {
            executorCalls++;
            throw new Error('executor should not run for stale preflight');
          },
        },
      },
    });
    const shareOperationId = 'rootless-stale-op';
    await stageRootlessSnapshot(shareOperationId);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
    }));
    const processed = await publisher.processNext('wallet-1');

    expect(executorCalls).toBe(0);
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.failedFromState).toBe('claimed');
    expect(processed?.failure?.code).toBe('publish_intent_stale');
  });

  it('fails a corrupt-head preflight as retryable workspace_unavailable, not a terminal code', async () => {
    // GH#2273 — a multi-valued SWM head (catch-up union residue) is transient local
    // corruption that sync repair heals; the queued request may still be byte-identical
    // to what the head certified at admission. Pre-fix the corrupt-head message fell
    // through the classification chain's keyword sniffing to terminal
    // `canonicalization_failed`, killing a job a later retry could have finalized.
    let executorCalls = 0;
    const publisher = createPublisher({
      config: {
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            throw Object.assign(
              new Error('Corrupt graph-scoped SWM head for did:dkg:test/1: head carries 2 shareOperationId values (op-a, storage-ack-b)'),
              { code: 'KA_WORKSPACE_HEAD_CORRUPT' },
            );
          },
          execute: async () => {
            executorCalls++;
            throw new Error('executor should not run for corrupt-head preflight');
          },
        },
      },
    });
    const shareOperationId = 'rootless-corrupt-head-op';
    await stageRootlessSnapshot(shareOperationId);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
    }));
    const processed = await publisher.processNext('wallet-1');

    expect(executorCalls).toBe(0);
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.failedFromState).toBe('claimed');
    expect(processed?.failure?.code).toBe('workspace_unavailable');
    expect(processed?.failure?.retryable).toBe(true);
  });

  it('classifies a corrupt head at the pre-execute preflight from validated, not broadcast', async () => {
    // GH#2273 — the preflight runs TWICE per attempt: once on claim and once immediately
    // before execute. The second invocation's throw lands in the broadcast-path catch,
    // where the failed-from state is decided by `isKnowledgeAssetPublishPreconditionFailure`.
    // Pre-fix that predicate did not recognize KA_WORKSPACE_HEAD_CORRUPT, so the job
    // failed from 'broadcast' and the SECOND classifier defaulted the corrupt-head
    // message to `rpc_unavailable` — this row pins the site-B path specifically, which
    // the single-preflight row above cannot reach.
    let preflightCalls = 0;
    let executorCalls = 0;
    const publisher = createPublisher({
      config: {
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            preflightCalls += 1;
            if (preflightCalls === 1) return undefined;
            throw Object.assign(
              new Error('Corrupt graph-scoped SWM head for did:dkg:test/1: head carries 2 shareOperationId values (op-a, storage-ack-b)'),
              { code: 'KA_WORKSPACE_HEAD_CORRUPT' },
            );
          },
          execute: async () => {
            executorCalls++;
            throw new Error('executor should not run when the pre-execute preflight rejects');
          },
        },
      },
    });
    const shareOperationId = 'rootless-corrupt-head-presend-op';
    await stageRootlessSnapshot(shareOperationId);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
    }));
    const processed = await publisher.processNext('wallet-1');

    expect(preflightCalls).toBe(2);
    expect(executorCalls).toBe(0);
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.failedFromState).toBe('validated');
    expect(processed?.failure?.code).toBe('workspace_unavailable');
    expect(processed?.failure?.retryable).toBe(true);
  });

  it('classifies a code-only precondition by its structured code, not its message text', async () => {
    // Behavior-INVARIANCE pin for the consolidated precondition classifier:
    // the code that routes a failure to the pre-send 'validated' state is the
    // same decision that persists the failure code. The message here is
    // deliberately keyword-free, so a regression back to message-keyed
    // classification (which would still route the state via the code list)
    // could not reproduce the expected pairing from the message alone.
    let executorCalls = 0;
    let preflightCalls = 0;
    const publisher = createPublisher({
      config: {
        knowledgeAssetVmPublishHandler: {
          preflight: async () => {
            preflightCalls += 1;
            if (preflightCalls === 1) return undefined;
            throw Object.assign(
              new Error('zzz keyword-free precondition zzz'),
              { code: 'CG_NOT_REGISTERED' },
            );
          },
          execute: async () => {
            executorCalls++;
            throw new Error('executor should not run for an unregistered CG precondition');
          },
        },
      },
    });
    const shareOperationId = 'rootless-code-only-precondition-op';
    await stageRootlessSnapshot(shareOperationId);

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest({
      shareOperationId,
    }));
    const processed = await publisher.processNext('wallet-1');

    expect(executorCalls).toBe(0);
    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.failedFromState).toBe('validated');
    // Preserves the pre-existing effective mapping for this code (the legacy
    // chain never matched its real messages either); re-taxonomizing is #1974.
    expect(processed?.failure?.code).toBe('canonicalization_failed');
  });

  it('exposes the SWM share operation contract', async () => {
    const publisherContract: Publisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const write = await publisherContract.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    expect(write.shareOperationId).toContain('swm-');
  });

  it('stores explicit LiftJob and LiftRequest control-plane triples', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift({ ...request(), subGraphName: 'research' });

    const result = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> {
        <${jobSubject(jobId)}> ?p ?o .
      }
    }`);

    expect(result.type).toBe('bindings');
    if (result.type !== 'bindings') return;

    const triples = new Map(result.bindings.map((row) => [row['p'], row['o']]));
    expect(triples.get(CONTROL_STATUS)).toBe('"accepted"');
    expect(triples.get(CONTROL_JOB_SLUG)).toBe('"music-social/person-profile/create/op-1/rihana"');
    expect(triples.get(CONTROL_HAS_REQUEST)).toBe(requestSubject(jobId));
    expect(triples.get(CONTROL_ACCEPTED_AT)).toBe('"1001"^^<http://www.w3.org/2001/XMLSchema#integer>');
    expect(triples.get(CONTROL_MAX_RETRIES)).toBe('"10"^^<http://www.w3.org/2001/XMLSchema#integer>');
    expect(triples.get(CONTROL_PAYLOAD)).toBeDefined();

    const requestResult = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> {
        <${requestSubject(jobId)}> ?p ?o .
      }
    }`);

    expect(requestResult.type).toBe('bindings');
    if (requestResult.type !== 'bindings') return;

    const requestTriples = requestResult.bindings.map((row) => [row['p'], row['o']]);
    expect(requestTriples).toContainEqual([
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      CONTROL_REQUEST_TYPE,
    ]);
    expect(requestTriples).toContainEqual([CONTROL_CONTEXT_GRAPH_ID, '"music-social"']);
    expect(requestTriples).toContainEqual([CONTROL_SWM_ID, '"swm-1"']);
    expect(requestTriples).toContainEqual([CONTROL_SHARE_OPERATION_ID, '"op-1"']);
    expect(requestTriples).toContainEqual([CONTROL_SCOPE, '"person-profile"']);
    expect(requestTriples).toContainEqual([CONTROL_SUB_GRAPH_NAME, '"research"']);
    expect(requestTriples).toContainEqual([CONTROL_AUTHORITY_PROOF_REF, '"proof:owner:1"']);
    expect(requestTriples).toContainEqual([CONTROL_ROOT, '"urn:local:/rihana"']);
  });

  it('claims the oldest accepted job for a wallet', async () => {
    const publisher = createPublisher();

    await publisher.seedLegacyRawLift(request());
    await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-2' });

    const claimed = await publisher.claimNext('wallet-1');
    const remaining = await publisher.list({ status: 'accepted' });

    expect(claimed?.jobId).toBe('job-1');
    expect(claimed?.status).toBe('claimed');
    expect(claimed?.claim?.walletId).toBe('wallet-1');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.jobId).toBe('job-2');
  });

  it('persists wallet locks in a separate control-plane graph and releases them on terminal states', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());

    await publisher.claimNext('wallet-1');

    const lockResult = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);

    expect(lockResult.type).toBe('bindings');
    if (lockResult.type !== 'bindings') return;
    const lockTriples = new Map(lockResult.bindings.map((row) => [row['p'], row['o']]));
    expect(lockTriples.get(CONTROL_WALLET_ID)).toBe('"wallet-1"');
    expect(lockTriples.get(CONTROL_LOCKED_JOB)).toBe(jobSubject(jobId));
    expect(lockTriples.get(CONTROL_LOCK_STATUS)).toBe('"active"');
    expect(lockTriples.get(CONTROL_LOCK_EXPIRES_AT)).toBeDefined();

    await publisher.update(jobId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'wallet_unavailable',
        message: 'wallet offline',
        errorPayloadRef: 'urn:error:wallet-offline',
      }) as any,
    });

    const released = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);
    expect(released.type).toBe('bindings');
    if (released.type !== 'bindings') return;
    expect(released.bindings).toHaveLength(0);
  });

  it('renews wallet lock leases while jobs remain active', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-2' });

    await publisher.claimNext('wallet-1');
    const originalExpiresAt = await readLockExpiresAt('wallet-1');
    now += 5 * 60 * 1000 - 100;

    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });

    const renewedExpiresAt = await readLockExpiresAt('wallet-1');
    expect(renewedExpiresAt).toBeGreaterThan(originalExpiresAt);

    now = originalExpiresAt;
    expect(await publisher.claimNext('wallet-1')).toBeNull();
  });

  it('releases stale wallet locks during recovery', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());

    await publisher.claimNext('wallet-1');

    now += 5 * 60 * 1000 + 10;
    const recovered = await publisher.recover();
    const job = await publisher.getStatus(jobId);
    const released = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);

    expect(recovered).toBe(1);
    expect(job?.status).toBe('accepted');
    expect(released.type).toBe('bindings');
    if (released.type !== 'bindings') return;
    expect(released.bindings).toHaveLength(0);
  });

  it('clears orphan wallet locks for terminal jobs during recovery', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());

    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'wallet_unavailable',
        message: 'wallet offline',
        errorPayloadRef: 'urn:error:wallet-offline',
      }) as any,
    });

    await store.insert(
      serializeWalletLock(
        {
          walletId: 'wallet-1',
          jobId,
          acquiredAt: now,
          expiresAt: now + 60_000,
          status: 'active',
        },
        DEFAULT_WALLET_LOCK_GRAPH_URI,
      ),
    );

    await publisher.recover();

    const released = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);
    expect(released.type).toBe('bindings');
    if (released.type !== 'bindings') return;
    expect(released.bindings).toHaveLength(0);
  });

  it('rejects a stale release without deleting a newer wallet lock', async () => {
    const publisher = createPublisher();
    const jobA = await publisher.seedLegacyRawLift(request());
    const jobB = await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-2' });

    await publisher.claimNext('wallet-1');
    await publisher.update(jobA, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });

    await store.deleteByPattern({
      subject: walletLockSubject('wallet-1'),
      graph: DEFAULT_WALLET_LOCK_GRAPH_URI,
    });
    await store.insert(
      serializeWalletLock(
        {
          walletId: 'wallet-1',
          jobId: jobB,
          acquiredAt: now,
          expiresAt: now + 60_000,
          status: 'active',
          claimToken: 'wallet-1:replacement',
        },
        DEFAULT_WALLET_LOCK_GRAPH_URI,
      ),
    );

    await expect(
      publisher.update(jobA, 'failed', {
        failure: createLiftJobFailureMetadata({
          failedFromState: 'validated',
          code: 'authority_unavailable',
          message: 'late failure',
          errorPayloadRef: 'urn:error:late-failure',
        }) as any,
      }),
    ).rejects.toThrow(/stale|lock|claim/i);

    const lock = await store.query(`SELECT ?job WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> <${CONTROL_LOCKED_JOB}> ?job .
      }
    }`);
    expect(lock.type).toBe('bindings');
    if (lock.type !== 'bindings') return;
    expect(lock.bindings[0]?.['job']).toBe(jobSubject(jobB));
  });

  it('serializes concurrent claims so only one wallet gets the job', async () => {
    const publisher = createPublisher();
    await publisher.seedLegacyRawLift(request());

    const [first, second] = await Promise.all([
      publisher.claimNext('wallet-1'),
      publisher.claimNext('wallet-2'),
    ]);

    const claimed = [first, second].filter(Boolean);
    const empty = [first, second].filter((job) => job === null);

    expect(claimed).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(claimed[0]?.status).toBe('claimed');
  });

  it('serializes claims across publisher instances in the same process', async () => {
    const first = createPublisher();
    const second = createPublisher();
    await first.seedLegacyRawLift(request());

    const [jobA, jobB] = await Promise.all([
      first.claimNext('wallet-1'),
      second.claimNext('wallet-2'),
    ]);

    const claimed = [jobA, jobB].filter(Boolean);
    const empty = [jobA, jobB].filter((job) => job === null);

    expect(claimed).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(claimed[0]?.status).toBe('claimed');
  });

  it('derives readable root-range slugs for multiple roots', async () => {
    const publisher = createPublisher();

    const jobId = await publisher.seedLegacyRawLift({
      ...request(),
      shareOperationId: 'op-9',
      roots: ['urn:local:/manson', 'urn:local:/rihana'],
    });

    const job = await publisher.getStatus(jobId);
    expect(job?.jobSlug).toBe('music-social/person-profile/create/op-9/manson-rihana');
  });

  it('updates jobs through the MVP state machine', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.claimNext('wallet-1');

    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xabc', walletId: 'wallet-1' },
    });
    await publisher.update(jobId, 'included', {
      inclusion: { txHash: '0xabc', blockNumber: 42 },
    });
    await publisher.update(jobId, 'finalized', {
      finalization: {
        txHash: '0xabc',
        ual: 'did:dkg:mock:31337/0xabc/1',
        batchId: '1',
        startKAId: '1',
        endKAId: '1',
        publisherAddress: '0x1111111111111111111111111111111111111111',
      },
    });

    const job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('finalized');
    expect(job?.finalization?.txHash).toBe('0xabc');
  });

  it('records canonical publish results back into LiftJob progress states', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });

    const included = await publisher.recordPublishResult(
      jobId,
      {
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
      { publicByteSize: 123 },
    );

    expect(included.status).toBe('included');
    expect(included.broadcast?.txHash).toBe('0xabc');
    expect(included.broadcast?.publicByteSize).toBe(123);
    expect(included.inclusion?.blockNumber).toBe(10);

    const finalized = await publisher.recordPublishResult(jobId, {
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
    });

    expect(finalized.status).toBe('finalized');
    expect(finalized.finalization?.ual).toBe('did:dkg:mock:31337/0xabc/1');
    expect(finalized.finalization?.batchId).toBe('7');
  });

  it('rejects publish results whose tx differs from persisted broadcast tx', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: {
        txHash: '0xaaa',
        walletId: 'wallet-1',
      },
    });

    await expect(
      publisher.recordPublishResult(jobId, {
        kaId: 1n,
        ual: 'did:dkg:mock:31337/0xbbb/1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'confirmed',
        onChainResult: {
          batchId: 7n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: '0xbbb',
          blockNumber: 10,
          blockTimestamp: 1700000000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      }),
    ).rejects.toThrow(/does not match persisted broadcast tx 0xaaa/);

    const stored = await publisher.getStatus(jobId);
    expect(stored?.status).toBe('broadcast');
    expect(stored?.broadcast?.txHash).toBe('0xaaa');
    expect(stored?.inclusion).toBeUndefined();
    expect(stored?.finalization).toBeUndefined();
  });

  it('records canonical publish failures back into LiftJob failed state', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });

    const failed = await publisher.recordPublishFailure(jobId, {
      error: new Error('RPC submit timed out after 30s'),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:error:submit-timeout',
      timeout: {
        timeoutMs: 30_000,
        timeoutAt: 123,
        handling: 'check_chain_then_finalize_or_reset',
      },
    });

    expect(failed.status).toBe('failed');
    expect(failed.failure?.code).toBe('tx_submit_timeout');
    expect(failed.failure?.timeout?.timeoutMs).toBe(30_000);
  });

  it('processes the next job through workspace resolution, validation, and canonical publish', async () => {
    const publisher = createPublisher({
      config: {
        publishExecutor: async ({ walletId, publishOptions }) => {
          expect(walletId).toBe('wallet-1');
          expect(publishOptions.contextGraphId).toBe('music-social');
          // GH #1122 — async lift preserves caller root IRIs (parity with sync).
          expect(publishOptions.quads[0]?.subject).toBe('urn:local:/rihana');
          expect(publishOptions.privateQuads?.[0]?.subject).toBe('urn:local:/rihana');
          return {
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
          };
        },
      },
    });
    const privateStore = new PrivateContentStore(store, new GraphManager(store));

    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const write = await dkgPublisher.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });
    await privateStore.storePrivateTriplesForOperation('music-social', write.shareOperationId, 'urn:local:/rihana', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/secret', object: '"stage-secret"', graph: '' },
    ]);
    expect(await privateStore.getPrivateTriples('music-social', 'urn:local:/rihana')).toEqual([]);

    const jobId = await publisher.seedLegacyRawLift({
      ...request(),
      shareOperationId: write.shareOperationId,
    });

    const processed = await publisher.processNext('wallet-1');

    expect(processed?.jobId).toBe(jobId);
    expect(processed?.status).toBe('finalized');
    expect(processed?.validation?.authorityProofRef).toBe('proof:owner:1');
    expect(processed?.finalization?.ual).toBe('did:dkg:mock:31337/0xabc/1');
    const canonicalRoot = processed?.validation?.canonicalRootMap['urn:local:/rihana'];
    expect(canonicalRoot).toBeDefined();
    expect((await privateStore.getPrivateTriples('music-social', canonicalRoot!)).map((quad) => quad.object)).toEqual(['"stage-secret"']);
    expect(await privateStore.getPrivateTriplesForOperation('music-social', write.shareOperationId, 'urn:local:/rihana')).toEqual([]);
  });

  it('records validation/publish execution failures during processNext', async () => {
    const publisher = createPublisher({
      config: {
        publishExecutor: async () => {
          throw new Error('RPC submit timed out after 30s');
        },
      },
    });

    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const write = await dkgPublisher.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    await publisher.seedLegacyRawLift({
      ...request(),
      shareOperationId: write.shareOperationId,
    });

    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.code).toBe('tx_submit_timeout');
  });

  it('finalizes tentative publish results without on-chain details as local completions', async () => {
    const publisher = createPublisher({
      config: {
        publishExecutor: async () => ({
          kaId: 0n,
          ual: 'did:dkg:mock:31337/0xabc/tentative',
          merkleRoot: new Uint8Array([0xab, 0xcd]),
          kaManifest: [],
          status: 'tentative',
        }),
      },
    });

    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const write = await dkgPublisher.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    await publisher.seedLegacyRawLift({
      ...request(),
      shareOperationId: write.shareOperationId,
    });

    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('finalized');
    expect(processed?.broadcast).toBeUndefined();
    expect(processed?.inclusion).toBeUndefined();
    expect(processed?.finalization).toEqual({
      mode: 'local',
      ual: 'did:dkg:mock:31337/0xabc/tentative',
    });
    expect(processed?.failure).toBeUndefined();
  });

  it('persists unknown included-phase failures as terminal failed jobs', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.seedLegacyRawLift(request());

    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 1,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });

    const failed = await publisher.recordPublishFailure(jobId, {
      error: new Error('unexpected included-phase issue'),
      failedFromState: 'included',
      errorPayloadRef: 'urn:error:unknown-included',
    });

    expect(failed.status).toBe('failed');
    expect(failed.failure?.code).toBe('confirmation_mismatch');
  });

  it('uses renamed shared-memory fields in publisher APIs', async () => {
    const publisher = createPublisher();
    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    const write = await dkgPublisher.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    expect(write.shareOperationId).toContain('swm-');

    const jobId = await publisher.seedLegacyRawLift({
      swmId: 'swm-main',
      shareOperationId: write.shareOperationId,
      roots: ['urn:local:/rihana'],
      contextGraphId: 'music-social',
      namespace: 'aloha',
      scope: 'person-profile',
      transitionType: 'CREATE',
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });

    const job = await publisher.getStatus(jobId);
    expect(job?.request.jobType).toBe('lift');
    expect(job?.request.jobType === 'lift' ? job.request.lift.shareOperationId : undefined).toBe(write.shareOperationId);
    expect(job?.jobSlug).toContain(write.shareOperationId);
  });

  it('stores confirmed metadata in the graph manager meta graph', async () => {
    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const graphManager = new GraphManager(store);

    const result = await dkgPublisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [
        { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
      ],
      publisherPeerId: 'peer-1',
    });

    expect(result.status).toBe('confirmed');

    const metadata = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${graphManager.metaGraphUri(CONTEXT_GRAPH)}> {
        <${result.ual}> ?p ?o .
      }
    }`);

    expect(metadata.type).toBe('bindings');
    if (metadata.type !== 'bindings') {
      throw new Error('Expected bindings result for metadata graph');
    }
    expect(metadata.bindings.length).toBeGreaterThan(0);
  });

  it('publishes only the unmatched CREATE remainder against finalized authoritative state', async () => {
    const executorCalls: Array<{ publishOptions: any }> = [];
    const publishExecutor = async ({ walletId, publishOptions }: any) => {
      executorCalls.push({ publishOptions });
      expect(publishOptions.quads).toHaveLength(1);
      expect(publishOptions.quads[0]?.predicate).toBe('http://schema.org/genre');
      return {
        kaId: 1n,
        ual: 'did:dkg:mock:31337/0xabc/1',
        merkleRoot: new Uint8Array([0xab, 0xcd]),
        kaManifest: [],
        status: 'confirmed' as const,
        onChainResult: {
          batchId: 7n,
          startKAId: 1n,
          endKAId: 1n,
          txHash: '0xabc',
          blockNumber: 10,
          blockTimestamp: 1700000000,
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      };
    };
    const publisher = createPublisher({ config: { publishExecutor } });

    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    // GH #1122 — the async lift now PRESERVES caller root IRIs (parity with
    // sync), so authoritative VM state and the SWM share live at the SAME root
    // (`urn:local:/rihana`). Seed the authoritative state through a SEPARATE
    // publisher instance: Rule-4 entity exclusivity is tracked per-process in
    // memory (`ownedEntities`, never hydrated from the store), so `dkgPublisher`
    // does not see this root as locally owned and the subsequent share() is
    // allowed — exactly the cross-node idempotency case the CREATE-remainder
    // subtraction guards (node A finalized R; node B shares R and lifts a CREATE,
    // and subtraction drops the already-finalized quads from the store).
    const seedPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    await seedPublisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [
        { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
      ],
      publisherPeerId: 'peer-1',
    });

    const write = await dkgPublisher.share(CONTEXT_GRAPH, [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/genre', object: '"Pop"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    await publisher.seedLegacyRawLift({
      ...request(),
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: write.shareOperationId,
    });

    const processed = await publisher.processNext('wallet-1');

    expect(executorCalls).toHaveLength(1);
    expect(processed?.status).toBe('finalized');
  });

  it('finalizes CREATE as a no-op when all canonical quads are already authoritative', async () => {
    let executorCallCount = 0;
    const publishExecutor = async () => {
      executorCallCount++;
      throw new Error('should not be called');
    };
    const publisher = createPublisher({ config: { publishExecutor } });

    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });

    // GH #1122 — caller-IRI parity: seed authoritative VM state at the SAME root
    // through a SEPARATE publisher instance so `dkgPublisher`'s per-process Rule-4
    // tracking does not block the share (see the remainder test above for the
    // full rationale).
    const seedPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    await seedPublisher.publish({
      contextGraphId: CONTEXT_GRAPH,
      quads: [
        { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
      ],
      publisherPeerId: 'peer-1',
    });

    const write = await dkgPublisher.share(CONTEXT_GRAPH, [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    await publisher.seedLegacyRawLift({
      ...request(),
      contextGraphId: CONTEXT_GRAPH,
      shareOperationId: write.shareOperationId,
    });

    const processed = await publisher.processNext('wallet-1');
    const reloaded = await publisher.getStatus(processed!.jobId);

    expect(executorCallCount).toBe(0);
    expect(processed?.status).toBe('finalized');
    expect(processed?.finalization?.mode).toBe('noop');
    expect(reloaded?.status).toBe('finalized');
    expect(reloaded?.finalization?.mode).toBe('noop');
  });

  it('keeps prepare-stage mapping/config failures on the validation side', async () => {
    const publisher = createPublisher({
      config: {
        resolvedSliceOverrides: {
          accessPolicy: 'ownerOnly',
          publisherPeerId: '',
        },
        publishExecutor: async () => {
          throw new Error('should not be called');
        },
      },
    });

    const dkgPublisher = makeTestPublisher({
      store,
      chain: createEVMAdapter(HARDHAT_KEYS.CORE_OP),
      eventBus: new TypedEventBus(),
      keypair: await generateEd25519Keypair(),
      publisherPrivateKey: HARDHAT_KEYS.CORE_OP,
      publisherNodeIdentityId: BigInt(getSharedContext().coreProfileId),
    });
    const write = await dkgPublisher.share('music-social', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/name', object: '"Rihana"', graph: '' },
    ], { publisherPeerId: 'peer-1' });

    await publisher.seedLegacyRawLift({
      ...request(),
      shareOperationId: write.shareOperationId,
      authority: { type: 'owner', proofRef: 'proof:owner:1' },
    });

    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.code).toBe('canonicalization_failed');
  });

  it('classifies transient shared-memory resolution failures as retryable validation failures', async () => {
    const publisher = createPublisher({
      config: {
        publishExecutor: async () => {
          throw new Error('should not be called');
        },
      },
    });
    await publisher.seedLegacyRawLift({
      ...request(),
      shareOperationId: 'op-1',
    });

    const originalQuery = store.query.bind(store);
    store.query = async (sparql: string) => {
      if (sparql.includes('_shared_memory_meta')) {
        throw new Error('shared memory store timeout');
      }
      return originalQuery(sparql);
    };

    const processed = await publisher.processNext('wallet-1');

    expect(processed?.status).toBe('failed');
    expect(processed?.failure?.code).toBe('workspace_unavailable');
    expect(processed?.failure?.retryable).toBe(true);
  });

  it('lists and counts jobs by status', async () => {
    const publisher = createPublisher();
    const acceptedId = await publisher.seedLegacyRawLift(request());
    const failedId = await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-2' });
    await publisher.claimNext('wallet-1');
    await publisher.claimNext('wallet-2');
    await publisher.update(failedId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'wallet_unavailable',
        message: 'wallet offline',
        errorPayloadRef: 'urn:error:wallet-offline',
      }) as any,
    });

    const failed = await publisher.list({ status: 'failed' });
    const stats = await publisher.getStats();

    expect(failed).toHaveLength(1);
    expect(failed[0]?.jobId).toBe(failedId);
    expect(stats.accepted).toBe(0);
    expect(stats.failed).toBe(1);
    expect(stats.claimed).toBe(1);
    expect((await publisher.getStatus(acceptedId))?.status).toBe('claimed');
  });

  it('recovers interrupted jobs and finalizes broadcast jobs through the resolver', async () => {
    const publisher = createPublisher({
      recoveryResult: {
        inclusion: { txHash: '0xbbb', blockNumber: 7 },
        finalization: {
          txHash: '0xbbb',
          ual: 'did:dkg:mock:31337/0xbbb/7',
          batchId: '7',
          startKAId: '7',
          endKAId: '7',
          publisherAddress: '0x1111111111111111111111111111111111111111',
        },
      },
    });

    const claimedId = await publisher.seedLegacyRawLift(request());
    const broadcastId = await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-2' });
    const privateStore = new PrivateContentStore(store, new GraphManager(store));
    await privateStore.storePrivateTriplesForOperation('music-social', 'op-2', 'urn:local:/rihana', [
      { subject: 'urn:local:/rihana', predicate: 'http://schema.org/secret', object: '"recover-secret"', graph: '' },
    ]);

    await publisher.claimNext('wallet-1');
    await publisher.claimNext('wallet-2');

    await publisher.update(broadcastId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(broadcastId, 'broadcast', {
      broadcast: { txHash: '0xbbb', walletId: 'wallet-2' },
    });

    const recovered = await publisher.recover();
    const claimed = await publisher.getStatus(claimedId);
    const broadcast = await publisher.getStatus(broadcastId);

    expect(recovered).toBe(2);
    expect(claimed?.status).toBe('accepted');
    expect(broadcast?.status).toBe('finalized');
    expect(broadcast?.recovery?.action).toBe('finalized_from_chain');
    expect((await privateStore.getPrivateTriples('music-social', 'dkg:music-social:aloha:person/rihana')).map((quad) => quad.object)).toEqual(['"recover-secret"']);
    expect(await privateStore.getPrivateTriplesForOperation('music-social', 'op-2', 'urn:local:/rihana')).toEqual([]);
  });

  it('keeps broadcast jobs in place while inconclusive recovery is still within the timeout window', async () => {
    const publisher = createPublisher({ recoveryResult: null });
    const broadcastId = await publisher.seedLegacyRawLift(request());

    await publisher.claimNext('wallet-1');
    await publisher.update(broadcastId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(broadcastId, 'broadcast', {
      broadcast: { txHash: '0xccc', walletId: 'wallet-1' },
    });

    const recovered = await publisher.recover();
    const job = await publisher.getStatus(broadcastId);

    expect(recovered).toBe(0);
    expect(job?.status).toBe('broadcast');
    expect(job?.recovery).toBeUndefined();
  });

  it('fails broadcast jobs once inconclusive recovery exceeds the timeout window', async () => {
    const publisher = createPublisher({
      recoveryResult: null,
      config: {
        recoveryLookupTimeoutMs: 50,
      },
    });
    const broadcastId = await publisher.seedLegacyRawLift(request());

    await publisher.claimNext('wallet-1');
    await publisher.update(broadcastId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(broadcastId, 'broadcast', {
      broadcast: { txHash: '0xccc', walletId: 'wallet-1' },
    });

    now += 100;

    const recovered = await publisher.recover();
    const job = await publisher.getStatus(broadcastId);

    expect(recovered).toBe(1);
    expect(job?.status).toBe('failed');
    expect(job?.failure?.code).toBe('recovery_lookup_timeout');
    expect(job?.failure?.timeout?.handling).toBe('retry_recovery');
  });

  it('finalizes retry_recovery jobs from broadcast with correct recoveredFromStatus', async () => {
    let resolverResult: AsyncLiftPublisherRecoveryResult | null = null;
    const clock = () => ++now;
    const nextId = () => `job-${++ids}`;
    const publisher = withLegacyRawLiftTestSeeder(new TripleStoreAsyncLiftPublisher(store, {
      now: clock,
      idGenerator: nextId,
      chainRecoveryResolver: async () => resolverResult,
      recoveryLookupTimeoutMs: 50,
    }), store, { now: clock, idGenerator: nextId });

    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3, authorityProofRef: 'proof:owner:1', transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xbcast', walletId: 'wallet-1' },
    });

    now += 100;
    await publisher.recover();
    let job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.failure?.failedFromState).toBe('broadcast');
    expect(job?.failure?.timeout?.handling).toBe('retry_recovery');
    expect(job?.timestamps?.failedAt).toBeDefined();

    resolverResult = {
      inclusion: { txHash: '0xbcast', blockNumber: 8 },
      finalization: {
        txHash: '0xfin', blockNumber: 10, blockTimestamp: now,
        batchId: 'batch-1', batchRoot: '0xroot', batchSize: 1,
      },
    };
    await publisher.recover();
    job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('finalized');
    expect(job?.recovery?.action).toBe('finalized_from_chain');
    expect(job?.recovery?.recoveredFromStatus).toBe('broadcast');
    expect(job?.timestamps?.failedAt).toBeUndefined();
  });

  it('finalizes retry_recovery jobs from included with correct recoveredFromStatus', async () => {
    let resolverResult: AsyncLiftPublisherRecoveryResult | null = null;
    const clock = () => ++now;
    const nextId = () => `job-${++ids}`;
    const publisher = withLegacyRawLiftTestSeeder(new TripleStoreAsyncLiftPublisher(store, {
      now: clock,
      idGenerator: nextId,
      chainRecoveryResolver: async () => resolverResult,
      recoveryLookupTimeoutMs: 50,
    }), store, { now: clock, idGenerator: nextId });

    const jobId = await publisher.seedLegacyRawLift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3, authorityProofRef: 'proof:owner:1', transitionType: 'CREATE',
      },
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xincl', walletId: 'wallet-1' },
    });
    await publisher.update(jobId, 'included', {
      inclusion: { txHash: '0xincl', blockNumber: 9 },
    });

    now += 100;
    await publisher.recover();
    let job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.failure?.failedFromState).toBe('included');
    expect(job?.failure?.timeout?.handling).toBe('retry_recovery');
    expect(job?.timestamps?.failedAt).toBeDefined();

    resolverResult = {
      inclusion: { txHash: '0xincl', blockNumber: 9 },
      finalization: {
        txHash: '0xfin2', blockNumber: 12, blockTimestamp: now,
        batchId: 'batch-2', batchRoot: '0xroot2', batchSize: 1,
      },
    };
    await publisher.recover();
    job = await publisher.getStatus(jobId);
    expect(job?.status).toBe('finalized');
    expect(job?.recovery?.action).toBe('finalized_from_chain');
    expect(job?.recovery?.recoveredFromStatus).toBe('included');
    expect(job?.timestamps?.failedAt).toBeUndefined();
  });

  it('keeps broadcast knowledge asset VM publish jobs pending instead of blind retrying', async () => {
    const publisher = createPublisher();

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: KA_VM_VALIDATION,
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xkavm', walletId: 'wallet-1' },
    });

    const recovered = await publisher.recover();
    const job = await publisher.getStatus(jobId);
    const lock = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_WALLET_LOCK_GRAPH_URI}> {
        <${walletLockSubject('wallet-1')}> ?p ?o .
      }
    }`);

    expect(recovered).toBe(0);
    expect(job?.status).toBe('broadcast');
    expect(job?.broadcast?.txHash).toBe('0xkavm');
    expect(job?.recovery).toBeUndefined();
    expect(lock.type).toBe('bindings');
    if (lock.type !== 'bindings') return;
    expect(lock.bindings.length).toBeGreaterThan(0);
  });

  it('fails included knowledge asset VM publish jobs as clearable lifecycle recovery failures', async () => {
    const publisher = createPublisher({
      config: {
        recoveryLookupTimeoutMs: 50,
      },
    });

    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: KA_VM_VALIDATION,
    });
    await publisher.update(jobId, 'broadcast', {
      broadcast: { txHash: '0xkavm', walletId: 'wallet-1' },
    });
    await publisher.update(jobId, 'included', {
      inclusion: { txHash: '0xkavm', blockNumber: 99 },
    });

    now += 100;
    const recovered = await publisher.recover();
    const job = await publisher.getStatus(jobId);

    expect(recovered).toBe(1);
    expect(job?.status).toBe('failed');
    expect(job?.failure?.code).toBe('recovery_state_inconsistent');
    expect(job?.failure?.resolution).toBe('fail_job');

    expect(await publisher.clear('failed')).toBe(1);
    expect(await publisher.getStatus(jobId)).toBeNull();
  });

  it('supports pause, resume, cancel, retry, and clear', async () => {
    const publisher = createPublisher();
    const cancelId = await publisher.seedLegacyRawLift(request());
    const retryId = await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-2' });
    const clearId = await publisher.seedLegacyRawLift({ ...request(), shareOperationId: 'op-3' });

    await publisher.pause();
    expect(await publisher.claimNext('wallet-1')).toBeNull();
    await publisher.resume();

    await publisher.cancel(cancelId);
    const cancelledRequest = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> {
        <${requestSubject(cancelId)}> ?p ?o .
      }
    }`);
    expect(cancelledRequest.type).toBe('bindings');
    if (cancelledRequest.type !== 'bindings') return;
    expect(cancelledRequest.bindings).toHaveLength(0);

    await publisher.claimNext('wallet-2');
    await publisher.update(retryId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'wallet_unavailable',
        message: 'wallet offline',
        errorPayloadRef: 'urn:error:retryable',
      }) as any,
    });

    await publisher.claimNext('wallet-3');
    await publisher.update(clearId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        swmQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });
    await publisher.update(clearId, 'broadcast', {
      broadcast: { txHash: '0xccc', walletId: 'wallet-3' },
    });
    await publisher.update(clearId, 'included', {
      inclusion: { txHash: '0xccc', blockNumber: 9 },
    });
    await publisher.update(clearId, 'finalized', {
      finalization: {
        txHash: '0xccc',
        ual: 'did:dkg:mock:31337/0xccc/9',
        batchId: '9',
        startKAId: '9',
        endKAId: '9',
        publisherAddress: '0x1111111111111111111111111111111111111111',
      },
    });

    expect(await publisher.retry()).toBe(1);
    expect((await publisher.getStatus(retryId))?.status).toBe('accepted');

    expect(await publisher.clear('finalized')).toBe(1);
    expect(await publisher.getStatus(clearId)).toBeNull();
    expect(await publisher.getStatus(cancelId)).toBeNull();

    const clearedRequest = await store.query(`SELECT ?p ?o WHERE {
      GRAPH <${DEFAULT_CONTROL_GRAPH_URI}> {
        <${requestSubject(clearId)}> ?p ?o .
      }
    }`);
    expect(clearedRequest.type).toBe('bindings');
    if (clearedRequest.type !== 'bindings') return;
    expect(clearedRequest.bindings).toHaveLength(0);
  });
});
