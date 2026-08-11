import type { VerdictDiffCellV1 } from './authority-verdict-diff-cells-v1.js';

/**
 * Static constructibility resolution for the verdict-diff cell space.
 *
 * A cell is UNCONSTRUCTIBLE when no fixture can build its inputs -- distinct
 * from a cell whose inputs build fine and whose evaluator returns a refusal.
 * The second is a verdict and belongs in the table; only the first is retired
 * here.
 *
 * THE STRUCTURE IS THE POINT. Every rule carries the site that refuses the
 * state and the exact failure string that site emits. A statically-resolved
 * cell without a named refusal would make this a silent drop channel: the sweep
 * would shrink and the coverage claim would still read as complete. The rule
 * shape makes that impossible to express -- there is nowhere to put a cell
 * without also saying what refuses it.
 *
 * Rules are added only once their refusal has been READ AT THE SITE. A rule
 * derived from reasoning about what "should" be refused is the
 * specify-without-measuring trap wearing a resolver's clothes.
 */
export interface ConstructibilityRuleV1 {
  /** Stable id so a cell's retirement can be traced to one rule. */
  readonly id: string;
  /** file:line of the refusal, so the claim is checkable. */
  readonly site: string;
  /** The exact string that site emits, quoted from source. */
  readonly failure: string;
  /** Why this axis combination reaches that refusal. */
  readonly because: string;
  readonly refuses: (cell: VerdictDiffCellV1) => boolean;
}

export const CONSTRUCTIBILITY_RULES_V1: readonly ConstructibilityRuleV1[] = [
  {
    id: 'R1-tombstone-carries-fork-resolution',
    site: 'packages/core/src/system-record-agent-profile-head-codec-v1-internal.ts:273',
    failure: 'V1 has no direct terminal fork-resolution tombstone',
    because:
      'The head codec\'s tombstone branch refuses any head carrying '
      + 'forkResolutionDigest, so a tombstone candidate with that key present '
      + 'cannot be built at all -- neither evaluator ever sees the input.',
    refuses: (cell) =>
      cell.candidateHeadState === 'tombstone'
      && cell.candidateForkResolutionDigest === 'present',
  },
];

export interface ConstructibilitySplitV1 {
  readonly total: number;
  readonly constructible: readonly VerdictDiffCellV1[];
  /** Every retired cell paired with the rule that retired it. */
  readonly unconstructible: readonly {
    readonly cell: VerdictDiffCellV1;
    readonly ruleId: string;
  }[];
  /** Retirement counts per rule, so an over-matching rule is visible. */
  readonly byRule: Readonly<Record<string, number>>;
}

export function resolveConstructibilityV1(
  cells: readonly VerdictDiffCellV1[],
): ConstructibilitySplitV1 {
  const constructible: VerdictDiffCellV1[] = [];
  const unconstructible: { cell: VerdictDiffCellV1; ruleId: string }[] = [];
  const byRule: Record<string, number> = Object.fromEntries(
    CONSTRUCTIBILITY_RULES_V1.map((r) => [r.id, 0]),
  );

  for (const cell of cells) {
    // First matching rule owns the retirement, so a cell is never counted twice
    // and `byRule` sums exactly to the unconstructible total.
    const rule = CONSTRUCTIBILITY_RULES_V1.find((r) => r.refuses(cell));
    if (rule === undefined) {
      constructible.push(cell);
    } else {
      unconstructible.push({ cell, ruleId: rule.id });
      byRule[rule.id] = (byRule[rule.id] ?? 0) + 1;
    }
  }

  return { total: cells.length, constructible, unconstructible, byRule };
}
