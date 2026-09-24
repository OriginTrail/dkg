// Child-process lock holder for the lease tests. It takes the lock, reads the
// counter, and holds the lock for `holdMs`: awaiting, so it keeps renewing its
// lease, or with its event loop blocked, so it cannot. Then it checks it still
// holds the lock and writes the counter back incremented.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { withFileLock } from '../../src/file-lock.js';

const [lockPath, counterPath, logPath, mode, holdMs, staleMs] = process.argv.slice(2);
const log = (event: string) => appendFileSync(logPath, `holder:${event}\n`);
try {
  await withFileLock(lockPath, async (lock) => {
    log('enter');
    const count = Number(readFileSync(counterPath, 'utf-8'));
    if (mode === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
    else await sleep(Number(holdMs));
    await lock.assertHeld();
    writeFileSync(counterPath, String(count + 1));
    log('leave');
  }, { staleMs: Number(staleMs), timeoutMs: 10_000 });
} catch (error) {
  log(`error: ${(error as Error).message}`);
  process.exitCode = 3;
}
