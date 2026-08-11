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
 *   - axis E (version relation) applies only when D is 'equal'.
 *   - axis F (head digest)     applies only when D and E are both 'equal'.
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
  readonly acceptedTransitionDigest: 'equal' | 'differ';
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
 * to exactly 48 distinct core inputs. Core will therefore discriminate 48 ways
 * where storage cannot discriminate at all -- which is what "no total mapping"
 * means concretely, and what Phase 3 inherits if it routes the live path
 * through core.
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

/** Two cells sharing this key present IDENTICAL inputs to core. */
export function coreInputProjectionKeyV1(cell: VerdictDiffCellV1): string {
  return projectionKeyV1(cell, CORE_INVISIBLE_AXES_V1);
}

/** Two cells sharing this key present IDENTICAL inputs to the storage entry. */
export function storageInputProjectionKeyV1(cell: VerdictDiffCellV1): string {
  return projectionKeyV1(cell, STORAGE_INVISIBLE_AXES_V1);
}

/** Every subset of the four optional evidence members (axis J). */
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
              for (const acceptedTransitionDigest of A.G_acceptedTransitionDigest) {
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
                            acceptedTransitionDigest,
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
