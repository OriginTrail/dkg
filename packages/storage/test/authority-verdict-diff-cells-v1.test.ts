import { describe, expect, it } from 'vitest';

import { VERDICT_DIFF_AXES_V1 } from './helpers/authority-verdict-diff-fixture-v1.js';
import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';

/**
 * The generator's own pin. It does not compare the two evaluators -- that is the
 * verdict table's job -- it fixes the SHAPE and SIZE of the space the table will
 * have to cover, so the sweep's coverage claim is falsifiable.
 *
 * A generator whose cell count can drift silently makes "one row per
 * constructible cell" unverifiable: the table would still be full, just of
 * fewer things than it claims.
 */
describe('verdict-diff case generator', () => {
  const cells = enumerateVerdictDiffCellsV1();

  // The raw twelve-axis cross-product is ~1.3M. The axes are not independent,
  // and the dependency rules come from the spec's own axis definitions, so the
  // reachable space is far smaller. Pinning the number is what makes a later
  // "the sweep covered every cell" claim checkable rather than rhetorical.
  // 100,224 = 3,456 (absent) + 96,768 (present).
  //   absent : C(2) x G(2) x H(3) x I(3) x J(16) x K(2) x L(3) = 3,456
  //   present: B(4) x [that same 1,728] x [D,E,F = 7] = 96,768
  // The D/E/F factor is 7 rather than 4x3x2=24 because E and F apply only where
  // the spec defines them. Raw cross-product without dependencies is ~1.3M.
  //
  // THIS PIN MOVED, AND WHY -- it was 120,960 until axis D was found to be
  // dependent too. D relates the candidate to the CURRENT head, so it has no
  // referent when the snapshot is absent, exactly like axis B. That is measured,
  // not assumed: both evaluators branch on an absent current before any sequence
  // logic runs (core :111/:531/:678; storage next-state :1092 returns
  // rematerialize immediately). A relation with no referent is not a cell the
  // fixture can build, so those 20,736 combinations were never real cells.
  // The pin moves with the reason attached; it must never move silently.
  //
  // THIS IS THE REACHABLE COUNT, NOT THE CONSTRUCTIBLE ONE. Most of these cells
  // describe states no fixture can build, and each of those is a RESULT to be
  // recorded with its refusing site -- not a cell to run. Pinning the reachable
  // number first is what makes the later constructible/unconstructible split
  // add up to something checkable.
  it("pins the reachable cell count under the spec's axis dependencies", () => {
    expect(cells.length).toBe(100_224);
  });

  it('gives every cell a unique id', () => {
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length);
  });

  // Axis B applies only to a present snapshot. An absent snapshot has no applied
  // status at all, and recording `undefined` rather than a default is what stops
  // the table asserting coverage of a state the case never had.
  //
  // Asserted over a COLLECTED violation set rather than per cell. An `expect`
  // per cell is ~100k assertions for one property: it ran 2.2s idle and blew
  // the 5s timeout the moment the lane was loaded, which is a red that says
  // nothing about the generator. Collecting first also names the offending
  // cell instead of reporting `expected true to be false`.
  it('omits applied status exactly when the snapshot is absent', () => {
    const offenders = cells.filter(
      (c) => (c.appliedStatus === undefined) !== (c.snapshot === 'absent'),
    );
    expect(offenders.slice(0, 3)).toEqual([]);
    expect(offenders).toHaveLength(0);
  });

  // Axis E applies only at an equal sequence; axis F only when sequence AND
  // version are both equal. These are the spec's stated dependencies, pinned so
  // a later widening of the generator cannot quietly change what the table means.
  // Each dependency is collected separately so a failure names WHICH axis
  // widened, rather than reporting one anonymous boolean for all three.
  it('applies the sequence, version and head-digest axes only where defined', () => {
    const sequenceOffenders = cells.filter(
      (c) => (c.sequenceRelation === undefined) !== (c.snapshot === 'absent'),
    );
    const versionOffenders = cells.filter(
      (c) => (c.versionRelation === undefined) !== (c.sequenceRelation !== 'equal'),
    );
    const digestOffenders = cells.filter(
      (c) => (c.headDigest === undefined)
        !== !(c.sequenceRelation === 'equal' && c.versionRelation === 'equal'),
    );
    expect(sequenceOffenders.slice(0, 3)).toEqual([]);
    expect(versionOffenders.slice(0, 3)).toEqual([]);
    expect(digestOffenders.slice(0, 3)).toEqual([]);
    expect([sequenceOffenders.length, versionOffenders.length, digestOffenders.length])
      .toEqual([0, 0, 0]);
  });

  // Axis J is a presence subset, so all sixteen combinations of the four
  // optional evidence members must appear -- including the empty one, which is
  // the no-evidence case both evaluators have to handle.
  it('covers every evidence subset including the empty one', () => {
    const seen = new Set(cells.map((c) => [...c.evidence].sort().join('|')));
    expect(seen.size).toBe(16);
    expect(seen.has('')).toBe(true);
  });

  // Non-vacuity: every axis value the fixture declares must actually appear in
  // the generated space. Without this, dropping an axis value from the generator
  // would shrink coverage while every row above still passed.
  it('exercises every declared value of every independent axis', () => {
    expect(new Set(cells.map((c) => c.snapshot)).size).toBe(VERDICT_DIFF_AXES_V1.A_snapshot.length);
    expect(new Set(cells.map((c) => c.candidateHeadState)).size)
      .toBe(VERDICT_DIFF_AXES_V1.C_candidateHeadState.length);
    expect(new Set(cells.map((c) => c.acceptedTransitionDigest)).size)
      .toBe(VERDICT_DIFF_AXES_V1.G_acceptedTransitionDigest.length);
    expect(new Set(cells.map((c) => c.storageOperation)).size)
      .toBe(VERDICT_DIFF_AXES_V1.H_storageOperation.length);
    expect(new Set(cells.map((c) => c.coreDisposition)).size)
      .toBe(VERDICT_DIFF_AXES_V1.I_coreDisposition.length);
    expect(new Set(cells.map((c) => c.candidateForkResolutionDigest)).size)
      .toBe(VERDICT_DIFF_AXES_V1.K_candidateForkResolutionDigest.length);
    expect(new Set(cells.map((c) => c.clock)).size).toBe(VERDICT_DIFF_AXES_V1.L_clock.length);
    // Dependent axes: every declared value appears somewhere it is defined.
    expect(new Set(cells.filter((c) => c.appliedStatus).map((c) => c.appliedStatus)).size)
      .toBe(VERDICT_DIFF_AXES_V1.B_appliedStatus.length);
    expect(new Set(cells.filter((c) => c.sequenceRelation).map((c) => c.sequenceRelation)).size)
      .toBe(VERDICT_DIFF_AXES_V1.D_sequenceRelation.length);
    expect(new Set(cells.filter((c) => c.versionRelation).map((c) => c.versionRelation)).size)
      .toBe(VERDICT_DIFF_AXES_V1.E_versionRelation.length);
    expect(new Set(cells.filter((c) => c.headDigest).map((c) => c.headDigest)).size)
      .toBe(VERDICT_DIFF_AXES_V1.F_headDigest.length);
  });
});
