// The judgements of case 6 of devnet-test-issue-3251-member-sharing.mjs: did
// the large transfer hold member 2's only sync slot while the writes were made
// and received? Kept apart from the devnet I/O so that each one is tested on
// its own.
//
// The evidence is the node's own admission trace (admission-trace.mjs), which
// names each admission, whether it holds a general or a reserved shared-memory
// slot, the general pool's effective policy, and when it took and gave up its
// slot. The node's diagnostics cannot serve: they report one pool, grown by
// the reserved slot of the fix under test (#3258).

/**
 * Whether the general sync pool has the policy of case 6's member: one slot
 * and no queue (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`), as an
 * admission's trace record names it. That is the node's effective policy, so
 * an environment override (`DKG_SYNC_GLOBAL_MAX_INFLIGHT`, …) that gave it
 * spare slots shows here. A reserved shared-memory slot beside the general one
 * is not counted: it is the fix under test. Returns null when it does, else
 * the reason.
 */
export function singleSlotProblem(policy) {
  if (!policy || policy.limit === null || policy.limit === undefined) return 'its trace names no sync policy';
  if (policy.partitioned) return 'its general sync slots are partitioned, not one pool';
  if (policy.limit !== 1) return `the node runs ${policy.limit} general sync slot(s), not one`;
  if (policy.queueLimit !== 0) return `the node has a general sync queue of ${policy.queueLimit ?? 'unknown size'}, not none`;
  return null;
}

/**
 * Whether the large transfer holds the node's only general sync slot now: its
 * trace (`admissions`, null when the node wrote none) shows an admission of the
 * large graph (`isTransfer`) that took the general slot (not a reserved
 * shared-memory slot beside it) and has not given it up, under the policy of
 * case 6; the latest such admission is the transfer. A catch-up job that is
 * merely running proves nothing: without an admission there is nothing that
 * holds the slot. Returns { transfer } (its admission) or { why }.
 */
export function heldTransfer(admissions, isTransfer) {
  if (admissions === null) return { why: 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)' };
  const transfers = admissions.filter(isTransfer);
  const holding = transfers.filter(admission => admission.releasedAt === null);
  const general = holding.filter(admission => !admission.reserved);
  if (general.length) {
    const transfer = general.at(-1);
    const policy = singleSlotProblem(transfer.policy);
    return policy ? { why: policy } : { transfer };
  }
  if (holding.length) return { why: 'its transfer of the large graph holds a reserved shared-memory slot, not the general one' };
  return { why: transfers.length ? 'its transfer of the large graph had already given up the slot' : 'no transfer of it was admitted to a sync slot' };
}

/**
 * How long the transfer held the general slot, from the trace read once the
 * window [from, until] of the writes and their receipt checks has ended, at
 * `readAt`: until its release, or, while it has none, until the read. Returns
 * { held (through `until`), provenUntil, reason }.
 */
export function busySlotCovered({ transfer, admissions, readAt, until }) {
  if (!transfer) return { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null };
  const traced = admissions?.find(admission => admission.id === transfer.id);
  if (!traced) return { held: false, reason: 'the trace no longer shows the transfer', provenUntil: null };
  const provenUntil = traced.releasedAt ?? readAt;
  return provenUntil >= until
    ? { held: true, provenUntil }
    : { held: false, reason: 'the transfer gave up the slot', provenUntil };
}

/**
 * Whether a write that a read found at `receivedAt` (when that read completed)
 * was received while the transfer held the slot (`busy` from busySlotCovered):
 * no later than its release, or than the trace read while it had none. A
 * receipt after the release is not: the slot may by then have gone to the pull
 * that delivered the write.
 */
export const receivedWhileHeld = (receivedAt, busy) => busy.provenUntil !== null && receivedAt <= busy.provenUntil;
