import type { SystemRecordAppliedStateV1 } from './system-record-applied-state-v1.js';
import type { AgentProfileAcceptedAuthorityStateV1 } from './system-record-authority-v1-internal.js';

/**
 * The authority disposition domain, taken from the state core's evaluator
 * consumes rather than restated, so the two cannot drift apart.
 */
export type AgentProfileAuthorityDispositionV1 =
  AgentProfileAcceptedAuthorityStateV1['disposition'];

/**
 * What a persisted applied row derives to.
 *
 * Wider than {@link AgentProfileAuthorityDispositionV1} by two `undecided-`
 * members. They are values, not absences: V1 has not decided what a terminal
 * row's authority disposition is, and the honest encoding of "not decided" is a
 * member of the domain that no consumer can mistake for a decision. Assigning
 * this type where an authority disposition is required is a type error until
 * the caller handles both, which is the point -- an `undecided-` row must not
 * reach discovery, dialing or a fork-resolution branch by default.
 */
export type AgentProfileDerivedAuthorityDispositionV1 =
  | AgentProfileAuthorityDispositionV1
  | 'undecided-tombstone-disposition'
  | 'undecided-shadow-tombstone-disposition';

/**
 * Whether the row carries the persisted trace of a terminal transition
 * equivocation.
 *
 * THE SUBSTRATE, AND WHY IT NEEDS NO PER-SLOT TYPE TAG. `conflictDigestSlots`
 * has exactly three write sites, all in storage's
 * `system-record-next-state-v1-internal.ts`: the active carry-forward
 * (:343-345), the quarantine merge (:456-464) and the tombstone carry-forward
 * (:695-697). Only the merge ADDS, it adds only `entry.type === 'transition'`
 * digests (:458-459), and only when `facts.terminalTransitionConflict` is set
 * (:457) -- the flag that distinguishes a transition equivocation from an
 * ordinary head fork, and one storage re-derives from the evidence entries and
 * cross-checks (`system-record-verified-replacement-v1-internal.ts:776-778`) so
 * it cannot be asserted independently of the evidence it describes. A non-empty
 * slot array therefore MEANS a terminal transition conflict was once merged,
 * and nothing else in the system can put a digest there.
 *
 * `conflictOverflow` is included because it records slots that were dropped:
 * the merge keeps only the first `SYSTEM_RECORD_MAX_CONFLICT_DIGESTS` and sets
 * the flag for the remainder (:462-464). Reading the array alone would let a
 * record that equivocated MORE than the cap read as clean -- the failure mode
 * would arrive exactly on the worst-behaved peers.
 *
 * DO NOT NARROW THIS TO `status === 'quarantined'`. That is the reading the
 * substrate exists to replace: core separates materialization status from
 * authority disposition, so a tombstoned or shadow-tombstoned row can carry an
 * equivocation, and plan :252-253 has terminal states retain precisely these
 * "precharged security/conflict slots" for that reason.
 */
function hasPersistedTransitionEquivocationV1(
  applied: Extract<SystemRecordAppliedStateV1, { readonly state: 'present' }>,
): boolean {
  return applied.conflictDigestSlots.length > 0 || applied.conflictOverflow;
}

/**
 * Derives the authority disposition core's head-advance evaluator consumes from
 * the applied state persisted in reserved RDF.
 *
 * WHY THIS EXISTS. `evaluateAgentProfileHeadAdvanceV1` takes
 * `AgentProfileAcceptedAuthorityStateV1.disposition` as an INPUT and persists
 * nothing; `disposition` appears zero times in `packages/storage/src`. Plan
 * line 204 requires a transition-equivocation quarantine to hold "across later
 * heads/restart/provider changes". Without a derivation from persisted state
 * the quarantine lives only in whatever object last held it, so it dies at
 * every process start and the sticky short-circuit at
 * `system-record-authority-v1-internal.ts:139-140` becomes a guard that cannot
 * fire in production. This function is that derivation, and the property it
 * owes is restart survival: the same disposition from the quads alone.
 *
 * THE EQUIVOCATION TEST RUNS BEFORE THE STATUS SWITCH, AND THAT ORDER IS
 * LOAD-BEARING -- it is not a defensive default. Measured at integration head
 * 97f4c9e69: the write path cannot currently produce an `active` row carrying
 * slots, because the unquarantine gate
 * (`system-record-next-state-v1-internal.ts:1098`) defers while slots are
 * occupied. But that is a property of ONE disjunct in ONE classifier, not of
 * the row: the active derivation CARRIES slots forward from the snapshot
 * (:343-345) rather than clearing them, and persisted state imposes no coupling
 * at all between `status` and the slots -- an `active`, `dirty` or `tombstone`
 * row carrying slots was built and decoded through the real reserved-state
 * codec while proving out this slice. A reader consumes decoded quads, not the
 * write path's output, so it must not inherit the write path's invariant.
 * Ordering the equivocation test first is what makes that true by construction.
 */
export function deriveAgentProfileAuthorityDispositionV1(
  applied: SystemRecordAppliedStateV1,
): AgentProfileDerivedAuthorityDispositionV1 {
  // No snapshot, nothing quarantined: core rejects any other reading of an
  // absent row (authority :217, :532), so this is forced, not chosen.
  if (applied.state === 'absent') return 'discoverable';

  if (hasPersistedTransitionEquivocationV1(applied)) {
    return 'transition-equivocation-quarantined';
  }

  switch (applied.status) {
    case 'active':
      return 'discoverable';
    case 'quarantined':
      // Quarantined with no transition evidence retained: a head fork, which
      // core clears through its fork-resolution-successor branch (authority
      // :326, :433, :569) rather than holding permanently.
      return 'head-fork-quarantined';
    case 'tombstone':
      // NOT inert, and NOT `discoverable`. The projection is deleted (plan
      // :250-253) so discovery is moot, but core reads the disposition on the
      // authority branches (:139, :326) when deciding the NEXT candidate for
      // this record, and V1 defines no answer for a tombstoned row. Naming the
      // gap is the only reading that does not invent a clearance.
      return 'undecided-tombstone-disposition';
    case 'dirty':
      // The shadow-mode tombstone derivation's status
      // (`system-record-next-state-v1-internal.ts:679`, mirrored at :995). Its
      // disposition follows whatever the cutover decides shadow rows mean, so
      // it is undecided for the same reason and by a separate name -- one
      // decision must not silently answer the other.
      return 'undecided-shadow-tombstone-disposition';
    default: {
      // Reached only when the applied-status union grows: the assignment is the
      // compile error that makes a new status this slice's problem rather than
      // a row that quietly derives to whatever the last branch returned.
      const unmapped: never = applied.status;
      throw new Error(
        `unmapped system-record applied status: ${JSON.stringify(unmapped)}`,
      );
    }
  }
}
