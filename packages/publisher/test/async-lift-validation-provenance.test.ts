import { broadcastExhausted } from './_helpers/rpc-prep-failure-2942.js';
import * as subtraction from '../src/async-lift-subtraction.js';
import { seedLegacyRawLiftTestJob } from './_helpers/legacy-raw-lift.js';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { SparqlHttpStore, StoreReadTransportFailure } from '@origintrail-official/dkg-storage';
import { mapExecutionFailure } from '../src/async-lift-execution-failure.js';
import { atLiftValidationStage, LiftValidationStageError } from '../src/lift-validation-error.js';
import { assertCanonicalLiftJobPayload } from '../src/lift-job-payload-codec.js';
import { deriveLiftJobRetryProjection, isHeldForChainProof } from '../src/async-lift-retry-disposition.js';
import { parseWorkspacePublicSnapshotNQuads } from '../src/workspace-snapshot-store.js';
import { kaVmPublishRequest, KA_VM_VALIDATION } from '../../../scripts/testing/ka-vm-publish.js';
import { createAsyncLift2270Harness, confirmedPublishResult, expectFailed, TX_HASH } from './_helpers/async-lift-2270-harness.js';
import { RETRY_LANE, createStoreRejectionFixtures, rawLiftRequest } from './_helpers/store-rejection-2940.js';

const transport = () => new StoreReadTransportFailure(new TypeError('fetch failed'));
const stageError = (error: unknown) => new LiftValidationStageError('initial_preflight', error);
const map = (error: unknown, overrides = {}) => mapExecutionFailure({
  jobId: 'provenance', currentStatus: 'claimed', requestedOrigin: 'claimed', error, now: () => 0, ...overrides,
});

