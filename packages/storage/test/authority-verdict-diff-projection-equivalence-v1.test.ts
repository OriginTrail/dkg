import { describe, expect, it } from 'vitest';

import {
  coreInputProjectionKeyV1,
  enumerateVerdictDiffCellsV1,
  storageInputProjectionKeyV1,
  type VerdictDiffCellV1,
} from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  buildCoreAcceptedStateV1,
  buildCoreEvidenceV1,
} from './helpers/authority-verdict-diff-core-evidence-v1.js';

/**
 * THE PROJECTION KEYS ARE LOAD-BEARING, SO THEY ARE PROVEN RATHER THAN ASSERTED.
 *
 * The sweeps run ONE representative per projection and attribute its verdict to
 * every cell in the group. That is sound only if the cells in a group really do
 * present byte-identical inputs -- which is a claim about the BUILDERS, not
 * about the key. Nothing previously checked it.
 *
 * The hazard is specific and quiet. Cells differing only in `storageOperation`
 * share a core projection key, and enumeration order makes the 'active'
 * operation the representative. If a core input builder ever started reading
 * `storageOperation`, the other operations would never be evaluated: the whole
 * group would inherit the representative's verdict, every count would still sum,
 * and the table would stay green while silently covering less than it claims.
 * That is the same species as a coverage claim that cannot fail.
 *
 * So this suite rebuilds the ACTUAL inputs for EVERY cell and compares them
 * within each group. It is the only check here that would catch a builder
 * reading an invisible axis, and it is deliberately exhaustive rather than
 * sampled: a sampled version would pass on exactly the builder that reads an
 * axis only in a rare branch.
 *
 * Collected then asserted ONCE, never asserted per cell. A ~164k-assertion loop
 * is what previously turned a correct suite into an intermittent timeout, and
 * the collected form also names the offending group instead of failing on an
 * anonymous row.
 *
 * THE STRONGEST EVIDENCE THIS SUITE CAN CITE IS NOT ITS OWN. Everything here
 * compares CONSTRUCTED INPUTS, which is a claim about the builders. The equality
 * pinned as CORE_SUMMARY_INDEPENDENCE_V1 compares the evaluator's OUTPUT over
 * 9,792 projections with the summary member present and absent, and got identity
 * with two live discrimination controls. Input equality implies output equality;
 * the converse does not hold, so that result is the harder half of the same claim
 * and is re-run by authority-verdict-diff-summary-independence-v1.test.ts.
 */
const VERDICT_DIFF_SUITE_TIMEOUT_MS = 600_000;

/**
 * A cell's core input, rendered comparable.
 *
 * The verified authority summary is a WeakSet-branded factory object: it has no
 * meaningful serialisation and must not be compared structurally. It is
 * memoised per HEAD SHAPE, so two cells receive the very same object exactly
 * when their shape keys agree -- which is what the marker records.
 *
 * THE MARKER IS INERT WITHIN A GROUP, NOT STRICTER, AND CALLING IT STRICTER WAS
 * WRONG. Every axis feeding `coreHeadShapeKeyV1` is also inside the core
 * projection key, so within one group the marker is CONSTANT: it contributes the
 * same string to every cell compared and can never be why two fingerprints
 * differ. A term that cannot vary inside the comparison is not a strict
 * comparison, it is no comparison.
 *
 * WHAT COVERS THE SUMMARY IS CONSTRUCTION, NOT THIS TEST, and it is recorded as
 * the argument it is. The sweep's summary index is keyed by
 * `coreHeadShapeKeyV1(cell)` (authority-verdict-diff-core-evidence-v1.ts:316),
 * so cells sharing a projection key share a shape key and receive the SAME map
 * entry -- the identical minted object, or identically none. The OUTPUT-side
 * half is pinned separately and is the harder one: CORE_SUMMARY_INDEPENDENCE_V1
 * drives 9,792 projections with the member present and absent and gets identity,
 * with two live discrimination controls.
 */
function coreInputFingerprintV1(cell: VerdictDiffCellV1): string {
  const head = buildCoreCandidateHeadV1(cell);
  const headPart = head.built
    ? `head:${head.digest}:${JSON.stringify(head.candidate)}`
    : `head-refused:${head.ruleId}`;

  const accepted = JSON.stringify(buildCoreAcceptedStateV1(cell));

  // Evidence is built against an EMPTY summary index on purpose: the summary is
  // the one member that cannot be compared by value, and its identity is fully
  // determined by the head shape recorded below. Everything else is plain data
  // and is compared exactly.
  const evidencePart = `evidence:${JSON.stringify(buildCoreEvidenceV1(cell, new Map()))}`;

  const wantsSummary = cell.evidence.includes('verifiedAuthoritySummary');
  const summaryPart = `summary:${wantsSummary ? coreHeadShapeKeyV1(cell) : 'absent'}`;

  return [headPart, accepted, evidencePart, summaryPart].join(' ');
}

