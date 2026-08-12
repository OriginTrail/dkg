import { describe, expect, it } from 'vitest';

import {
  assertAgentProfileHeadObjectV1,
  computeAgentProfileHeadObjectDigestV1,
} from '@origintrail-official/dkg-core/system-record-v1';

import { createSystemRecordVerifiedReplacementRegistryV1 } from '../src/system-record-verified-replacement-v1-internal.js';
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

/**
 * R2, R3 and R4 retire 32,832 cells between them -- a third of the space -- on
 * the claim that the verified-replacement registry refuses three of the six
 * (storage operation x candidate head state) pairs. A citation shows the string
 * sits at the line; it does NOT show the site refuses that combination. So each
 * is FIRED here through the real registry with the exact pairing its rule
 * names.
 *
 * The registry is the right instrument: the harness drives storage through the
 * exported derivation, and the derivation's facts can only come from here.
 */
describe('verified-replacement registry operation/head-state refusals', () => {
  it('refuses every operation/head-state pair the rules retire', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const tombstoneHead = fixture.tombstone.head;
    const activeHead = fixture.active.head;

    // R2 -- operation 'active' routes straight to issueActive.
    expect(() => registry.issuer.issueCandidate({
      operation: 'active',
      ...fixture.active,
      head: tombstoneHead,
    } as never)).toThrow('verified replacement head must be active');

    // R3 -- operation 'quarantine' reaches the SAME refusal by delegation, which
    // is the whole reason it is a separate rule: nothing in the quarantine
    // branch checks the head, it just inherits issueActive's requirement.
    expect(() => registry.issuer.issueCandidate({
      operation: 'quarantine',
      ...fixture.quarantine,
      head: tombstoneHead,
    } as never)).toThrow('verified replacement head must be active');

    // R4 -- and the mirror image on the tombstone fall-through.
    expect(() => registry.issuer.issueCandidate({
      operation: 'tombstone',
      ...fixture.tombstone,
      head: activeHead,
    } as never)).toThrow('verified tombstone replacement head must be tombstone');
  });

  // THE RULE ORDER IS A MEASUREMENT, NOT A PREFERENCE, and the per-rule counts
  // rest on it: R2 and R3 retire 32,832 cells each rather than 65,664 precisely
  // because R1 owns the fork-resolution half first. That is only true if the
  // codec really refuses before the state check does -- issueActive validates
  // the head at :637 and tests its state at :641 -- so the pairing that trips
  // both must report the CODEC's message.
  //
  // PARAMETERIZED OVER AXIS K, because the counts are. Firing only the K='absent'
  // half leaves the other half of each rule's territory retired against a
  // citation never fired with a head matching it: `byRule` would still sum to the
  // unconstructible total and every count would stay green under a wrong OWNER.
  // A rule's territory and a rule's count are different claims, and only the
  // count was being checked.
  it('lets the head codec refuse ahead of the operation/head-state check', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    const tombstoneWithResolution = {
      ...(fixture.tombstone.head as unknown as Record<string, unknown>),
      forkResolutionDigest: `0x${'cd'.repeat(32)}`,
    };

    // R1 ahead of R2, on the direct route.
    expect(() => registry.issuer.issueCandidate({
      operation: 'active',
      ...fixture.active,
      head: tombstoneWithResolution,
    } as never)).toThrow('V1 has no direct terminal fork-resolution tombstone');

    // R1 ahead of R3, on the DELEGATED route. R3 reaches the state check only via
    // issueActive, so its K='present' remainder depends on the same ordering by a
    // different path -- and a path that is not fired is a path not measured.
    expect(() => registry.issuer.issueCandidate({
      operation: 'quarantine',
      ...fixture.quarantine,
      head: tombstoneWithResolution,
    } as never)).toThrow('V1 has no direct terminal fork-resolution tombstone');
  });

  // R4's OWNERSHIP OF ITS K='PRESENT' HALF, fired rather than asserted.
  //
  // R4 alone retires BOTH fork-resolution values -- 65,664 cells -- on the claim
  // that nothing refuses an ACTIVE head carrying forkResolutionDigest ahead of
  // the tombstone branch's state check. That claim points the opposite way from
  // R2/R3's, which is exactly why it was easy to leave unfired: a rule saying
  // "something fires first" invites a test, and one saying "nothing does" does
  // not. If the head codec ever started refusing an active head with a fork
  // resolution, half of R4's territory would belong to R1 instead, the counts
  // would still sum, and nothing else here would notice.
  it('lets the tombstone branch refuse an active head carrying a fork resolution', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    // A fork-resolving head must be NON-INITIAL, and finding that out is half of
    // what this test is worth. Adding forkResolutionDigest to the fixture's
    // genesis head is refused by :200 'ordinary initial head must omit all
    // history digests' -- so R4's rationale ("the head codec permits an ACTIVE
    // head to carry forkResolutionDigest") is true only above version zero, and
    // nothing had established that. Axis E is a RELATIVE axis, so the fixture is
    // free to move the version and the cells stay constructible; had E been
    // absolute, R4's K='present' half would have been unconstructible instead of
    // merely unfired.
    const activeWithResolution = {
      ...(fixture.active.head as unknown as Record<string, unknown>),
      version: '2',
      previousHeadDigest: computeAgentProfileHeadObjectDigestV1(fixture.active.head),
      forkResolutionDigest: `0x${'cd'.repeat(32)}`,
    };

    // The premise first: the codec must MINT this head, or the refusal below
    // would be the codec's and R4 would be the wrong owner.
    expect(refusalOf(activeWithResolution)).toBe('MINTS');

    expect(() => registry.issuer.issueCandidate({
      operation: 'tombstone',
      ...fixture.tombstone,
      head: activeWithResolution,
    } as never)).toThrow('verified tombstone replacement head must be tombstone');
  });

  // The positive control. Without it the three refusals above are equally
  // consistent with a registry that refuses everything, and the rules would
  // retire a third of the space on a fixture defect.
  it('accepts each operation paired with the head state its rule leaves alone', async () => {
    const fixture = await makeAuthenticTerminalReplacementFixtureV1();
    const registry = createSystemRecordVerifiedReplacementRegistryV1();
    for (const issue of [
      { operation: 'active' as const, ...fixture.active },
      { operation: 'quarantine' as const, ...fixture.quarantine },
      { operation: 'tombstone' as const, ...fixture.tombstone },
    ]) {
      const handle = registry.issuer.issueCandidate(issue as never);
      const facts = registry.consumer.consume(handle, fixture.binding);
      expect(facts.operation).toBe(issue.operation);
      registry.consumer.release(facts);
    }
  });
});
