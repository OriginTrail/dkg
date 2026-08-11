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
 * reachable space is 98,496 and most of it describes states no fixture can
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
    expect(split.total).toBe(98_496);
    expect(split.constructible.length + split.unconstructible.length).toBe(98_496);
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

  // Per-rule counts, because the conservation sum above DETECTS a change while
  // these LOCALISE it. A predicate typo that dropped one conjunct would double
  // a rule's territory with every other row here still passing.
  //
  // Axes C (head state), H (storage operation) and K (fork resolution) are
  // independent of every other axis, so each (C,H,K) triple owns exactly
  // 98,496 / 12 = 8,208 cells. That is the unit every number below is built
  // from, and it is what makes them predictable rather than merely observed:
  //   R1  C=tombstone & K=present, all three operations   3 x 8,208 = 24,624
  //   R2  C=tombstone & H=active, K=absent remainder      1 x 8,208 =  8,208
  //   R3  C=tombstone & H=quarantine, K=absent remainder  1 x 8,208 =  8,208
  //   R4  C=active    & H=tombstone, both K values        2 x 8,208 = 16,416
  // R2 and R3 see only the K='absent' remainder because R1 fires first, which
  // mirrors the real refusal order: issueActive validates the head at :637
  // before testing its state at :641.
  //
  // EVERY NUMBER HERE MOVED WHEN AXIS G WAS GATED ON SNAPSHOT PRESENCE, and they
  // were RE-DERIVED FROM THE UNIT rather than adjusted -- the unit itself is what
  // changed (8,352 -> 8,208), so patching the totals would have left the rule
  // counts internally inconsistent while the conservation sum still balanced.
  //
  // Cross-check from the other direction, which is the check that makes these
  // predicted rather than observed: the registry refuses three of the six
  // (operation, head state) pairs outright, which is half the space (49,248),
  // plus R1's tombstone-with-resolution cells in the one surviving pair
  // (C=tombstone & H=tombstone & K=present, 8,208) = 57,456. And forward instead
  // of by subtraction: the 5 surviving triples x 8,208 = 41,040 constructible.
  it('retires each rule\'s exact territory', () => {
    expect(split.byRule['R1-tombstone-carries-fork-resolution']).toBe(24_624);
    expect(split.byRule['R2-active-operation-needs-active-head']).toBe(8_208);
    expect(split.byRule['R3-quarantine-operation-needs-active-head']).toBe(8_208);
    expect(split.byRule['R4-tombstone-operation-needs-tombstone-head']).toBe(16_416);
    expect(split.unconstructible.length).toBe(57_456);
    expect(split.constructible.length).toBe(41_040);
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
