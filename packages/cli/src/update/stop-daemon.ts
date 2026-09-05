import { hasErrorCode } from '@origintrail-official/dkg-core';

import { isProcessRunning, readPid } from '../config.js';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns true if the daemon stopped (or was not running). */
export async function stopDaemonIfRunning(): Promise<boolean> {
  const pid = await readPid();
  if (!pid || !isProcessRunning(pid)) return true;
  console.log('Stopping daemon...');
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if (!hasErrorCode(err, 'ESRCH')) throw err;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await wait(500);
    if (!isProcessRunning(pid)) return true;
  }
  console.error('Daemon is still running after SIGTERM. Stop it manually before restarting.');
  return false;
}
