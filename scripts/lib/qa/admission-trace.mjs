// The admissions to a node's global sync slots, as the node's own admission
// trace records them: the agent writes it (packages/agent/src/sync/
// admission-trace.ts) when DKG_SYNC_ADMISSION_TRACE names a file, one JSON line
// when an admission holds its slot and one when its work has settled, just
// before the slot is freed, each with the admission's opaque id, its label (the
// one the `Sync backpressure running` log line names), whether it holds a
// reserved shared-memory slot rather than a general one, the general pool's
// effective policy, and the time in ms.

/**
 * Every admission the trace records, in the order they started: { id, label,
 * reserved, policy: { limit, queueLimit, partitioned } (the general pool's, as
 * the trace names it; null where it names none), startedAt, releasedAt (null
 * while it holds its slot) }. Lines that are not trace records are skipped, and
 * so is a release without its start.
 */
export function traceAdmissions(text) {
  const admissions = new Map();
  for (const line of String(text ?? '').split('\n')) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record === null || typeof record !== 'object' || typeof record.id !== 'string' || typeof record.label !== 'string' || !Number.isFinite(record.at)) continue;
    if (record.event === 'start' && !admissions.has(record.id)) {
      const number = value => (Number.isFinite(value) ? value : null);
      const policy = { limit: number(record.limit), queueLimit: number(record.queueLimit), partitioned: record.partitioned === true };
      admissions.set(record.id, { id: record.id, label: record.label, reserved: record.reserved === true, policy, startedAt: record.at, releasedAt: null });
    } else if (record.event === 'release' && admissions.get(record.id)?.releasedAt === null) {
      admissions.get(record.id).releasedAt = record.at;
    }
  }
  return [...admissions.values()];
}
