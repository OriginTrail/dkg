// A crash-safe file write over the caller's filesystem calls. Kept free of
// other daemon imports, so bookkeeping outside the auto-updater (the managed
// Oxigraph owner record) can use it without loading the updater's modules.

/** The filesystem calls an atomic write needs. */
export interface AtomicWriteIo {
  writeFile(path: string, data: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}

/**
 * Write `data` to `path` via a temporary sibling and a POSIX rename, so a
 * crash mid-write never leaves a partially-written file at `path`. The
 * temporary file is removed when the rename fails.
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
