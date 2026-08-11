import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import {
  CONSTRUCTIBILITY_RULES_V1,
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

  it('attributes every retired cell to exactly one rule that exists', () => {
    const ids = new Set(CONSTRUCTIBILITY_RULES_V1.map((r) => r.id));
    for (const { ruleId } of split.unconstructible) expect(ids.has(ruleId)).toBe(true);
    const summed = Object.values(split.byRule).reduce((a, b) => a + b, 0);
    expect(summed).toBe(split.unconstructible.length);
  });

  // R1 retires a clean quarter: candidate head state and the candidate's
  // fork-resolution digest are both independent of every other axis, so
  // 1/2 x 1/2 of 120,960 = 30,240. Pinning the number is what would catch the
  // rule silently widening -- a predicate typo that dropped one conjunct would
  // retire half the space and every other row here would still pass.
  it('retires exactly the tombstone-with-fork-resolution quarter', () => {
    expect(split.byRule['R1-tombstone-carries-fork-resolution']).toBe(25_056);
    expect(split.constructible.length).toBe(75_168);
  });

  // A retirement is a citation, not an opinion: the failure string each rule
  // claims must actually be present at the file it names. Without this a rule
  // could cite a site that never refuses anything and the split would look
  // just as principled.
  it('verifies every rule quotes a failure string that exists at its site', () => {
    for (const rule of CONSTRUCTIBILITY_RULES_V1) {
      const [path] = rule.site.split(':');
      const source = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
      expect(source).toContain(rule.failure);
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
