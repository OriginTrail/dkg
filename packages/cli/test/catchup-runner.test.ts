import { describe, expect, it, vi } from 'vitest';
import {
  catchupPeerResponded,
  catchupPeerSucceeded,
  catchupPlaneCompletedWithoutFailure,
  classifyDurableCatchupRequest,
  runDurableCatchupLeg,
} from '../src/catchup-runner.js';

describe('catchup runner progress accounting', () => {
  it('does not count timed-out peers as success, including after partial progress', () => {
    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 1,
      resumedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 1,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 1,
      insertedDataTriples: 1,
    }, null, false)).toBe(false);
  });

  it('does not count metadata-only delivery as peer success', () => {
    const metadataOnly = {
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 1,
      insertedDataTriples: 0,
      insertedMetaTriples: 1,
      metaOnlyResponses: 1,
    };
    expect(catchupPeerResponded(metadataOnly, null)).toBe(true);
    expect(catchupPeerSucceeded(metadataOnly, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    }, null, false)).toBe(true);
  });

  it('tracks timeout responses separately from successful peers', () => {
    const timeoutOnly = {
      failedPeers: 0,
      timedOutPhases: 1,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(timeoutOnly, null)).toBe(true);
    expect(catchupPeerSucceeded(timeoutOnly, null, false)).toBe(false);

    const transportFailure = {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(transportFailure, null)).toBe(false);
    expect(catchupPeerSucceeded(transportFailure, null, false)).toBe(false);
  });

  it('counts either durable or shared-memory transport response as peer responded', () => {
    const durableAnswered = {
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    const sharedTransportFailure = {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(durableAnswered, sharedTransportFailure)).toBe(true);
    expect(catchupPeerSucceeded(durableAnswered, sharedTransportFailure, false)).toBe(false);

    const durableTransportFailure = {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    const sharedAnswered = {
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(durableTransportFailure, sharedAnswered)).toBe(true);
    expect(catchupPeerSucceeded(durableTransportFailure, sharedAnswered, false)).toBe(false);
  });

  it('does not count denied or failed peers as success', () => {
    expect(catchupPeerSucceeded({
      failedPeers: 0,
      failedPhases: 1,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, null, false)).toBe(false);
    expect(catchupPeerResponded({
      failedPeers: 0,
      failedPhases: 1,
    }, null)).toBe(true);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, null, true)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, null, false)).toBe(false);

    expect(catchupPeerSucceeded({
      failedPeers: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
    }, {
      failedPeers: 1,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
    }, false)).toBe(false);
  });

  it.each([
    ['rejected KCs', { rejectedKcs: 1 }],
    ['data rejected without metadata', { dataRejectedMissingMeta: 1 }],
  ])('does not treat durable integrity rejection as clean completion or peer success: %s', (_label, rejection) => {
    const durable = {
      failedPeers: 0,
      failedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 1,
      insertedTriples: 1,
      insertedDataTriples: 1,
      deferredBackpressure: 0,
      deniedPhases: 0,
      ...rejection,
    };

    expect(catchupPeerResponded(durable, null)).toBe(true);
    expect(catchupPlaneCompletedWithoutFailure(durable)).toBe(false);
    expect(catchupPeerSucceeded(durable, null, false)).toBe(false);
  });

  it('treats a clean verified private-only durable response as peer progress', () => {
    const durable = {
      failedPeers: 0,
      failedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 1,
      checkpointAdvances: 0,
      insertedTriples: 8,
      insertedDataTriples: 0,
      insertedMetaTriples: 8,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 1,
      rejectedKcs: 0,
      dataRejectedMissingMeta: 0,
      deferredBackpressure: 0,
      deniedPhases: 0,
    };

    expect(catchupPlaneCompletedWithoutFailure(durable)).toBe(true);
    expect(catchupPeerSucceeded(durable, null, false)).toBe(true);
  });

  it('classifies local scheduler deferral separately from a remote response or success', () => {
    const deferredBeforeFetch = {
      failedPeers: 0,
      failedPhases: 0,
      deferredBackpressure: 1,
      bytesReceived: 0,
      completedPhases: 0,
      emptyResponses: 0,
      insertedTriples: 0,
    };
    expect(catchupPeerResponded(deferredBeforeFetch, null)).toBe(false);
    expect(catchupPeerSucceeded(deferredBeforeFetch, null, false)).toBe(false);

    const partialThenDeferred = {
      ...deferredBeforeFetch,
      bytesReceived: 10,
      insertedTriples: 1,
      insertedDataTriples: 1,
    };
    expect(catchupPeerResponded(partialThenDeferred, null)).toBe(true);
    expect(catchupPeerSucceeded(partialThenDeferred, null, false)).toBe(false);
  });
});

