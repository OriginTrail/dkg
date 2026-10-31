import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export { STORE_HARDEN_LOCK_FILENAME, storeHardenLockPath } from './store-migration-marker.js';
import { readStoreMigrationMarker, storeHardenLockPath } from './store-migration-marker.js';

/** Daemon startup must not expose writers until migration verification settles. */
export async function assertStoreMigrationInactive(dkgHome: string): Promise<void> {
  const path = storeHardenLockPath(dkgHome);
  if (readStoreMigrationMarker(path).kind === 'missing') return;
  throw new Error(`Store hardening marker exists at ${path}. Finish migration or recover an interrupted migration before starting the daemon.`);
}

/**
 * Why a recorded daemon pid forbids hardening, if it does. Only ESRCH proves the
 * pid is gone: a daemon under another account answers EPERM, and any other
 * failure says nothing either way.
 */
export function daemonStoreMigrationRefusal(pid: number): string | undefined {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return undefined;
    return `Cannot verify daemon state: this account cannot check pid ${pid}. Run as the account that runs the daemon, or confirm it has stopped and remove daemon.pid, before hardening the store.`;
  }
  return `DKG daemon is running (pid ${pid}). Stop it with \`dkg stop\` before hardening the store; --yes only skips confirmation.`;
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
  const refusal = daemonStoreMigrationRefusal(pid);
  if (refusal !== undefined) throw new Error(refusal);
}
