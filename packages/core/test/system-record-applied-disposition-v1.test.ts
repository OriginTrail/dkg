import { describe, expect, it } from 'vitest';

import {
  canonicalizeSystemRecordAppliedStateV1,
  computeSystemRecordAccountedBytesV1,
  computeSystemRecordRootClaimSetDigestV1,
  systemRecordAppliedStateAbsentV1,
  SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1,
  type SystemRecordAppliedStatePresentV1,
  type SystemRecordAppliedStatusV1,
  type SystemRecordAppliedStateV1,
} from '../src/system-record-applied-state-v1.js';
import {
  deriveAgentProfileAuthorityDispositionV1,
  type AgentProfileAuthorityDispositionResultV1,
} from '../src/system-record-applied-disposition-v1-internal.js';
import { computeSystemRecordStableKeyHashV1 } from '../src/system-record-inventory-v1.js';
import { EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1 } from '../src/system-record-objects-v1.js';

const HASH_A = `0x${'aa'.repeat(32)}` as const;
const HASH_B = `0x${'bb'.repeat(32)}` as const;
const SLOT_A = `0x${'11'.repeat(32)}` as const;
const SLOT_B = `0x${'22'.repeat(32)}` as const;
const ROOT_A = 'did:dkg:agent:0x1111111111111111111111111111111111111111';
const PEER = '12D3KooWJ1TsijH7H5F74hfAD5XishQz3sxrmAtVY37GtNd9CqYf';
const STABLE_KEY = computeSystemRecordStableKeyHashV1('otp:20430', PEER);

const APPLIED_STATUSES = ['active', 'quarantined', 'tombstone', 'dirty'] as const;

/** The domain core's evaluator accepts. The undecided arm is NOT in it. */
const ACCEPTED_DISPOSITIONS = [
  'discoverable',
  'head-fork-quarantined',
  'transition-equivocation-quarantined',
] as const;

function decided(
  disposition: (typeof ACCEPTED_DISPOSITIONS)[number],
): AgentProfileAuthorityDispositionResultV1 {
  return { outcome: 'decided', disposition };
}
function undecided(status: 'tombstone' | 'dirty'): AgentProfileAuthorityDispositionResultV1 {
  return { outcome: 'undecided-terminal', status };
}

/**
 * ONE CELL OF THE MAPPING, AS DATA.
 *
 * `status`, `slots` and `overflow` are `undefined` on the absent row because
 * they are INAPPLICABLE there, never because they default -- a defaulted axis
 * claims a value the case never had.
 */
interface AppliedDispositionCellV1 {
  /** The row of the specified table this cell belongs to; rows are 1..6. */
  readonly row: 1 | 2 | 3 | 4 | 5 | 6;
  readonly state: 'absent' | 'present';
  readonly status?: SystemRecordAppliedStatusV1;
  readonly slots?: 'empty' | 'occupied';
  readonly overflow?: boolean;
  readonly expected: AgentProfileAuthorityDispositionResultV1;
}

/**
 * THE SPECIFIED TABLE, PINNED AS DATA. Every cell's result is committed here and
 * the test DERIVES its expectation from this constant -- a harness that printed
 * the derivation's own answers back would be green forever and would say nothing
 * on the day a result moved.
 *
 * 17 cells: one absent row, plus the full cross-product of 4 statuses x
 * {empty, occupied} slots x {false, true} overflow. All 17 are constructible as
 * PERSISTED state -- proven below by running each through the applied-state
 * canonicaliser -- including the three the write path cannot currently reach
 * (`active`/`dirty`/`tombstone` carrying slots, and overflow set with the array
 * empty). None is retired, so none needs a refusing site.
 */
