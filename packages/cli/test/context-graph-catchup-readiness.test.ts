import { describe, expect, it } from 'vitest';
import type { CatchupJobResult } from '../src/catchup-runner.js';
import {
  CONTEXT_GRAPH_READINESS_VERSION,
  classifyContextGraphCatchupReadiness,
} from '../src/context-graph-readiness.js';

function mixedPeerResult(verifiedDataPeers: number): CatchupJobResult {
  return {
    connectedPeers: 2,
    totalPeers: 2,
    selectedPeers: 2,
    syncCapablePeers: 2,
    peersTried: 2,
    peersResponded: 2,
    peersSucceeded: verifiedDataPeers > 0 ? 1 : 0,
    dataSynced: 5,
    sharedMemorySynced: 0,
    denied: true,
    deniedPeers: 1,
    cleanPlaneCompletions: {
      durable: { verifiedDataPeers, emptyPeers: 0 },
      sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
    },
    diagnostics: {
      noProtocolPeers: 0,
      durable: {
        fetchedMetaTriples: 0,
        fetchedDataTriples: 5,
        insertedMetaTriples: 0,
        insertedDataTriples: 5,
        bytesReceived: 50,
        resumedPhases: 0,
        timedOutPhases: 1,
        completedPhases: 1,
        checkpointAdvances: 0,
        emptyResponses: 0,
        metaOnlyResponses: 0,
        dataRejectedMissingMeta: 0,
        rejectedKcs: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 1,
      },
      sharedMemory: {
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
        droppedDataTriples: 0,
        failedPeers: 0,
        failedPhases: 0,
        deniedPhases: 0,
      },
    },
  };
}

