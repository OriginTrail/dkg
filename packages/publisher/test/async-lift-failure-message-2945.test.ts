/**
 * GH#2945 - a persisted failure message never carries a full RPC URL, whatever the failure code.
 *
 * #2944 reduced the message only on the typed transient lanes. A provider's own text carries the request
 * URL (ethers embeds it) and a configured URL can carry an API key, while the failure record is echoed by
 * the job routes for EVERY code. The reduction now happens where the message is built - once per mapping
 * branch - and the classification still reads the raw text, so no failure changes code, origin or retry
 * eligibility: only the persisted text does.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveLiftJobClaim } from '../src/index.js';
import { createAsyncLift2270Harness, expectFailed } from './_helpers/async-lift-2270-harness.js';
import { KA_VM_VALIDATION, kaVmPublishRequest } from '../../../scripts/testing/ka-vm-publish.js';
import { RETRY_LANE, createStoreRejectionFixtures } from './_helpers/store-rejection-2940.js';
import { KEYED_RPC_URL } from './_helpers/rpc-prep-failure-2942.js';

describe('GH#2945 persisted failure messages are host-only for every failure code', () => {
  const h = createAsyncLift2270Harness();
  const { stage, failsOnceThenPublishes } = createStoreRejectionFixtures(h);

  beforeEach(() => h.reset());

  function expectHostOnly(message: string): void {
    expect(message).not.toContain('SECRET-API-KEY');
    expect(message).not.toContain('/v2/');
    expect(message).toContain('rpc.example');
  }

  async function validatedSession(publisher: ReturnType<typeof h.createPublisher>) {
    await stage();
    const jobId = await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());
    const claimed = await publisher.claimNext('wallet-1');
    if (!claimed) throw new Error('expected a claim');
    await publisher.update(jobId, 'validated', { validation: KA_VM_VALIDATION });
    return { session: publisher.openClaimSession(claimed as ActiveLiftJobClaim), jobId };
  }

  it('a claimed/validated-origin failure on the legacy keyword chain', async () => {
    const publisher = h.createPublisher(RETRY_LANE);
    const { session } = await validatedSession(publisher);

    const failed = expectFailed(await session.recordExecutionFailure(
      'validated',
      new Error(`Store query failed while reading ${KEYED_RPC_URL}: busy`),
    ));

    expect(failed.failure.code).toBe('workspace_unavailable');
    expectHostOnly(failed.failure.message);
  });

  it('a broadcast-origin failure on the publish mapper (a genuine submission timeout)', async () => {
    const publisher = h.createPublisher({
      ...RETRY_LANE,
      knowledgeAssetVmPublishHandler: failsOnceThenPublishes(
        () => new Error(`RPC submit timed out against ${KEYED_RPC_URL}`),
        { n: 0 },
      ),
    });
    await stage();
    await publisher.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest());

    const failed = expectFailed(await publisher.processNext('wallet-1'));

    expect(failed.failure.code).toBe('tx_submit_timeout');
    expectHostOnly(failed.failure.message);
  });

  it('a failure recorded through the public recordPublishFailure path', async () => {
    const publisher = h.createPublisher(RETRY_LANE);
    const { jobId } = await validatedSession(publisher);

    const failed = expectFailed(await publisher.recordPublishFailure(jobId, {
      error: new Error(`execution reverted (info={ "requestUrl": "${KEYED_RPC_URL}" })`),
      failedFromState: 'broadcast',
      errorPayloadRef: 'urn:dkg:test:error:2945',
    }));

    expectHostOnly(failed.failure.message);
  });

  it('classification still reads the RAW text: a URL path that spells a keyword changes nothing', async () => {
    // "timeout" appears only inside the URL. The legacy chain keyed on it before this change and still
    // does; the persisted message just no longer carries the path.
    const publisher = h.createPublisher(RETRY_LANE);
    const { session } = await validatedSession(publisher);

    const failed = expectFailed(await session.recordExecutionFailure(
      'validated',
      new Error('lookup failed at https://rpc.example/timeout/SECRET-API-KEY'),
    ));

    expect(failed.failure.code).toBe('workspace_unavailable');
    expect(failed.failure.message).not.toContain('SECRET-API-KEY');
    expect(failed.failure.message).not.toContain('/timeout/');
  });

  it('text without a URL is persisted exactly as before', async () => {
    const publisher = h.createPublisher(RETRY_LANE);
    const { session } = await validatedSession(publisher);

    const failed = expectFailed(await session.recordExecutionFailure(
      'validated',
      new Error('Store query failed: connect ECONNREFUSED 127.0.0.1:8545'),
    ));

    expect(failed.failure.message).toBe('Store query failed: connect ECONNREFUSED 127.0.0.1:8545');
  });
});
