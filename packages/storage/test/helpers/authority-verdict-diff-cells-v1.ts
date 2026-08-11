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
  readonly sequenceRelation: 'below' | 'equal' | 'plusOne' | 'abovePlusOne';
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
        for (const sequenceRelation of A.D_sequenceRelation) {
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
                            sequenceRelation,
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
