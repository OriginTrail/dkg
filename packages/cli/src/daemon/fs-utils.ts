// Filesystem helpers shared across the daemon. Kept in their own module
// (rather than inlined in callers) so they can be reused and unit-tested
// independently.

import { _autoUpdateIo } from './manifest.js';

export interface WriteFileAtomicOptions {
  /**
   * POSIX file mode to apply to the destination. When provided, the temp
   * file is CREATED with this mode (closing the umask-derived
   * permission window — see slice 06 review C1) AND a defensive
   * `chmod` is issued after rename in case the destination already
   * existed and the source-mode transfer wasn't consistent.
   *
   * Without this, a `~/.dkg/auth.token` writer that does the historical
   * "writeFile with default mode then chmod" pair leaves a brief
   * 0o644 window during which a same-host adversary can read the
   * secret. Auth-bearing writers MUST pass `{ mode: 0o600 }`.
   */
  mode?: number;
}

/**
 * Write `data` to `path` via temp file + POSIX rename so a crash mid-write
 * never leaves a partially-written file at `path`. Used for bookkeeping
 * files that the daemon reads on startup or compares against —
 * `.current-commit`, `.current-version`, `.update-pending.json`,
 * `auth.token` (slice 06 mint/revoke).
 *
 * Witnessed corruption that motivates this: on dkg-v9-relay-01 we found
 * `.current-commit` containing the same 40-char SHA written end-to-end with
 * no separator — an interrupted/retried `writeFile` to an existing file
 * does not truncate atomically. Reading that 80-char value then never
 * matched any remote SHA, sending the auto-updater into a permanent
 * "update available" loop that never converged.
 *
 * Falls back to a non-atomic write if `rename` is not available on the IO
 * surface (older test stubs); production always has it. The fallback
 * still honors `options.mode` so secret-bearing callers don't lose
 * permission enforcement when running against a partial IO surface.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  options?: WriteFileAtomicOptions,
): Promise<void> {
  const { writeFile, rename, unlink, chmod } = _autoUpdateIo;
  const mode = options?.mode;
  const writeOpts = mode !== undefined ? { mode } : undefined;

  if (typeof rename !== 'function') {
    // Older test stubs may not provide `rename`. Production fs/promises
    // always does, so this branch only matters in unit tests with partial
    // IO surfaces. Falling back to a direct write keeps the helper usable
    // (without atomicity) instead of throwing TypeError on destructure.
    await writeFile(path, data, writeOpts);
    if (mode !== undefined && typeof chmod === 'function') {
      await chmod(path, mode);
    }
    return;
  }
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  await writeFile(tmp, data, writeOpts);
  try {
    await rename(tmp, path);
  } catch (err) {
    try { await unlink?.(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
  // Defensive `chmod` after rename: when the destination existed before
  // the rename, some platforms preserve the destination's old mode
  // instead of inheriting the temp file's. Re-asserting the mode here
  // makes the contract explicit regardless of platform.
  if (mode !== undefined && typeof chmod === 'function') {
    await chmod(path, mode);
  }
}
