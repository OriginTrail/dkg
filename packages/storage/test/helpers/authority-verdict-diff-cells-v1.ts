import { VERDICT_DIFF_AXES_V1 } from './authority-verdict-diff-fixture-v1.js';

/**
 * The verdict-diff case generator.
 *
 * The twelve axes are NOT independent, and enumerating their raw cross-product
 * would be both enormous (~1.3M) and mostly meaningless -- most combinations
 * describe states the axes themselves forbid. The dependency rules below come
 * from the Phase 1 spec's own axis definitions, not from reading either
 * implementation:
 *
 *   - axis B (applied status) applies only when A is 'present'.
 *   - axis D (sequence relation) applies only when A is 'present'.
 *   - axis E (version relation) applies only when D is 'equal'.
 *   - axis F (head digest)     applies only when D and E are both 'equal'.
 *   - axis G (accepted transition digest) applies only when A is 'present'.
 *
 * Where an axis does not apply, the cell records `undefined` rather than a
 * default. That distinction is load-bearing: a defaulted axis silently claims a
 * value the case never had, and the table would then assert coverage of a cell
 * that was never generated.
 */

export interface VerdictDiffCellV1 {
  readonly id: string;
  readonly snapshot: 'absent' | 'present';
  readonly appliedStatus?: 'active' | 'quarantined' | 'tombstone' | 'dirty';
  readonly candidateHeadState: 'active' | 'tombstone';
  readonly sequenceRelation?: 'below' | 'equal' | 'plusOne' | 'abovePlusOne';
  readonly versionRelation?: 'below' | 'equal' | 'above';
  readonly headDigest?: 'equal' | 'differ';
  readonly acceptedTransitionDigest?: 'equal' | 'differ';
  readonly storageOperation: 'active' | 'tombstone' | 'quarantine';
  readonly coreDisposition:
    | 'discoverable' | 'head-fork-quarantined' | 'transition-equivocation-quarantined';
  readonly evidence: readonly string[];
  readonly candidateForkResolutionDigest: 'present' | 'absent';
  readonly clock: 'valid' | 'beyondFutureSkew' | 'priorExpirySkewUnmet';
}

/**
 * THE TWO EVALUATORS READ DISJOINT SUBSETS OF THE AXES, and that is a finding
 * before it is an optimisation.
 *
 * Core's inputs are `AgentProfileAcceptedAuthorityStateV1` (:63) and
 * `AgentProfileHeadAdvanceEvidenceV1` (:76). Neither carries an applied STATUS
 * or a storage OPERATION -- there is no field to put them in. Storage's
 * classifier takes (snapshot, facts, headDigest): `facts` carries `operation`,
 * and nothing on either object carries core's `disposition` or core's evidence
 * object. So each side sees a PROJECTION of the cell, and a cell is the pair.
 *
 * The consequence is measured, not rhetorical: every storage input corresponds
 * to exactly 192 distinct core inputs -- axis I's 3 dispositions times axis J's
 * 64 evidence subsets, neither visible to storage. Core will therefore
 * discriminate 192 ways where storage cannot discriminate at all, which is what
 * "no total mapping" means concretely, and what Phase 3 inherits if it routes
 * the live path through core.
 *
 * The lists below are load-bearing rather than decorative: the projection keys
 * are BUILT from them, so moving an axis between the visible and invisible sets
 * moves the pinned input counts.
 */
export const CORE_INVISIBLE_AXES_V1 = ['B_appliedStatus', 'H_storageOperation'] as const;
export const STORAGE_INVISIBLE_AXES_V1 = ['I_coreDisposition', 'J_evidencePresence'] as const;

/** Axis name -> the cell field carrying it. Pinned complete against the axes. */
export const AXIS_TO_CELL_FIELD_V1 = {
  A_snapshot: 'snapshot',
  B_appliedStatus: 'appliedStatus',
  C_candidateHeadState: 'candidateHeadState',
  D_sequenceRelation: 'sequenceRelation',
  E_versionRelation: 'versionRelation',
  F_headDigest: 'headDigest',
  G_acceptedTransitionDigest: 'acceptedTransitionDigest',
  H_storageOperation: 'storageOperation',
  I_coreDisposition: 'coreDisposition',
  J_evidencePresence: 'evidence',
  K_candidateForkResolutionDigest: 'candidateForkResolutionDigest',
  L_clock: 'clock',
} as const;

function projectionKeyV1(cell: VerdictDiffCellV1, invisible: readonly string[]): string {
  return Object.entries(AXIS_TO_CELL_FIELD_V1)
    .filter(([axis]) => !invisible.includes(axis))
    .map(([, field]) => {
      const value = (cell as unknown as Record<string, unknown>)[field];
      return Array.isArray(value) ? [...value].sort().join('+') : String(value);
    })
    .join('|');
}

/**
 * Two cells sharing this key present IDENTICAL inputs to core.
 *
 * THE KEY OVER-DISCRIMINATES SINCE RULE S1 WAS REMOVED, AND IT IS LEFT ALONE.
 * A cell naming `verifiedAuthoritySummary` on a head shape that cannot mint one
 * now builds the same evidence object as the cell without that member, so the
 * two sit in different projections while presenting byte-identical inputs. The
 * key's contract is only that cells SHARING a key present identical inputs,
 * which over-discrimination cannot violate, and editing a reviewed key to merge
 * groups would change the thing being measured for no gain.
 *
 * THE MEASUREMENT GOES BESIDE THE PIN INSTEAD -- the axis-L precedent, where the
 * clock's invisibility to storage was recorded as a number rather than legislated
 * into the key. Here it is CORE_SUMMARY_INDEPENDENCE_V1: all 9,792 affected
 * projections returned identical verdicts with a foreign summary and with the
 * member absent. That is also the strongest projection-equivalence evidence this
 * harness holds, because it is an equality established over the evaluator's
 * OUTPUT rather than over its constructed input.
 */
