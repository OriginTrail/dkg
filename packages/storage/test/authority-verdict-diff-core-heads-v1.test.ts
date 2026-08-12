import { describe, expect, it } from 'vitest';

import {
  computeAgentProfileAuthorityTransitionDigestV1,
  computeAgentProfileHeadObjectDigestV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { enumerateVerdictDiffCellsV1 } from './helpers/authority-verdict-diff-cells-v1.js';
import { resolveConstructibilityV1 } from './helpers/authority-verdict-diff-constructibility-v1.js';
import {
  buildCoreCandidateHeadV1,
  coreHeadShapeKeyV1,
  CORE_ALL_TRANSITIONS_V1,
  CORE_CURRENT_DIGEST_V1,
  CORE_CURRENT_HEAD_V1,
  CORE_CURRENT_SEQUENCE_V1,
  CORE_CURRENT_VERSION_V1,
  CORE_OTHER_TRANSITION_DIGEST_V1,
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

  // One cell per shape, kept so a built head can be checked against the axes
  // the cell CLAIMS rather than against the key derived from it.
  const representative = new Map<string, (typeof constructible)[number]>();
  for (const cell of constructible) {
    const key = coreHeadShapeKeyV1(cell);
    if (!representative.has(key)) representative.set(key, cell);
  }

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

  // COUNTS ARE NOT CONTENT. Every check above measures how MANY shapes build;
  // none of them opens a built head and asks whether it is the head its cell
  // describes. A builder that mapped two axis values onto one head -- 'plusOne'
  // and 'abovePlusOne' onto the same sequence, say -- would keep every count
  // here green while the sweep evaluated duplicate inputs for distinct cells.
  //
  // The expected values are restated from what each axis MEANS, never read back
  // from the builder's own switch: an expectation computed from the code under
  // test agrees with it by construction. Axes that do not apply to a cell are
  // skipped rather than defaulted -- a defaulted axis would pin a free choice
  // the cell never made.
  it('builds candidate heads that honour the axes their cells claim', () => {
    const SEQUENCE_DELTA = { below: -1n, equal: 0n, plusOne: 1n, abovePlusOne: 2n };
    const VERSION_DELTA = { below: -1n, equal: 0n, above: 1n };
    const violations: string[] = [];

    for (const [key, result] of byShape) {
      if (!result.built) continue;
      const cell = representative.get(key);
      if (cell === undefined) {
        violations.push(`${key}: built shape has no representative cell`);
        continue;
      }
      const head = result.candidate as unknown as Record<string, unknown>;
      const note = (m: string) => violations.push(`${key}: ${m}`);

      if (String(head.state) !== cell.candidateHeadState) {
        note(`state ${String(head.state)} does not match axis C ${cell.candidateHeadState}`);
      }
      if (cell.headDigest === 'equal' && result.digest !== CORE_CURRENT_DIGEST_V1) {
        note('axis F equal did not reproduce the current head digest');
      }
      if (cell.headDigest === 'differ' && result.digest === CORE_CURRENT_DIGEST_V1) {
        note('axis F differ reproduced the current head digest');
      }
      if (cell.sequenceRelation !== undefined) {
        const delta = BigInt(String(head.authoritySequence)) - CORE_CURRENT_SEQUENCE_V1;
        if (delta !== SEQUENCE_DELTA[cell.sequenceRelation]) {
          note(`axis D ${cell.sequenceRelation} wanted delta ${SEQUENCE_DELTA[cell.sequenceRelation]}, head has ${delta}`);
        }
      }
      if (cell.versionRelation !== undefined) {
        const delta = BigInt(String(head.version)) - CORE_CURRENT_VERSION_V1;
        if (delta !== VERSION_DELTA[cell.versionRelation]) {
          note(`axis E ${cell.versionRelation} wanted delta ${VERSION_DELTA[cell.versionRelation]}, head has ${delta}`);
        }
      }
      // AXIS G IS SEQUENCE-RELATIVE. 'equal' means the candidate names the
      // ACCEPTED rotation into its OWN authority sequence; 'differ' means it
      // names a COMPETING rotation into that same sequence. Ruled 2026-08-12;
      // the denotation and its provenance are declared at the axis itself.
      //
      // Resolved against the transition OBJECTS rather than against the
      // builder's own per-sequence table. Comparing a head to the table that
      // built it agrees BY CONSTRUCTION and could never detect a builder that
      // ignored the axis -- the same self-reference that makes a count computed
      // from the generator worthless as a pin.
      if (cell.acceptedTransitionDigest !== undefined) {
        const named = CORE_ALL_TRANSITIONS_V1.find((transition) =>
          computeAgentProfileAuthorityTransitionDigestV1(transition)
            === head.acceptedTransitionDigest);
        if (named === undefined) {
          note('axis G names a transition this fixture does not carry');
        } else if (named.nextAuthoritySequence !== String(head.authoritySequence)) {
          note(`axis G names a rotation into sequence ${named.nextAuthoritySequence}`
            + ` while the head sits at ${String(head.authoritySequence)}`);
        } else {
          // The accepted rotation is the one this head's own wallet root came
          // from; a competing rotation moves to some other root.
          const accepted = named.nextEvmIssuer === head.evmIssuer;
          if (cell.acceptedTransitionDigest === 'equal' && !accepted) {
            note("axis G equal is not the accepted rotation into the head's own sequence");
          }
          if (cell.acceptedTransitionDigest === 'differ' && accepted) {
            note('axis G differ is not a competing rotation');
          }
        }
      }
      // THE SPECIAL CASE IS PINNED, NOT INHERITED. At the current authority
      // sequence the general rule must still land on exactly the two constants
      // the pre-generalisation assertion named, byte for byte -- so "the
      // D='equal' column did not move" is asserted rather than argued.
      if (String(head.authoritySequence) === CORE_CURRENT_HEAD_V1.authoritySequence) {
        if (cell.acceptedTransitionDigest === 'equal'
          && head.acceptedTransitionDigest !== CORE_CURRENT_HEAD_V1.acceptedTransitionDigest) {
          note("axis G equal at the current sequence left the current head's transition digest");
        }
        if (cell.acceptedTransitionDigest === 'differ'
          && head.acceptedTransitionDigest !== CORE_OTHER_TRANSITION_DIGEST_V1) {
          note('axis G differ at the current sequence left CORE_OTHER_TRANSITION_DIGEST_V1');
        }
      }
      const carriesFork = head.forkResolutionDigest !== undefined;
      if (carriesFork !== (cell.candidateForkResolutionDigest === 'present')) {
        note(`axis K ${cell.candidateForkResolutionDigest} but head ${carriesFork ? 'carries' : 'omits'} a fork resolution`);
      }
    }

    expect(violations).toEqual([]);
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
