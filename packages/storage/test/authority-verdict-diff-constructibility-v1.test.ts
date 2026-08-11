import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import {
  CONSTRUCTIBILITY_RULES_V1,
  readCitedSourceLineV1,
  resolveConstructibilityV1,
} from './helpers/authority-verdict-diff-constructibility-v1.js';

/**
 * The constructibility split, and the conservation law that keeps the static
 * shortcuts honest.
 *
 * Static resolution is the lever that makes this sweep runnable at all -- the
 * reachable space is 120,960 and most of it describes states no fixture can
 * build. The danger is that the same lever can quietly delete cells: a rule
 * that matches too broadly shrinks the run set while every other assertion
 * still passes.
 *
 * Two things stop that. The sum must equal the pinned total, so nothing can be
 * dropped without the arithmetic failing; and every rule must name the site
 * that refuses the state, so a retirement is a citation rather than an opinion.
 */
describe('verdict-diff constructibility split', () => {
  const cells = enumerateVerdictDiffCellsV1();
  const split = resolveConstructibilityV1(cells);

  // THE CONSERVATION LAW. If a rule starts matching more cells, this still
  // holds -- which is why the per-rule counts below matter too. Together they
  // localise a change rather than merely detecting one.
  it('conserves the pinned cell total across the split', () => {
    expect(split.total).toBe(100_224);
    expect(split.constructible.length + split.unconstructible.length).toBe(100_224);
  });

  // Collected rather than asserted per retired cell, for the same reason as the
  // generator's dependency pins: 25k assertions for one property is a timeout
  // risk that reports nothing about the rules.
  it('attributes every retired cell to exactly one rule that exists', () => {
    const ids = new Set(CONSTRUCTIBILITY_RULES_V1.map((r) => r.id));
    const unattributed = split.unconstructible.filter(({ ruleId }) => !ids.has(ruleId));
    expect(unattributed.slice(0, 3)).toEqual([]);
    expect(unattributed).toHaveLength(0);
    const summed = Object.values(split.byRule).reduce((a, b) => a + b, 0);
    expect(summed).toBe(split.unconstructible.length);
  });

  // R1 retires a clean quarter: candidate head state and the candidate's
  // fork-resolution digest are both independent of every other axis, so
  // 1/2 x 1/2 of 100,224 = 25,056. Pinning the number is what would catch the
  // rule silently widening -- a predicate typo that dropped one conjunct would
  // retire half the space and every other row here would still pass.
  it('retires exactly the tombstone-with-fork-resolution quarter', () => {
    expect(split.byRule['R1-tombstone-carries-fork-resolution']).toBe(25_056);
    expect(split.constructible.length).toBe(75_168);
  });

  // A retirement is a citation, not an opinion: the failure string each rule
  // claims must actually be present at the LINE it names. The weaker
  // file-contains form is what let R1's site sit one line past its own
  // `fail(...)` call -- a citation nobody could follow, passing a test whose
  // whole job was to make citations followable.
  it('verifies every rule quotes a failure string that exists at its cited line', () => {
    for (const rule of CONSTRUCTIBILITY_RULES_V1) {
      expect(readCitedSourceLineV1(rule.site, new URL('../../../', import.meta.url)))
        .toContain(rule.failure);
    }
  });

  // Non-vacuity: a rule that matches nothing is dead weight that makes the
  // table look more resolved than it is, and a rule matching everything would
  // empty the run set. Both are caught here rather than at review time.
  it('keeps every rule live and non-total', () => {
    for (const rule of CONSTRUCTIBILITY_RULES_V1) {
      const n = split.byRule[rule.id] ?? 0;
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(split.total);
    }
  });
});
