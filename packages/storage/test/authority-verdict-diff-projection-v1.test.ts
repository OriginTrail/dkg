import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { VERDICT_DIFF_AXES_V1 } from './helpers/authority-verdict-diff-fixture-v1.js';
import {
  AXIS_TO_CELL_FIELD_V1,
  CORE_INVISIBLE_AXES_V1,
  coreInputProjectionKeyV1,
  enumerateVerdictDiffCellsV1,
  STORAGE_INVISIBLE_AXES_V1,
  storageInputProjectionKeyV1,
} from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';

/**
 * What each evaluator can SEE, and what that costs the mapping.
 *
 * The two implementations do not take the same inputs -- the Phase 1 spec says
 * so -- but "do not take the same inputs" is a sentence, and the diff needs a
 * number. Each side sees a projection of the cell onto the axes its own input
 * types can carry, and the projections are what make the sweep runnable at all:
 * cells sharing a projection present byte-identical inputs, so the evaluator
 * runs once per projection rather than once per cell.
 *
 * The same measurement is the finding. A storage input maps to 48 core inputs,
 * so core discriminates 48 ways where storage cannot discriminate at all.
 */
describe('verdict-diff evaluator input projections', () => {
  const split = resolveConstructibilityV1(enumerateVerdictDiffCellsV1());
  const cells = split.constructible;

  const groupSizes = (key: (cell: (typeof cells)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const cell of cells) {
      const k = key(cell);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const sizes = [...counts.values()];
    return {
      distinct: counts.size,
      min: Math.min(...sizes),
      max: Math.max(...sizes),
    };
  };

  // The field map is what the projection keys are built from, so a new axis
  // that never reached it would silently drop out of BOTH keys and merge cells
  // that differ.
  it('maps every axis to a cell field, and no others', () => {
    expect(Object.keys(AXIS_TO_CELL_FIELD_V1).sort())
      .toEqual(Object.keys(VERDICT_DIFF_AXES_V1).sort());
  });

  it('keeps the invisible-axis lists disjoint and inside the axis set', () => {
    for (const axis of [...CORE_INVISIBLE_AXES_V1, ...STORAGE_INVISIBLE_AXES_V1]) {
      expect(Object.keys(VERDICT_DIFF_AXES_V1)).toContain(axis);
    }
    for (const axis of CORE_INVISIBLE_AXES_V1) {
      expect(STORAGE_INVISIBLE_AXES_V1).not.toContain(axis);
    }
  });

  // THE PIN THAT MAKES THE SWEEP'S COST CHECKABLE. 41,760 rows need 7,782
  // evaluator runs, not 83,520 -- and if a later change breaks a projection the
  // run count moves here before the table quietly doubles in cost or, worse,
  // merges two cells that were never the same input.
  it('pins the distinct input count on each side', () => {
    expect(cells).toHaveLength(41_760);
    expect(groupSizes(coreInputProjectionKeyV1).distinct).toBe(6_912);
    expect(groupSizes(storageInputProjectionKeyV1).distinct).toBe(870);
  });

  // THE FINDING ITSELF. Storage's blindness is UNIFORM: every one of its inputs
  // stands for exactly 48 cells, because it cannot see core's disposition (3
  // values) or core's evidence presence (16 subsets), and 3 x 16 = 48. Core's
  // is ragged (1 to 8) because the operation axis it cannot see is entangled
  // with the head-state axis it can -- R2/R3/R4 retire three of the six pairs,
  // so the surviving operations differ per head state.
  it('measures how much each side cannot discriminate', () => {
    const storage = groupSizes(storageInputProjectionKeyV1);
    expect([storage.min, storage.max]).toEqual([48, 48]);
    expect(
      VERDICT_DIFF_AXES_V1.I_coreDisposition.length * 2 ** VERDICT_DIFF_AXES_V1.J_evidencePresence.length,
    ).toBe(48);

    const core = groupSizes(coreInputProjectionKeyV1);
    expect([core.min, core.max]).toEqual([1, 8]);
  });

  // A SCOPED ABSENCE CLAIM, made checkable. Core consumes `disposition` as an
  // input and persists nothing; the claim that storage has no source for it is
  // what Phase 2 exists to fix, so it is pinned rather than remembered -- and
  // pinned at the scope actually searched, which is this directory only.
  it('finds no disposition producer anywhere in packages/storage/src', () => {
    const root = new URL('../src/', import.meta.url);
    const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory()
        ? walk(new URL(`${entry.name}/`, dir))
        : entry.name.endsWith('.ts') ? [readFileSync(new URL(entry.name, dir), 'utf8')] : []));
    const hits = walk(root).filter((source) => source.includes('disposition'));
    expect(hits).toHaveLength(0);
  });
});