describe('context graph catch-up readiness classification', () => {
  const readinessBeforeCatchup = {
    version: 0,
    durableVerified: false,
    sharedMemoryVerified: false,
    updatedAt: 0,
  };

  it('uses a clean per-peer completion even when aggregate diagnostics contain denial and timeout', () => {
    const classification = classifyContextGraphCatchupReadiness({
      result: mixedPeerResult(1),
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      statePatch: {
        synced: true,
        sharedMemorySynced: false,
      },
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
    });
  });

  it('uses a clean private-only durable completion even when another peer denies and times out', () => {
    const result = mixedPeerResult(0);
    result.dataSynced = 0;
    result.peersSucceeded = 1;
    if (!result.cleanPlaneCompletions || !result.diagnostics?.durable) {
      throw new Error('durable completion evidence missing');
    }
    result.cleanPlaneCompletions.durable.verifiedPrivateOnlyPeers = 1;
    result.diagnostics.durable.fetchedDataTriples = 0;
    result.diagnostics.durable.insertedDataTriples = 0;
    result.diagnostics.durable.verifiedPrivateOnlyResponses = 1;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      statePatch: {
        synced: true,
        sharedMemorySynced: false,
      },
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
      eventPayload: {
        dataSynced: 0,
        sharedMemorySynced: 0,
        verifiedPrivateOnlyResponses: 1,
      },
    });
  });

  it('accepts legacy-runner diagnostics for a clean verified private-only durable response', () => {
    const result = mixedPeerResult(0);
    delete result.cleanPlaneCompletions;
    result.dataSynced = 0;
    result.denied = false;
    result.deniedPeers = 0;
    result.peersSucceeded = 1;
    if (!result.diagnostics?.durable) throw new Error('durable diagnostics missing');
    result.diagnostics.durable.fetchedMetaTriples = 8;
    result.diagnostics.durable.fetchedDataTriples = 0;
    result.diagnostics.durable.insertedMetaTriples = 8;
    result.diagnostics.durable.insertedDataTriples = 0;
    result.diagnostics.durable.verifiedPrivateOnlyResponses = 1;
    result.diagnostics.durable.timedOutPhases = 0;
    result.diagnostics.durable.deniedPhases = 0;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
      eventPayload: {
        verifiedPrivateOnlyResponses: 1,
      },
    });
  });

  it('keeps same-peer partial progress unready when no peer completed cleanly', () => {
    const result = mixedPeerResult(0);
    // The worker may count a peer that committed useful partial progress as a
    // liveness success. That counter is deliberately not readiness evidence.
    result.peersSucceeded = 1;
    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'unreachable',
      readinessPatch: {
        durableVerified: false,
        sharedMemoryVerified: false,
      },
    });
    expect(classification.eventPayload).toBeUndefined();
  });

  // Emptiness is only provable as a whole-round verdict: an empty response is
  // byte-identical whether the peer hosts an empty graph or has never heard of
  // it, so a clean-empty peer proves the plane only when NOBODY in the round
  // delivered content and nothing failed.
  function publicEmptyRoundResult(): CatchupJobResult {
    const result = mixedPeerResult(0);
    result.dataSynced = 0;
    result.peersSucceeded = 2;
    result.denied = false;
    result.deniedPeers = 0;
    if (!result.cleanPlaneCompletions || !result.diagnostics?.durable) {
      throw new Error('durable completion evidence missing');
    }
    result.cleanPlaneCompletions.durable.emptyPeers = 2;
    result.diagnostics.durable.fetchedDataTriples = 0;
    result.diagnostics.durable.insertedDataTriples = 0;
    result.diagnostics.durable.emptyResponses = 2;
    result.diagnostics.durable.timedOutPhases = 0;
    result.diagnostics.durable.deniedPhases = 0;
    result.diagnostics.durable.completedPhases = 4;
    return result;
  }

  it('persists a unanimously clean-empty round only because it was FULLY accounted', () => {
    const classification = classifyContextGraphCatchupReadiness({
      result: publicEmptyRoundResult(),
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    });

    expect(classification).toMatchObject({
      jobStatus: 'done',
      statePatch: {
        synced: true,
        sharedMemorySynced: false,
      },
      // Every attempted peer answered (`failedPeers: 0`), so the empty verdict
      // was taken over the whole peer set and may be written down. The same
      // round with a peer unaccounted for must NOT be — see the next case.
      readinessPatch: {
        durableVerified: true,
        sharedMemoryVerified: false,
      },
    });

    // `synced` is a second persisted readiness bit and gates write preflight,
    // so it has to carry the SAME verdict as the provenance patch.
    expect(classification.statePatch?.synced)
      .toBe(classification.readinessPatch?.durableVerified);
  });

  it('does not settle a round where one peer answered empty but never completed', () => {
    // The shape the fully-accounted check alone cannot see. Peer A completes
    // empty; peer B returns an empty payload but `complete: false`.
    // `catchupPeerPlaneEvidence` erases B to an all-zero record, so `emptyPeers`
    // stays 1 and — because an incomplete round is NOT a transport failure —
    // `failedPeers` stays 0. Both the unanimous-empty proof and the
    // fully-accounted gate would therefore pass, and the graph would be frozen
    // as synced on half an answer.
    const mixed = publicEmptyRoundResult();
    mixed.cleanPlaneCompletions!.durable.emptyPeers = 1;
    mixed.cleanPlaneCompletions!.durable.incompleteResponders = 1;
    mixed.diagnostics!.durable.emptyResponses = 2;
    mixed.diagnostics!.durable.failedPeers = 0;

    const classification = classifyContextGraphCatchupReadiness({
      result: mixed,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    });

    expect(classification.jobStatus).not.toBe('done');
    expect(classification.readinessPatch).toMatchObject({ durableVerified: false });
    // …and nothing opens the writeability gate either.
    expect(classification.statePatch?.synced).toBe(false);
  });

  it('re-derives an empty verdict instead of carrying it into the next run', () => {
    // The false-`done` residual: with no authoritative curator, one unrelated
    // empty response alongside transport-level peer failures satisfies the
    // unanimous-empty proof. That is survivable as a per-run verdict, but the
    // readiness OR against `readinessBeforeCatchup` would otherwise make it
    // permanent — every later run would report `done` without re-proving
    // anything, which is exactly the false-`done` class issue #2006 targets.
    const firstRun = publicEmptyRoundResult();
    firstRun.cleanPlaneCompletions!.durable.emptyPeers = 1;
    firstRun.diagnostics!.durable.emptyResponses = 1;
    firstRun.diagnostics!.durable.failedPeers = 1;

    const first = classifyContextGraphCatchupReadiness({
      result: firstRun,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    });
    expect(first.jobStatus).toBe('done');
    expect(first.readinessPatch).toMatchObject({ durableVerified: false });
    // …and the subscription must not be marked synced either, or write
    // preflight (`contextGraphRowIsWritable`: `subscribed && synced`) would
    // grant durable readiness the provenance store deliberately withheld.
    expect(first.statePatch?.synced).toBe(false);

    // Second run: metadata only, nothing proven. Feed back exactly what run one
    // persisted. If the empty verdict had been frozen, this would still say
    // `done` while proving nothing.
    const secondRun = publicEmptyRoundResult();
    secondRun.cleanPlaneCompletions!.durable.emptyPeers = 0;
    secondRun.diagnostics!.durable.emptyResponses = 0;
    secondRun.diagnostics!.durable.metaOnlyResponses = 1;

    const second = classifyContextGraphCatchupReadiness({
      result: secondRun,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup: {
        ...readinessBeforeCatchup,
        version: CONTEXT_GRAPH_READINESS_VERSION,
        durableVerified: first.readinessPatch!.durableVerified!,
      },
    });
    expect(second.jobStatus).not.toBe('done');

    // The other half of the contract: readiness proven by CONTENT is still
    // sticky, so a graph that really did sync does not re-prove itself forever.
    const proven = publicEmptyRoundResult();
    proven.dataSynced = 12;
    proven.cleanPlaneCompletions!.durable.verifiedDataPeers = 1;
    expect(classifyContextGraphCatchupReadiness({
      result: proven,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    }).readinessPatch).toMatchObject({ durableVerified: true });
  });

  it('does not accept a public clean-empty peer when another peer denies', () => {
    // A denial means we did not hear from every peer, so "nobody has anything"
    // is not established. Before #2006 this returned `done`.
    const result = publicEmptyRoundResult();
    result.denied = true;
    result.deniedPeers = 1;
    result.cleanPlaneCompletions!.durable.emptyPeers = 1;
    result.diagnostics!.durable.emptyResponses = 1;
    result.diagnostics!.durable.deniedPhases = 1;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    });

    expect(classification.jobStatus).not.toBe('done');
    expect(classification).toMatchObject({
      jobStatus: 'unreachable',
      readinessPatch: { durableVerified: false, sharedMemoryVerified: false },
    });
  });

  it('does not let a clean-empty peer mask a data-bearing peer that failed', () => {
    // The exact reported #2006 shape: 122,705 triples fetched, five phases
    // failed, no verified data completion, and unrelated peers answering empty.
    const result = publicEmptyRoundResult();
    result.cleanPlaneCompletions!.durable.emptyPeers = 1;
    result.diagnostics!.durable.emptyResponses = 1;
    result.diagnostics!.durable.fetchedDataTriples = 122_705;
    result.diagnostics!.durable.failedPhases = 5;

    const classification = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    });

    expect(classification.jobStatus).not.toBe('done');
    expect(classification.readinessPatch).toMatchObject({ durableVerified: false });
  });

  it('applies the same fail-closed empty rule to a legacy runner result', () => {
    // A result without `cleanPlaneCompletions` (an older in-process runner
    // during a rolling upgrade) takes the compatibility branch. It must not be
    // a way around the round-level guard.
    const masked = publicEmptyRoundResult();
    delete masked.cleanPlaneCompletions;
    masked.diagnostics!.durable.fetchedDataTriples = 122_705;
    masked.diagnostics!.durable.failedPhases = 5;

    expect(classifyContextGraphCatchupReadiness({
      result: masked,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    }).jobStatus).not.toBe('done');

    // …and a legacy result from a genuinely empty round still settles.
    const clean = publicEmptyRoundResult();
    delete clean.cleanPlaneCompletions;
    expect(classifyContextGraphCatchupReadiness({
      result: clean,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    })).toMatchObject({
      jobStatus: 'done',
      // Same rule as the non-legacy path: a fully accounted empty round is
      // written down, a partial one is not.
      readinessPatch: { durableVerified: true },
    });

    // The partial-round half of that rule, on the legacy branch too.
    const lossy = publicEmptyRoundResult();
    delete lossy.cleanPlaneCompletions;
    lossy.diagnostics!.durable.failedPeers = 1;
    expect(classifyContextGraphCatchupReadiness({
      result: lossy,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    })).toMatchObject({
      jobStatus: 'done',
      readinessPatch: { durableVerified: false },
      statePatch: { synced: false },
    });
  });

  it('never proves a private plane from an empty round', () => {
    const classification = classifyContextGraphCatchupReadiness({
      result: publicEmptyRoundResult(),
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    });

    expect(classification.jobStatus).toBe('unreachable');
    expect(classification.readinessPatch).toMatchObject({ durableVerified: false });
  });

  // A registered public graph with no Knowledge Assets yet. Its host serves the
  // CG definition triples from `<cg>/_meta`, so it answers metadata-only rather
  // than wire-empty and the whole-round rule above can never fire — no peer in
  // the round produced an `emptyResponses`. The curator's own hosted-empty
  // round is the only evidence such a graph can produce.
  function curatorHostedEmptyResult(): CatchupJobResult {
    const result = publicEmptyRoundResult();
    if (!result.cleanPlaneCompletions || !result.diagnostics?.durable) {
      throw new Error('durable completion evidence missing');
    }
    result.cleanPlaneCompletions.durable.emptyPeers = 0;
    result.cleanPlaneCompletions.durable.authorityEmptyPeers = 1;
    result.diagnostics.durable.emptyResponses = 0;
    result.diagnostics.durable.metaOnlyResponses = 1;
    result.diagnostics.durable.fetchedMetaTriples = 9;
    result.diagnostics.durable.insertedMetaTriples = 9;
    return result;
  }

  it('settles a registered-but-empty public graph on the curator hosted-empty round', () => {
    expect(classifyContextGraphCatchupReadiness({
      result: curatorHostedEmptyResult(),
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    })).toMatchObject({
      jobStatus: 'done',
      statePatch: { synced: true },
      readinessPatch: { durableVerified: true },
    });
  });

  it.each([
    ['the round came from members rather than the curator', (result: CatchupJobResult) => {
      result.cleanPlaneCompletions!.durable.authorityEmptyPeers = 0;
    }],
    ['another peer delivered data the curator did not have', (result: CatchupJobResult) => {
      result.diagnostics!.durable.fetchedDataTriples = 122_705;
    }],
  ])('keeps the same round unready when %s', (_label, mutate) => {
    const result = curatorHostedEmptyResult();
    mutate(result);

    expect(classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    })).toMatchObject({
      jobStatus: 'unreachable',
      readinessPatch: { durableVerified: false },
    });
  });

  it('is not discarded by the denial gate before readiness is evaluated', () => {
    // `cleanCompletionHasResponse` gates the denial and no-response branches
    // that run BEFORE `catchupPlaneReady` is consulted. A new evidence carrier
    // missing from that gate is silently unreachable: the durable plane would
    // be provably ready and the job would still return `denied`, because a
    // shared-memory phase from some other peer was refused.
    const result = curatorHostedEmptyResult();
    result.denied = true;
    result.deniedPeers = 1;
    result.diagnostics!.sharedMemory.deniedPhases = 1;

    expect(classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup,
    })).toMatchObject({
      jobStatus: 'done',
      readinessPatch: { durableVerified: true },
    });
  });

  it('never settles a PRIVATE plane on a curator hosted-empty round', () => {
    // Private planes stay proof-by-content only: an authorized-but-filtered
    // response is indistinguishable from an empty one on this side of the wire.
    expect(classifyContextGraphCatchupReadiness({
      result: curatorHostedEmptyResult(),
      includeSharedMemory: false,
      hasConfirmedMeta: true,
      isPrivate: true,
      readinessBeforeCatchup,
    }).jobStatus).toBe('unreachable');
  });
});