export function coreInputProjectionKeyV1(cell: VerdictDiffCellV1): string {
  return projectionKeyV1(cell, CORE_INVISIBLE_AXES_V1);
}

/** Two cells sharing this key present IDENTICAL inputs to the storage entry. */
export function storageInputProjectionKeyV1(cell: VerdictDiffCellV1): string {
  return projectionKeyV1(cell, STORAGE_INVISIBLE_AXES_V1);
}

/** Every subset of the optional evidence members (axis J): 2^6 = 64. */
function evidenceSubsets(): readonly (readonly string[])[] {
  const members = VERDICT_DIFF_AXES_V1.J_evidencePresence;
  const out: string[][] = [];
  for (let mask = 0; mask < 1 << members.length; mask += 1) {
    out.push(members.filter((_, bit) => (mask & (1 << bit)) !== 0));
  }
  return out;
}

export function enumerateVerdictDiffCellsV1(): readonly VerdictDiffCellV1[] {
  const A = VERDICT_DIFF_AXES_V1;
  const cells: VerdictDiffCellV1[] = [];
  let n = 0;

  for (const snapshot of A.A_snapshot) {
    // Axis B applies only to a present snapshot.
    const statuses = snapshot === 'present'
      ? [...A.B_appliedStatus] as (VerdictDiffCellV1['appliedStatus'])[]
      : [undefined];
    for (const appliedStatus of statuses) {
      for (const candidateHeadState of A.C_candidateHeadState) {
        // Axis D relates the candidate to the CURRENT head, so it has no
        // referent when the snapshot is absent -- the same dependency axis B
        // already has, measured rather than assumed: both evaluators branch on
        // an absent current before any sequence logic runs (core
        // system-record-authority-v1-internal.ts:111/:531/:678; storage
        // next-state-v1-internal.ts:1092 returns rematerialize immediately).
        const sequences = snapshot === 'present'
          ? [...A.D_sequenceRelation] as (VerdictDiffCellV1['sequenceRelation'])[]
          : [undefined];
        for (const sequenceRelation of sequences) {
          // Axis E applies only at an equal sequence.
          const versions = sequenceRelation === 'equal'
            ? [...A.E_versionRelation] as (VerdictDiffCellV1['versionRelation'])[]
            : [undefined];
          for (const versionRelation of versions) {
            // Axis F applies only when sequence AND version are both equal.
            const digests = sequenceRelation === 'equal' && versionRelation === 'equal'
              ? [...A.F_headDigest] as (VerdictDiffCellV1['headDigest'])[]
              : [undefined];
            for (const headDigest of digests) {
              // Axis G relates the candidate's acceptedTransitionDigest to the
              // CURRENT head's, so like axis D it has no referent when the
              // snapshot is absent. Ruled 2026-08-11 after measurement: the
              // transition-equivocation decision the spec names this axis for is
              // core system-record-authority-v1-internal.ts:171, whose referent is
              // `current`, and :111 diverts to the absent branch before it ever
              // runs; storage returns at next-state-v1-internal.ts:1092 for an
              // absent snapshot without reading the field at all. Left ungated the
              // fixture could not build 'equal' and 'differ' as DISTINCT inputs
              // there -- both cells would carry identical inputs, so it is not an
              // axis in that region.
              //
              // THE FIELD IS STILL LIVE ON THE ABSENT-TOMBSTONE SUB-PATH, against
              // a different referent: :254 calls isTombstoneBoundToPredecessorV1,
              // which compares the candidate's acceptedTransitionDigest to
              // summary.tombstonePredecessor's -- EVIDENCE, not the accepted head.
              // That is a fixture obligation rather than an axis, and it ships
              // WITH A DRIVER (authority-verdict-diff-evidence-binding-v1.test.ts)
              // because a demotion without one lets the pin arithmetic reconcile
              // while the coverage driving that refusal quietly falls.
              const transitionDigests = snapshot === 'present'
                ? [...A.G_acceptedTransitionDigest] as
                  (VerdictDiffCellV1['acceptedTransitionDigest'])[]
                : [undefined];
              for (const acceptedTransitionDigest of transitionDigests) {
                for (const storageOperation of A.H_storageOperation) {
                  for (const coreDisposition of A.I_coreDisposition) {
                    for (const evidence of evidenceSubsets()) {
                      for (const candidateForkResolutionDigest of A.K_candidateForkResolutionDigest) {
                        for (const clock of A.L_clock) {
                          n += 1;
                          cells.push({
                            id: `cell-${String(n).padStart(5, '0')}`,
                            snapshot,
                            ...(appliedStatus === undefined ? {} : { appliedStatus }),
                            candidateHeadState,
                            ...(sequenceRelation === undefined
                              ? {} : { sequenceRelation }),
                            ...(versionRelation === undefined ? {} : { versionRelation }),
                            ...(headDigest === undefined ? {} : { headDigest }),
                            ...(acceptedTransitionDigest === undefined
                              ? {} : { acceptedTransitionDigest }),
                            storageOperation,
                            coreDisposition,
                            evidence,
                            candidateForkResolutionDigest,
                            clock,
                          });
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return cells;
}
