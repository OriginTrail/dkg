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
  // 120,960 = 5 status branches (1 absent + 4 present) x 24,192 per branch,
  // where 24,192 = C(2) x [D,E,F = 7] x G(2) x H(3) x I(3) x J(16) x K(2) x L(3).
  // The D/E/F factor is 7 rather than 4x3x2=24 because E and F only apply where
  // the spec defines them. Raw cross-product without the dependencies is ~1.3M.
  //
  // THIS IS THE REACHABLE COUNT, NOT THE CONSTRUCTIBLE ONE. Most of these cells
  // describe states no fixture can build, and each of those is a RESULT to be
  // recorded with its refusing site -- not a cell to run. Pinning the reachable
  // number first is what makes the later constructible/unconstructible split
  // add up to something checkable.
  it("pins the reachable cell count under the spec's axis dependencies", () => {
    expect(cells.length).toBe(120_960);
  });

  it('gives every cell a unique id', () => {
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length);
  });

  // Axis B applies only to a present snapshot. An absent snapshot has no applied
  // status at all, and recording `undefined` rather than a default is what stops
  // the table asserting coverage of a state the case never had.
  it('omits applied status exactly when the snapshot is absent', () => {
    for (const c of cells) {
      expect(c.appliedStatus === undefined).toBe(c.snapshot === 'absent');
    }
  });

  // Axis E applies only at an equal sequence; axis F only when sequence AND
  // version are both equal. These are the spec's stated dependencies, pinned so
  // a later widening of the generator cannot quietly change what the table means.
  it('applies the version and head-digest axes only where they are defined', () => {
    for (const c of cells) {
      expect(c.versionRelation === undefined).toBe(c.sequenceRelation !== 'equal');
      const digestApplies = c.sequenceRelation === 'equal' && c.versionRelation === 'equal';
      expect(c.headDigest === undefined).toBe(!digestApplies);
    }
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
    expect(new Set(cells.map((c) => c.sequenceRelation)).size)
      .toBe(VERDICT_DIFF_AXES_V1.D_sequenceRelation.length);
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
    expect(new Set(cells.filter((c) => c.versionRelation).map((c) => c.versionRelation)).size)
      .toBe(VERDICT_DIFF_AXES_V1.E_versionRelation.length);
    expect(new Set(cells.filter((c) => c.headDigest).map((c) => c.headDigest)).size)
      .toBe(VERDICT_DIFF_AXES_V1.F_headDigest.length);
  });
});