describe('route-level durable catchup orchestration', () => {
  it('adapts a detailed incomplete result and preserves its retry reason', async () => {
    const syncFromPeerDetailed = vi.fn(async () => ({
      insertedTriples: 0,
      complete: false,
      fetchedMetaTriples: 0,
      fetchedDataTriples: 0,
      insertedMetaTriples: 0,
      insertedDataTriples: 0,
      bytesReceived: 0,
      resumedPhases: 0,
      timedOutPhases: 0,
      completedPhases: 0,
      checkpointAdvances: 0,
      emptyResponses: 0,
      metaOnlyResponses: 0,
      verifiedPrivateOnlyResponses: 0,
      dataRejectedMissingMeta: 0,
      rejectedKcs: 0,
      failedPeers: 0,
      failedPhases: 0,
      deniedPhases: 0,
      backoffWorthyFailures: 0,
      deferredBackpressure: 0,
    }));

    const result = await runDurableCatchupLeg(
      { syncFromPeerDetailed },
      'peer-a',
      'cg-a',
      1234,
    );

    expect(result).toMatchObject({
      insertedTriples: 0,
      state: 'failed',
      complete: false,
      failureReasons: [{ code: 'incompleteWithoutProgress', count: 1 }],
    });
    expect(syncFromPeerDetailed).toHaveBeenCalledWith(
      'peer-a',
      ['cg-a'],
      undefined,
      undefined,
      undefined,
      {
        totalTimeoutMs: 1_000,
        signal: expect.any(AbortSignal),
      },
    );
  });

  it('aborts authentication at the whole-operation deadline after a near-exhausted fetch', async () => {
    vi.useFakeTimers();
    let authenticationStarted = false;
    let committed = false;
    const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const syncFromPeerDetailed = vi.fn(async (
      _peerId: string,
      _contextGraphIds: string[],
      _onPhase: undefined,
      _onAccessDenied: undefined,
      _sinceBatchIdFor: undefined,
      options: { signal: AbortSignal },
    ) => {
      await wait(900, options.signal);
      authenticationStarted = true;
      await wait(200, options.signal);
      committed = true;
      return {
        insertedTriples: 1,
        complete: true,
      } as any;
    });

    try {
      const pending = runDurableCatchupLeg(
        { syncFromPeerDetailed: syncFromPeerDetailed as any },
        'peer-near-deadline',
        'cg-near-deadline',
        1_000,
      );
      await vi.advanceTimersByTimeAsync(900);
      expect(authenticationStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({
        insertedTriples: 0,
        state: 'failed',
        complete: false,
        failureReasons: [{
          code: 'exception',
          message: 'Durable catchup from peer-near-deadline for cg-near-deadline timed out after 1000ms',
        }],
      });
      expect(committed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('awaits an in-flight non-cancellable commit and reports its actual outcome', async () => {
    vi.useFakeTimers();
    let commitStarted = false;
    let operationSignal: AbortSignal | undefined;
    let resolveCommit!: () => void;
    let settled = false;
    const syncFromPeerDetailed = vi.fn(async (
      _peerId: string,
      _contextGraphIds: string[],
      _onPhase: undefined,
      _onAccessDenied: undefined,
      _sinceBatchIdFor: undefined,
      options: { signal: AbortSignal },
    ) => {
      operationSignal = options.signal;
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      commitStarted = true;
      await new Promise<void>((resolve) => {
        resolveCommit = resolve;
      });
      return {
        insertedTriples: 1,
        insertedDataTriples: 1,
        complete: true,
      } as any;
    });

    try {
      const pending = runDurableCatchupLeg(
        { syncFromPeerDetailed: syncFromPeerDetailed as any },
        'peer-commit-boundary',
        'cg-commit-boundary',
        1_000,
      ).finally(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(900);
      expect(commitStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(operationSignal?.aborted).toBe(true);
      expect(settled).toBe(false);

      resolveCommit();
      await expect(pending).resolves.toMatchObject({
        insertedTriples: 1,
        state: 'complete',
        complete: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ANDs completion across requested CGs and classifies partial progress', () => {
    const outcome = classifyDurableCatchupRequest([
      [{ durableComplete: true }],
      [{ durableComplete: false }],
    ], true, false);

    expect(outcome).toMatchObject({
      perContextGraphCompletion: [true, false],
      complete: false,
      allPeersFailed: false,
      incomplete: true,
      responseStatus: 200,
      errorBody: { errorCode: 'DURABLE_CATCHUP_INCOMPLETE', retryable: true },
    });
  });

  it('keeps a CG complete when any redundant peer completed cleanly', () => {
    const outcome = classifyDurableCatchupRequest([
      [
        { durableState: 'complete', durableComplete: true },
        {
          durableState: 'failed',
          durableComplete: false,
          durableError: 'Durable sync did not complete (failedPhases=1)',
        },
      ],
    ], true, false);

    expect(outcome).toMatchObject({
      perContextGraphCompletion: [true],
      complete: true,
      allPeersFailed: false,
      incomplete: false,
      responseStatus: 200,
    });
    expect(outcome.errorBody).toBeUndefined();
  });

  it('fails retryably when a durable-only request has no eligible attempt', () => {
    const outcome = classifyDurableCatchupRequest([[]], true, false);

    expect(outcome).toMatchObject({
      perContextGraphCompletion: [undefined],
      complete: false,
      allPeersFailed: false,
      noEligibleAttempts: true,
      incomplete: true,
      responseStatus: 503,
      errorBody: { errorCode: 'DURABLE_CATCHUP_NO_ELIGIBLE_PEERS', retryable: true },
    });
  });

  it('keeps a complete subset retryable when another requested CG has no attempt', () => {
    const outcome = classifyDurableCatchupRequest([
      [{ durableComplete: true }],
      [],
    ], true, false);

    expect(outcome).toMatchObject({
      perContextGraphCompletion: [true, undefined],
      complete: false,
      allPeersFailed: false,
      noEligibleAttempts: false,
      incomplete: true,
      responseStatus: 200,
      errorBody: { errorCode: 'DURABLE_CATCHUP_INCOMPLETE', retryable: true },
    });
  });

  it('preserves unknown completion for a real legacy durable attempt', () => {
    const outcome = classifyDurableCatchupRequest([[{}]], true, false);

    expect(outcome).toMatchObject({
      perContextGraphCompletion: [undefined],
      allPeersFailed: false,
      noEligibleAttempts: false,
      incomplete: false,
      responseStatus: 200,
    });
    expect(outcome.complete).toBeUndefined();
    expect(outcome.errorBody).toBeUndefined();
  });

  it('classifies all-peer failure from typed state without parsing display text', () => {
    const outcome = classifyDurableCatchupRequest([
      [{ durableState: 'failed', durableComplete: false }],
    ], true, false);

    expect(outcome).toMatchObject({
      complete: false,
      allPeersFailed: true,
      incomplete: false,
      responseStatus: 503,
      errorBody: { errorCode: 'DURABLE_CATCHUP_ALL_PEERS_FAILED' },
    });
  });
});
