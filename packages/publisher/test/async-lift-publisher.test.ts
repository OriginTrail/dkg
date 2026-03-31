import { beforeEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import {
  TripleStoreAsyncLiftPublisher,
  createLiftJobFailureMetadata,
  type AsyncLiftPublisherRecoveryResult,
  type LiftRequest,
} from '../src/index.js';
import {
  CONTROL_JOB_SLUG,
  CONTROL_ACCEPTED_AT,
  CONTROL_AUTHORITY_PROOF_REF,
  CONTROL_HAS_REQUEST,
  CONTROL_LOCKED_JOB,
  CONTROL_LOCK_EXPIRES_AT,
  CONTROL_LOCK_STATUS,
  CONTROL_WALLET_ID,
  CONTROL_PARANET_ID,
  CONTROL_PAYLOAD,
  CONTROL_REQUEST_TYPE,
  CONTROL_ROOT,
  CONTROL_SCOPE,
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
  DEFAULT_WALLET_LOCK_GRAPH_URI,
  requestSubject,
  jobSubject,
  serializeWalletLock,
  walletLockSubject,
} from '../src/async-lift-control-plane.js';

describe('TripleStoreAsyncLiftPublisher', () => {
  let now = 1_000;
  let ids = 0;
  let store: OxigraphStore;

  const request = (): LiftRequest => ({
    workspaceId: 'ws-1',
    workspaceOperationId: 'op-1',
    roots: ['urn:local:/rihana'],
    paranetId: 'music-social',
    namespace: 'aloha',
    scope: 'person-profile',
    transitionType: 'CREATE',
    authority: { type: 'owner', proofRef: 'proof:owner:1' },
  });

  beforeEach(() => {
    store = new OxigraphStore();
    now = 1_000;
    ids = 0;
  });

  function createPublisher(recoveryResult?: AsyncLiftPublisherRecoveryResult | null) {
    return new TripleStoreAsyncLiftPublisher(store, {
      now: () => ++now,
      idGenerator: () => `job-${++ids}`,
      chainRecoveryResolver: recoveryResult === undefined ? undefined : async () => recoveryResult,
    });
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

  it('creates accepted jobs and returns status', async () => {
    const publisher = createPublisher();

    const jobId = await publisher.lift(request());
    const job = await publisher.getStatus(jobId);

    expect(jobId).toBe('job-1');
    expect(job?.status).toBe('accepted');
    expect(job?.jobSlug).toBe('music-social/person-profile/create/op-1/rihana');
    expect(job?.request.paranetId).toBe('music-social');
  });

  it('stores explicit LiftJob and LiftRequest control-plane triples', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.lift(request());

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
    expect(requestTriples).toContainEqual([CONTROL_PARANET_ID, '"music-social"']);
    expect(requestTriples).toContainEqual([CONTROL_SCOPE, '"person-profile"']);
    expect(requestTriples).toContainEqual([CONTROL_AUTHORITY_PROOF_REF, '"proof:owner:1"']);
    expect(requestTriples).toContainEqual([CONTROL_ROOT, '"urn:local:/rihana"']);
  });

  it('claims the oldest accepted job for a wallet', async () => {
    const publisher = createPublisher();

    await publisher.lift(request());
    await publisher.lift({ ...request(), workspaceOperationId: 'op-2' });

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
    const jobId = await publisher.lift(request());

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
    const jobId = await publisher.lift(request());
    await publisher.lift({ ...request(), workspaceOperationId: 'op-2' });

    await publisher.claimNext('wallet-1');
    const originalExpiresAt = await readLockExpiresAt('wallet-1');
    now += 5 * 60 * 1000 - 100;

    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 3,
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
    const jobId = await publisher.lift(request());

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
    const jobId = await publisher.lift(request());

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

  it('does not delete a newer wallet lock when an older job releases late', async () => {
    const publisher = createPublisher();
    const jobA = await publisher.lift(request());
    const jobB = await publisher.lift({ ...request(), workspaceOperationId: 'op-2' });

    await publisher.claimNext('wallet-1');
    await publisher.update(jobA, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 3,
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

    await publisher.update(jobA, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'validated',
        code: 'authority_unavailable',
        message: 'late failure',
        errorPayloadRef: 'urn:error:late-failure',
      }) as any,
    });

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
    await publisher.lift(request());

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
    await first.lift(request());

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

    const jobId = await publisher.lift({
      ...request(),
      workspaceOperationId: 'op-9',
      roots: ['urn:local:/manson', 'urn:local:/rihana'],
    });

    const job = await publisher.getStatus(jobId);
    expect(job?.jobSlug).toBe('music-social/person-profile/create/op-9/manson-rihana');
  });

  it('updates jobs through the MVP state machine', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.lift(request());
    await publisher.claimNext('wallet-1');

    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 3,
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
    const jobId = await publisher.lift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 3,
        authorityProofRef: 'proof:owner:1',
        transitionType: 'CREATE',
      },
    });

    const included = await publisher.recordPublishResult(
      jobId,
      {
        kcId: 1n,
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
      kcId: 1n,
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

  it('records canonical publish failures back into LiftJob failed state', async () => {
    const publisher = createPublisher();
    const jobId = await publisher.lift(request());
    await publisher.claimNext('wallet-1');
    await publisher.update(jobId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 3,
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

  it('lists and counts jobs by status', async () => {
    const publisher = createPublisher();
    const acceptedId = await publisher.lift(request());
    const failedId = await publisher.lift({ ...request(), workspaceOperationId: 'op-2' });
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
      inclusion: { txHash: '0xbbb', blockNumber: 7 },
      finalization: {
        txHash: '0xbbb',
        ual: 'did:dkg:mock:31337/0xbbb/7',
        batchId: '7',
        startKAId: '7',
        endKAId: '7',
        publisherAddress: '0x1111111111111111111111111111111111111111',
      },
    });

    const claimedId = await publisher.lift(request());
    const broadcastId = await publisher.lift({ ...request(), workspaceOperationId: 'op-2' });

    await publisher.claimNext('wallet-1');
    await publisher.claimNext('wallet-2');

    await publisher.update(broadcastId, 'validated', {
      validation: {
        canonicalRoots: ['dkg:music-social:aloha:person/rihana'],
        canonicalRootMap: { 'urn:local:/rihana': 'dkg:music-social:aloha:person/rihana' },
        workspaceQuadCount: 3,
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
  });

  it('supports pause, resume, cancel, retry, and clear', async () => {
    const publisher = createPublisher();
    const cancelId = await publisher.lift(request());
    const retryId = await publisher.lift({ ...request(), workspaceOperationId: 'op-2' });
    const clearId = await publisher.lift({ ...request(), workspaceOperationId: 'op-3' });

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
        workspaceQuadCount: 3,
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
