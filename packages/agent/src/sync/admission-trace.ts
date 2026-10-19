import { appendFileSync } from 'node:fs';

/**
 * A trace of the admissions to the global sync slots, for devnet tests that
 * must know which admission held a slot, and when (the issue-3251 devnet
 * suite keeps one member's general slot busy with a large transfer and checks
 * that the member received other writes meanwhile).
 *
 * Off unless `DKG_SYNC_ADMISSION_TRACE` names a file. Then each admission
 * appends one line once it holds its slot and one once its work has settled,
 * just before the slot is freed, and while any admission holds a slot the
 * trace lists the ones that do, once a second:
 *
 *   {"event":"start","id":"<pid>-<n>","label":"shared-memory:<graph>:<peer>","slot":"general",
 *    "limit":1,"queueLimit":0,"partitioned":false,"at":<epoch ms>}
 *   {"event":"holding","ids":["<pid>-<n>",...],"at":<epoch ms>}
 *   {"event":"release","id":"<pid>-<n>",...,"at":<epoch ms>}
 *
 * `id` is opaque and the same on every line of an admission. The label is the
 * one the `Sync backpressure running` log line names. `slot` is `general`, or
 * the reserve whose slot the admission holds (`shared-memory`,
 * `control-plane`). `limit`, `queueLimit` and `partitioned` are the general
 * pool's effective policy (the `global inflight=…/limit, queued=…/queueLimit`
 * of the log line): the diagnostics report one pool grown by the reserved
 * slots, so a reader that must know the general pool takes it from here.
 *
 * A line that cannot be written is skipped: the trace never stands in the way
 * of sync. So a reader takes an admission to hold its slot from its start to
 * the last line that shows it holding (its release, or a `holding` line that
 * lists it), and no longer: a lost release, or a process that died, ends the
 * evidence there.
 */
export const SYNC_ADMISSION_TRACE_HOLDING_MS = 1_000;

let sequence = 0;
// The admissions that hold a slot now, each with the trace file it writes to.
const holding = new Map<string, string>();
let heartbeat: ReturnType<typeof setInterval> | undefined;

export interface SyncAdmissionTraceContext {
  /** `general`, or the reserve whose slot the admission holds. */
  slot?: string;
  /** The general pool's effective policy. */
  limit?: number | null;
  queueLimit?: number | null;
  partitioned?: boolean;
}

function append(file: string, record: Record<string, unknown>): void {
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // A trace that cannot be written is no reason to fail the sync work.
  }
}

function writeHolding(): void {
  const at = Date.now();
  const byFile = new Map<string, string[]>();
  for (const [id, file] of holding) byFile.set(file, [...(byFile.get(file) ?? []), id]);
  for (const [file, ids] of byFile) append(file, { event: 'holding', ids, at });
}

export async function traceSyncAdmission<T>(
  label: string,
  work: () => Promise<T>,
  { slot = 'general', limit = null, queueLimit = null, partitioned = false }: SyncAdmissionTraceContext = {},
): Promise<T> {
  const file = process.env.DKG_SYNC_ADMISSION_TRACE;
  if (!file) return work();
  sequence += 1;
  const id = `${process.pid}-${sequence}`;
  const line = (event: 'start' | 'release'): void => {
    append(file, { event, id, label, slot, limit, queueLimit, partitioned, at: Date.now() });
  };
  holding.set(id, file);
  line('start');
  if (heartbeat === undefined) {
    heartbeat = setInterval(writeHolding, SYNC_ADMISSION_TRACE_HOLDING_MS);
    heartbeat.unref?.();
  }
  try {
    return await work();
  } finally {
    holding.delete(id);
    line('release');
    if (holding.size === 0 && heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  }
}
