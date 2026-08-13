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
 * The same measurement is the finding, and the number is the one this suite
 * asserts: every storage input covers exactly 192 cells -- min AND max, so the
 * blindness is uniform, not an average hiding a spread -- while core's groups
 * run from 1 to 8. Core discriminates inside a set storage cannot split at all.
 *
 * REFINED SINCE, by the projection-equivalence suite: axis L never reaches a
 * storage input -- measured at SOURCE, where issuedAt, nowMs, clockSkew and
 * futureSkew do not occur anywhere in packages/storage/src -- so the storage
 * projection keys collapse 855 -> 285 once the clock segment is removed, which
 * is KEY ARITHMETIC (855 = 285 x 3) rather than a byte comparison of built
 * inputs, and the honest figure is 576 cells per CLOCK-INDEPENDENT KEY-GROUP,
 * not 192. Both numbers are real and they answer different questions -- 192 is
 * what the committed projection key groups, 576 is what a clock-independent
 * group covers. NEITHER is cells-per-input: the built inputs number 273, which
 * does not divide 164,160 (remainder 87, ~601.3 cells each), and a non-integer
 * is the proof that inputs are not uniformly sized.
 */
// Stated rather than inherited, for the reason recorded in the generator's own
// suite: vitest's 5s default already cost this lane a run once, and the space
// has quadrupled since. This suite groups 164,160 cells twice, so it is the
// closest of the three to the old default.
const VERDICT_DIFF_SUITE_TIMEOUT_MS = 120_000;