/**
 * The storage-visible construction inputs.
 *
 * Storage's facts are issued FROM the candidate head, so the head is what a
 * storage projection has to hold identical. The applied status and the storage
 * operation select which snapshot and which issue route are used, and both are
 * inside storage's key, so they are recorded rather than compared away.
 */
function storageInputFingerprintV1(cell: VerdictDiffCellV1): string {
  const head = buildCoreCandidateHeadV1(cell);
  const headPart = head.built
    ? `head:${head.digest}:${JSON.stringify(head.candidate)}`
    : `head-refused:${head.ruleId}`;
  return [
    headPart,
    `snapshot:${cell.snapshot}`,
    `applied:${cell.appliedStatus ?? '-'}`,
    `operation:${cell.storageOperation}`,
  ].join(' ');
}

function groupsWithMixedInputs(
  cells: readonly VerdictDiffCellV1[],
  key: (cell: VerdictDiffCellV1) => string,
  fingerprint: (cell: VerdictDiffCellV1) => string,
): readonly string[] {
  const seen = new Map<string, { readonly f: string; readonly id: string }>();
  const mixed = new Set<string>();
  for (const cell of cells) {
    const k = key(cell);
    const f = fingerprint(cell);
    const first = seen.get(k);
    if (first === undefined) seen.set(k, { f, id: cell.id });
    // Name the CELLS, not only their group: a projection key is not searchable
    // in the fixture the way a cell id is, and the group alone does not say
    // which two members disagreed.
    else if (first.f !== f) mixed.add(`${k} [${first.id} vs ${cell.id}]`);
  }
  return [...mixed].sort();
}

