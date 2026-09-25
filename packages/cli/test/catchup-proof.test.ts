import { describe, expect, it } from 'vitest';
import {
  catchupPeerPlaneEvidence,
  catchupPlaneProvenByAuthorityHostedEmpty,
  catchupPlaneProvenByData,
  catchupPlaneProvenByUnanimousEmpty,
  catchupPlaneReady,
} from '../src/catchup-proof.js';

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
