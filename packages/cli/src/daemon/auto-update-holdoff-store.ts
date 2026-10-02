/**
 * File-backed persistence for the auto-update rollout deadline.
 *
 * The persisted deadline policy (`createPersistedHoldoffDeadline`) owns the
 * rules; this module only reads, atomically replaces and removes the
 * `<DKG home>/.update-holdoff.json` record it keeps across restarts.
 */
import { writeFileAtomic } from './fs-utils.js';
import { _autoUpdateIo } from './manifest.js';
import type { UpdateHoldoffRecord, UpdateHoldoffStore } from './auto-update-holdoff-deadline.js';

/** File under the DKG home (next to `releases/`) that holds the persisted deadline. */
export const UPDATE_HOLDOFF_FILE = '.update-holdoff.json';

/** The fs calls the store makes. Defaults to the daemon's `_autoUpdateIo`. */
export interface UpdateHoldoffFs {
  readFile(path: string, encoding: 'utf-8'): Promise<string>;
  writeFile(path: string, data: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Parse a persisted record, throwing on anything that is not a well-formed one. */
export function parseUpdateHoldoffRecord(raw: string): UpdateHoldoffRecord {
  const parsed: unknown = JSON.parse(raw);
  const rec = parsed as Partial<UpdateHoldoffRecord> | null;
  if (
    !rec || typeof rec !== 'object'
    || typeof rec.target !== 'string' || rec.target.length === 0
    || typeof rec.deadlineEpochMs !== 'number' || !Number.isFinite(rec.deadlineEpochMs)
  ) {
    throw new Error('malformed rollout hold-off record');
  }
  return { target: rec.target, deadlineEpochMs: rec.deadlineEpochMs };
}

/**
 * JSON-file store for the rollout deadline. Writes go through the daemon's
 * `writeFileAtomic` (temp sibling + rename), so a crash mid-write never leaves
 * a torn record. `read` returns null when the file is absent and throws when
 * it cannot be read or parsed; the policy logs that and draws a fresh hold.
 */
export function createFileUpdateHoldoffStore(
  path: string,
  fs: UpdateHoldoffFs = _autoUpdateIo,
): UpdateHoldoffStore {
  return {
    async read() {
      let raw: string;
      try {
        raw = await fs.readFile(path, 'utf-8');
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
      return parseUpdateHoldoffRecord(raw);
    },
    async write(record) {
      await writeFileAtomic(path, `${JSON.stringify(record)}\n`, fs);
    },
    async clear() {
      try {
        await fs.unlink(path);
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    },
  };
}
