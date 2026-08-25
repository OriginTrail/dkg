import { describe, expect, it, vi } from 'vitest';
import {
  catchupPeerPlaneEvidence,
  catchupPeerResponded,
  catchupPeerSucceeded,
  catchupPlaneCompletedWithoutFailure,
  catchupPlaneProvenByAuthorityHostedEmpty,
  catchupPlaneProvenByData,
  catchupPlaneProvenByUnanimousEmpty,
  catchupPlaneReady,
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
        onAtomicCommitStarted: expect.any(Function),
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
      options: {
        signal: AbortSignal;
        onAtomicCommitStarted: (contextGraphId: string, ual: string) => void;
      },
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
      options: {
        signal: AbortSignal;
        onAtomicCommitStarted: (contextGraphId: string, ual: string) => void;
      },
    ) => {
      operationSignal = options.signal;
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      options.onAtomicCommitStarted('cg-commit-boundary', 'did:dkg:test/commit');
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

  it('hard-bounds a detailed adapter before atomic commit without a phase-string side channel', async () => {
    vi.useFakeTimers();
    const syncFromPeerDetailed = vi.fn(async (
      _peerId: string,
      _contextGraphIds: string[],
      onPhase: undefined,
      _onAccessDenied: undefined,
      _sinceBatchIdFor: undefined,
      _options: {
        signal: AbortSignal;
        onAtomicCommitStarted: (contextGraphId: string, ual: string) => void;
      },
    ) => {
      expect(onPhase).toBeUndefined();
      return new Promise<never>(() => {});
    });

    try {
      const pending = runDurableCatchupLeg(
        { syncFromPeerDetailed: syncFromPeerDetailed as any },
        'peer-detailed-precommit-hung',
        'cg-detailed-precommit-hung',
        1_000,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({
        insertedTriples: 0,
        state: 'failed',
        complete: false,
        failureReasons: [{
          code: 'exception',
          message: 'Durable catchup from peer-detailed-precommit-hung for cg-detailed-precommit-hung timed out after 1000ms',
        }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns indeterminate when an in-flight commit exceeds settlement grace', async () => {
    vi.useFakeTimers();
    let commitStarted = false;
    const syncFromPeerDetailed = vi.fn(async (
      _peerId: string,
      _contextGraphIds: string[],
      _onPhase: undefined,
      _onAccessDenied: undefined,
      _sinceBatchIdFor: undefined,
      options: {
        onAtomicCommitStarted: (contextGraphId: string, ual: string) => void;
      },
    ) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      options.onAtomicCommitStarted('cg-commit-indeterminate', 'did:dkg:test/commit');
      commitStarted = true;
      return new Promise<never>(() => {});
    });

    try {
      const pending = runDurableCatchupLeg(
        { syncFromPeerDetailed: syncFromPeerDetailed as any },
        'peer-commit-indeterminate',
        'cg-commit-indeterminate',
        1_000,
      );
      await vi.advanceTimersByTimeAsync(900);
      expect(commitStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(pending).resolves.toMatchObject({
        insertedTriples: 0,
        state: 'indeterminate',
        complete: false,
        failureReasons: [{
          code: 'indeterminateSettlement',
          count: 1,
        }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hard-bounds a legacy durable adapter that ignores cancellation', async () => {
    vi.useFakeTimers();
    const syncFromPeer = vi.fn(async () => new Promise<number>(() => {}));

    try {
      const pending = runDurableCatchupLeg(
        { syncFromPeer: syncFromPeer as any },
        'peer-legacy-hung',
        'cg-legacy-hung',
        1_000,
      );
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toMatchObject({
        insertedTriples: 0,
        state: 'failed',
        complete: false,
        failureReasons: [{
          code: 'exception',
          message: 'Durable catchup from peer-legacy-hung for cg-legacy-hung timed out after 1000ms',
        }],
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

  it('classifies indeterminate settlement as retryable incomplete progress', () => {
    const outcome = classifyDurableCatchupRequest([
      [{
        durableState: 'indeterminate',
        durableComplete: false,
        durableError: 'Durable sync did not complete (indeterminateSettlement=1)',
      }],
    ], true, false);

    expect(outcome).toMatchObject({
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

// Issue #2006. On the wire, a peer that hosts an empty Context Graph and a peer
// that has never heard of it are byte-identical: an unknown CG has no access
// policy, so the responder authorizes the request and its CG-scoped queries
// simply return zero rows. The requester emits `emptyResponses` only when BOTH
// phase payloads are empty, so an empty response can never carry hosting
// evidence. Emptiness is therefore only provable as a whole-round verdict.
describe('catch-up plane proof predicates', () => {
  const noEvidence = { verifiedDataPeers: 0, verifiedPrivateOnlyPeers: 0, emptyPeers: 0 };
  const cleanEmptyRound = {
    fetchedMetaTriples: 0,
    fetchedDataTriples: 0,
    emptyResponses: 2,
    failedPeers: 0,
    failedPhases: 0,
    timedOutPhases: 0,
    deniedPhases: 0,
    deferredBackpressure: 0,
  };
  const emptyPeers = { ...noEvidence, emptyPeers: 2 };

  it('treats verified data and verified private-only completions as positive proof', () => {
    expect(catchupPlaneProvenByData({ ...noEvidence, verifiedDataPeers: 1 })).toBe(true);
    expect(catchupPlaneProvenByData({ ...noEvidence, verifiedPrivateOnlyPeers: 1 })).toBe(true);
    expect(catchupPlaneProvenByData(noEvidence)).toBe(false);
    expect(catchupPlaneProvenByData(undefined)).toBe(false);
    // A clean empty response is NOT positive proof — it can never stop the walk.
    expect(catchupPlaneProvenByData(emptyPeers)).toBe(false);
  });

  it('accepts a unanimously clean, content-free public round as proof of emptiness', () => {
    expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, cleanEmptyRound, { isPrivate: false }))
      .toBe(true);
    expect(catchupPlaneReady(emptyPeers, cleanEmptyRound, { isPrivate: false })).toBe(true);
  });

  it('never proves a private plane from an empty round', () => {
    expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, cleanEmptyRound, { isPrivate: true }))
      .toBe(false);
    expect(catchupPlaneReady(emptyPeers, cleanEmptyRound, { isPrivate: true })).toBe(false);
  });

  it.each([
    ['a data-bearing peer that failed', { fetchedDataTriples: 122_705, failedPhases: 5 }],
    ['fetched data with no verified completion', { fetchedDataTriples: 5_000 }],
    ['a failed phase', { failedPhases: 1 }],
    ['a timed-out phase', { timedOutPhases: 1 }],
    ['a denial', { deniedPhases: 1 }],
    ['a local admission deferral', { deferredBackpressure: 1 }],
    // An integrity rejection is stronger than a failure: it is a peer that
    // SERVED CONTENT for this graph which then failed verification, so it is
    // positive evidence the graph is not empty. `classifyDurableProgress`
    // already treats both as blocking failures per peer.
    ['data rejected for missing metadata', { dataRejectedMissingMeta: 1 }],
    ['a rejected Knowledge Collection', { rejectedKcs: 1 }],
  ])('voids the empty proof when the round contains %s', (_label, overrides) => {
    const diagnostics = { ...cleanEmptyRound, ...overrides };
    expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, diagnostics, { isPrivate: false }))
      .toBe(false);
    expect(catchupPlaneReady(emptyPeers, diagnostics, { isPrivate: false })).toBe(false);
  });

  it.each([
    // Every registered Context Graph carries definition triples in its own
    // `<cg>/_meta`, so ANY peer that hosts the graph returns metadata even when
    // the graph holds zero Knowledge Assets. Treating that as content would make
    // a legitimately empty public graph permanently unreadable.
    ['metadata from a hosting peer', { fetchedMetaTriples: 12 }],
    // A transport failure is a peer we never heard from. On a live testnet a
    // majority of connected peers can be unreachable; an unreachable stranger is
    // evidence of nothing. A peer that DID engage and then failed shows up in
    // the voiding counters above.
    ['a transport failure to an unreachable peer', { failedPeers: 4 }],
  ])('still proves an empty public round despite %s', (_label, overrides) => {
    const diagnostics = { ...cleanEmptyRound, ...overrides };
    expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, diagnostics, { isPrivate: false }))
      .toBe(true);
    expect(catchupPlaneReady(emptyPeers, diagnostics, { isPrivate: false })).toBe(true);
  });

  it('proves a registered public graph that simply has no Knowledge Assets yet', () => {
    // The shape a freshly registered, still-empty public Context Graph actually
    // produces: its host serves the CG definition triples (metadata) and no
    // data, other peers answer clean-empty, and some connected peers are
    // unreachable. This must reach `done`, not sit at `unreachable` forever.
    const registeredButEmpty = {
      ...cleanEmptyRound,
      fetchedMetaTriples: 9,
      emptyResponses: 3,
      failedPeers: 2,
    };
    expect(catchupPlaneReady(emptyPeers, registeredButEmpty, { isPrivate: false })).toBe(true);
  });

  it('still reports ready when a peer delivered verified data despite other failures', () => {
    const diagnostics = { ...cleanEmptyRound, fetchedDataTriples: 24_541, failedPhases: 1 };
    const completion = { ...emptyPeers, verifiedDataPeers: 1 };
    expect(catchupPlaneReady(completion, diagnostics, { isPrivate: false })).toBe(true);
    expect(catchupPlaneReady(completion, diagnostics, { isPrivate: true })).toBe(true);
  });

  it('requires at least one clean empty completion before an empty verdict', () => {
    expect(catchupPlaneProvenByUnanimousEmpty(
      noEvidence,
      { ...cleanEmptyRound, emptyResponses: 0 },
      { isPrivate: false },
    )).toBe(false);
  });

  // A registered public graph that really is empty still carries definition
  // triples in its own `<cg>/_meta`, so the peer hosting it answers
  // metadata-only, never wire-empty. Nothing in the whole-round rule above can
  // ever fire for it — the curator has to say so itself.
  describe('an empty graph whose only responder is its curator', () => {
    const hostedEmptyRound = {
      insertedTriples: 9,
      insertedMetaTriples: 9,
      insertedDataTriples: 0,
      fetchedDataTriples: 0,
      metaOnlyResponses: 1,
      emptyResponses: 0,
      completedPhases: 2,
    };
    const hostedEmptyDiagnostics = {
      ...cleanEmptyRound,
      fetchedMetaTriples: 9,
      emptyResponses: 0,
    };

    it('never reads a SHARED-MEMORY round as hosted-empty evidence', () => {
      // `<cg>/_meta` definition triples are a DURABLE fact: serving them proves
      // the peer hosts the Context Graph. Shared-memory metadata is a different
      // artifact, and shared memory is contributed by many members rather than
      // owned by the curator — so "the curator has SWM structure but no SWM
      // rows" does not mean the network has none. Treating it as hosted-empty
      // would settle the shared plane and stop the walk before any member that
      // actually holds the SWM data is contacted.
      const curatorSharedMetaOnly = {
        insertedTriples: 5,
        insertedMetaTriples: 5,
        insertedDataTriples: 0,
        fetchedDataTriples: 0,
        emptyResponses: 0,
        completedPhases: 2,
      };

      expect(catchupPeerPlaneEvidence(curatorSharedMetaOnly, {
        fromAuthority: true,
        plane: 'shared-memory',
      })).toMatchObject({ authorityEmptyPeers: 0 });

      // Nor does a wire-empty one: on this plane NOBODY's emptiness is
      // authoritative, because the curator does not own the members' layers.
      // An empty SWM plane is still provable, but only as a whole-round verdict.
      expect(catchupPeerPlaneEvidence(
        { ...curatorSharedMetaOnly, insertedTriples: 0, insertedMetaTriples: 0, emptyResponses: 1 },
        { fromAuthority: true, plane: 'shared-memory' },
      )).toMatchObject({ authorityEmptyPeers: 0, emptyPeers: 1 });

      // …and the identical shape on the DURABLE plane is hosting evidence.
      expect(catchupPeerPlaneEvidence(curatorSharedMetaOnly, {
        complete: true,
        fromAuthority: true,
        plane: 'durable',
      })).toMatchObject({ authorityEmptyPeers: 1 });
    });

    it('counts the curator, and ONLY the curator, as hosted-empty evidence', () => {
      expect(catchupPeerPlaneEvidence(hostedEmptyRound, {
        plane: 'durable',
        complete: true,
        fromAuthority: true,
      })).toMatchObject({ verifiedDataPeers: 0, emptyPeers: 0, authorityEmptyPeers: 1 });
      // The identical round from any other peer is the commonest state on the
      // network — a member holding `_meta` that has not synced the data yet —
      // and counting it would resettle #2006 as `done` with zero KAs.
      expect(catchupPeerPlaneEvidence(hostedEmptyRound, { plane: 'durable', complete: true }))
        .toMatchObject({ authorityEmptyPeers: 0 });
      // Neither does a curator round that fetched data but inserted none.
      expect(catchupPeerPlaneEvidence(
        { ...hostedEmptyRound, fetchedDataTriples: 4_000 },
        { plane: 'durable', complete: true, fromAuthority: true },
      )).toMatchObject({ authorityEmptyPeers: 0 });
    });

    it('proves the public plane with no wire-empty response anywhere in the round', () => {
      const completion = { ...noEvidence, authorityEmptyPeers: 1 };
      expect(catchupPlaneProvenByAuthorityHostedEmpty(
        completion,
        hostedEmptyDiagnostics,
        { isPrivate: false },
      )).toBe(true);
      expect(catchupPlaneReady(completion, hostedEmptyDiagnostics, { isPrivate: false })).toBe(true);
      // Without the curator's own evidence the same round proves nothing.
      expect(catchupPlaneReady(noEvidence, hostedEmptyDiagnostics, { isPrivate: false })).toBe(false);
    });

    it('is voided when another peer delivered data the curator did not have', () => {
      expect(catchupPlaneProvenByAuthorityHostedEmpty(
        { ...noEvidence, authorityEmptyPeers: 1 },
        { ...hostedEmptyDiagnostics, fetchedDataTriples: 122_705 },
        { isPrivate: false },
      )).toBe(false);
    });

    it.each([
      ['data rejected for missing metadata', { dataRejectedMissingMeta: 1 }],
      ['a rejected Knowledge Collection', { rejectedKcs: 1 }],
    ])('is voided by %s elsewhere in the round, ahead of the curator\'s word', (_label, overrides) => {
      // Content that failed verification still proves content EXISTS, which
      // outranks the curator saying the graph is empty — unlike a plain
      // transport or phase failure, which the curator's answer does outrank.
      expect(catchupPlaneProvenByAuthorityHostedEmpty(
        { ...noEvidence, authorityEmptyPeers: 1 },
        { ...hostedEmptyDiagnostics, ...overrides },
        { isPrivate: false },
      )).toBe(false);
    });

    it('never proves a private plane', () => {
      expect(catchupPlaneProvenByUnanimousEmpty(
        { ...noEvidence, authorityEmptyPeers: 1 },
        hostedEmptyDiagnostics,
        { isPrivate: true },
      )).toBe(false);
    });
  });

  describe('a non-curator that has `_meta` but no data', () => {
    // The requester itself logs "peer may have empty or pruned data graph" for
    // this response, which names the ambiguity exactly: the graph is empty, OR
    // this member has not synced it yet. Without the curator present there is
    // nothing to resolve it against, and combining it with an unrelated peer's
    // empty answer would settle a 40-KA graph as `done` with zero.
    const memberWithMetaOnly = {
      ...cleanEmptyRound,
      emptyResponses: 1,
      metaOnlyResponses: 1,
      fetchedMetaTriples: 9,
    };

    it('cannot be combined with a stranger\'s empty answer to prove the plane', () => {
      expect(catchupPlaneProvenByUnanimousEmpty(
        { ...noEvidence, emptyPeers: 1 },
        memberWithMetaOnly,
        { isPrivate: false },
      )).toBe(false);
      expect(catchupPlaneReady(
        { ...noEvidence, emptyPeers: 1 },
        memberWithMetaOnly,
        { isPrivate: false },
      )).toBe(false);
    });

    it('costs the legitimately empty graph nothing once its CURATOR answers', () => {
      // The positive half. Voiding on `metaOnlyResponses` would be a bad trade
      // if it also blocked the real empty-public-graph case — it does not,
      // because the curator's own round settles that through the other proof
      // mode, which is evaluated independently.
      expect(catchupPlaneReady(
        { ...noEvidence, emptyPeers: 1, authorityEmptyPeers: 1 },
        memberWithMetaOnly,
        { isPrivate: false },
      )).toBe(true);
    });

    it('leaves the all-strangers round provable, so the rule is not vacuous', () => {
      // A tightened clause that can never be satisfied is worse than no clause,
      // because nothing reveals it. Pin that the unanimous rule still fires
      // when every responder answered wire-empty and nobody returned metadata.
      expect(catchupPlaneProvenByUnanimousEmpty(
        { ...noEvidence, emptyPeers: 2 },
        { ...cleanEmptyRound, metaOnlyResponses: 0 },
        { isPrivate: false },
      )).toBe(true);
    });
  });

  describe('a curator that was selected but never cleanly answered', () => {
    // The walk puts a resolvable curator ALONE in wave 1, so when it
    // transport-fails the walk moves on to strangers, one answers empty, and the
    // graph's 40 Knowledge Assets get reported as zero. That is issue #2006's own
    // symptom in its sharpest form.
    const curatorSilent = { ...cleanEmptyRound, failedPeers: 1, authorityUnanswered: true };

    it('cannot have its plane proven by a stranger answering empty', () => {
      expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, curatorSilent, { isPrivate: false }))
        .toBe(false);
      expect(catchupPlaneReady(emptyPeers, curatorSilent, { isPrivate: false })).toBe(false);
    });

    it.each([
      // No curator resolved at all. The hosted-empty backstop structurally
      // cannot fire here, so voiding on a mere unreachable STRANGER would pin a
      // legitimately empty public graph at `unreachable` forever — the liveness
      // failure this rule exists to avoid. Only the CURATOR's silence is decisive.
      ['no curator was resolvable', { ...cleanEmptyRound, failedPeers: 4 }],
      // Registered-but-empty public graph on a lossy network, curator absent
      // from the round entirely.
      ['the graph is registered but empty', {
        ...cleanEmptyRound, fetchedMetaTriples: 9, emptyResponses: 3, failedPeers: 2,
      }],
    ])('still proves an empty round when %s', (_label, diagnostics) => {
      expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, diagnostics, { isPrivate: false }))
        .toBe(true);
      expect(catchupPlaneReady(emptyPeers, diagnostics, { isPrivate: false })).toBe(true);
    });

    it('is still proven when the curator DID answer, unreachable strangers aside', () => {
      // The positive complement: the flag is about the curator's silence, not
      // about the round being lossy.
      const curatorAnswered = { ...cleanEmptyRound, failedPeers: 3, authorityUnanswered: false };
      expect(catchupPlaneProvenByUnanimousEmpty(emptyPeers, curatorAnswered, { isPrivate: false }))
        .toBe(true);
    });
  });

  it('uses per-peer completion evidence, and the aggregate ONLY without it', () => {
    // Per-peer evidence (`cleanPlaneCompletions`) and the aggregate counter
    // (`diagnostics.emptyResponses`) are separate carriers, but they are not
    // interchangeable and must not be ORed together.
    //
    // `emptyResponses` counts an empty PAYLOAD; `emptyPeers` counts a peer whose
    // round was empty AND clean. A peer that answered empty but did not complete
    // raises the first and not the second — so consulting the aggregate when
    // per-peer evidence exists lets an explicitly incomplete response prove the
    // plane ready, which is the false-`done` class this proof exists to prevent.
    expect(catchupPlaneProvenByUnanimousEmpty(
      { ...noEvidence, emptyPeers: 1 },
      { ...cleanEmptyRound, emptyResponses: 0 },
      { isPrivate: false },
    )).toBe(true);

    // Completion evidence PRESENT and negative: the aggregate must not re-admit
    // it. This is the assertion that fails if the carriers are ORed.
    expect(catchupPlaneProvenByUnanimousEmpty(
      noEvidence,
      { ...cleanEmptyRound, emptyResponses: 1 },
      { isPrivate: false },
    )).toBe(false);

    // Completion evidence genuinely ABSENT (the legacy runner result): the
    // aggregate is the only carrier there is, so it still counts. Without this
    // row, dropping the fallback entirely would look like a passing change.
    expect(catchupPlaneProvenByUnanimousEmpty(
      undefined,
      { ...cleanEmptyRound, emptyResponses: 1 },
      { isPrivate: false },
    )).toBe(true);
  });

  it('does not let an explicitly incomplete empty peer prove the plane', () => {
    // The production shape of the row above: the worker reports a peer that
    // returned an empty payload but whose round never completed, so the peer is
    // absent from `emptyPeers` while `emptyResponses` still counts it.
    const incompleteEmpty = catchupPeerPlaneEvidence(
      { emptyResponses: 1, completedPhases: 0, bytesReceived: 0 },
      { plane: 'durable', complete: false },
    );
    expect(incompleteEmpty.emptyPeers).toBe(0);
    expect(catchupPlaneProvenByUnanimousEmpty(
      incompleteEmpty,
      { ...cleanEmptyRound, emptyResponses: 1 },
      { isPrivate: false },
    )).toBe(false);
  });
});

describe('catch-up peer accounting with a skipped plane', () => {
  const cleanShared = {
    insertedTriples: 3,
    insertedDataTriples: 3,
    completedPhases: 1,
    bytesReceived: 30,
  };

  it('does not read a skipped durable plane as a peer response', () => {
    // The walk omits the durable plane for peers contacted purely as a
    // shared-memory fallback. An absent plane is not a silent one: it must not
    // manufacture a response for a peer whose only requested plane failed.
    expect(catchupPeerResponded(null, { failedPeers: 1 })).toBe(false);
    expect(catchupPeerResponded(null, undefined)).toBe(false);
    expect(catchupPeerResponded(null, cleanShared)).toBe(true);
  });

  it('judges a skipped durable plane purely on the shared-memory outcome', () => {
    expect(catchupPeerSucceeded(null, cleanShared, false)).toBe(true);
    expect(catchupPeerSucceeded(null, { ...cleanShared, timedOutPhases: 1 }, false)).toBe(false);
    expect(catchupPeerSucceeded(null, { failedPeers: 1 }, false)).toBe(false);
  });
});
