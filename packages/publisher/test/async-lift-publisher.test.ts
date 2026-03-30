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
  CONTROL_PARANET_ID,
  CONTROL_PAYLOAD,
  CONTROL_REQUEST_TYPE,
  CONTROL_ROOT,
  CONTROL_SCOPE,
  CONTROL_STATUS,
  DEFAULT_CONTROL_GRAPH_URI,
  requestSubject,
  jobSubject,
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
      }),
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

    await publisher.claimNext('wallet-2');
    await publisher.update(retryId, 'failed', {
      failure: createLiftJobFailureMetadata({
        failedFromState: 'claimed',
        code: 'wallet_unavailable',
        message: 'wallet offline',
        errorPayloadRef: 'urn:error:retryable',
      }),
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
  });
});
