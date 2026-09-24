// Child-process lock holder for the lease tests. It takes the lock, reads the
// counter, and holds the lock for `holdMs`, then commits the counter
// incremented. It holds it awaiting (`await`, renewing its lease), with its
// event loop blocked before the commit (`block`, so its lease lapses and it
// loses the lock), or blocked inside the commit after its check that it
// still holds the lock (`block-in-commit`).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { withFileLock } from '../../src/file-lock.js';

const [lockPath, counterPath, logPath, mode, holdMs, staleMs] = process.argv.slice(2);
const log = (event: string) => appendFileSync(logPath, `holder:${event}\n`);
const block = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
try {
  await withFileLock(lockPath, async (lock) => {
    log('enter');
    const count = Number(readFileSync(counterPath, 'utf-8'));
    if (mode === 'block') block();
    else if (mode === 'await') await sleep(Number(holdMs));
    await lock.commit(async () => {
      if (mode === 'block-in-commit') {
        log('committing');
        block();
      }
      writeFileSync(counterPath, String(count + 1));
    });
    log('leave');
  }, { staleMs: Number(staleMs), timeoutMs: 10_000 });
} catch (error) {
  log(`error: ${(error as Error).message}`);
  process.exitCode = 3;
}
