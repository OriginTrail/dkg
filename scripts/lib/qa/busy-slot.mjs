// The judgements of case 6 of devnet-test-issue-3251-member-sharing.mjs: did
// the large transfer hold member 2's general sync slot while the writes were
// made and received? Kept apart from the devnet I/O so that each one is tested
// on its own.
//
// The evidence is the node's own admission trace (admission-trace.mjs), which
// names each admission, the slot it holds (the general one, or a reserved one
// of the fixes under test: shared-memory pulls #3258, control-plane fetches
// #3302), the general pool's effective policy, and until when a line shows it
// holding its slot. The node's diagnostics cannot serve: they report one pool,
// grown by the reserved slots.

/** How long the transfer must have held the general slot before the writes start: a pull that ends at once is not the transfer. */
export const TRANSFER_CONFIRM_MS = 5_000;
/** The trace lists the admissions that hold a slot once a second: one that no line of the last few seconds lists may have ended. */
export const TRACE_FRESH_MS = 3_000;

/**
 * Whether the general sync pool has the policy of case 6's member: one slot
 * and no queue (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`), as an
 * admission's trace record names it. That is the node's effective policy, so
 * an environment override (`DKG_SYNC_GLOBAL_MAX_INFLIGHT`, …) that gave it
 * spare slots shows here. The reserved slots beside the general one are not
 * counted: they are the fixes under test. Returns null when it does, else the
 * reason.
 */
export function singleSlotProblem(policy) {
  if (!policy || policy.limit === null || policy.limit === undefined) return 'its trace names no sync policy';
  if (policy.partitioned) return 'its general sync slots are partitioned, not one pool';
  if (policy.limit !== 1) return `the node runs ${policy.limit} general sync slot(s), not one`;
  if (policy.queueLimit !== 0) return `the node has a general sync queue of ${policy.queueLimit ?? 'unknown size'}, not none`;
  return null;
}

/**
 * Whether the large transfer holds the node's only general sync slot at `now`:
 * its trace (`admissions`, null when the node wrote none) shows an admission
 * of the large graph (`isTransfer`) in the general slot, under the policy of
 * case 6, that has no release, that a line of the last `freshMs` shows holding
 * the slot, and that has held it for `confirmMs` already. A reserved slot
 * leaves the general one to other work, so a transfer there is not the case.
 * A catch-up job that is merely running proves nothing: without an admission
 * there is nothing that holds the slot. Returns { transfer } (its admission)
 * or { why }.
 */
export function heldTransfer(admissions, isTransfer, { now, confirmMs = TRANSFER_CONFIRM_MS, freshMs = TRACE_FRESH_MS }) {
  if (admissions === null) return { why: 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)' };
  const transfers = admissions.filter(isTransfer);
  if (transfers.length === 0) return { why: 'no transfer of it was admitted to a sync slot' };
  const holding = transfers.filter(admission => admission.releasedAt === null && now - admission.heldUntil <= freshMs);
  const general = holding.filter(admission => admission.slot === 'general');
  const confirmed = general.filter(admission => admission.heldUntil - admission.startedAt >= confirmMs);
  if (confirmed.length) {
    const transfer = confirmed.at(-1);
    const policy = singleSlotProblem(transfer.policy);
    return policy ? { why: policy } : { transfer };
  }
  if (general.length) return { why: `its transfer of the large graph has held the general slot for less than ${Math.round(confirmMs / 1000)} s` };
  if (holding.length) return { why: `its transfer of the large graph holds a reserved ${holding.at(-1).slot} slot, not the general one` };
  return { why: 'no transfer of it holds a slot now: each gave it up, or no recent trace line shows it holding' };
}

/**
 * How long the node's general sync slot has been free at `now`, by its trace:
 * 0 while a recent line shows an admission holding it, else the time since the
 * last line that did (`Infinity` for a trace without one). A new pull admitted
 * while the slot is free takes it.
 */
export function generalSlotIdleFor(admissions, now, { freshMs = TRACE_FRESH_MS } = {}) {
  const general = (admissions ?? []).filter(admission => admission.slot === 'general');
  if (general.some(admission => admission.releasedAt === null && now - admission.heldUntil <= freshMs)) return 0;
  const last = Math.max(-Infinity, ...general.map(admission => admission.heldUntil));
  return Math.max(0, now - last);
}

/**
 * Until when the trace shows the transfer in the general slot, read once the
 * window of the writes and their receipt checks has ended at `until`: its
 * release, or the last `holding` line that lists it, never later (a lost
 * release or a dead process ends the evidence there). Another admission in
 * the one general slot meanwhile contradicts the trace, and then nothing is
 * proven. Returns { held (through `until`), provenUntil, reason }.
 */
export function busySlotCovered({ transfer, admissions, until }) {
  if (!transfer) return { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null };
  const traced = admissions?.find(admission => admission.id === transfer.id);
  if (!traced) return { held: false, reason: 'the trace no longer shows the transfer', provenUntil: null };
  const other = admissions.find(admission => admission.id !== traced.id && admission.slot === 'general'
    && admission.startedAt < traced.heldUntil && admission.heldUntil > traced.startedAt);
  if (other) return { held: false, reason: `the trace shows ${other.label} in the one general slot while the transfer held it`, provenUntil: null };
  const provenUntil = traced.heldUntil;
  if (provenUntil >= until) return { held: true, provenUntil };
  return {
    held: false,
    provenUntil,
    reason: traced.releasedAt === null ? 'no trace line shows the transfer holding the slot after then' : 'the transfer gave up the slot',
  };
}

/**
 * Whether a write that a read found at `receivedAt` (when that read completed)
 * was received while the transfer held the slot (`busy` from busySlotCovered):
 * no later than the last moment the trace shows it holding. A receipt after
 * that is not: the slot may by then have gone to the pull that delivered the
 * write.
 */
export const receivedWhileHeld = (receivedAt, busy) => busy.provenUntil !== null && receivedAt <= busy.provenUntil;

/**
 * The admissions of `isOther` (the public graph's pulls) that held a slot
 * between `from` and `to`, counted by slot: { 'shared-memory': 2, … }.
 */
export function admissionsBySlot(admissions, isOther, from, to) {
  const counts = {};
  for (const admission of admissions ?? []) {
    if (!isOther(admission) || admission.startedAt > to || admission.heldUntil < from) continue;
    counts[admission.slot] = (counts[admission.slot] ?? 0) + 1;
  }
  return counts;
}
