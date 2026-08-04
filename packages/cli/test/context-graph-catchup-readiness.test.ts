import { describe, expect, it } from 'vitest';
import type { CatchupJobResult } from '../src/catchup-runner.js';
import type { SwmSnapshotCoverage } from '@origintrail-official/dkg-agent';
import {
  CONTEXT_GRAPH_READINESS_VERSION,
  classifyContextGraphCatchupReadiness,
  swmShortfallClause,
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
    expect(c.error).toBe('Verified data was inserted, but catch-up did not complete without a timeout or failed phase. The incomplete plane remains unready; retry once the network is healthier.');
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

/**
 * The shortfall clause Chunk 5 appends. Kept separate from T16 above, which
 * pins the ten base strings.
 *
 * T16 used to assert the incomplete-progress message as a PREFIX — satisfied by
 * that prefix followed by anything at all, including nothing. It now pins the
 * whole string with `toBe`, because the weaker form bought nothing: that
 * fixture appends no shortfall, so full equality passes unchanged and can
 * additionally catch a clause wrongly appended there.
 *
 * The strengthening does NOT make these rows redundant, for the reason that
 * matters: T16's scenario never appends a clause, so no assertion of any
 * strength in it can observe whether THIS clause is correct, malformed or
 * absent. Strength and reachability are different properties — these rows are
 * the ones that reach it.
 */
describe('T16b — the shared-memory shortfall clause (#2050)', () => {
  const INCOMPLETE_PROGRESS = 'Verified data was inserted, but catch-up did not complete without a timeout or failed phase. The incomplete plane remains unready; retry once the network is healthier.';

  const r26: SwmSnapshotCoverage = {
    contextGraphId: 'medical-research',
    peerIdSuffix: 'abcd1234',
    snapshotsResolved: 178,
    snapshotsTotal: 250,
    manifestComplete: true,
    missingCount: 72,
    missingSample: ['did:dkg:ka:one', 'did:dkg:ka:two'],
  };

  it('names the counts, the peer, the pass count and the outstanding work', () => {
    expect(swmShortfallClause(r26, 2)).toBe(
      ' (Shared memory: 178/250 snapshots fetched from peer …abcd1234 after 3 passes;'
      + ' 72 not retrieved, including did:dkg:ka:one, did:dkg:ka:two (+70 more).)',
    );
  });

  it('says "1 pass" when the walk was never repeated', () => {
    // `continuationPasses` counts the REPEATS, so zero repeats is still one walk.
    expect(swmShortfallClause(r26, 0)).toContain('after 1 pass;');
    expect(swmShortfallClause(r26, undefined)).toContain('after 1 pass;');
  });

  it('adds nothing when there is no shortfall to report', () => {
    // Both must be exactly '' or the base sentence stops being byte-identical
    // on every path that has nothing to say. The second case matters most: a
    // fully-resolved manifest beside an `unreachable` verdict means the
    // shortfall is on another plane, and "0 outstanding" would misdirect.
    expect(swmShortfallClause(undefined, 3)).toBe('');
    expect(swmShortfallClause({ ...r26, missingCount: 0, missingSample: [] }, 3)).toBe('');
  });

  it('calls an incomplete manifest a lower bound rather than a total', () => {
    expect(swmShortfallClause({ ...r26, manifestComplete: false }, 0))
      .toContain("The peer's snapshot manifest was itself incomplete, so 250 is a lower bound");
  });

  it('caps the named identifiers and accounts for the ones it omits', () => {
    const many = Array.from({ length: 25 }, (_, i) => `did:dkg:ka:${i}`);
    const clause = swmShortfallClause({ ...r26, missingCount: 90, missingSample: many }, 1);

    // Exactly ten named — ka:0 through ka:9, the tenth followed by the marker
    // rather than a comma — and the marker accounts for the other eighty.
    expect(clause).toContain('did:dkg:ka:9 (+80 more)');
    expect(clause).not.toContain('did:dkg:ka:10');
    expect(clause.match(/did:dkg:ka:\d+/g)).toHaveLength(10);
  });

  it('drops the marker when every outstanding ref is named', () => {
    const clause = swmShortfallClause(
      { ...r26, missingCount: 2, missingSample: ['did:dkg:ka:one', 'did:dkg:ka:two'] },
      0,
    );

    expect(clause).toContain('2 not retrieved, including did:dkg:ka:one, did:dkg:ka:two.)');
    expect(clause).not.toContain('more)');
  });

  it('scopes every figure to shared memory, never implying a durable retry', () => {
    // Continuation passes repeat the shared-memory peer walk ONLY. A reader
    // must not infer the durable plane was retried three times.
    const clause = swmShortfallClause(r26, 2);

    expect(clause).toContain('Shared memory:');
    expect(clause.toLowerCase()).not.toContain('durable');
  });

  it('appends to the incomplete-progress terminal, leaving its sentence byte-identical', () => {
    const result = swmIncompleteProgress();
    result.diagnostics!.sharedMemory.swmCoverage = r26;
    result.diagnostics!.sharedMemory.continuationPasses = 2;

    const c = classifyContextGraphCatchupReadiness({
      result,
      includeSharedMemory: true,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup: { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 },
    });

    expect(c.jobStatus).toBe('unreachable');
    // Whole-string equality: the prefix pin in T16 cannot see the append.
    expect(c.error).toBe(INCOMPLETE_PROGRESS + swmShortfallClause(r26, 2));
    expect(c.error).toContain('178/250');
    expect(c.error).toContain('72 not retrieved');
  });

  it('says why continuation stopped, in words that match the reason', () => {
    expect(swmShortfallClause(r26, 2, 'budget-exhausted'))
      .toContain('Continuation stopped because the time budget was exhausted.');
    expect(swmShortfallClause(r26, 2, 'max-passes-reached'))
      .toContain('Continuation stopped because the pass limit was reached.');
    expect(swmShortfallClause(r26, 2, 'no-capable-peers'))
      .toContain('Continuation stopped because no remaining peer reported holding the missing snapshots.');
  });

  it('never blames the clock for a stall, since a stall outranks the budget', () => {
    // `coverage-stalled` outranks `budget-exhausted` in the policy, so a run
    // that stalled AND expired reports the stall. If this text mentioned time
    // it would send an operator to raise a budget that buys nothing — the
    // precise misdirection that precedence exists to prevent.
    const clause = swmShortfallClause(r26, 3, 'coverage-stalled');

    expect(clause).toContain('a further pass stopped making progress, so more passes would not help');
    expect(clause).not.toMatch(/budget|time|timed out|expired/i);
  });

  it('omits the stop reason when the continuation loop never ran', () => {
    // Absent when shared memory was not requested; `continue` is not a stop.
    expect(swmShortfallClause(r26, 0, undefined)).not.toContain('Continuation stopped');
    expect(swmShortfallClause(r26, 0, 'continue')).not.toContain('Continuation stopped');
  });

  it('says an incomplete manifest was not retried, not merely that it is a bound', () => {
    // Two distinct facts: the count understates the shortfall, AND that peer
    // was dropped from later passes by the capability gate.
    expect(swmShortfallClause({ ...r26, manifestComplete: false }, 1))
      .toContain('250 is a lower bound and that peer was not retried.');
  });

  it('leaves that terminal byte-identical when the round reported no coverage', () => {
    const c = classifyContextGraphCatchupReadiness({
      result: swmIncompleteProgress(),
      includeSharedMemory: true,
      hasConfirmedMeta: true,
      isPrivate: false,
      readinessBeforeCatchup: { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 },
    });

    expect(c.error).toBe(INCOMPLETE_PROGRESS);
  });

  /** A responding round that stored verified SWM data without completing the plane. */
  function swmIncompleteProgress(): CatchupJobResult {
    const plane = () => ({
      fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0,
      insertedDataTriples: 0, bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0,
      completedPhases: 0, checkpointAdvances: 0, emptyResponses: 0, metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0, rejectedKcs: 0, droppedDataTriples: 0,
      failedPeers: 0, failedPhases: 0, deniedPhases: 0,
    });
    const result = {
      connectedPeers: 1, totalPeers: 1, selectedPeers: 1, syncCapablePeers: 1,
      peersTried: 1, peersResponded: 1, peersSucceeded: 1,
      dataSynced: 0, sharedMemorySynced: 5, denied: false, deniedPeers: 0,
      cleanPlaneCompletions: {
        durable: { verifiedDataPeers: 0, emptyPeers: 0 },
        sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
      },
      diagnostics: { noProtocolPeers: 0, durable: plane(), sharedMemory: plane() },
    } as unknown as CatchupJobResult;
    // Progress without proof: this is what `madeIncompleteProgress` reads.
    result.diagnostics!.sharedMemory.insertedDataTriples = 5;
    return result;
  }
});

/**
 * T16b (#2050) — the shortfall clause reaches the USER-VISIBLE error.
 *
 * Deliberately complementary to the implementer's own T16b, which asserts
 * `swmShortfallClause` directly. This one never calls the formatter: it drives
 * `classifyContextGraphCatchupReadiness` and asserts the composed terminal
 * string, so it covers the SEAM — that the clause is actually appended, from
 * the right fields, on the right branch.
 *
 * That seam is exactly what T16's prefix pin cannot see. Mutating the clause to
 * return `''` leaves `startsWith(...)` green, because a prefix is satisfied by
 * the prefix followed by nothing; these rows die. Two independent tests of an
 * operator-facing string is not redundancy — the formatter test is the floor,
 * this is the check.
 */
describe('T16b — the shortfall clause reaches the terminal message', () => {
  const before = { version: 0, durableVerified: false, sharedMemoryVerified: false, updatedAt: 0 };
  const PREFIX = 'Verified data was inserted, but catch-up did not complete without a timeout or failed phase. The incomplete plane remains unready; retry once the network is healthier.';

  /** The r26 shape: data inserted, plane unproven, coverage 72 short. */
  function shortfallResult(over: Partial<{
    resolved: number; total: number; missingCount: number; missingSample: string[];
    manifestComplete: boolean; continuationPasses: number;
  }> = {}): CatchupJobResult {
    const r = unresponsiveBase();
    r.dataSynced = 5;
    r.diagnostics!.durable.insertedDataTriples = 5;
    r.diagnostics!.durable.timedOutPhases = 1;
    const sm = r.diagnostics!.sharedMemory as Record<string, unknown>;
    sm['swmCoverage'] = {
      contextGraphId: 'cg-under-test',
      peerIdSuffix: 'abcd1234',
      snapshotsResolved: over.resolved ?? 178,
      snapshotsTotal: over.total ?? 250,
      manifestComplete: over.manifestComplete ?? true,
      missingCount: over.missingCount ?? 72,
      missingSample: over.missingSample ?? ['ref-a', 'ref-b'],
    };
    sm['continuationPasses'] = over.continuationPasses ?? 2;
    return r;
  }

  function unresponsiveBase(): CatchupJobResult {
    const plane = () => ({
      fetchedMetaTriples: 0, fetchedDataTriples: 0, insertedMetaTriples: 0,
      insertedDataTriples: 0, bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0,
      completedPhases: 0, checkpointAdvances: 0, emptyResponses: 0, metaOnlyResponses: 0,
      dataRejectedMissingMeta: 0, rejectedKcs: 0, droppedDataTriples: 0,
      failedPeers: 0, failedPhases: 0, deniedPhases: 0,
    });
    return {
      connectedPeers: 1, totalPeers: 1, selectedPeers: 1, syncCapablePeers: 1,
      peersTried: 1, peersResponded: 1, peersSucceeded: 1,
      dataSynced: 0, sharedMemorySynced: 0, denied: false, deniedPeers: 0,
      cleanPlaneCompletions: {
        durable: { verifiedDataPeers: 0, emptyPeers: 0 },
        sharedMemory: { verifiedDataPeers: 0, emptyPeers: 0 },
      },
      diagnostics: { noProtocolPeers: 0, durable: plane(), sharedMemory: plane() },
    };
  }

  const errorFor = (result: CatchupJobResult) => classifyContextGraphCatchupReadiness({
    result, includeSharedMemory: true, hasConfirmedMeta: true, isPrivate: false,
    readinessBeforeCatchup: before,
  }).error ?? '';

  it('appends the shortfall AFTER the byte-identical existing sentence', () => {
    const error = errorFor(shortfallResult());
    expect(error.startsWith(PREFIX)).toBe(true);
    // The part `startsWith` cannot see. A clause mutated to '' leaves the
    // assertion above green and kills this one.
    expect(error.length).toBeGreaterThan(PREFIX.length);
    // The `(+70 more)` marker is not incidental: 72 outstanding against a
    // 2-ref sample leaves 70 unnamed, and the reader must not mistake the named
    // refs for the whole inventory. An earlier draft of this expectation omitted
    // it — the producer caps the sample at 10, so a clause without a marker
    // would silently understate every shortfall larger than the cap.
    expect(error.slice(PREFIX.length)).toBe(
      ' (Shared memory: 178/250 snapshots fetched from peer …abcd1234'
      + ' after 3 passes; 72 not retrieved, including ref-a, ref-b (+70 more).)',
    );
  });

  it('names the peer, the counts and the outstanding total from ONE record', () => {
    const error = errorFor(shortfallResult());
    expect(error).toContain('178/250');
    expect(error).toContain('…abcd1234');
    expect(error).toContain('72 not retrieved');
    // Never a synthetic pair, and never the durable plane: continuation passes
    // repeat the shared-memory walk only.
    expect(error).not.toContain('200/250');
    expect(error.slice(PREFIX.length)).not.toContain('durable');
  });

  it('reports the WALK plus its repeats, not the repeat count alone', () => {
    // `continuationPasses` counts repeats, so the text must read passes + 1.
    expect(errorFor(shortfallResult({ continuationPasses: 0 }))).toContain('after 1 pass;');
    expect(errorFor(shortfallResult({ continuationPasses: 1 }))).toContain('after 2 passes;');
  });

  it('emits NO clause when nothing is outstanding', () => {
    // With largest-manifest ordering, `missingCount === 0` means the SWM plane
    // resolved everything the best-informed peer knew of and the `unreachable`
    // came from elsewhere. "0 outstanding" beside a failure verdict would
    // misdirect, so the sentence must end byte-identical to pre-fix.
    expect(errorFor(shortfallResult({ resolved: 250, missingCount: 0 }))).toBe(PREFIX);
  });

  it('flags a truncated manifest as a lower bound and says the peer was not retried', () => {
    const error = errorFor(shortfallResult({ manifestComplete: false }));
    expect(error).toContain('is a lower bound');
    expect(error).toContain('not retried');
  });
});

/**
 * The two shortfall AXES (#2050). `missingCount` measures retrieval; writes are
 * a separate counter. Gating the clause on retrieval alone made it go silent in
 * exactly the failure class the G7 repair exists for — every ref fetched
 * cleanly, some could not be written to the store — so the operator got the
 * base sentence and nothing at all about shared memory.
 */
describe('T16c — retrieval and write shortfalls are reported separately', () => {
  const base: SwmSnapshotCoverage = {
    contextGraphId: 'medical-research',
    peerIdSuffix: 'abcd1234',
    snapshotsResolved: 250,
    snapshotsTotal: 250,
    manifestComplete: true,
    missingCount: 0,
    missingSample: [],
    materializationFailures: 0,
  };

  it('speaks up when everything fetched but some writes failed', () => {
    // Pre-fix this returned '' — the one case where shared memory WAS the
    // problem was the one case the message said nothing about.
    const clause = swmShortfallClause({ ...base, materializationFailures: 12 }, 0);

    expect(clause).not.toBe('');
    expect(clause).toContain('12 retrieved but not written to the store');
  });

  it('never claims snapshots were "verified" when none were written', () => {
    // `snapshotsResolved` counts refs present and digest-valid in the blob
    // cache, NOT Knowledge Assets written. Calling that "verified" would report
    // "250/250 snapshots verified" on a graph where every write failed — wrong
    // in the flattering direction and undetectable by the reader.
    const clause = swmShortfallClause({ ...base, materializationFailures: 250 }, 0);

    expect(clause).toContain('250/250 snapshots fetched');
    expect(clause).not.toContain('verified');
  });

  it('reports both axes distinctly when both fail', () => {
    const clause = swmShortfallClause(
      { ...base, snapshotsResolved: 200, missingCount: 50, missingSample: ['ref-x'], materializationFailures: 7 },
      1,
    );

    expect(clause).toContain('50 not retrieved, including ref-x');
    expect(clause).toContain('7 retrieved but not written to the store');
    // Separate clauses, not one conflated number: a retrieval shortfall sends
    // an operator to the network, a write shortfall to the store.
    expect(clause).toContain('50 not retrieved, including ref-x (+49 more); 7 retrieved but not written');
  });

  it('still says nothing when both axes are clean', () => {
    expect(swmShortfallClause(base, 3)).toBe('');
  });

  it('treats an absent write counter as none known, not as a shortfall', () => {
    // The record crosses a worker RPC boundary; an older or partial payload
    // must not force a clause onto a round with nothing to report.
    const { materializationFailures: _omitted, ...withoutCounter } = base;
    expect(swmShortfallClause(withoutCounter as SwmSnapshotCoverage, 0)).toBe('');
  });
});