describe('GH#3419 pre-validation provenance', () => {
  it.each([
    new TypeError('fetch failed'), new Error('query timeout authority root unavailable'),
    new Error('lost cause'), new Error('arbitrary wrapper', { cause: transport() }),
    new LiftValidationStageError('initial_preflight', stageError(transport())),
  ])('does not infer content failure or retry safety from unknown/wrapped evidence', error => {
    expect(map(error)).toMatchObject({ code: 'validation_unknown', retryable: false });
  });

  it('requires persisted pre-dispatch state as well as a typed read cause', () => {
    expect(map(stageError(transport()))).toMatchObject({ code: 'workspace_unavailable', validationDiagnostic: {
      stage: 'initial_preflight', cause: 'store_read_transport',
    } });
    expect(map(stageError(transport()), { currentStatus: 'validated' })).toMatchObject({ code: 'validation_unknown' });
    expect(map(stageError(transport()), {
      currentStatus: 'validated', requestedOrigin: 'broadcast', evidence: { neverDispatched: true },
    })).toMatchObject({ failedFromState: 'validated', code: 'workspace_unavailable' });
    expect(map(stageError(transport()), {
      currentStatus: 'broadcast', requestedOrigin: 'broadcast', evidence: { neverDispatched: true },
    })).toMatchObject({ failedFromState: 'broadcast', code: 'rpc_unavailable' });
    expect(map(stageError(transport()), {
      currentStatus: 'included', requestedOrigin: 'included', evidence: { neverDispatched: true },
    })).toMatchObject({ failedFromState: 'included' });
  });

  it('retains a deterministic malformed N-Quads diagnosis without exposing the content/ref', async () => {
    const error = await atLiftValidationStage('workspace_read', () =>
      parseWorkspacePublicSnapshotNQuads('private invalid RDF', 'private-snapshot-ref')).catch(e => e);
    const failure = map(error);
    expect(failure).toMatchObject({ code: 'canonicalization_failed', retryable: false,
      validationDiagnostic: { stage: 'workspace_read', cause: 'content' } });
    expect(JSON.stringify(failure)).not.toContain('private');
  });

  it.each(['http-503', 'deadline'])('persists actual read %s provenance, projects backoff and retries only the same admitted job', async kind => {
    const secret = 'private-response-body credential=secret urn:private-rdf';
    const server = createServer((_req, res) => { if (kind === 'http-503') { res.writeHead(503); res.end(secret); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    const readStore = new SparqlHttpStore({ queryEndpoint: `http://127.0.0.1:${address.port}/private`, consistencyProfile: 'atomic-readback', timeout: 25 });
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    let preflights = 0, executions = 0;
    const publisher = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: {
      preflight: async () => { if (++preflights === 1) await readStore.query('SELECT ?s WHERE { ?s ?p ?o }'); },
      execute: async () => { executions++; throw new Error('unexpected unknown executor failure'); },
    } });
    try {
      await stage();
      const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
      const failed = expectFailed(await publisher.processNext('wallet-1'));
      expect(failed.failure).toMatchObject({ code: 'workspace_unavailable', failedFromState: 'claimed',
        validationDiagnostic: { stage: 'initial_preflight', cause: 'store_read_transport' } });
      expect(failed.broadcast).toBeUndefined();
      expect(executions).toBe(0);
      expect(deriveLiftJobRetryProjection(failed, { autoRetryEnabled: true })).toMatchObject({ autoRetryEligible: true, waitingReason: 'backoff' });
      const persisted = await publisher.getStatus(jobId);
      expect(assertCanonicalLiftJobPayload(JSON.parse(JSON.stringify(persisted))).failure).toEqual(failed.failure);
      expect(JSON.stringify(persisted)).not.toContain(secret);
      expect(JSON.stringify(persisted)).not.toContain('/private');
      h.advance(10_000);
      expect(await publisher.processNext('wallet-1')).toMatchObject({ jobId });
      expect(executions).toBe(1);
    } finally { await readStore.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });

  it('records a KA preparation rejection from validated without running the executor', async () => {
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    let executions = 0;
    const publisher = h.createPublisher({ ...RETRY_LANE,
      resolvedSliceOverrides: { accessPolicy: 'ownerOnly', publisherPeerId: '' },
      knowledgeAssetVmPublishHandler: { execute: async () => { executions++; return confirmedPublishResult(); } },
    });
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = expectFailed(await publisher.processNext('wallet-1'));
    expect(failed.failure).toMatchObject({ failedFromState: 'validated', code: 'canonicalization_failed',
      validationDiagnostic: { stage: 'payload_preparation', cause: 'content' } });
    expect((await publisher.getStatus(jobId))?.failure).toEqual(failed.failure);
    expect(executions).toBe(0);
    expect(failed.timestamps.nextRetryAt).toBeUndefined();
  });

  it('retries a typed read failure at raw subtraction with proof supplied by the worker', async () => {
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    let executions = 0;
    const publisher = h.createPublisher({ ...RETRY_LANE, publishExecutor: async () => { executions++; return confirmedPublishResult(); } });
    await stage();
    const jobId = await seedLegacyRawLiftTestJob(h.store, rawLiftRequest());
    const subtract = vi.spyOn(subtraction, 'subtractFinalizedExactQuads').mockRejectedValueOnce(transport());
    try {
      const failed = expectFailed(await publisher.processNext('wallet-1'));
      expect(subtract).toHaveBeenCalledTimes(1);
      expect(failed.failure).toMatchObject({ failedFromState: 'validated', code: 'workspace_unavailable',
        validationDiagnostic: { stage: 'workspace_read', cause: 'store_read_transport' } });
      expect(failed.timestamps.nextRetryAt).toBeDefined();
      expect(failed.broadcast).toBeUndefined();
      expect(executions).toBe(0);
      h.advance(10_000);
      expect(await publisher.processNext('wallet-1')).toMatchObject({ jobId, status: 'finalized' });
      expect(executions).toBe(1);
    } finally { subtract.mockRestore(); }
  });

  it('does not turn a hash-bearing final-preflight RPC failure into a dependency retry', async () => {
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    let preflights = 0, executions = 0;
    const publisher = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: {
      preflight: async () => { if (++preflights === 2) throw broadcastExhausted(TX_HASH); },
      execute: async () => { executions++; return confirmedPublishResult(); },
    } });
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = expectFailed(await publisher.processNext('wallet-1'));
    expect(failed.failure).toMatchObject({ failedFromState: 'validated', code: 'validation_unknown', retryable: false,
      validationDiagnostic: { stage: 'final_preflight', cause: 'unknown' } });
    expect(executions).toBe(0);
    expect(failed.timestamps.nextRetryAt).toBeUndefined();
    expect(deriveLiftJobRetryProjection(failed, { autoRetryEnabled: true })).toEqual({ autoRetryEligible: false });
    expect(await publisher.retry({ jobId })).toBe(0);
    h.advance(10_000);
    expect(await publisher.processNext('wallet-1')).toBeNull();
  });

  it.each((['broadcast', 'included'] as const).flatMap(status => [
    { status, label: 'read interruption', error: () => stageError(transport()) },
    { status, label: 'string timeout', error: () => 'request timed out' },
  ]))('keeps $status chain evidence held after $label', async ({ status, error }) => {
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    const publisher = h.createPublisher(RETRY_LANE);
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claim = await publisher.claimNext('wallet-1');
    if (!claim) throw new Error('missing claim');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    const broadcast = { txHash: TX_HASH, walletId: 'wallet-1', operationKind: 'create' as const };
    await publisher.update(jobId, 'broadcast', { broadcast });
    if (status === 'included') await publisher.update(jobId, 'included', { broadcast, inclusion: { txHash: TX_HASH, blockNumber: 1 } });
    const failed = expectFailed(await publisher.openClaimSession(claim).recordExecutionFailure(status, error(), { neverDispatched: true }));
    expect(failed.broadcast?.txHash).toBe(TX_HASH);
    if (typeof error() !== 'string') {
      expect(failed.failure).toMatchObject({ code: status === 'included' ? 'confirmation_mismatch' : 'rpc_unavailable',
        message: 'Publication validation boundary conflicts with persisted execution state',
        validationDiagnostic: { stage: 'initial_preflight', cause: 'unknown' } });
      expect(failed.failure.timeout).toBeUndefined();
    }
    if (typeof error() === 'string') expect(failed.failure).toMatchObject({
      code: status === 'included' ? 'finality_timeout' : 'tx_submit_timeout',
      timeout: { timeoutMs: 0, handling: 'check_chain_then_finalize_or_reset' },
    });
    expect(isHeldForChainProof(failed)).toBe(true);
    expect(deriveLiftJobRetryProjection(failed, { autoRetryEnabled: true })).toMatchObject({ autoRetryEligible: false, waitingReason: 'pending_chain_proof' });
  });
});
