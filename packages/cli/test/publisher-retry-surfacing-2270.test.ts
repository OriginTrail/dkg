import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { QuorumUnmetError, type LiftJob } from '@origintrail-official/dkg-publisher';
import { createPublisherControlFromStore } from '../src/publisher-runner.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';

/**
 * GH#2270 — what the daemon TELLS an operator about retries.
 *
 * Both surfaces are driven over the real publisher control (not a hand-rolled fake), so a
 * row can only pass if the route reads the publisher's own disposition:
 *   - POST /api/publisher/retry reports all three counts of one pass. `retried` keeps its
 *     pre-#2270 meaning; the additive counts are the jobs left failed, which the old
 *     single-count response hid — including the evidence-bearing ones the publisher now
 *     refuses to blind-republish.
 *   - the job-detail routes serve the DERIVED `retryState` beside a byte-identical `job`.
 *     The derivation lives on the publisher because it reads the effective kill-switch;
 *     the last row proves that knob actually reaches the admission instance (#1836 class).
 */
describe('GH#2270 publisher retry surfacing (routes over a real publisher)', () => {
  const stores: OxigraphStore[] = [];

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  });

  type Control = ReturnType<typeof createPublisherControlFromStore>;

  function newControl(options: { autoRetryEnabled?: boolean } = {}): Control {
    const store = new OxigraphStore();
    stores.push(store);
    return createPublisherControlFromStore(store, {
      ...(options.autoRetryEnabled === undefined ? {} : { retryTuning: options }),
    });
  }

  /** The canonical KA VM-publish request; `name` keeps each job on its own lifecycle subject. */
  function kaVmPublishRequest(name: string) {
    const authorAddress = '0x1111111111111111111111111111111111111111';
    const kaNumber = 7n;
    const kaUal = `did:dkg:31337/${authorAddress}/${kaNumber.toString()}`;
    return {
      contextGraphId: 'music-social', name, agentAddress: '0x0', shareOperationId: `share-op-${name}`,
      roots: [] as string[], contentScopeVersion: 2 as const, kaUal, assertionVersion: '1',
      publicTripleCount: 2, privateTripleCount: 0,
      seal: {
        merkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`, authorAddress: authorAddress as `0x${string}`,
        signature: { r: (`0x${'34'.repeat(32)}`) as `0x${string}`, vs: (`0x${'56'.repeat(32)}`) as `0x${string}` },
        schemeVersion: 1, reservedKaId: ((BigInt(authorAddress) << 96n) | kaNumber).toString() as `${bigint}`,
      },
      sealChainId: '31337' as `${bigint}`, sealKav10Address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
      sealFinalizedAtIso: '2026-01-01T00:00:00.000Z', sealMerkleRoot: (`0x${'12'.repeat(32)}`) as `0x${string}`,
      intentKey: `sha256:${'ab'.repeat(32)}`, wmCurrentAssertion: '12'.repeat(32), swmCurrentAssertion: '12'.repeat(32),
      kaNumber: kaNumber.toString(), reservedUal: kaUal,
    };
  }

  const VALIDATION = {
    canonicalRoots: [], canonicalRootMap: {}, swmQuadCount: 2,
    authorityProofRef: 'knowledge-asset-lifecycle', transitionType: 'CREATE' as const,
  };
  const TX_HASH = `0x${'ab'.repeat(32)}` as `0x${string}`;

  async function claimedAndValidated(control: Control, name: string): Promise<string> {
    const jobId = await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest(name));
    await control.claimNext(`wallet-${name}`);
    await control.update(jobId, 'validated', { validation: VALIDATION });
    return jobId;
  }

  /** Pre-send-safe: quorum is collected before the publish tx is signed, so no txHash exists. */
  async function failWithUnmetQuorum(control: Control, name = 'quorum'): Promise<string> {
    const jobId = await claimedAndValidated(control, name);
    await control.recordPublishFailure(jobId, {
      error: new QuorumUnmetError({ collected: 2, required: 3, dialled: 2 }),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
    return jobId;
  }

  /** Evidence-bearing: a persisted txHash means the transaction may be on chain. */
  async function failAfterRecordedTxHash(control: Control, name = 'rpc'): Promise<string> {
    const jobId = await claimedAndValidated(control, name);
    await control.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: `wallet-${name}` } });
    await control.recordPublishFailure(jobId, {
      error: new Error('RPC endpoint temporarily unavailable'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
    return jobId;
  }

  /** Terminal: nothing re-arms a confirmation mismatch — not the lane, not an operator. */
  async function failTerminally(control: Control, name = 'mismatch'): Promise<string> {
    const jobId = await claimedAndValidated(control, name);
    await control.update(jobId, 'broadcast', { broadcast: { txHash: TX_HASH, walletId: `wallet-${name}` } });
    await control.update(jobId, 'included', {
      broadcast: { txHash: TX_HASH, walletId: `wallet-${name}` },
      inclusion: { txHash: TX_HASH, blockNumber: 42 },
    });
    await control.recordPublishFailure(jobId, {
      error: new Error('on-chain confirmation mismatch'),
      failedFromState: 'included',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
    return jobId;
  }

  async function statusOf(control: Control, jobId: string): Promise<LiftJob> {
    const job = await control.getStatus(jobId);
    if (!job) throw new Error(`job ${jobId} vanished`);
    return job;
  }

  it('POST /api/publisher/retry reports the full disposition of the pass', async () => {
    const control = newControl();
    const quorumJobId = await failWithUnmetQuorum(control);
    const evidenceJobId = await failAfterRecordedTxHash(control);
    const terminalJobId = await failTerminally(control);

    const res = await request(control, 'POST', '/api/publisher/retry', JSON.stringify({ status: 'failed' }));

    expect(res.status).toBe(200);
    // One partition of the three failed jobs — reaccepted, held for chain proof, nothing left.
    expect(res.body).toEqual({ retried: 1, blockedPendingRecovery: 1, skipped: 1 });
    // The counts are not bookkeeping: the pre-send job is active again, and the job that may
    // carry a transaction was NOT reaccepted (pre-#2270 it was, blindly).
    expect((await statusOf(control, quorumJobId)).status).toBe('accepted');
    expect((await statusOf(control, evidenceJobId)).status).toBe('failed');
    expect((await statusOf(control, terminalJobId)).status).toBe('failed');
  });

  it('GET /api/publisher/job serves retryState beside a byte-identical job', async () => {
    const control = newControl();
    const jobId = await failWithUnmetQuorum(control);

    const res = await request(control, 'GET', `/api/publisher/job?id=${jobId}`);

    expect(res.status).toBe(200);
    expect(res.body.job).toEqual(JSON.parse(JSON.stringify(await statusOf(control, jobId))));
    expect(res.body.retryState).toEqual({ autoRetryEligible: true, waitingReason: 'backoff' });
  });

  it('reports a job that may carry a transaction as waiting on chain proof, never eligible', async () => {
    const control = newControl();
    const jobId = await failAfterRecordedTxHash(control);

    const res = await request(control, 'GET', `/api/publisher/job?id=${jobId}`);

    expect(res.body.retryState).toEqual({ autoRetryEligible: false, waitingReason: 'pending_chain_proof' });
  });

  it('omits waitingReason for jobs that are not waiting on a retry at all', async () => {
    const control = newControl();
    // A terminal failure: no lane, operator action or fresh mandate re-arms it, so
    // "waiting" would be a lie — the field is ABSENT rather than reported as exhausted.
    const terminalJobId = await failTerminally(control);
    const terminal = await request(control, 'GET', `/api/publisher/job?id=${terminalJobId}`);
    expect(terminal.body.retryState).toEqual({ autoRetryEligible: false });

    // Same for a job that has not failed: it is still on its way.
    const acceptedControl = newControl();
    const acceptedJobId = await acceptedControl.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest('fresh'));
    const accepted = await request(acceptedControl, 'GET', `/api/publisher/job?id=${acceptedJobId}`);
    expect(accepted.body.retryState).toEqual({ autoRetryEligible: false });
  });

  it('reflects the operator kill-switch: autoRetryEnabled false → waiting on the operator', async () => {
    // The knob must travel config.publisher → createPublisherControlFromStore → this
    // projection. Without that forwarding the route reports `backoff` on a node where
    // nothing will ever fire the retry — the #1836 dead-config class, on a read surface.
    const control = newControl({ autoRetryEnabled: false });
    const jobId = await failWithUnmetQuorum(control);

    const res = await request(control, 'GET', `/api/publisher/job?id=${jobId}`);

    expect(res.body.retryState).toEqual({ autoRetryEligible: false, waitingReason: 'operator' });
  });

  it('serves retryState on the job-payload and legacy job routes too', async () => {
    const control = newControl();
    const jobId = await failAfterRecordedTxHash(control);
    const job = JSON.parse(JSON.stringify(await statusOf(control, jobId)));
    const expected = { autoRetryEligible: false, waitingReason: 'pending_chain_proof' };

    const withPayload = await request(control, 'GET', `/api/publisher/job-payload?id=${jobId}`);
    expect(withPayload.body.job).toEqual(job);
    expect(withPayload.body.retryState).toEqual(expected);

    // The legacy shape spreads the job at the top level; every job field keeps its value
    // and `retryState` joins it there, exactly as `payload` already does.
    const legacy = await request(control, 'GET', `/api/publisher/jobs/${jobId}`);
    expect(legacy.body).toEqual({ ...job, retryState: expected });
  });

  async function request(
    publisherControl: Control,
    method: 'GET' | 'POST',
    path: string,
    rawBody = '',
  ): Promise<{ status: number; body: any }> {
    const url = new URL(`http://127.0.0.1${path}`);
    const req = Readable.from([]);
    // readBody() resolves synchronously from a prebuffered body (as httpAuthGuard's eager
    // drain leaves it) — no mock stream to drive in the unit harness.
    Object.assign(req, {
      method, url: path, headers: { host: '127.0.0.1' },
      __dkgPrebufferedBody: Buffer.from(rawBody, 'utf8'),
    });
    const res = {
      statusCode: 0, body: '', headers: undefined as Record<string, string> | undefined, writableEnded: false,
      writeHead(status: number, headers: Record<string, string>) { this.statusCode = status; this.headers = headers; return this; },
      end(body?: string) { this.body = body ?? ''; this.writableEnded = true; return this; },
    };
    await handlePublisherRoutes({
      req: req as RequestContext['req'],
      res: res as unknown as ServerResponse,
      agent: {} as RequestContext['agent'],
      publisherControl,
      publisherState: { runtime: null, availability: { available: false, reason: 'publisher_disabled', retryable: false, operatorActionRequired: true } },
      config: {} as RequestContext['config'],
      startedAt: 0,
      dashDb: {} as RequestContext['dashDb'],
      opWallets: { adminWallet: { address: '0x0', privateKey: '0x0' }, wallets: [] } as RequestContext['opWallets'],
      network: null as RequestContext['network'],
      tracker: {} as RequestContext['tracker'],
      memoryManager: {} as RequestContext['memoryManager'],
      bridgeAuthToken: undefined,
      nodeVersion: 'test', nodeCommit: 'test',
      catchupTracker: {} as RequestContext['catchupTracker'],
      extractionRegistry: {} as RequestContext['extractionRegistry'],
      fileStore: {} as RequestContext['fileStore'],
      extractionStatus: new Map(),
      assertionImportLocks: new Map(),
      vectorStore: {} as RequestContext['vectorStore'],
      embeddingProvider: null,
      validTokens: new Set<string>(),
      apiHost: '127.0.0.1', apiPortRef: { value: 0 },
      url, path: url.pathname,
      requestToken: undefined, requestAgentAddress: '0x0',
    } as unknown as RequestContext);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  }
});
