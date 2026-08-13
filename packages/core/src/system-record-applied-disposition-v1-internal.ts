import type { SystemRecordAppliedStateV1 } from './system-record-applied-state-v1.js';
import type { AgentProfileAcceptedAuthorityStateV1 } from './system-record-authority-v1-internal.js';

/**
 * The authority disposition domain, taken from the state core's evaluator
 * consumes rather than restated, so the two cannot drift apart.
 */
export type AgentProfileAuthorityDispositionV1 =
  AgentProfileAcceptedAuthorityStateV1['disposition'];

/**
 * The applied statuses V1 has not decided an authority disposition for.
 *
 * Kept as two distinct members rather than one `terminal` label: a tombstone and
 * a shadow-mode tombstone are separate open questions with separate owners, and
 * collapsing them would let one decision silently answer the other.
 */
export type AgentProfileUndecidedTerminalStatusV1 = 'tombstone' | 'dirty';

/**
 * What a persisted applied row derives to.
 *
 * A DISCRIMINATED RESULT, NOT A WIDENED DISPOSITION DOMAIN. The two states are
 * different kinds of answer: one is a decision core's evaluator can act on, the
 * other is the recorded absence of a decision. Encoding the second as extra
 * members of the disposition union would make every consumer responsible for
 * remembering which strings are not really dispositions — a two-name check that
 * silently under-covers the moment a third undecided state appears. The shape
 * below makes decided-versus-undecided a branch the compiler forces, so a new
 * undecided status is a type error at every consumer rather than a value that
 * slips through an enumeration nobody updated.
 *
 * `disposition` is reachable only after narrowing on `outcome`, and it is
 * exactly {@link AgentProfileAuthorityDispositionV1} — never a superset.
 */
export type AgentProfileAuthorityDispositionResultV1 =
  | {
      readonly outcome: 'decided';
      readonly disposition: AgentProfileAuthorityDispositionV1;
    }
  | {
      readonly outcome: 'undecided-terminal';
      readonly status: AgentProfileUndecidedTerminalStatusV1;
    };

function decided(
  disposition: AgentProfileAuthorityDispositionV1,
): AgentProfileAuthorityDispositionResultV1 {
  return Object.freeze({ outcome: 'decided', disposition });
}

function undecidedTerminal(
  status: AgentProfileUndecidedTerminalStatusV1,
): AgentProfileAuthorityDispositionResultV1 {
  return Object.freeze({ outcome: 'undecided-terminal', status });
}

/**
 * Whether the row carries the persisted trace of a terminal transition
 * equivocation.
 *
 * THE SUBSTRATE, AND WHY IT NEEDS NO PER-SLOT TYPE TAG. `conflictDigestSlots`
 * has exactly three write sites, all in storage's
 * `system-record-next-state-v1-internal.ts`: the active carry-forward
 * (:343-345), the quarantine merge (:469-477) and the tombstone carry-forward
 * (:708-710). Only the merge ADDS, it adds only `entry.type === 'transition'`
 * digests (:471-472), and only when `facts.terminalTransitionConflict` is set
 * (:470) -- the flag that distinguishes a transition equivocation from an
 * ordinary head fork, and one storage re-derives from the evidence entries and
 * cross-checks (`system-record-verified-replacement-v1-internal.ts:776-778`) so
 * it cannot be asserted independently of the evidence it describes. A non-empty
 * slot array therefore MEANS a terminal transition conflict was once merged,
 * and nothing else in the system can put a digest there. That write-site
 * structure is pinned by
 * `packages/storage/test/system-record-conflict-slot-substrate-v1.test.ts`, so
 * this reader's premise fails loudly rather than silently if a future writer
 * repurposes the array.
 *
 * `conflictOverflow` is included because it records slots that were dropped:
 * the merge keeps only the first `SYSTEM_RECORD_MAX_CONFLICT_DIGESTS` and sets
 * the flag for the remainder (:475-477). Reading the array alone would let a
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
 * owes is restart survival: the same result from the quads alone.
 *
 * THE EQUIVOCATION TEST RUNS BEFORE THE STATUS SWITCH, AND THAT ORDER IS
 * LOAD-BEARING -- it is not a defensive default. Measured at integration head
 * 97f4c9e69: the write path cannot currently produce an `active` row carrying
 * slots, because the unquarantine gate
 * (`system-record-next-state-v1-internal.ts:1111`) defers while slots are
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
): AgentProfileAuthorityDispositionResultV1 {
  // No snapshot, nothing quarantined: core rejects any other reading of an
  // absent row (authority :217, :532), so this is forced, not chosen.
  if (applied.state === 'absent') return decided('discoverable');

  if (hasPersistedTransitionEquivocationV1(applied)) {
    return decided('transition-equivocation-quarantined');
  }

  switch (applied.status) {
    case 'active':
      return decided('discoverable');
    case 'quarantined':
      // Quarantined with no transition evidence retained: a head fork, which
      // core clears through its fork-resolution-successor branch (authority
      // :326, :433, :569) rather than holding permanently.
      return decided('head-fork-quarantined');
    case 'tombstone':
      // NOT inert, and NOT `discoverable`. The projection is deleted (plan
      // :250-253) so discovery is moot, but core reads the disposition on the
      // authority branches (:139, :326) when deciding the NEXT candidate for
      // this record, and V1 defines no answer for a tombstoned row. Reporting
      // the gap is the only reading that does not invent a clearance.
      return undecidedTerminal('tombstone');
    case 'dirty':
      // The shadow-mode tombstone derivation's status
      // (`system-record-next-state-v1-internal.ts:692`, mirrored at :1008). Its
      // disposition follows whatever the cutover decides shadow rows mean, so
      // it is undecided for the same reason and under its own status -- one
      // decision must not silently answer the other.
      return undecidedTerminal('dirty');
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