describe('verdict-diff projection equivalence', { timeout: VERDICT_DIFF_SUITE_TIMEOUT_MS }, () => {
  const cells = resolveConstructibilityV1(enumerateVerdictDiffCellsV1()).constructible;

  // THE FLOOR THIS SUITE WAS MISSING, AND ITS ABSENCE WAS THE SAME DEFECT THE
  // SUITE EXISTS TO DETECT. `groupsWithMixedInputs` reports only groups whose
  // members DISAGREE, so a fingerprint returning one fixed string yields no
  // disagreements anywhere and every row below passes. Every assertion in this
  // file was green against a check that could not fail.
  //
  // THE CORE BOUND IS THE EQUIVALENCE CLAIM IN ITS POSITIVE FORM: one distinct
  // core input per core projection. It is asserted over cells whose head BUILT,
  // and the restriction is measured rather than convenient -- a REFUSED build
  // renders as `head-refused:${ruleId}`, a string carrying none of the cell's
  // axes, so refused projections collapse onto one another by rule id. Measured:
  // 23,040 built projections against 23,040 distinct built inputs (exact), and
  // 2,880 refused projections against 2,304 distinct refused fingerprints. The
  // 576 difference is entirely the refused collapse, and it is CONSERVATIVE --
  // distinct projections presenting identical inputs costs redundant evaluation
  // and never merges cells that differ.
  //
  // THE STORAGE BOUND IS A LOWER BOUND WITH A ONE-LINE PROOF: the fingerprint
  // concatenates snapshot, applied status and operation verbatim, so it must
  // distinguish at least as many values as there are distinct triples of them.
  // An exact storage bijection does NOT hold and is not asserted -- the clock
  // sits in the storage projection key but reaches no storage input, and the
  // refused collapse applies here too (855 keys, 273 distinct fingerprints).
  it('discriminates, so the equalities below are not vacuous', () => {
    const built = cells.filter((cell) => buildCoreCandidateHeadV1(cell).built);
    expect(built.length).toBeGreaterThan(0);
    expect(new Set(built.map(coreInputFingerprintV1)).size)
      .toBe(new Set(built.map(coreInputProjectionKeyV1)).size);

    const triples = new Set(cells.map(
      (cell) => `${cell.snapshot}|${cell.appliedStatus ?? '-'}|${cell.storageOperation}`,
    ));
    expect(triples.size).toBeGreaterThan(1);
    expect(new Set(cells.map(storageInputFingerprintV1)).size)
      .toBeGreaterThanOrEqual(triples.size);
  });

  // THE CHECK THE SWEEPS REST ON. Every cell sharing a core projection key must
  // produce the same accepted state, the same candidate head and the same
  // evidence -- otherwise one representative's verdict is being attributed to
  // inputs that were never evaluated.
  it('gives every cell in a core projection byte-identical core inputs', () => {
    expect(groupsWithMixedInputs(cells, coreInputProjectionKeyV1, coreInputFingerprintV1))
      .toEqual([]);
  });

  it('gives every cell in a storage projection byte-identical storage inputs', () => {
    expect(groupsWithMixedInputs(cells, storageInputProjectionKeyV1, storageInputFingerprintV1))
      .toEqual([]);
  });

  /**
   * THE INVISIBLE AXES, PROVEN INVISIBLE RATHER THAN DECLARED SO.
   *
   * The lists in the cells helper are a claim about what each side's builders
   * read. Holding an axis fixed and varying ONLY it must leave the built input
   * unchanged -- and if some future builder starts reading it, this goes red at
   * the axis that moved rather than somewhere downstream.
   */
  it('builds identical core inputs when only a core-invisible axis moves', () => {
    const withoutInvisible = (cell: VerdictDiffCellV1) => [
      cell.snapshot, cell.candidateHeadState, cell.sequenceRelation ?? '-',
      cell.versionRelation ?? '-', cell.headDigest ?? '-',
      cell.acceptedTransitionDigest ?? '-', cell.coreDisposition,
      [...cell.evidence].sort().join('+'), cell.candidateForkResolutionDigest, cell.clock,
    ].join('|');
    expect(groupsWithMixedInputs(cells, withoutInvisible, coreInputFingerprintV1)).toEqual([]);
  });

  /**
   * AXIS L IS INVISIBLE TO STORAGE, AND THE COMMITTED KEY DOES NOT SAY SO.
   *
   * `STORAGE_INVISIBLE_AXES_V1` names only I and J, so the clock is inside
   * storage's projection key. But axis L reaches exactly one place -- the
   * `nowMs` of core's EVIDENCE -- and storage's entry takes no clock argument at
   * all: `issuedAt`, `nowMs`, `clockSkew` and `futureSkew` do not occur anywhere
   * in packages/storage/src.
   *
   * That is not a defect in the key. Its contract is only that cells SHARING a
   * key present identical inputs, which over-discrimination cannot violate, and
   * running 855 projections where 285 would do costs nothing worth having. It is
   * recorded as a MEASUREMENT instead, because the number is the finding: each
   * CLOCK-INDEPENDENT KEY-GROUP covers 576 cells, not 192, and the three clock
   * values are served by one byte-identical input. That is the sharpest available statement
   * of the clock divergence -- not merely that storage has no clock, but that
   * the same storage input answers for a candidate core refuses on skew and for
   * one it accepts.
   *
   * 576 IS CELLS PER KEY-GROUP, NEVER CELLS PER INPUT, AND THE DISTINCTION IS
   * MEASURABLE RATHER THAN PEDANTIC. The built inputs number 273, and 273 does
   * NOT divide 164,160 -- it leaves remainder 87, giving ~601.3 cells per input.
   * A non-integer is the proof that inputs are NOT uniformly sized: they collapse
   * further than the key-groups, across applied statuses and operations wherever
   * those agree. Any sentence of the form "N cells per storage input" derived
   * from a KEY count is describing the key, which is the same conflation that
   * once had this suite credited with measuring 285 built inputs it never
   * measured.
   */
  it('measures that the clock cannot reach a storage input', () => {
    const distinctKeys = new Set(cells.map(storageInputProjectionKeyV1));
    const distinctInputs = new Set(cells.map(storageInputFingerprintV1));
    const withoutClock = new Set(
      cells.map((cell) => `${storageInputProjectionKeyV1(cell)}`
        .split('|').slice(0, -1).join('|')),
    );
    expect(distinctKeys.size).toBe(855);
    expect(withoutClock.size).toBe(285);
    expect(distinctKeys.size).toBe(withoutClock.size * 3);
    // THE EMPIRICAL INPUT-COLLAPSE FIGURE, PINNED RATHER THAN BOUNDED. The old
    // one-sided bound is satisfied by any degenerate fingerprint -- 1 < 855 --
    // so it could not distinguish a real collapse from a broken instrument, and
    // it is the number the artifact spent four sentences claiming to have.
    // The built inputs collapse further than either key because the head is
    // shared across applied statuses and operations wherever those agree.
    expect(distinctInputs.size).toBe(273);
    expect(distinctInputs.size).toBeLessThan(withoutClock.size);
  });
});
