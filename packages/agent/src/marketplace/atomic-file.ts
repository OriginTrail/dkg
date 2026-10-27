/**
 * Atomic owner-only file writes for marketplace state and secrets: a unique
 * tmp file created with mode 0600, renamed over the target, then chmodded to
 * 0600 — `writeFileSync`'s `mode` applies only on create, so a pre-existing
 * 0644 target would otherwise keep its looser mode. The parent directory is
 * created with `dirMode` when absent.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function writeFileAtomic0600(filePath: string, content: string, opts: { dirMode?: number } = {}): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, ...(opts.dirMode !== undefined ? { mode: opts.dirMode } : {}) });
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (error) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw error;
  }
  if (process.platform !== 'win32') chmodSync(filePath, 0o600);
}
