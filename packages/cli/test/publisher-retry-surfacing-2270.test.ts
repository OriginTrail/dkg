import type { ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { QuorumUnmetError, type LiftJob } from '@origintrail-official/dkg-publisher';
import { createPublisherControlFromStore, type AsyncPublisherAvailability } from '../src/publisher-runner.js';
import { handlePublisherRoutes } from '../src/daemon/routes/publisher.js';
import type { RequestContext } from '../src/daemon/routes/context.js';
import { requestAuthentication } from './_helpers/request-authentication.js';

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

  /**
   * Re-admit a held job and read the verdict admission hands back. A held record answers with
   * `LiftJobPendingChainProofError`, whose `retryable` is the per-job answer to "does an automatic
   * lane exist that can move THIS record" — the value the HTTP boundary forwards to the client.
   */
  async function admissionVerdictFor(control: Control, name: string): Promise<{ retryable: boolean }> {
    try {
      await control.enqueueKnowledgeAssetVmPublish(kaVmPublishRequest(name));
    } catch (error) {
      const held = error as { retryable?: boolean };
      if (typeof held.retryable !== 'boolean') throw error;
      return { retryable: held.retryable };
    }
    throw new Error('expected admission to hold the job for chain proof');
  }

  /**
   * Terminal AND tx-bearing: a confirmation mismatch is a job whose transaction is unaccounted
   * for, so GH#2270 holds it for chain proof rather than letting its subject fall vacant.
   */
  async function failTerminallyHeld(control: Control, name = 'mismatch'): Promise<string> {
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

  /**
   * Terminal with NOTHING to account for: the publish reverted before any broadcast metadata was
   * written, so no lane, operator action or fresh mandate re-arms it and it is not waiting on
   * anything either.
   */
  async function failTerminallyWithoutEvidence(control: Control, name = 'reverted'): Promise<string> {
    const jobId = await claimedAndValidated(control, name);
    await control.recordPublishFailure(jobId, {
      error: new Error('execution reverted'),
      failedFromState: 'broadcast',
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
    const terminalJobId = await failTerminallyWithoutEvidence(control);

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

  it('POST /api/publisher/retry can select one exact failed job without sweeping the rest', async () => {
    const control = newControl();
    const selectedJobId = await failWithUnmetQuorum(control);
    const untouchedJobId = await failWithUnmetQuorum(control, 'untouched');

    const res = await request(
      control,
      'POST',
      '/api/publisher/retry',
      JSON.stringify({ status: 'failed', jobId: selectedJobId }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ retried: 1, blockedPendingRecovery: 0, skipped: 0 });
    expect((await statusOf(control, selectedJobId)).status).toBe('accepted');
    expect((await statusOf(control, untouchedJobId)).status).toBe('failed');
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
    // A terminal failure with nothing to account for: no lane, operator action or fresh mandate
    // re-arms it, so "waiting" would be a lie — the field is ABSENT rather than reported as
    // exhausted. (A terminal failure that DID broadcast is a different case: see the row below.)
    const terminalJobId = await failTerminallyWithoutEvidence(control);
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

  // The publisher's projection answers what the CONFIGURED lane would do; it cannot see whether a
  // runtime exists to run that lane. On a node with no funded publisher wallet, or one whose
  // publisher failed to start, `backoff` promises a retry that will never fire — so the route,
  // which knows the runtime state, has to say so.
  it.each([
    ['no_publisher_wallets'],
    ['publisher_startup_failed'],
  ] as const)('reports no automatic retry when the publisher runtime is unavailable (%s)', async (reason) => {
    const control = newControl();
    const jobId = await failWithUnmetQuorum(control);
    // Same job, same config: with a runtime running, this is a scheduled retry.
    const running = await request(control, 'GET', `/api/publisher/job?id=${jobId}`);
    expect(running.body.retryState).toEqual({ autoRetryEligible: true, waitingReason: 'backoff' });

    const res = await request(control, 'GET', `/api/publisher/job?id=${jobId}`, '', {
      available: false,
      reason,
      retryable: false,
      operatorActionRequired: true,
    });

    // Not eligible, and waiting on the OPERATOR — which is what the availability reason served
    // beside it tells them to go and fix. The job itself is untouched: this is a read.
    expect(res.body.retryState).toEqual({ autoRetryEligible: false, waitingReason: 'operator' });
    expect(res.body.job.status).toBe('failed');
  });

  it('carries the LIVE runtime capability through the production factory into the admission verdict', async () => {
    // 🟡 3824743596 — the probe helper, the daemon option and the publisher policy each had their
    // own test, but nothing traversed the bridge between them. The forwarding edge is invisible to
    // all three: if `createPublisherControlFromStore` stopped passing `chainProofCapableForWallet`
    // through, every one of them stays green while a live, capable node tells clients their held
    // job has no automatic exit — sending them to an operator action they do not need.
    //
    // Late binding is part of the contract and part of this test: the capability is read through a
    // closure over state that does not exist yet when the control is built, exactly as the daemon
    // wires it (the runtime starts after admission).
    let liveRuntimeCapable: boolean | undefined;
    const probedWallets: string[] = [];
    const store = new OxigraphStore();
    stores.push(store);
    const control = createPublisherControlFromStore(store, {
      chainProofCapableForWallet: (walletId) => {
        probedWallets.push(walletId);
        // Undefined would mean the control consulted the runtime before it existed.
        if (liveRuntimeCapable === undefined) throw new Error('probed before the runtime was bound');
        return liveRuntimeCapable;
      },
    });

    // The record must be one the dispatcher COULD finalize, or it has no automatic exit whatever
    // the runtime can do — and this test would pass its false-polarity row for the wrong reason.
    // The durable operation marker is the part `failAfterRecordedTxHash` leaves out, so it is set
    // explicitly here.
    const jobId = await claimedAndValidated(control, 'rpc');
    await control.update(jobId, 'broadcast', {
      broadcast: { txHash: TX_HASH, walletId: 'wallet-rpc', operationKind: 'create', nonce: 7 },
    });
    await control.recordPublishFailure(jobId, {
      error: new Error('RPC endpoint temporarily unavailable'),
      failedFromState: 'broadcast',
      errorPayloadRef: `urn:dkg:test:error:${jobId}`,
    });
    const heldJob = await control.getStatus(jobId);
    if (!heldJob || !('failure' in heldJob)) throw new Error('expected a held failed job');

    // The runtime comes up capable AFTER the control was constructed.
    liveRuntimeCapable = true;
    expect(await admissionVerdictFor(control, 'rpc')).toEqual({ retryable: true });
    // The probe was asked about the wallet that actually signed, not a placeholder.
    expect(probedWallets).toContain('wallet-rpc');

    // Both polarities through the SAME wiring: a runtime that cannot settle this job must not be
    // reported as having an automatic exit. Asserting only `true` would pass on a forwarding edge
    // replaced by a constant.
    liveRuntimeCapable = false;
    expect(await admissionVerdictFor(control, 'rpc')).toEqual({ retryable: false });
  });

  it('leaves a chain-proof hold alone when the publisher runtime is unavailable', async () => {
    // The narrowing speaks only for what this node's LANE will do, so it must not repaint reasons
    // that have nothing to do with a runtime: a job whose transaction is unaccounted for waits on
    // chain proof whether or not a publisher is running, and calling that "operator" would point
    // an operator at the wrong problem.
    const control = newControl();
    const jobId = await failAfterRecordedTxHash(control);

    const res = await request(control, 'GET', `/api/publisher/job?id=${jobId}`, '', {
      available: false,
      reason: 'no_publisher_wallets',
      retryable: false,
      operatorActionRequired: true,
    });

    expect(res.body.retryState).toEqual({ autoRetryEligible: false, waitingReason: 'pending_chain_proof' });
  });

  it('reports a TERMINAL failure that broadcast a transaction as waiting on chain proof', async () => {
    // The gap the retry surfacing hid: a `confirmation_mismatch` is terminal, so it read as
    // "nothing is waiting on this" while its transaction was unaccounted for — and admission
    // would hand the KA to a replacement job. It is now held on every surface.
    const control = newControl();
    const heldJobId = await failTerminallyHeld(control);

    const res = await request(control, 'GET', `/api/publisher/job?id=${heldJobId}`);
    expect(res.body.retryState).toEqual({ autoRetryEligible: false, waitingReason: 'pending_chain_proof' });

    const retry = await request(control, 'POST', '/api/publisher/retry', JSON.stringify({ status: 'failed' }));
    expect(retry.body).toEqual({ retried: 0, blockedPendingRecovery: 1, skipped: 0 });
    expect((await statusOf(control, heldJobId)).status).toBe('failed');
  });

  it('serves retryState on the job-payload and both legacy job routes too', async () => {
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

    // The FOURTH surface — the legacy payload variant — spreads the job the same way and must
    // carry `retryState` beside `payload`; a named lifecycle job has no raw payload (null).
    const legacyPayload = await request(control, 'GET', `/api/publisher/jobs/${jobId}/payload`);
    expect(legacyPayload.body).toEqual({ ...job, payload: null, retryState: expected });
  });

  /**
   * GH#2270 — `availability` defaults to a RUNNING publisher, because that is the node these rows
   * describe. The job-detail routes narrow `retryState` when no runtime exists, so the rows that
   * exercise that narrowing pass an unavailable state explicitly.
   */
  async function request(
    publisherControl: Control,
    method: 'GET' | 'POST',
    path: string,
    rawBody = '',
    availability: AsyncPublisherAvailability = { available: true },
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
      publisherState: { runtime: null, availability },
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
      authentication: requestAuthentication({ kind: 'anonymous' }), requestAgentAddress: '0x0',
    } as unknown as RequestContext);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} };
  }
});
