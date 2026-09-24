// Filesystem helpers shared across the daemon. Kept in their own module
// (rather than inlined in callers) so they can be reused and unit-tested
// independently.

import { _autoUpdateIo } from './manifest.js';

/** The fs calls `writeFileAtomic` makes. Defaults to the daemon's `_autoUpdateIo`. */
export interface AtomicWriteIo {
  writeFile(path: string, data: string): Promise<unknown>;
  /** Replaces `path` with the temp file: the step that makes the write atomic. */
  rename(from: string, to: string): Promise<unknown>;
  /** Removes the temp file when the rename fails (best effort). */
  unlink(path: string): Promise<unknown>;
}

/**
 * Write `data` to `path` via temp file + POSIX rename so a crash mid-write
 * never leaves a partially-written file at `path`. Used for bookkeeping
 * files that the daemon reads on startup or compares against —
 * `.current-commit`, `.current-version`, `.update-pending.json`,
 * `.update-holdoff.json`.
 *
 * Witnessed corruption that motivates this: on dkg-v9-relay-01 we found
 * `.current-commit` containing the same 40-char SHA written end-to-end with
 * no separator — an interrupted/retried `writeFile` to an existing file
 * does not truncate atomically. Reading that 80-char value then never
 * matched any remote SHA, sending the auto-updater into a permanent
 * "update available" loop that never converged.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  io: AtomicWriteIo = _autoUpdateIo,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await io.writeFile(tmp, data);
  try {
    await io.rename(tmp, path);
  } catch (err) {
    try { await io.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
