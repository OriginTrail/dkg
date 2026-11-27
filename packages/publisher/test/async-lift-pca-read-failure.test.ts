import { describe, expect, it } from 'vitest';
import { PCA_FUNDING_UNKNOWN_CODE, PCA_FUNDING_UNKNOWN_MESSAGE } from '@origintrail-official/dkg-core';
import { mapExecutionFailure } from '../src/async-lift-execution-failure.js';
import { deriveLiftJobRetryProjection } from '../src/async-lift-retry-disposition.js';
import { createAsyncLift2270Harness, confirmedPublishResult, expectFailed, TX_HASH } from './_helpers/async-lift-2270-harness.js';
import { RETRY_LANE, createStoreRejectionFixtures } from './_helpers/store-rejection-2940.js';
import { kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';

const fundingUnknown = () => Object.assign(new Error(PCA_FUNDING_UNKNOWN_MESSAGE), {
  code: PCA_FUNDING_UNKNOWN_CODE, readCode: 'RPC_ENDPOINTS_EXHAUSTED',
});
const map = (error: unknown, overrides = {}) => mapExecutionFailure({
  jobId: 'pca-read', currentStatus: 'validated', requestedOrigin: 'broadcast',
  evidence: { neverDispatched: true }, error, now: () => 1, ...overrides,
});

describe('PCA funding-read failure at queued publication execution', () => {
  it('classifies the typed unavailable read only with persisted pre-send proof', () => {
    expect(map(fundingUnknown())).toMatchObject({
      failedFromState: 'validated', code: 'workspace_unavailable',
      validationDiagnostic: { cause: 'precondition' },
    });
  });

  it.each([
    { evidence: undefined }, { evidence: { neverDispatched: false } },
    { currentStatus: 'claimed', requestedOrigin: 'claimed', evidence: undefined },
    { currentStatus: 'broadcast' }, { currentStatus: 'included', requestedOrigin: 'included' },
  ])('does not infer a pre-send failure from missing or contradictory evidence: %j', overrides => {
    const failure = map(fundingUnknown(), overrides);
    expect(failure.failedFromState).not.toBe('validated');
    expect(failure.code).not.toBe('workspace_unavailable');
  });

  it.each([
    ['message only', () => new Error(PCA_FUNDING_UNKNOWN_MESSAGE)],
    ['wrapped', () => new Error('wrapped', { cause: fundingUnknown() })],
    ...(['txHash', 'transactionHash', 'receipt'] as const).map(key => [
      key, () => Object.assign(fundingUnknown(), { [key]: TX_HASH }),
    ] as const),
    ...(['code', 'txHash', 'transactionHash', 'receipt'] as const).map(key => [
      `throwing ${key}`, () => Object.defineProperty(fundingUnknown(), key, {
        get() { throw new Error('hostile accessor'); },
      }),
    ] as const),
  ] as const)('does not grant retry from %s', (_name, makeError) => {
    expect(map(makeError()).code).not.toBe('workspace_unavailable');
  });

  it('retries the same admitted job after a pre-send funding read recovers', async () => {
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    let executions = 0;
    let sends = 0;
    const publisher = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: {
      execute: async input => {
        if (++executions === 1) throw fundingUnknown();
        await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7, operationKind: 'create' });
        sends++;
        const result = confirmedPublishResult();
        return { ...result, onChainResult: { ...result.onChainResult, txHash: TX_HASH } };
      },
    } });
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const failed = expectFailed(await publisher.processNext('wallet-1'));
    expect(failed.failure).toMatchObject({ failedFromState: 'validated', code: 'workspace_unavailable' });
    expect(failed.broadcast).toBeUndefined();
    expect(sends).toBe(0);
    expect(deriveLiftJobRetryProjection(failed, { autoRetryEnabled: true })).toMatchObject({
      autoRetryEligible: true, waitingReason: 'backoff',
    });
    h.advance(10_000);
    expect(await publisher.processNext('wallet-1')).toMatchObject({ jobId, status: 'finalized' });
    expect({ executions, sends }).toEqual({ executions: 2, sends: 1 });
  });

  it('preserves the durable transaction and does not resend after a later funding error', async () => {
    const h = createAsyncLift2270Harness();
    const { stage } = createStoreRejectionFixtures(h);
    let executions = 0;
    const publisher = h.createPublisher({ ...RETRY_LANE, knowledgeAssetVmPublishHandler: {
      execute: async input => {
        executions++;
        await input.publishOptions.onBeforeBroadcast?.({ txHash: TX_HASH, nonce: 7, operationKind: 'create' });
        throw fundingUnknown();
      },
    } });
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    expect(await publisher.processNext('wallet-1')).toMatchObject({
      jobId, status: 'broadcast', broadcast: { txHash: TX_HASH, walletId: 'wallet-1' },
    });
    h.advance(10_000);
    expect(await publisher.recover()).toBe(0);
    expect(await publisher.processNext('wallet-2')).toBeNull();
    expect(await publisher.getStatus(jobId)).toMatchObject({ status: 'broadcast', broadcast: { txHash: TX_HASH } });
    expect(executions).toBe(1);
  });
});
