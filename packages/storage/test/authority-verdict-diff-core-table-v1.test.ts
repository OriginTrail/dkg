import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  CORE_BUILDABLE_HEAD_SHAPES_V1,
  CORE_DECIDED_CELLS_V1,
  CORE_POST_RESOLVER_RETIRED_CELLS_V1,
  CORE_PROJECTIONS_V1,
  CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1,
  CORE_SUMMARY_MINT_OUTCOMES_V1,
  CORE_SWEEP_FINDINGS_V1,
  CORE_VERDICT_TABLE_DIGEST_V1,
  CORE_VERDICT_TABLE_V1,
  VERDICT_DIFF_COUNTERFACTUALS_V1,
} from './helpers/authority-verdict-diff-core-table-v1.js';
import { buildCoreSummaryIndexV1 } from './helpers/authority-verdict-diff-core-evidence-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';
import {
  runCoreSweepV1,
  type CoreProjectionRowV1,
} from './helpers/authority-verdict-diff-core-sweep-v1.js';
import {
  CORE_DELEGATED_REJECT_REASON_SITES_V1,
  CORE_QUARANTINE_REASONS_V1,
  CORE_REJECT_REASON_SITES_V1,
} from './helpers/authority-verdict-diff-fixture-v1.js';

/**
 * The core half of the verdict table, pinned.
 *
 * The suite walks ~394k cells and evaluates ~26k projections, so it carries an
 * explicit generous timeout: vitest's 5s default has already cost this lane a
 * run once, and a space-walking suite that times out says nothing about the
 * thing it was measuring.
 */
