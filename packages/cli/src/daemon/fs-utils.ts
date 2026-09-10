import { _autoUpdateIo } from './manifest.js';
import { writeFileAtomic as writeSharedFileAtomic } from '../fs-utils.js';

/**
 * Write `data` to `path` via temp file + POSIX rename so a crash mid-write
 * never leaves a partially-written file at `path`. Used for bookkeeping
 * files that the daemon reads on startup or compares against —
 * `.current-commit`, `.current-version`, `.update-pending.json`.
 *
 * Witnessed corruption that motivates this: on dkg-v9-relay-01 we found
 * `.current-commit` containing the same 40-char SHA written end-to-end with
 * no separator — an interrupted/retried `writeFile` to an existing file
 * does not truncate atomically. Reading that 80-char value then never
 * matched any remote SHA, sending the auto-updater into a permanent
 * "update available" loop that never converged.
 *
 * Falls back to a non-atomic write if `rename` is not available on the IO
 * surface (older test stubs); production always has it.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await writeSharedFileAtomic(path, data, { io: _autoUpdateIo });
}