/**
 * T16 (#2050) — byte-equality characterization of EVERY terminal `error` string
 * this module can emit.
 *
 * WHY THESE PASS ON THE PRE-FIX TREE, DELIBERATELY. These are characterization
 * tests, written BEFORE Chunk 5 appends anything. All ten strings previously
 * appeared ONLY in `context-graph-readiness.ts` — no test, no node-ui reference,
 * no snapshot — so "the other strings are unchanged" was unverifiable. Passing
 * pre-fix is their entire purpose; they are not evidence that any fix works.
 * T16b (the appended shortfall) is the row that must fail pre-fix.
 *
 * Chunk 5 appends to exactly ONE of these — the `madeIncompleteProgress`
 * message — which is therefore asserted as an exact PREFIX. The other nine are
 * full equality and must stay byte-identical.
 */
describe('T16 — terminal readiness strings are byte-identical', () => {
  const before = { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 };

  function zeroPlane() {
    return {
      fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0,
      insertedDataTriples: 0, bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0,
      completedPhases: 0, checkpointAdvances: 0, emptyResponses: 0, metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0, rejectedKcs: 0, droppedDataTriples: 0,
      failedPeers: 0, failedPhases: 0, deniedPhases: 0,
    };
  }

  /** Every disjunct of `catchupResultHasCleanResponse` false — what the tail branches need. */
  function unresponsive(): CatchupJobResult {
    return {
      connectedPeers: 0, totalPeers: 0, selectedPeers: 0, syncCapablePeers: 0,
      peersTried: 0, peersResponded: 0, peersSucceeded: 0,
      dataSynced: 0, sharedMemorySynced: 0, denied: false, deniedPeers: 0,
      cleanPlaneCompletions: {
        durable: { verifiedDataPeers: 0, emptyPeers: 0 },
        sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
      },
      diagnostics: { noProtocolPeers: 0, durable: zeroPlane(), sharedMemory: zeroPlane() },
    };
  }

  function responding(): CatchupJobResult {
    const r = unresponsive();
    r.connectedPeers = 1; r.totalPeers = 1; r.selectedPeers = 1; r.syncCapablePeers = 1;
    r.peersTried = 1; r.peersResponded = 1; r.peersSucceeded = 1;
    return r;
  }

  /**
   * A clean response that proves NOTHING. Proving the plane instead
   * (`verifiedDataPeers = 1`) makes `catchupPlaneProvenByData` fire, so
   * `missingGraphProof` is false and the classification returns `done` with no
   * error at all — the metadata-only route reaches the clean-response gate while
   * leaving every proof path false.
   */
  function metadataOnly(): CatchupJobResult {
    const r = responding();
    r.diagnostics!.durable.fetchedMetaTriples = 10;
    r.diagnostics!.durable.metaOnlyResponses = 1;
    return r;
  }

  function durableProven(): CatchupJobResult {
    const r = responding();
    r.dataSynced = 5;
    r.diagnostics!.durable.insertedDataTriples = 5;
    r.diagnostics!.durable.completedPhases = 1;
    r.cleanPlaneCompletions!.durable.verifiedDataPeers = 1;
    return r;
  }

  const classify = (
    result: CatchupJobResult,
    over: Partial<{ includeSharedMemory: boolean; hasConfirmedMeta: boolean; isPrivate: boolean }> = {},
  ) => classifyContextGraphCatchupReadiness({
    result, includeSharedMemory: false, hasConfirmedMeta: true, isPrivate: false,
    readinessBeforeCatchup: before, ...over,
  });

  it('pins the missing-authoritative-metadata string', () => {
    const c = classify(metadataOnly(), { hasConfirmedMeta: false });
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe('No peer delivered authoritative context-graph metadata — the curator may be offline, or responding peers do not host this project.');
  });

  it('pins the incomplete-progress sentence as an exact PREFIX (Chunk 5 appends here)', () => {
    const r = responding();
    r.dataSynced = 5;
    r.diagnostics!.durable.insertedDataTriples = 5;
    r.diagnostics!.durable.timedOutPhases = 1;
    const c = classify(r);
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error?.startsWith('Verified data was inserted, but catch-up did not complete without a timeout or failed phase. The incomplete plane remains unready; retry once the network is healthier.')).toBe(true);
  });

  it('pins the private missing-graph-proof string', () => {
    const c = classify(metadataOnly(), { isPrivate: true });
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe('No authorized context-graph peer delivered verified durable or shared-memory data — empty or metadata-only responses cannot prove a private graph is fully synchronized, and the curator may be offline.');
  });

  it('pins the private durable-ok-shared-memory-incomplete string', () => {
    const c = classify(durableProven(), { isPrivate: true, includeSharedMemory: true });
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe('Durable context-graph data synchronized, but shared-memory catch-up did not complete. Retry to finish shared-memory synchronization.');
  });

  it('pins the public not-clean-for-every-plane string', () => {
    const c = classify(metadataOnly());
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe('Context-graph catch-up did not complete cleanly for every requested data plane. Retry once the network is healthier.');
  });

  it('pins the no-peer-could-deliver string', () => {
    const r = unresponsive();
    r.peersTried = 2; r.peersResponded = 0;
    const c = classify(r);
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe("No peer could deliver this project's data — the curator may be offline, or no node currently holds the data. You can still send a signed join request; they will receive it next time they come online.");
  });

  it('pins the all-reachable-peers-failed string', () => {
    const r = unresponsive();
    r.peersTried = 2; r.peersResponded = 1;
    const c = classify(r);
    expect(c.jobStatus).toBe('failed');
    expect(c.error).toBe('Sync did not complete — all reachable peers failed (timeouts or transport errors). Retry once the network is healthier.');
  });

  it('pins the no-sync-capable-peers string', () => {
    const r = unresponsive();
    r.connectedPeers = 3; r.totalPeers = 3; r.selectedPeers = 3; r.syncCapablePeers = 0;
    const c = classify(r);
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe('No sync-capable peers found for catch-up — the curator may be offline.');
  });

  it('pins the no-peers-connected string', () => {
    const c = classify(unresponsive());
    expect(c.jobStatus).toBe('unreachable');
    expect(c.error).toBe("No peers connected — couldn't reach the curator. They may be offline, or your node hasn't bootstrapped to the network yet.");
  });

  it('pins both denial strings, singular and plural', () => {
    // Field-by-field rather than `toMatchObject`: this is the one pair in the
    // set where a partial match would tolerate an extra field appearing on the
    // classification without anyone noticing.
    const one = unresponsive();
    one.denied = true; one.deniedPeers = 1;
    const c1 = classify(one);
    expect(c1.jobStatus).toBe('denied');
    expect(c1.error).toBe('Sync denied by remote peer');

    const many = unresponsive();
    many.denied = true; many.deniedPeers = 3;
    const c3 = classify(many);
    expect(c3.jobStatus).toBe('denied');
    expect(c3.error).toBe('Sync denied by 3 remote peers');
  });

  it('leaves `error` ABSENT on a clean `done` classification', () => {
    // The other direction, and nothing else in this file can see it. Every row
    // above pins a POPULATED error, so all of them would still pass if the
    // module grew a spurious message on the success path — a user-visible
    // regression that a suite of positive assertions is blind to.
    const c = classify(durableProven());
    expect(c.jobStatus).toBe('done');
    expect(c.error).toBeUndefined();
  });
});
