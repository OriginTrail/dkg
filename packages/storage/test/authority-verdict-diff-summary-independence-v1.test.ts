import { describe, expect, it } from 'vitest';

import { evaluateAgentProfileHeadAdvanceV1 } from '@origintrail-official/dkg-core/system-record-v1';

import {
  coreInputProjectionKeyV1,
  enumerateVerdictDiffCellsV1,
  type VerdictDiffCellV1,
} from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  buildCoreAcceptedStateV1,
  buildCoreEvidenceV1,
  buildCoreSummaryIndexV1,
  type CoreSummaryMintV1,
  type CoreSummaryRefusalV1,
} from './helpers/authority-verdict-diff-core-evidence-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  CORE_SUMMARY_INDEPENDENCE_V1,
} from './helpers/authority-verdict-diff-core-table-v1.js';

/**
 * THE MEASUREMENT THAT LICENSES THE RE-PIN, RE-RUN RATHER THAN QUOTED.
 *
 * The table used to retire 61,920 cells -- 38% of the space -- for naming
 * `verifiedAuthoritySummary` on a head shape whose closure would not mint one.
 * That rule was wrong: a summary is a factory-only capability, so a caller
 * holding such a head has exactly ONE evidence object it can assemble, the one
 * without that member. Those cells are now driven with the member OMITTED.
 *
 * THE CLAIM THAT MAKES THE OMISSION HONEST IS AN EQUALITY, AND IT IS EXHAUSTIVE
 * OVER THE AFFECTED SET. Every one of the 9,792 affected projections is driven
 * twice here: once with a summary minted for a DIFFERENT head, once with the
 * member absent. If any present-state branch read the field, a foreign summary
 * would be a different input and some verdict would move.
 *
 * WHY THIS EXISTS AS A TEST RATHER THAN AS A GREP. Core copies the field into its
 * evidence snapshot through an allowlist at
 * system-record-authority-v1-internal.ts:929, so it travels INSIDE an object. A
 * branch reading it off the whole snapshot, or by dynamic access, would never
 * appear in a grep for the symbol -- the symbol is absent from the branch and the
 * read still happens. Only running the branches closes that gap.
 *
 * WHY THE CONTROLS ARE NOT OPTIONAL. An instrument that compared nothing would
 * report the same flawless equality, so a perfect result is uninformative on its
 * own. The absent-path control is the one that fails if the instrument is blind:
 * core DOES read the field there, and 128 of 576 cells move when it is taken
 * away. The present-path control closes the other direction -- 10,368 cells that
 * hold a VALID summary of their own are inert when it is removed -- so the
 * present region's indifference is not an artefact of the substitute being
 * foreign rather than of the field being unread.
 *
 * EVERYTHING IS ASSERTED IN ONE COMPARISON. Collected and compared once, so a
 * control cannot be dropped, weakened or silently skipped without turning this
 * red -- and so a failure reports every number side by side instead of failing on
 * an anonymous row inside a 20,000-iteration loop.
 */
const SUITE_TIMEOUT_MS = 600_000;

type MintV1 = CoreSummaryMintV1 | CoreSummaryRefusalV1;

/**
 * One projection's verdict, rendered as the same label the table keys on.
 *
 * Driven through the EXPORTED entry, like every other measurement in this
 * harness: reaching past it would measure a component Phase 3 may delete. A
 * throw is recorded as its own label rather than swallowed, because "the two
 * arms agreed" must not be satisfiable by two identical crashes.
 */
function verdictOfV1(cell: VerdictDiffCellV1, summaries: ReadonlyMap<string, MintV1>): string {
  const head = buildCoreCandidateHeadV1(cell);
  if (!head.built) return `REFUSED|${head.ruleId}`;
  try {
    const decision = evaluateAgentProfileHeadAdvanceV1(
      buildCoreAcceptedStateV1(cell) as never,
      head.candidate,
      buildCoreEvidenceV1(cell, summaries) as never,
    ) as { decision: string; reason?: string };
    return decision.reason === undefined
      ? decision.decision
      : `${decision.decision}|${decision.reason}`;
  } catch (error) {
    return `THREW|${String((error as { message?: string }).message)}`;
  }
}