const APPLIED_DISPOSITION_TABLE_V1: readonly AppliedDispositionCellV1[] = Object.freeze([
  // Row 1 -- FORCED, not a design decision: core rejects any other reading of an
  // absent row at authority :217 and :532.
  { row: 1, state: 'absent', expected: decided('discoverable') },

  // Row 2 -- the ordinary discoverable record.
  { row: 2, state: 'present', status: 'active', slots: 'empty', overflow: false, expected: decided('discoverable') },

  // Row 4 -- quarantined with no transition evidence retained: a head fork,
  // which core clears through its fork-resolution-successor branch.
  { row: 4, state: 'present', status: 'quarantined', slots: 'empty', overflow: false, expected: decided('head-fork-quarantined') },

  // Rows 5 and 6 -- the two open questions, reported as such and kept apart.
  { row: 5, state: 'present', status: 'tombstone', slots: 'empty', overflow: false, expected: undecided('tombstone') },
  { row: 6, state: 'present', status: 'dirty', slots: 'empty', overflow: false, expected: undecided('dirty') },

  // Row 3 -- ANY status, once the substrate carries the equivocation. Twelve
  // cells, because it takes precedence over rows 2, 4, 5 and 6 alike.
  { row: 3, state: 'present', status: 'active', slots: 'occupied', overflow: false, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'active', slots: 'occupied', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'active', slots: 'empty', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'quarantined', slots: 'occupied', overflow: false, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'quarantined', slots: 'occupied', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'quarantined', slots: 'empty', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'tombstone', slots: 'occupied', overflow: false, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'tombstone', slots: 'occupied', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'tombstone', slots: 'empty', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'dirty', slots: 'occupied', overflow: false, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'dirty', slots: 'occupied', overflow: true, expected: decided('transition-equivocation-quarantined') },
  { row: 3, state: 'present', status: 'dirty', slots: 'empty', overflow: true, expected: decided('transition-equivocation-quarantined') },
]);

function stateForCell(cell: AppliedDispositionCellV1): SystemRecordAppliedStateV1 {
  if (cell.state === 'absent') return systemRecordAppliedStateAbsentV1();
  const status = cell.status;
  if (status === undefined) throw new Error('a present cell must name a status');
  const rootClaimSetDigest = computeSystemRecordRootClaimSetDigestV1({
    objectType: 'system-record-root-claim-set',
    kind: 'agents',
    networkId: 'otp:20430',
    stableKeyHash: STABLE_KEY,
    currentRoot: ROOT_A,
    historicalRoots: [],
  });
  /*
   * THE PROJECTION SHAPE IS DECIDED BY THE STATUS, BECAUSE THE CODEC DECIDES IT.
   *
   * A terminal row must commit the canonical empty projection and table
   * (applied-state :335-339) and an active row a non-empty one (:341-345), so a
   * single shape across all four statuses would build cells the system can
   * never hold -- and the table would then measure the fixture rather than the
   * mapping. `dirty` takes the terminal shape because its only producer is the
   * shadow-mode tombstone derivation (next-state :692, projection literal
   * :695-700).
   */
  const terminal = status === 'tombstone' || status === 'dirty';
  const projectionBytes = terminal ? 0 : 4_096;
  const tableBytes = terminal ? 0 : 80;
  const present: SystemRecordAppliedStatePresentV1 = {
    objectType: 'system-record-applied-state',
    state: 'present',
    kind: 'agents',
    networkId: 'otp:20430',
    stableKeyHash: STABLE_KEY,
    peerId: PEER,
    stateRevision: '1',
    status,
    headDigest: HASH_A,
    transitionLineage: [],
    // A quarantined row must carry installed evidence or a resumable sidecar
    // intent (applied-state :272-275); the mapping never reads it, so it changes
    // no result -- it is here because without it the row is not constructible.
    ...(status === 'quarantined' ? { conflictEvidenceDigest: HASH_A } : {}),
    projectionDigest: terminal ? SYSTEM_RECORD_EMPTY_PROJECTION_DIGEST_V1 : HASH_B,
    projectionBytes: String(projectionBytes),
    projectionQuads: terminal ? '0' : '3',
    ownedSubjectTableDigest: terminal ? EMPTY_OWNED_SUBJECT_TABLE_DIGEST_V1 : HASH_A,
    ownedSubjectCount: terminal ? '0' : '1',
    ownedSubjectTableBytes: String(tableBytes),
    currentRoot: ROOT_A,
    historicalRoots: [],
    conflictDigestSlots: cell.slots === 'occupied' ? [SLOT_A, SLOT_B] : [],
    conflictOverflow: cell.overflow === true,
    materializationEpoch: '2',
    rootClaimSetDigest,
    accountedBytes: computeSystemRecordAccountedBytesV1(tableBytes, projectionBytes).toString(),
  };
  return present;
}

function coordinateKey(cell: AppliedDispositionCellV1): string {
  return `${cell.state}|${cell.status ?? '-'}|${cell.slots ?? '-'}|${String(cell.overflow ?? '-')}`;
}

/** One stable name per result, for counting. Undecided rows stay distinguishable. */
function resultLabel(result: AgentProfileAuthorityDispositionResultV1): string {
  return result.outcome === 'decided'
    ? result.disposition
    : `undecided-terminal:${result.status}`;
}