describe('authority verdict diff: core table', { timeout: 600_000 }, () => {
  function labelOf(row: CoreProjectionRowV1): string {
    const outcome = row.outcome;
    if (outcome.kind === 'decision') {
      return outcome.reason === undefined
        ? outcome.decision
        : `${outcome.decision}|${outcome.reason}`;
    }
    return outcome.kind === 'refused'
      ? `REFUSED|${outcome.ruleId}`
      : `THREW|${outcome.message}`;
  }

  async function sweep() {
    const split = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
    return { split, rows: await runCoreSweepV1(split.constructible) };
  }

  it('pins every projection verdict exactly, and the distribution that localises a move', async () => {
    const { split, rows } = await sweep();
    expect(split.constructible.length).toBe(CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1);
    expect(rows.length).toBe(CORE_PROJECTIONS_V1);

    // The digest DETECTS a change: two verdicts swapping between projections
    // with compensating counts leaves every distribution row untouched.
    const digest = createHash('sha256')
      .update(rows.map((row) => `${row.projectionKey}=>${labelOf(row)}`).sort().join('\n'))
      .digest('hex');
    expect(digest).toBe(CORE_VERDICT_TABLE_DIGEST_V1);

    // The distribution LOCALISES it: collected then asserted once, so a failure
    // names the offending verdict rather than reporting "expected true to be
    // false" from somewhere inside a 26,000-iteration loop.
    const observed: Record<string, { cells: number; projections: number }> = {};
    for (const row of rows) {
      const key = labelOf(row);
      const entry = observed[key] ?? { cells: 0, projections: 0 };
      entry.cells += row.cellCount;
      entry.projections += 1;
      observed[key] = entry;
    }
    expect(observed).toStrictEqual(CORE_VERDICT_TABLE_V1);
  });

  it('conserves: what the table decides plus what it retires is what it was given', async () => {
    const { rows } = await sweep();
    let decided = 0;
    let retired = 0;
    for (const row of rows) {
      if (row.outcome.kind === 'decision') decided += row.cellCount;
      else retired += row.cellCount;
    }
    expect(decided).toBe(CORE_DECIDED_CELLS_V1);
    expect(retired).toBe(CORE_POST_RESOLVER_RETIRED_CELLS_V1);
    // The sum is what makes per-cell coverage falsifiable: without it the table
    // stays full while covering fewer things than it claims.
    expect(decided + retired).toBe(CORE_RESOLVER_CONSTRUCTIBLE_CELLS_V1);
  });

  it('records no verdict core did not return, and no literal the harvest cannot place', async () => {
    const { rows } = await sweep();
    const placeable = new Set([
      ...Object.keys(CORE_REJECT_REASON_SITES_V1),
      ...Object.keys(CORE_DELEGATED_REJECT_REASON_SITES_V1),
    ]);
    const quarantineReasons = new Set(Object.keys(CORE_QUARANTINE_REASONS_V1));

    const unmappedLiterals: string[] = [];
    const escaped: string[] = [];
    const unknownQuarantine: string[] = [];
    for (const row of rows) {
      const outcome = row.outcome;
      // A THROW IS NOT A VERDICT. The evaluator's contract is to return a
      // decision, so anything escaping it is a finding, never a table row.
      if (outcome.kind === 'threw') escaped.push(`${row.projectionKey}: ${outcome.message}`);
      if (outcome.kind !== 'decision') continue;
      if (outcome.decision === 'reject' && !placeable.has(outcome.reason ?? '')) {
        unmappedLiterals.push(outcome.reason ?? '<none>');
      }
      if (outcome.decision === 'quarantine' && !quarantineReasons.has(outcome.reason ?? '')) {
        unknownQuarantine.push(outcome.reason ?? '<none>');
      }
    }
    expect(escaped).toStrictEqual([]);
    // An unmapped literal is a reject that was added or reworded; the map says
    // which case to look at, which is exactly why it is cheap to triage.
    expect([...new Set(unmappedLiterals)]).toStrictEqual([]);
    expect([...new Set(unknownQuarantine)]).toStrictEqual([]);
  });

  it('mints a summary for only the head shapes core will close over, each for a stated reason', async () => {
    const split = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
    const summaries = await buildCoreSummaryIndexV1(split.constructible);
    const buildable = new Set(
      split.constructible
        .filter((cell) => buildCoreCandidateHeadV1(cell).built)
        .map(coreHeadShapeKeyV1),
    );
    expect(buildable.size).toBe(CORE_BUILDABLE_HEAD_SHAPES_V1);

    // Digests are normalised out of the key: they are head-content dependent, so
    // pinning them would make this row a restatement of the fixture's hashes
    // rather than of which REFUSALS the closure builder issues.
    const counts: Record<string, number> = {};
    for (const shapeKey of buildable) {
      const mint = summaries.get(shapeKey);
      const key = mint === undefined
        ? 'ABSENT'
        : mint.minted
          ? 'MINTED'
          : mint.message.replace(/0x[0-9a-f]{64}/gu, '<digest>');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toStrictEqual(CORE_SUMMARY_MINT_OUTCOMES_V1);

    // NO REFUSAL MAY BE A MISSING ARTIFACT. A closure resolves every digest a
    // head names, so a fixture that omits one gets a refusal that reads exactly
    // like a domain refusal -- and pinning it would retire cells on this
    // harness's own omission. This is the guard that keeps that from returning.
    for (const [message, count] of Object.entries(counts)) {
      expect(
        { message, missingObject: message.includes('verification closure is missing') },
      ).toStrictEqual({ message, missingObject: false });
      expect(count).toBeGreaterThan(0);
    }
  });

  it('keeps counterfactuals out of the cells and anchored to their mutation', () => {
    expect(VERDICT_DIFF_COUNTERFACTUALS_V1.length).toBeGreaterThan(0);
    for (const entry of VERDICT_DIFF_COUNTERFACTUALS_V1) {
      // Anchored means a file:line, both texts, and a proof it was applied --
      // otherwise the recorded result and "the experiment never ran" are
      // indistinguishable from the notes.
      expect(entry.site).toMatch(/^packages\/[^:]+\.ts:\d+$/u);
      expect(entry.before).not.toBe(entry.after);
      expect(entry.appliedProof.length).toBeGreaterThan(0);
      expect(entry.actualVerdict.length).toBeGreaterThan(0);
    }
    // No counterfactual result may appear as a table verdict.
    const verdicts = new Set(Object.keys(CORE_VERDICT_TABLE_V1));
    for (const entry of VERDICT_DIFF_COUNTERFACTUALS_V1) {
      expect(verdicts.has(entry.result)).toBe(false);
    }
  });

  it('carries its findings as data rather than as a commit message', () => {
    expect(CORE_SWEEP_FINDINGS_V1.length).toBe(3);
    for (const finding of CORE_SWEEP_FINDINGS_V1) expect(finding.length).toBeGreaterThan(80);
  });
});