describe('verdict-diff: verified-authority-summary independence', { timeout: SUITE_TIMEOUT_MS }, () => {
  it('re-runs the equality that licenses omitting an unmintable summary, with both controls', async () => {
    const cells = resolveConstructibilityV1(enumerateVerdictDiffCellsV1()).constructible;
    const { summaries } = await buildCoreSummaryIndexV1(cells);

    const groups = new Map<string, { representative: VerdictDiffCellV1; count: number }>();
    for (const cell of cells) {
      const key = coreInputProjectionKeyV1(cell);
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, { representative: cell, count: 1 });
      else existing.count += 1;
    }

    // THE SUBSTITUTE IS A REAL MINTED SUMMARY FOR ANOTHER HEAD, not a fabricated
    // object: the type is WeakSet-branded and a forgery would be refused by the
    // brand check rather than by any branch, which would make the equality hold
    // for the wrong reason. Chosen in sorted shape order so the run is
    // reproducible; WHICH minted summary it is cannot matter, and the equality
    // below is what says so rather than an assumption stated here.
    const foreign = [...summaries.entries()]
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .find(([, mint]) => mint.minted)?.[1] as CoreSummaryMintV1 | undefined;
    expect(foreign?.minted).toBe(true);

    const measured = {
      affectedProjections: 0,
      affectedCells: 0,
      affectedCellsAbsentPath: 0,
      affectedCellsPresentPath: 0,
      equalityHeld: 0,
      equalityDiffered: 0,
      equalityThrew: 0,
      absentControlCells: 0,
      absentControlDiffered: 0,
      presentControlCells: 0,
      presentControlDiffered: 0,
      clockShortCircuitCells: 0,
      summaryCarryingProjections: 0,
      summaryCarryingCells: 0,
    };
    const divergences: string[] = [];

    for (const { representative: cell, count } of groups.values()) {
      if (!buildCoreCandidateHeadV1(cell).built) continue;
      if (!cell.evidence.includes('verifiedAuthoritySummary')) continue;
      const shape = coreHeadShapeKeyV1(cell);
      const mint = summaries.get(shape);

      if (mint !== undefined && mint.minted) {
        // THE CONTROLS. These cells hold a summary of their OWN, so removing it
        // is the sharpest available probe of whether the field is read at all.
        measured.summaryCarryingProjections += 1;
        measured.summaryCarryingCells += count;
        const withOwn = verdictOfV1(cell, summaries);
        const without = verdictOfV1(cell, new Map());
        if (cell.snapshot === 'absent') {
          measured.absentControlCells += count;
          if (withOwn !== without) measured.absentControlDiffered += count;
        } else {
          measured.presentControlCells += count;
          if (withOwn !== without) measured.presentControlDiffered += count;
        }
        continue;
      }

      // THE AFFECTED SET: exactly what rule S1 used to retire.
      measured.affectedProjections += 1;
      measured.affectedCells += count;
      if (cell.snapshot === 'absent') measured.affectedCellsAbsentPath += count;
      else measured.affectedCellsPresentPath += count;
      if (cell.clock === 'beyondFutureSkew') measured.clockShortCircuitCells += count;

      const omitted = verdictOfV1(cell, summaries);
      const substituted = verdictOfV1(cell, new Map<string, MintV1>([[shape, foreign as MintV1]]));
      if (omitted.startsWith('THREW') || substituted.startsWith('THREW')) {
        measured.equalityThrew += 1;
      }
      if (omitted === substituted) measured.equalityHeld += 1;
      else {
        measured.equalityDiffered += 1;
        if (divergences.length < 5) {
          divergences.push(`${cell.id} omitted=${omitted} foreign=${substituted}`);
        }
      }
    }

    // Named separately so a divergence reports WHICH cell moved rather than only
    // that a counter did.
    expect(divergences).toStrictEqual([]);
    expect(measured).toStrictEqual({ ...CORE_SUMMARY_INDEPENDENCE_V1 });
  });
});
