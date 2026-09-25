// Filesystem helpers shared across the daemon. Kept in their own module
// (rather than inlined in callers) so they can be reused and unit-tested
// independently.

import { _autoUpdateIo } from './manifest.js';

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
  const { writeFile, rename, unlink } = _autoUpdateIo;
  if (typeof rename !== 'function') {
    // Older test stubs may not provide `rename`. Production fs/promises
    // always does, so this branch only matters in unit tests with partial
    // IO surfaces. Falling back to a direct write keeps the helper usable
    // (without atomicity) instead of throwing TypeError on destructure.
    await writeFile(path, data);
    return;
  }
  // Older stubs may also lack `unlink`; cleanup was always best-effort there.
  await writeFileAtomicWith({ writeFile, rename, unlink: unlink ?? (async () => {}) }, path, data);
}

/** The filesystem calls an atomic write needs. */
export interface AtomicWriteIo {
  writeFile(path: string, data: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

/**
 * `writeFileAtomic` over a caller's filesystem, for bookkeeping that does not
 * belong to the auto-updater's IO surface (the managed Oxigraph owner record).
 * The temporary file is removed when the rename fails.
 */
export async function writeFileAtomicWith(io: AtomicWriteIo, path: string, data: string): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await io.writeFile(tmp, data);
  try {
    await io.rename(tmp, path);
  } catch (err) {
    try { await io.unlink(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