describe('verdict-diff evaluator input projections', { timeout: VERDICT_DIFF_SUITE_TIMEOUT_MS }, () => {
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

  // THE PIN THAT MAKES THE SWEEP'S COST CHECKABLE. 164,160 rows need 26,775
  // evaluator runs, not 328,320 -- and if a later change breaks a projection the
  // run count moves here before the table quietly doubles in cost or, worse,
  // merges two cells that were never the same input.
  //
  // RE-DERIVED, NEVER SCALED, at every move -- core's group sizes are ragged, so
  // a ratio applied to the old figure would be a guess wearing an arithmetic
  // costume. The derivation: core's key drops axes B and H, leaving
  // (A,D,E,F,G) x C x I x J x K x L over the constructible set, where the
  // surviving (C,K) pairs number 3 and the (A,D,E,F,G) substructure is
  // 1 (absent) + 7 x 2 (present) = 15, giving 15 x 3 x 3 x 64 x 3 = 25,920.
  // Storage's key drops I and J: 5 surviving (C,H,K) triples x L = 15 in the
  // absent region, plus B x 7 x G x 5 x L = 840 present, giving 855.
  //
  // STORAGE'S COUNT IS UNCHANGED BY THE AXIS-J CORRECTION, and that is the
  // cross-check rather than a coincidence: J is invisible to storage, so
  // widening it multiplies core's inputs and leaves storage's untouched. A
  // change that moved BOTH would mean the invisible-axis lists were wrong.
  it('pins the distinct input count on each side', () => {
    expect(cells).toHaveLength(164_160);
    expect(groupSizes(coreInputProjectionKeyV1).distinct).toBe(25_920);
    expect(groupSizes(storageInputProjectionKeyV1).distinct).toBe(855);
  });

  // THE FINDING ITSELF, and the axis-J correction made it four times larger.
  // Storage's blindness is UNIFORM: every one of its inputs stands for exactly
  // 192 cells, because it cannot see core's disposition (3 values) or core's
  // evidence presence (64 subsets), and 3 x 64 = 192. Core's is ragged (1 to 8)
  // because the operation axis it cannot see is entangled with the head-state
  // axis it can -- R2/R3/R4 retire three of the six pairs, so the surviving
  // operations differ per head state.
  //
  // What Phase 3 inherits is therefore sharper than first measured: core
  // discriminates 192 ways where storage cannot discriminate at all, and two of
  // those distinctions (`verifiedAuthoritySummary` and `forkEvidenceHeads`
  // presence) are ones the earlier space could not even express.
  it('measures how much each side cannot discriminate', () => {
    const storage = groupSizes(storageInputProjectionKeyV1);
    expect([storage.min, storage.max]).toEqual([192, 192]);
    expect(
      VERDICT_DIFF_AXES_V1.I_coreDisposition.length * 2 ** VERDICT_DIFF_AXES_V1.J_evidencePresence.length,
    ).toBe(192);

    const core = groupSizes(coreInputProjectionKeyV1);
    expect([core.min, core.max]).toEqual([1, 8]);
  });

  // A SCOPED ABSENCE CLAIM, made checkable. Core consumes `disposition` as an
  // input and persists nothing; the claim that storage has no source for it is
  // what Phase 2 exists to fix, so it is pinned rather than remembered -- and
  // pinned at the scope actually searched, which is this directory only.
  //
  // KEPT VERBATIM THROUGH THE LATE-TOMBSTONE ROUTING, WHICH IS THE POINT. That
  // slice added the first storage-side consumer and its first draft REPLACED
  // this walk with the three targeted claims below. That was wrong, and the
  // reason generalises: this raw substring zero is a TRIPWIRE and those are
  // GUARDS. A guard catches exactly what it names; the tripwire catches what
  // nobody thought to name -- a prose comment, a future literal, a copied
  // constant. It caught a neighbouring PR's ordinary-English comment within the
  // hour of being live. Guards COMPOSE with a tripwire and never replace one,
  // and this zero is cited as a premise in shipped artifacts, so replacing it
  // would have silently falsified those citations. The routing keeps the zero by
  // using the CamelCase symbol only and naming its reason member
  // `undecided-authority-classification`.
  it('finds no disposition producer anywhere in packages/storage/src', () => {
    const root = new URL('../src/', import.meta.url);
    const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory()
        ? walk(new URL(`${entry.name}/`, dir))
        : entry.name.endsWith('.ts') ? [readFileSync(new URL(entry.name, dir), 'utf8')] : []));
    const hits = walk(root).filter((source) => source.includes('disposition'));
    expect(hits).toHaveLength(0);
  });

  // ADDITIONS, NOT A REPLACEMENT. The walk above says the word is absent; these
  // say what the one legitimate consumer is allowed to do. Both are needed: the
  // absence claim cannot distinguish a correct consumer from a hand-rolled copy
  // of core's mapping, because a copy that avoided the word entirely would
  // satisfy it.
  it('consumes core\'s authority-classification reader and re-derives none of its own', () => {
    const root = new URL('../src/', import.meta.url);
    const walk = (dir: URL): { file: string; source: string }[] => readdirSync(
      dir,
      { withFileTypes: true },
    ).flatMap((entry) => (entry.isDirectory()
      ? walk(new URL(`${entry.name}/`, dir))
      : entry.name.endsWith('.ts')
        ? [{ file: entry.name, source: readFileSync(new URL(entry.name, dir), 'utf8') }]
        : []));
    const files = walk(root);
    // Non-vacuity first: a walk that found nothing would satisfy every claim
    // below, which is the shape this suite exists to refuse.
    expect(files.length).toBeGreaterThan(40);

    // THE CONSUMER IS KEYED ON THE CamelCase SYMBOL, which is the only form the
    // walk above permits -- and that is not a workaround, it is what makes both
    // checks live at once. Counting OCCURRENCES rather than files, because two
    // calls in one file are two facts and a file count would report them as one.
    const importing = files.filter(
      (f) => f.source.includes('deriveAgentProfileAuthorityDispositionV1'),
    );
    expect(importing.map((f) => f.file)).toStrictEqual(
      ['system-record-next-state-v1-internal.ts'],
    );
    const calls = importing.flatMap(
      (f) => f.source.match(/deriveAgentProfileAuthorityDispositionV1\(/g) ?? [],
    );
    expect(calls).toHaveLength(1);

    // EVERY REFERENCE IS ACCOUNTED FOR, NOT JUST EVERY CALL, and this line exists
    // because the call count alone SURVIVED its own mutant: `const alias =
    // deriveAgentProfileAuthorityDispositionV1;` is a reference and not a call,
    // so it passed a check whose whole job is bounding this consumer -- and an
    // alias can be invoked anywhere afterwards. Three occurrences: the import,
    // one docblock mention, and the single call. A fourth is either a second
    // consumer or an alias, and both are this seam's problem.
    const references = importing.flatMap(
      (f) => f.source.match(/deriveAgentProfileAuthorityDispositionV1/g) ?? [],
    );
    expect(references).toHaveLength(3);

    // AND THE DOMAIN ITSELF IS NOT RESTATED HERE. A storage-side copy of core's
    // three classification values is the exact re-implementation this seam
    // forbids, and it would be invisible to a call-site count -- a copy written
    // without the noun would pass the walk above and this one both, which is why
    // the values are named individually.
    for (const literal of [
      "'discoverable'",
      "'head-fork-quarantined'",
      "'transition-equivocation-quarantined'",
    ]) {
      expect(files.filter((f) => f.source.includes(literal)).map((f) => f.file))
        .toStrictEqual([]);
    }
  });
});
