import { appendFileSync } from 'node:fs';

/**
 * A trace of the admissions to the global sync slots, for devnet tests that
 * must know which admission held a slot, and when (the issue-3251 devnet
 * suite keeps one member's only slot busy with a large transfer and checks
 * that the transfer held it while the member received other writes).
 *
 * Off unless `DKG_SYNC_ADMISSION_TRACE` names a file. Then each admission
 * appends one line once it holds its slot and one once its work has settled,
 * just before the slot is freed:
 *
 *   {"event":"start","id":"<pid>-<n>","label":"shared-memory:<graph>:<peer>","reserved":false,
 *    "limit":1,"queueLimit":0,"partitioned":false,"at":<epoch ms>}
 *   {"event":"release","id":"<pid>-<n>",...,"at":<epoch ms>}
 *
 * `id` is opaque and the same on both lines of an admission, so the interval
 * between them lies within the time the admission held its slot. The label is
 * the one the `Sync backpressure running` log line names; `reserved` says the
 * admission holds a reserved shared-memory slot rather than a general one.
 * `limit`, `queueLimit` and `partitioned` are the general pool's effective
 * policy (the `global inflight=…/limit, queued=…/queueLimit` of the log line):
 * the diagnostics report one pool grown by the reserved slots, so a reader
 * that must know the general pool takes it from here. A line that cannot be
 * written is skipped: the trace never stands in the way of sync.
 */
let sequence = 0;

export interface SyncAdmissionTraceContext {
  /** The admission holds a reserved shared-memory slot rather than a general one. */
  reserved?: boolean;
  /** The general pool's effective policy. */
  limit?: number | null;
  queueLimit?: number | null;
  partitioned?: boolean;
}

export async function traceSyncAdmission<T>(
  label: string,
  work: () => Promise<T>,
  { reserved = false, limit = null, queueLimit = null, partitioned = false }: SyncAdmissionTraceContext = {},
): Promise<T> {
  const file = process.env.DKG_SYNC_ADMISSION_TRACE;
  if (!file) return work();
  sequence += 1;
  const id = `${process.pid}-${sequence}`;
  const write = (event: 'start' | 'release'): void => {
    try {
      appendFileSync(file, `${JSON.stringify({ event, id, label, reserved, limit, queueLimit, partitioned, at: Date.now() })}\n`);
    } catch {
      // A trace that cannot be written is no reason to fail the sync work.
    }
  };
  write('start');
  try {
    return await work();
  } finally {
    write('release');
  }
}
