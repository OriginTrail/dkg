import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessRunning } from '../config.js';

export const STORE_HARDEN_LOCK_FILENAME = '.store-harden.lock';
export const storeHardenLockPath = (dkgHome: string): string => join(dkgHome, STORE_HARDEN_LOCK_FILENAME);

/** Daemon startup must not expose writers until migration verification settles. */
export async function assertStoreMigrationInactive(dkgHome: string): Promise<void> {
  const path = storeHardenLockPath(dkgHome);
  try { await access(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Store hardening marker exists at ${path}. Finish migration or recover an interrupted migration before starting the daemon.`);
}

/** Called after the migration marker is held, closing races with daemon startup. */
export async function assertDaemonStoppedForStoreMigration(dkgHome: string): Promise<void> {
  let text: string;
  try { text = await readFile(join(dkgHome, 'daemon.pid'), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Cannot verify daemon state: invalid daemon.pid. Resolve it before hardening the store.');
  if (isProcessRunning(pid)) throw new Error(`DKG daemon is running (pid ${pid}). Stop it with \`dkg stop\` before hardening the store; --yes only skips confirmation.`);
}
