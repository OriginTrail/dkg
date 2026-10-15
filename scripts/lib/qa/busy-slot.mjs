// The judgements of case 6 of devnet-test-issue-3251-member-sharing.mjs: did
// the large transfer hold member 2's only sync slot while the writes were made
// and received? Kept apart from the devnet I/O so that each one is tested on
// its own.
//
// The evidence is the node's own: its effective sync policy (`sync-global` in
// /api/diagnostics/backpressure) and its admission trace (admission-trace.mjs),
// which names each admission and when it took and gave up its slot.

/**
 * Whether a reading shows the policy of case 6's member: one sync slot and no
 * queue (`syncGlobalMaxInflight: 1`, `syncGlobalQueueLimit: 0`). The reading
 * reports the node's effective policy, so an environment override
 * (`DKG_SYNC_GLOBAL_MAX_INFLIGHT`, …) that gave it spare slots shows here.
 * Returns null when it does, else the reason.
 */
export function singleSlotProblem(reading) {
  if (!reading || reading.unreadable) return `the sync slots could not be read (${reading?.unreadable ?? 'no reading'})`;
  if (reading.capacityModel !== 'shared') return `the sync slots are not one shared pool (${reading.capacityModel ?? 'no capacity model'})`;
  if (reading.inflightLimit !== 1) return `the node runs ${reading.inflightLimit ?? 'an unknown number of'} sync slot(s), not one`;
  if (reading.queueLimit !== 0) return `the node has a sync queue of ${reading.queueLimit ?? 'unknown size'}, not none`;
  return null;
}

/**
 * Whether the large transfer holds the node's only sync slot now: the node runs
 * the policy of case 6 (`reading`), and its trace (`admissions`, null when the
 * node wrote none) shows an admission of the large graph (`isTransfer`) that
 * took the global slot (not a reserved shared-memory slot beside it) and has
 * not given it up; the latest such admission is the transfer. A catch-up job
 * that is merely running proves nothing: without an admission there is nothing
 * that holds the slot. Returns { transfer } (its admission) or { why }.
 */
export function heldTransfer(reading, admissions, isTransfer) {
  const policy = reading === undefined ? 'no reading yet' : singleSlotProblem(reading);
  if (policy) return { why: policy };
  if (admissions === null) return { why: 'the node writes no admission trace (DKG_SYNC_ADMISSION_TRACE)' };
  const transfers = admissions.filter(isTransfer);
  const holding = transfers.filter(admission => admission.releasedAt === null);
  const global = holding.filter(admission => !admission.reserved);
  if (global.length) return { transfer: global.at(-1) };
  if (holding.length) return { why: 'its transfer of the large graph holds a reserved shared-memory slot, not the only global one' };
  return { why: transfers.length ? 'its transfer of the large graph had already given up the slot' : 'no transfer of it was admitted to a sync slot' };
}

/**
 * How long the transfer held the slot, from the trace read once the window
 * [from, until] of the writes and their receipt checks has ended, at
 * `readAt`: until its release, or, while it has none, until the read. The
 * policy must still be the one of case 6 (`policy`: singleSlotProblem of a
 * reading taken then). Returns { held (through `until`), provenUntil, reason }.
 */
export function busySlotCovered({ transfer, admissions, policy, readAt, until }) {
  if (!transfer) return { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null };
  if (policy) return { held: false, reason: policy, provenUntil: null };
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
