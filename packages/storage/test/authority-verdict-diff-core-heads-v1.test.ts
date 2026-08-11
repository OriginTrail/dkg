import { describe, expect, it } from 'vitest';

import { computeAgentProfileHeadObjectDigestV1 } from '@origintrail-official/dkg-core/system-record-v1';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
  CORE_CURRENT_DIGEST_V1,
  CORE_CURRENT_HEAD_V1,
} from './helpers/authority-verdict-diff-core-heads-v1.js';

/**
 * THE CANDIDATE-HEAD LAYER, MEASURED.
 *
 * The static rules retire cells nobody can even OFFER to an evaluator. This
 * suite is the next layer down: of the cells that survive them, which ones have
 * a candidate head that can actually be built? Every refusal found here is a
 * retirement the static resolver did not know about, and the constructible
 * count falls again -- which is the expected outcome, not a defect. It has
 * fallen at every layer so far, always with a recorded reason.
 *
 * The point of doing this as a pinned suite rather than as a script: a head
 * shape that stops building later would otherwise shrink the sweep silently.
 */
const SUITE_TIMEOUT_MS = 120_000;

describe('core candidate head construction', { timeout: SUITE_TIMEOUT_MS }, () => {
  const constructible = resolveConstructibilityV1(enumerateVerdictDiffCellsV1()).constructible;

  // One build per distinct SHAPE, which is the whole point of the shape key.
  const byShape = new Map<string, ReturnType<typeof buildCoreCandidateHeadV1>>();
  const cellsPerShape = new Map<string, number>();
  for (const cell of constructible) {
    const key = coreHeadShapeKeyV1(cell);
    cellsPerShape.set(key, (cellsPerShape.get(key) ?? 0) + 1);
    if (!byShape.has(key)) byShape.set(key, buildCoreCandidateHeadV1(cell));
  }

  const refused = [...byShape].filter(([, r]) => !r.built);
  const built = [...byShape].filter(([, r]) => r.built);

  // THE PREMISE OF THE WHOLE LAYER. If the current head does not mint, every
  // relation below is measured against nothing and the refusals would all be
  // artefacts of a broken fixture.
  it('mints the accepted current head every relation is measured against', () => {
    expect(CORE_CURRENT_HEAD_V1.state).toBe('active');
    expect(CORE_CURRENT_HEAD_V1.authoritySequence).toBe('2');
    expect(CORE_CURRENT_HEAD_V1.version).toBe('2');
    // Non-genesis, so axis G has a referent at all.
    expect(CORE_CURRENT_HEAD_V1.acceptedTransitionDigest).toBeDefined();
    expect(computeAgentProfileHeadObjectDigestV1(CORE_CURRENT_HEAD_V1))
      .toBe(CORE_CURRENT_DIGEST_V1);
  });

  // The memoisation claim, made checkable. If shapes stopped collapsing cells,
  // the sweep's cost would rise silently rather than failing here.
  it('collapses the constructible cells onto a small set of head shapes', () => {
    expect(constructible).toHaveLength(164_160);
    expect(byShape.size).toBeLessThan(200);
    expect([...cellsPerShape.values()].reduce((a, b) => a + b, 0)).toBe(164_160);
  });

  // NON-VACUITY IN BOTH DIRECTIONS. A layer that built everything would be
  // measuring nothing, and one that built nothing would be a broken fixture
  // reported as a finding -- the failure mode this harness has caught twice.
  it('both builds and refuses head shapes, so neither arm is vacuous', () => {
    expect(built.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
  });

  // THE AXIS-F CONTRADICTION, DEMONSTRATED RATHER THAN ASSERTED.
  //
  // These retirements cannot quote a failure string, because nothing throws:
  // asking for a head that is digest-equal to the current AND differs from it
  // is asking for two incompatible things. What can be shown is the
  // contradiction itself -- change the field the other axis names and the
  // digest moves -- which is the evidence a contradiction rule owes in place of
  // a citation.
  //
  // WHAT THIS DEMONSTRATES AND WHAT IT DOES NOT. It is a statement about THIS
  // referent, and only F2 generalises past it: F and G are both relative to the
  // current head, so no referent satisfies both. F1 and F3 pair relative F with
  // an ABSOLUTE axis, and their escape is a second referent rather than a second
  // object -- so they are HARNESS LIMITATIONS, relabelled as such in
  // CORE_HARNESS_LIMITATIONS_V1. The digests below still move; the inference
  // 'therefore the system refuses it' is the part that was wrong.
  it('demonstrates that digest equality forces every field an axis could vary', () => {
    const current = CORE_CURRENT_HEAD_V1 as unknown as Record<string, unknown>;

    // Axes G and K name fields an ACTIVE head may legally carry, so each variant
    // is a well-formed head and the demonstration is that its digest moves.
    for (const variant of [
      { ...current, acceptedTransitionDigest: `0x${'7e'.repeat(32)}` },
      { ...current, forkResolutionDigest: `0x${'cd'.repeat(32)}` },
    ]) {
      expect(computeAgentProfileHeadObjectDigestV1(variant as never))
        .not.toBe(CORE_CURRENT_DIGEST_V1);
    }

    // Axis C is a STRONGER contradiction than a moved digest, and finding that
    // out is worth more than the row that was written first. Setting `state` to
    // 'tombstone' on the current head does not merely change its hash -- it does
    // not produce a head at all, because a tombstone commits none of the active
    // head's projection and seal fields: 'agent profile head has unknown or
    // missing fields'. Digest equality with a tombstone candidate is not a
    // near-miss, it is a category error.
    expect(() => computeAgentProfileHeadObjectDigestV1(
      { ...current, state: 'tombstone' } as never,
    )).toThrow('agent profile head has unknown or missing fields');

    // The contradiction closed from the other side, over the heads the builder
    // ACTUALLY produced: nothing reaches the current's digest except a shape
    // that asked for digest equality on every axis the digest covers.
    const collisions = built.filter(([, r]) => r.built && r.digest === CORE_CURRENT_DIGEST_V1);
    expect(collisions.length).toBeGreaterThan(0);
    for (const [key] of collisions) {
      const [, state, , , headDigest, transition, fork] = key.split('|');
      expect({ state, headDigest, transition, fork })
        .toEqual({ state: 'active', headDigest: 'equal', transition: 'equal', fork: 'absent' });
    }
  });

  // Every refusal is attributed. An unattributed one would be a silent drop
  // channel: the sweep would shrink and nothing would say why.
  it('attributes every refused shape to a named rule with a message', () => {
    const unattributed = refused.filter(([, r]) =>
      r.built || r.ruleId.length === 0 || r.message.length === 0);
    expect(unattributed).toHaveLength(0);
  });

  /**
   * THE PIN THIS LAYER EXISTS FOR: the constructible count falls again, by a
   * number DERIVED BEFORE THE RUN rather than read off it.
   *
   * The derivation. Axis F applies only where D and E are both 'equal', which is
   * 1 of the 7 (D,E,F) combinations, so F='equal' owns 1/7 of the present
   * region: 5 surviving (C,H,K) triples x B(4) x G(2) x I(3) x J(64) x L(3) =
   * 23,040 constructible cells. The three axis-F rules then split it -- one
   * contradiction (F2) and two harness limitations (F1, F3), whose COUNTS are
   * unaffected by that relabelling -- in the order the builder tests them:
   *   F1 state:      C=tombstone, which is 1 of the 5 triples
   *                    1 x 4 x 2 x 3 x 64 x 3  =  4,608
   *   F2 transition: G='differ' over the 4 remaining C=active triples
   *                    4 x 4 x 1 x 3 x 64 x 3  =  9,216
   *   F3 fork:       K='present' over the 2 C=active triples that carry it,
   *                  with G already forced to 'equal'
   *                    2 x 4 x 1 x 3 x 64 x 3  =  4,608
   *                                     total  = 18,432
   * Cross-checked forward instead of by subtraction: what survives is exactly
   * C=active & G='equal' & K='absent', which is 2 triples x 4 x 3 x 64 x 3 =
   * 4,608 -- and 23,040 - 18,432 = 4,608 agrees.
   *
   * So 164,160 - 18,432 = 145,728 cells still have a buildable candidate head.
   *
   * RULE ORDER IS A MEASUREMENT HERE TOO. F1 before F2 before F3 is what makes
   * these counts what they are; swapping any two moves cells between rules while
   * the total stays put, which is precisely what per-rule counts exist to catch.
   */
  it('retires the axis-F contradictions and lowers the constructible count', () => {
    const retiredCells = new Map<string, number>();
    let buildable = 0;
    for (const cell of constructible) {
      const result = byShape.get(coreHeadShapeKeyV1(cell));
      if (result?.built) {
        buildable += 1;
        continue;
      }
      const id = result?.ruleId ?? 'UNATTRIBUTED';
      retiredCells.set(id, (retiredCells.get(id) ?? 0) + 1);
    }

    expect(retiredCells.get('F1-digest-equality-forces-the-current-state')).toBe(4_608);
    expect(retiredCells.get('F2-digest-equality-forces-the-current-transition-digest'))
      .toBe(9_216);
    expect(retiredCells.get('F3-digest-equality-forces-the-current-fork-resolution-absence'))
      .toBe(4_608);
    // The head codec refuses no SHAPE the static rules left standing. Pinned
    // rather than omitted: a codec change that started refusing one would
    // otherwise shrink the sweep with nothing naming the loss.
    expect(retiredCells.get('H1-head-codec-refuses-the-shape')).toBeUndefined();

    // Conservation, at this layer as at the last one.
    const retired = [...retiredCells.values()].reduce((a, b) => a + b, 0);
    expect(retired).toBe(18_432);
    expect(buildable).toBe(145_728);
    expect(buildable + retired).toBe(164_160);
  });
});