describe('applied state -> authority disposition', () => {
  /*
   * THE AXIS LIST IS CHECKED AGAINST THE CODEC, NOT AGAINST A TYPE ALIAS.
   *
   * The compile-time half lives in `system-record-package-export-v1.types.ts`,
   * because THIS file is not in any tsc program -- `packages/core/tsconfig.json`
   * includes only `src`, and vitest transpiles without semantic typechecking, so
   * a conditional-type guard written here would assert a literal `true` forever.
   * Found in review.
   *
   * What is executable HERE is the runtime half, read off the applied-state
   * codec rather than off a restated list: all four axis members are accepted,
   * and a non-member is refused by the codec's own message (:223-224).
   */
  it('uses axis statuses the applied-state codec accepts, and no others', () => {
    for (const status of APPLIED_STATUSES) {
      const state = stateForCell({
        row: 2, state: 'present', status, slots: 'empty', overflow: false,
        expected: decided('discoverable'),
      });
      if (state.state !== 'present') throw new Error('expected present');
      expect(() => canonicalizeSystemRecordAppliedStateV1(state)).not.toThrow();
    }
    const nonMember = stateForCell({
      row: 2, state: 'present', status: 'active', slots: 'empty', overflow: false,
      expected: decided('discoverable'),
    });
    expect(() => canonicalizeSystemRecordAppliedStateV1(
      { ...nonMember, status: 'expired' } as never,
    )).toThrow(/applied-state status is invalid/u);
  });

  // The pinned total comes first: without it, per-cell coverage is
  // unfalsifiable, because the table stays full while covering less than it
  // claims. Both counts are derived from the axis lists, and the histogram
  // reaches the same 17 from an independent direction.
  it('conserves 17 cells, cross-checked from the axes and from the results', () => {
    const derivedTotal = 1 + APPLIED_STATUSES.length * 2 * 2;
    expect(derivedTotal).toBe(17);
    expect(APPLIED_DISPOSITION_TABLE_V1).toHaveLength(derivedTotal);

    const histogram = new Map<string, number>();
    for (const cell of APPLIED_DISPOSITION_TABLE_V1) {
      const label = resultLabel(cell.expected);
      histogram.set(label, (histogram.get(label) ?? 0) + 1);
    }
    expect(Object.fromEntries(histogram)).toEqual({
      'discoverable': 2,
      'transition-equivocation-quarantined': 12,
      'head-fork-quarantined': 1,
      'undecided-terminal:tombstone': 1,
      'undecided-terminal:dirty': 1,
    });
    expect([...histogram.values()].reduce((sum, count) => sum + count, 0)).toBe(derivedTotal);
  });

  // Completeness against the axes rather than against the table's own contents:
  // a coordinate set derived from the table could not detect a row the table
  // never had.
  it('covers every coordinate the axes admit, with no duplicates', () => {
    const expected = new Set<string>(['absent|-|-|-']);
    for (const status of APPLIED_STATUSES) {
      for (const slots of ['empty', 'occupied'] as const) {
        for (const overflow of [false, true]) {
          expected.add(`present|${status}|${slots}|${String(overflow)}`);
        }
      }
    }
    const actual = APPLIED_DISPOSITION_TABLE_V1.map(coordinateKey);
    expect(new Set(actual).size).toBe(actual.length);
    expect([...new Set(actual)].sort()).toEqual([...expected].sort());
  });

  /*
   * EVERY CELL IS A STATE THE SYSTEM CAN ACTUALLY HOLD.
   *
   * The table claims all 17 coordinates are constructible as persisted state and
   * retires none, so none carries a refusing site. That claim is worth exactly
   * as much as its evidence: without this, the cells would be literals typed as
   * applied state, and the three the write path cannot reach would be
   * indistinguishable from shapes the codec forbids.
   */
  it('builds all 17 cells as states the applied-state codec accepts', () => {
    for (const cell of APPLIED_DISPOSITION_TABLE_V1) {
      const state = stateForCell(cell);
      if (state.state !== 'present') continue;
      expect(() => canonicalizeSystemRecordAppliedStateV1(state)).not.toThrow();
    }
  });

  it('derives the pinned result for every cell', () => {
    const observed = APPLIED_DISPOSITION_TABLE_V1.map((cell) => ({
      key: coordinateKey(cell),
      result: deriveAgentProfileAuthorityDispositionV1(stateForCell(cell)),
    }));
    expect(observed).toEqual(APPLIED_DISPOSITION_TABLE_V1.map((cell) => ({
      key: coordinateKey(cell),
      result: cell.expected,
    })));
  });

  /*
   * THE DISCRIMINATION PREDICATE, ONE DISJUNCT AT A TIME.
   *
   * Removing `conflictDigestSlots.length > 0` must be killed by a cell whose
   * ONLY equivocation signal is the array, and removing `conflictOverflow` by a
   * cell whose only signal is the flag. A single mixed cell (both signals set)
   * survives either removal alone and would report a solo-removal as covered
   * while neither disjunct was actually pinned.
   */
  it('makes each disjunct of the discrimination predicate solely responsible for a cell', () => {
    for (const status of APPLIED_STATUSES) {
      const slotsOnly = stateForCell({
        row: 3, state: 'present', status, slots: 'occupied', overflow: false,
        expected: decided('transition-equivocation-quarantined'),
      });
      const overflowOnly = stateForCell({
        row: 3, state: 'present', status, slots: 'empty', overflow: true,
        expected: decided('transition-equivocation-quarantined'),
      });
      expect(deriveAgentProfileAuthorityDispositionV1(slotsOnly))
        .toEqual(decided('transition-equivocation-quarantined'));
      expect(deriveAgentProfileAuthorityDispositionV1(overflowOnly))
        .toEqual(decided('transition-equivocation-quarantined'));
    }
  });

  /*
   * PRECEDENCE, STATED AS THE PROPERTY RATHER THAN AS AN ORDERING.
   *
   * Row 3 is reached from EVERY status, including the two whose own rows return
   * an undecided result and the one whose row returns `discoverable`. If the
   * equivocation test were moved below the status switch, every one of these
   * would return its status's own answer instead.
   */
  it('lets a persisted equivocation outrank every status, including active', () => {
    for (const status of APPLIED_STATUSES) {
      for (const [slots, overflow] of [['occupied', false], ['empty', true], ['occupied', true]] as const) {
        expect(deriveAgentProfileAuthorityDispositionV1(stateForCell({
          row: 3, state: 'present', status, slots, overflow,
          expected: decided('transition-equivocation-quarantined'),
        }))).toEqual(decided('transition-equivocation-quarantined'));
      }
    }
  });

  /*
   * WHAT THE UNDECIDED ARM IS FOR: it must not be consumable as a decision.
   *
   * The observable is structural rather than a string convention -- the result
   * carries no `disposition` at all, so there is nothing for a consumer to read
   * past the discriminator, and a terminal row cannot reach discovery by
   * default. The two statuses stay separately visible so one ruling cannot
   * silently answer the other.
   */
  it('reports terminal rows as undecided instead of inventing a clearance', () => {
    const tombstone = deriveAgentProfileAuthorityDispositionV1(stateForCell({
      row: 5, state: 'present', status: 'tombstone', slots: 'empty', overflow: false,
      expected: undecided('tombstone'),
    }));
    const shadow = deriveAgentProfileAuthorityDispositionV1(stateForCell({
      row: 6, state: 'present', status: 'dirty', slots: 'empty', overflow: false,
      expected: undecided('dirty'),
    }));

    for (const result of [tombstone, shadow]) {
      expect(result.outcome).toBe('undecided-terminal');
      // No disposition is carried, so none can be read off by accident.
      expect(Object.prototype.hasOwnProperty.call(result, 'disposition')).toBe(false);
      expect(ACCEPTED_DISPOSITIONS).not.toContain(
        (result as { readonly disposition?: string }).disposition,
      );
    }
    expect(tombstone).toEqual(undecided('tombstone'));
    expect(shadow).toEqual(undecided('dirty'));
    // The two gaps stay distinguishable.
    expect(tombstone).not.toEqual(shadow);
  });

  it('carries a disposition on every decided result, drawn from core\'s domain', () => {
    for (const cell of APPLIED_DISPOSITION_TABLE_V1) {
      const result = deriveAgentProfileAuthorityDispositionV1(stateForCell(cell));
      if (result.outcome !== 'decided') continue;
      expect(ACCEPTED_DISPOSITIONS).toContain(result.disposition);
    }
  });

  it('refuses an applied status outside the union rather than falling through', () => {
    const rogue = stateForCell({
      row: 2, state: 'present', status: 'active', slots: 'empty', overflow: false,
      expected: decided('discoverable'),
    });
    const forged = { ...rogue, status: 'resurrected' } as unknown as SystemRecordAppliedStateV1;
    expect(() => deriveAgentProfileAuthorityDispositionV1(forged))
      .toThrow(/unmapped system-record applied status/u);
  });
});
