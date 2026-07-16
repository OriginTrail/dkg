import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

import { decodeForcedExitCode } from '../src/daemon/shutdown.js';

const DAEMON_EXIT_CODE_RESTART = 75;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Standalone re-creation of the foreground supervisor loop from cli.ts,
 * adapted for in-process testing (returns instead of calling process.exit).
 *
 * Mirrors the real supervisor's offset-exit-code handling: an exit in
 * [100, 199] is a forced shutdown (deadlocked cleanup hit
 * SHUTDOWN_HARD_TIMEOUT_MS); the offset is stripped to recover the original
 * intent (0 -> final exit, 75 -> restart). Keeping this in sync with cli.ts
 * is what `forcedExits` + the corresponding tests below verify.
 */
async function testSupervisor(
  workerScript: string,
  opts?: { maxIterations?: number },
): Promise<{ exitCode: number; spawnCount: number; forcedExits: number }> {
  const maxCrashRestarts = 5;
  let crashRestartCount = 0;
  let spawnCount = 0;
  let forcedExits = 0;
  let currentChild: ChildProcess | null = null;
  let signalled = false;
  const maxIterations = opts?.maxIterations ?? 20;

  const onSignal = (sig: NodeJS.Signals) => {
    signalled = true;
    if (currentChild) currentChild.kill(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    while (spawnCount < maxIterations) {
      if (signalled) return { exitCode: 0, spawnCount, forcedExits };

      spawnCount++;
      currentChild = spawn(process.execPath, [workerScript], {
        stdio: 'pipe',
        env: process.env,
      });

      const rawExitCode = await new Promise<number | null>((resolve) => {
        currentChild!.once('exit', (code) => resolve(code));
        currentChild!.once('error', () => resolve(1));
      });
      currentChild = null;
      const { forced, originalExitCode } = decodeForcedExitCode(rawExitCode);
      if (forced) forcedExits++;

      if (signalled) return { exitCode: originalExitCode ?? 0, spawnCount, forcedExits };

      if (originalExitCode === DAEMON_EXIT_CODE_RESTART) {
        crashRestartCount = 0;
        await sleep(50);
        if (signalled) return { exitCode: 0, spawnCount, forcedExits };
        continue;
      }

      if (originalExitCode === 0) return { exitCode: 0, spawnCount, forcedExits };

      crashRestartCount++;
      if (crashRestartCount >= maxCrashRestarts) return { exitCode: originalExitCode ?? 1, spawnCount, forcedExits };
      await sleep(50);
      if (signalled) return { exitCode: 0, spawnCount, forcedExits };
    }
    return { exitCode: 1, spawnCount, forcedExits };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

describe('foreground supervisor', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dkg-supervisor-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('restarts worker on exit code 75, then exits cleanly on code 0', async () => {
    const stateFile = join(tmpDir, 'state');
    const workerScript = join(tmpDir, 'worker.mjs');

    await writeFile(workerScript, `
      import { existsSync, writeFileSync } from 'node:fs';
      const stateFile = ${JSON.stringify(stateFile)};
      if (existsSync(stateFile)) {
        process.exit(0);
      } else {
        writeFileSync(stateFile, 'ran');
        process.exit(75);
      }
    `);

    const result = await testSupervisor(workerScript);

    expect(result.spawnCount).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(existsSync(stateFile)).toBe(true);
  });

  it('exits immediately when worker exits with code 0', async () => {
    const workerScript = join(tmpDir, 'worker.mjs');
    await writeFile(workerScript, `process.exit(0);`);

    const result = await testSupervisor(workerScript);

    expect(result.spawnCount).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('gives up after 5 consecutive crashes', async () => {
    const workerScript = join(tmpDir, 'worker.mjs');
    await writeFile(workerScript, `process.exit(1);`);

    const result = await testSupervisor(workerScript);

    expect(result.spawnCount).toBe(5);
    expect(result.exitCode).toBe(1);
  });

  it('resets crash counter after a successful restart (exit 75)', async () => {
    const counterFile = join(tmpDir, 'counter');
    const workerScript = join(tmpDir, 'worker.mjs');

    // Exits 75 on first run (triggering restart), then crashes 4 times,
    // then exits 0. The crash counter should have reset after the 75.
    await writeFile(workerScript, `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const f = ${JSON.stringify(counterFile)};
      let n = 0;
      try { n = parseInt(readFileSync(f, 'utf-8'), 10); } catch {}
      n++;
      writeFileSync(f, String(n));
      if (n === 1) process.exit(75);
      if (n < 6) process.exit(1);
      process.exit(0);
    `);

    const result = await testSupervisor(workerScript);

    expect(result.exitCode).toBe(0);
    expect(result.spawnCount).toBe(6);
  });

  it('forwards SIGINT to child and exits without respawning', async () => {
    const workerScript = join(tmpDir, 'worker.mjs');
    await writeFile(workerScript, `
      process.on('SIGINT', () => process.exit(0));
      setTimeout(() => process.exit(1), 30000);
    `);

    const supervisorPromise = testSupervisor(workerScript);

    // Give the child time to start, then trigger SIGINT on this process.
    // The supervisor handler forwards it to the child via child.kill().
    await sleep(300);
    process.emit('SIGINT', 'SIGINT');

    const result = await supervisorPromise;

    expect(result.exitCode).toBe(0);
    expect(result.spawnCount).toBe(1);
  });

  it('handles spawn error (missing entrypoint) as crash', async () => {
    const result = await testSupervisor(join(tmpDir, 'does-not-exist.mjs'));

    expect(result.exitCode).toBe(1);
    expect(result.spawnCount).toBe(5);
  });

  it('treats forced-restart exit code 175 (= 75 + SHUTDOWN_FORCED_OFFSET) the same as a clean restart 75', async () => {
    // Mirrors the production case where the auto-update path calls
    // `shutdown(DAEMON_EXIT_CODE_RESTART)` but the cleanup deadlocks, so the
    // worker exits with 175 instead of 75. The supervisor must still respawn,
    // matching the operator's original "restart, please" intent — and it must
    // count this as a forced exit so the test (and Datadog in prod) can tell.
    const stateFile = join(tmpDir, 'state');
    const workerScript = join(tmpDir, 'worker.mjs');

    await writeFile(workerScript, `
      import { existsSync, writeFileSync } from 'node:fs';
      const stateFile = ${JSON.stringify(stateFile)};
      if (existsSync(stateFile)) {
        process.exit(0);
      } else {
        writeFileSync(stateFile, 'ran');
        process.exit(175);
      }
    `);

    const result = await testSupervisor(workerScript);

    expect(result.spawnCount).toBe(2);
    expect(result.exitCode).toBe(0);
    expect(result.forcedExits).toBe(1);
    expect(existsSync(stateFile)).toBe(true);
  });

  it('treats forced-final-exit code 100 (= 0 + SHUTDOWN_FORCED_OFFSET) the same as a clean exit 0', async () => {
    // Operator sent SIGINT, cleanup deadlocked, worker hard-exited with 100.
    // Supervisor should still terminate (operator wanted out), not crash-loop.
    const workerScript = join(tmpDir, 'worker.mjs');
    await writeFile(workerScript, `process.exit(100);`);

    const result = await testSupervisor(workerScript);

    expect(result.spawnCount).toBe(1);
    expect(result.exitCode).toBe(0);
    expect(result.forcedExits).toBe(1);
  });
});
