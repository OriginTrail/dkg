import { evaluateAgentProfileHeadAdvanceV1 } from '@origintrail-official/dkg-core/system-record-v1';

import {
  coreInputProjectionKeyV1,
  type VerdictDiffCellV1,
} from './authority-verdict-diff-cells-v1.js';
import {
  buildCoreAcceptedStateV1,
  buildCoreEvidenceV1,
  buildCoreSummaryIndexV1,
  type CoreSummaryIndexV1,
} from './authority-verdict-diff-core-evidence-v1.js';
import { buildCoreCandidateHeadV1 } from './authority-verdict-diff-core-heads-v1.js';

/**
 * THE CORE HALF OF THE SWEEP.
 *
 * Driven per PROJECTION, never per cell. Cells sharing `coreInputProjectionKeyV1`
 * present byte-identical inputs to core, so one evaluation serves all of them --
 * which is what turns 145,728 cells into 25,920 evaluations. The projection
 * counts are pinned separately, so a projection key that stopped discriminating
 * would surface as a red pin rather than as silently merged cells.
 *
 * Every evaluation goes through the EXPORTED entry
 * `evaluateAgentProfileHeadAdvanceV1`. That is the settled instrument: it is the
 * contract that survives Phase 3 routing, and reaching past it would measure a
 * component Phase 3 may delete.
 */

export type CoreProjectionOutcomeV1 =
  | { readonly kind: 'decision'; readonly decision: string; readonly reason?: string }
  | { readonly kind: 'refused'; readonly ruleId: string; readonly message: string }
  | { readonly kind: 'threw'; readonly message: string };

export interface CoreProjectionRowV1 {
  readonly projectionKey: string;
  readonly cellCount: number;
  readonly outcome: CoreProjectionOutcomeV1;
}

export async function runCoreSweepV1(
  cells: readonly VerdictDiffCellV1[],
): Promise<readonly CoreProjectionRowV1[]> {
  const { summaries } = await buildCoreSummaryIndexV1(cells);
  const groups = new Map<string, { representative: VerdictDiffCellV1; count: number }>();
  for (const cell of cells) {
    const key = coreInputProjectionKeyV1(cell);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { representative: cell, count: 1 });
    else existing.count += 1;
  }

  const rows: CoreProjectionRowV1[] = [];
  for (const [projectionKey, group] of groups) {
    rows.push({
      projectionKey,
      cellCount: group.count,
      outcome: evaluateProjectionV1(group.representative, summaries),
    });
  }
  return rows;
}

function evaluateProjectionV1(
  cell: VerdictDiffCellV1,
  summaries: CoreSummaryIndexV1['summaries'],
): CoreProjectionOutcomeV1 {
  const head = buildCoreCandidateHeadV1(cell);
  if (!head.built) return { kind: 'refused', ruleId: head.ruleId, message: head.message };
  // NO EVIDENCE REFUSAL ARM. Axis J is total: every member is data the fixture
  // holds, and an unmintable summary is OMITTED rather than refused. An arm here
  // would be a branch nothing can reach -- the shape of a check that cannot
  // fail, in the file whose job is to refuse those.
  try {
    const decision = evaluateAgentProfileHeadAdvanceV1(
      buildCoreAcceptedStateV1(cell) as never,
      head.candidate,
      buildCoreEvidenceV1(cell, summaries) as never,
    ) as { decision: string; reason?: string };
    return decision.reason === undefined
      ? { kind: 'decision', decision: decision.decision }
      : { kind: 'decision', decision: decision.decision, reason: decision.reason };
  } catch (error) {
    // A THROW IS NOT A VERDICT. The evaluator's contract is to return a
    // decision; anything that escapes it is recorded as its own outcome kind so
    // it can never be read as one of core's four decision values.
    return { kind: 'threw', message: String((error as { message?: string }).message) };
  }
}
