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
 */
const VERDICT_DIFF_SUITE_TIMEOUT_MS = 600_000;

/**
 * A cell's core input, rendered comparable.
 *
 * The verified authority summary is a WeakSet-branded factory object: it has no
 * meaningful serialisation and must not be compared structurally. It is
 * memoised per HEAD SHAPE, so two cells receive the very same object exactly
 * when their shape keys agree -- which is what the marker records. Comparing the
 * marker is therefore stricter than comparing the object would be, not weaker.
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
  const evidence = buildCoreEvidenceV1(cell, new Map());
  const evidencePart = evidence.built
    ? `evidence:${JSON.stringify(evidence.evidence)}`
    : `evidence-refused:${evidence.ruleId}`;

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
  const seen = new Map<string, string>();
  const mixed = new Set<string>();
  for (const cell of cells) {
    const k = key(cell);
    const f = fingerprint(cell);
    const first = seen.get(k);
    if (first === undefined) seen.set(k, f);
    else if (first !== f) mixed.add(k);
  }
  return [...mixed].sort();
}

describe('verdict-diff projection equivalence', { timeout: VERDICT_DIFF_SUITE_TIMEOUT_MS }, () => {
  const cells = resolveConstructibilityV1(enumerateVerdictDiffCellsV1()).constructible;

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
   * recorded as a MEASUREMENT instead, because the number is the finding: a
   * storage input stands for 576 cells, not 192, and the three clock values are
   * served by one byte-identical input. That is the sharpest available statement
   * of the clock divergence -- not merely that storage has no clock, but that
   * the same storage input answers for a candidate core refuses on skew and for
   * one it accepts.
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
    // The built inputs themselves collapse further than either key: the head is
    // shared across applied statuses and operations wherever those agree.
    expect(distinctInputs.size).toBeLessThan(distinctKeys.size);
  });
});
