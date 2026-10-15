// The judgements of case 6 of devnet-test-issue-3251-member-sharing.mjs: did
// the large transfer hold member 2's only sync slot while the writes were made
// and received? Kept apart from the devnet I/O so that each one is tested on
// its own.
//
// The evidence is the node's own: its diagnostics (`sync-global` in
// /api/diagnostics/backpressure, read every second) and its log. The node
// names no admission, so which admission a reading shows is reconstructed in
// admission-identity.mjs, which lists what that rests on. Here: the policy of
// the case (one slot, no queue), the confirmation that the work in the slot is
// the transfer, the readings that show it there through the window, and which
// receipts that evidence covers.

import { identifyAdmission, sameAdmission, startInterval } from './admission-identity.mjs';

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
 * Whether a reading shows the large transfer in the slot: the policy of case
 * 6, work in flight that the reading identifies (admission-identity.mjs), and
 * only admissions of the large graph (`isTransfer`) in the log that it can be.
 * Returns { transfer } (its identity: when it started, and its class) or
 * { why }.
 */
export function heldTransfer(reading, records, isTransfer) {
  const policy = reading === undefined ? 'no reading yet' : singleSlotProblem(reading);
  if (policy) return { why: policy };
  const identified = identifyAdmission(reading, records);
  if (!identified.identity) return { why: identified.why };
  const { records: candidates, ...transfer } = identified.identity;
  if (!candidates.some(isTransfer)) return { why: 'its slot was held by other work' };
  if (!candidates.every(isTransfer)) return { why: 'its log cannot tell the transfer from other work admitted at about the same time' };
  return { transfer };
}

/**
 * How long the transfer held the node's only sync slot from `from`, the start
 * of the window of the writes and of their receipt checks, and whether that
 * reached `until`, the window's end. `transfer` is its identity from
 * heldTransfer; `samples` are readings of the node's `sync-global` scheduler
 * ({ sentAt, at, inflight, oldestActiveAgeMs, oldestOperations, inflightLimit,
 * queueLimit, capacityModel }, or { at, unreadable }), also those taken after
 * `until`.
 *
 * A reading taken before the window (a free slot before the transfer was
 * admitted, say) neither proves nor disproves anything about it. From the
 * window's start, each reading must show the single-slot policy, work in
 * flight, and that work being the transfer (sameAdmission). One admission
 * holds the slot without a break, so between two such readings the transfer
 * held it throughout; after the last one nothing is known. The evidence ends
 * at the first reading of other work, of a free slot, of another policy, or
 * that could not be read, and at a gap longer than `maxGapMs` between
 * readings. A reading that came too slowly to tell proves nothing either way,
 * like a missing one. A catch-up job that is merely running proves nothing:
 * without an admission there is nothing that holds the slot.
 *
 * Returns { held, reason, provenUntil }. `provenUntil` is the earliest moment
 * the last reading of the transfer can have been taken (when its request went
 * out): the transfer held the slot from `from` to then. `held` is whether that
 * reaches `until`; `reason` says why the evidence ended short of it.
 */
export function busySlotCovered({ transfer, samples, from, until, maxGapMs = 5000 }) {
  if (!transfer) return { held: false, reason: 'no transfer of it was admitted to a sync slot', provenUntil: null };
  const readings = samples.filter(sample => sample.at >= from).sort((a, b) => a.at - b.at);
  if (readings.length === 0) return { held: false, reason: 'no reading of the sync slot in the window', provenUntil: null };
  let previous = from;
  let provenUntil = null;
  let slow = 0;
  const gap = (ms, last = '') => `no reading of the sync slot for ${last}${Math.round(ms / 1000)} s${slow ? ` (${slow} more came too slowly to tell which work held it)` : ''}`;
  const ended = reason => ({ held: false, reason, provenUntil });
  for (const sample of readings) {
    if (sample.at - previous > maxGapMs) return ended(gap(sample.at - previous));
    if (sample.unreadable) return ended(`the sync slot could not be read (${sample.unreadable})`);
    const policy = singleSlotProblem(sample);
    if (policy) return ended(policy);
    if (!startInterval(sample)) return ended('the sync slot was free');
    const same = sameAdmission(sample, transfer);
    if (same === 'other') return ended('the slot was held by other work');
    if (same === 'unclear') {
      slow += 1;
      continue;
    }
    previous = sample.at;
    provenUntil = Number.isFinite(sample.sentAt) ? sample.sentAt : sample.at;
    slow = 0;
    if (provenUntil >= until) return { held: true, provenUntil };
  }
  if (until - previous > maxGapMs) return ended(gap(until - previous, 'the last '));
  if (provenUntil === null) return ended(gap(until - from));
  return ended('no reading of the sync slot was taken at or after the end of the window');
}

/**
 * Whether a write that a read found at `receivedAt` (when that read completed)
 * was received while the transfer held the slot: a reading taken at or after
 * that moment still showed the transfer, with the evidence unbroken since the
 * window began (`busy` from busySlotCovered). A receipt later than the last
 * such reading is not: the slot may by then have gone to the pull that
 * delivered the write.
 */
export const receivedWhileHeld = (receivedAt, busy) => busy.provenUntil !== null && receivedAt <= busy.provenUntil;
