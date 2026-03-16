import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

const DAEMON_EXIT_CODE_RESTART = 75;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Standalone re-creation of the foreground supervisor loop from cli.ts,
 * adapted for in-process testing (returns instead of calling process.exit).
 */
async function testSupervisor(
  workerScript: string,
  opts?: { maxIterations?: number },
): Promise<{ exitCode: number; spawnCount: number }> {
  const maxCrashRestarts = 5;
  let crashRestartCount = 0;
  let spawnCount = 0;
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
      if (signalled) return { exitCode: 0, spawnCount };

      spawnCount++;
      currentChild = spawn(process.execPath, [workerScript], {
        stdio: 'pipe',
        env: process.env,
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        currentChild!.once('exit', (code) => resolve(code));
        currentChild!.once('error', () => resolve(1));
      });
      currentChild = null;

      if (signalled) return { exitCode: exitCode ?? 0, spawnCount };

      if (exitCode === DAEMON_EXIT_CODE_RESTART) {
        crashRestartCount = 0;
        await sleep(50);
        if (signalled) return { exitCode: 0, spawnCount };
        continue;
      }

      if (exitCode === 0) return { exitCode: 0, spawnCount };

      crashRestartCount++;
      if (crashRestartCount >= maxCrashRestarts) return { exitCode: exitCode ?? 1, spawnCount };
      await sleep(50);
      if (signalled) return { exitCode: 0, spawnCount };
    }
    return { exitCode: 1, spawnCount };
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
});
