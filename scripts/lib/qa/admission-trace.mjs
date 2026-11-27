// The admissions to a node's global sync slots, as the node's own admission
// trace records them. The agent writes it (packages/agent/src/sync/
// admission-trace.ts) when DKG_SYNC_ADMISSION_TRACE names a file: one JSON line
// when an admission holds its slot, one when its work has settled, just before
// the slot is freed, and, while any admission holds a slot, a `holding` line
// that lists the ones that do, once a second. A start and a release carry the
// admission's opaque id, its label (the one the `Sync backpressure running` log
// line names), its slot (`general`, or the reserve whose slot it holds), the
// general pool's effective policy, and the time in ms.
//
// A line the node could not write is missing from the trace. So an admission
// is taken to hold its slot from its start to the last line that shows it
// holding, its release or a `holding` line that lists it, and no longer: a
// release that was lost, or a process that died, ends the evidence there.

/**
 * Every admission the trace records, in the order they started: { id, label,
 * slot, policy: { limit, queueLimit, partitioned } (the general pool's, as the
 * trace names it; null where it names none), startedAt, releasedAt (null when
 * no release was read), heldUntil (the last moment a line shows it holding its
 * slot: its release, the last `holding` line that lists it, or its start) }.
 * Lines that are not trace records are skipped, and so are a release without
 * its start and the ids of a `holding` line that have none.
 */
export function traceAdmissions(text) {
  const admissions = new Map();
  for (const line of String(text ?? '').split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record === null || typeof record !== 'object' || !Number.isFinite(record.at)) continue;
    if (record.event === 'holding') {
      for (const id of Array.isArray(record.ids) ? record.ids : []) {
        const admission = admissions.get(id);
        if (admission?.releasedAt === null) admission.heldUntil = Math.max(admission.heldUntil, record.at);
      }
      continue;
    }
    if (typeof record.id !== 'string' || typeof record.label !== 'string') continue;
    if (record.event === 'start' && !admissions.has(record.id)) {
      const number = value => (Number.isFinite(value) ? value : null);
      const policy = { limit: number(record.limit), queueLimit: number(record.queueLimit), partitioned: record.partitioned === true };
      const slot = typeof record.slot === 'string' && record.slot ? record.slot : 'unknown';
      admissions.set(record.id, { id: record.id, label: record.label, slot, policy, startedAt: record.at, releasedAt: null, heldUntil: record.at });
    } else if (record.event === 'release' && admissions.get(record.id)?.releasedAt === null) {
      const admission = admissions.get(record.id);
      admission.releasedAt = record.at;
      admission.heldUntil = Math.max(admission.heldUntil, record.at);
    }
  }
  return [...admissions.values()];
}
