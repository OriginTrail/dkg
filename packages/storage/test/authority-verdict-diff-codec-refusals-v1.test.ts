import { describe, expect, it } from 'vitest';

import {
  assertAgentProfileHeadObjectV1,
  computeAgentProfileHeadObjectDigestV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { VERDICT_DIFF_AXES_V1 } from './helpers/authority-verdict-diff-fixture-v1.js';
import {
  AXIS_CANDIDATE_HEAD_BINDING_V1,
  readCitedSourceLineV1,
  TOMBSTONE_BRANCH_REFUSALS_V1,
} from './helpers/authority-verdict-diff-constructibility-v1.js';
import { makeAuthenticTerminalReplacementFixtureV1 } from './helpers/system-record-terminal-replacement-fixture.js';

/**
 * Why the tombstone branch produced ONE constructibility rule and THREE fixture
 * obligations.
 *
 * The split is not a judgement call and is deliberately not written as one. A
 * codec refusal retires cells only when an axis pins the field it binds to an
 * ABSOLUTE value; a relative axis is satisfied by moving the referent the
 * fixture also builds. So the disposition is DERIVED here from the axis binding
 * table, and each refusal is fired at its site so the classification rests on a
 * captured message rather than on a reading of the source.
 */

const REPO_ROOT = new URL('../../../', import.meta.url);

function refusalOf(head: unknown): string {
  try {
    assertAgentProfileHeadObjectV1(head);
    return 'MINTS';
  } catch (error) {
    return String((error as { message?: string }).message);
  }
}

describe('head-codec tombstone-branch refusals', () => {
  // A citation must land ON the refusal. The weaker file-contains form passes
  // for any line number at all, which is how R1's site sat one line past its
  // own `fail(...)` call until this assertion was written.
  it('cites a line that actually carries the quoted failure', () => {
    for (const refusal of TOMBSTONE_BRANCH_REFUSALS_V1) {
      expect(readCitedSourceLineV1(refusal.site, REPO_ROOT)).toContain(refusal.failure);
    }
  });

  it('derives every disposition from the axis binding table', () => {
    const absolute = new Set(
      Object.values(AXIS_CANDIDATE_HEAD_BINDING_V1)
        .filter((binding) => binding.binds === 'absolute')
        .map((binding) => binding.field),
    );
    for (const refusal of TOMBSTONE_BRANCH_REFUSALS_V1) {
      const derived = refusal.binds.some((field) => absolute.has(field))
        ? 'constructibility-rule'
        : 'fixture-obligation';
      expect(refusal.disposition).toBe(derived);
      expect(refusal.ruleId === undefined).toBe(derived === 'fixture-obligation');
    }
  });

  // The binding table is only worth deriving from if it describes the axes the
  // generator actually drives.
  it('binds only axes the generator drives', () => {
    for (const axis of Object.keys(AXIS_CANDIDATE_HEAD_BINDING_V1)) {
      expect(Object.keys(VERDICT_DIFF_AXES_V1)).toContain(axis);
    }
  });

  it('fires every refusal at its site and captures its message', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const tombstone = fixture.tombstone.head as unknown as Record<string, unknown>;
    expect(refusalOf(tombstone)).toBe('MINTS');

    // :269. NOT reachable by the two natural mutations -- version zero trips the
    // general :200 gate and a dropped predecessor trips :206 -- so the trigger
    // has to strip every history digest as well.
    const versionZero = { ...tombstone, authoritySequence: '0', version: '0' };
    delete versionZero.previousHeadDigest;
    delete versionZero.acceptedTransitionDigest;
    delete versionZero.forkResolutionDigest;
    expect(refusalOf(versionZero)).toContain('tombstone must name an accepted active predecessor');
    expect(refusalOf({ ...tombstone, version: '0' }))
      .toContain('ordinary initial head must omit all history digests');

    // :272 -- R1's own site.
    expect(refusalOf({ ...tombstone, forkResolutionDigest: `0x${'cd'.repeat(32)}` }))
      .toContain('V1 has no direct terminal fork-resolution tombstone');

    // :275 -- all three counts reach the same refusal.
    for (const field of ['ownedSubjectCount', 'projectionBytes', 'projectionQuads']) {
      expect(refusalOf({ ...tombstone, [field]: '1' }))
        .toContain('tombstone projection accounting must be zero');
    }

    // :278.
    expect(refusalOf({ ...tombstone, ownedSubjectTableDigest: `0x${'ab'.repeat(32)}` }))
      .toContain('tombstone must commit the canonical empty subject table');
  });

  // THE REFERENT-FREEDOM CONTROL, and the reason the three obligations are not
  // rules. Axis E is relative, so it would still force a refused absolute
  // version if the CURRENT head could not be built away from it. It can: an
  // active current mints at version 2, which leaves below/equal/above served by
  // candidate versions 1/2/3 -- none of them zero, so :269 refuses no cell.
  it('builds a current head that leaves every version relation off the refusal', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const tombstone = fixture.tombstone.head as unknown as Record<string, unknown>;
    const current = {
      ...(fixture.active.head as unknown as Record<string, unknown>),
      version: '2',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(fixture.active.head),
    };
    expect(refusalOf(current)).toBe('MINTS');
    for (const version of ['1', '2', '3']) {
      expect(refusalOf({ ...tombstone, version })).toBe('MINTS');
    }
  });
});
