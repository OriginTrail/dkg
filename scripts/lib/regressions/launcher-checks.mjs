import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { phaseSucceeded } from './phases.mjs';
import { pnpmCommand, runCommand } from './subprocess.mjs';

const isRunning = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { assert.equal(error.code, 'ESRCH'); return false; }
};
const IDLE_PROCESS = 'setInterval(() => {}, 1000)';

export async function checkInstalledPnpm(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-pnpm-launch-'));
  try {
    const result = await runCommand(pnpmCommand(), ['--version'], root, path.join(temp, 'pnpm.log'), 30000);
    assert.equal(result.error, undefined); assert.equal(result.code, 0); assert.equal(result.timedOut, false);
    assert.equal(result.stdout.trim(), '10.28.1');
    return { pnpm: result.stdout.trim(), invocation: result.invocation };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

// The runner stops the tree it spawned and nothing else. An unrelated process,
// started outside that tree, must survive both the deadline and cancellation.
export async function checkOwnedProcessTermination(root) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-process-'));
  const sentinel = spawn(process.execPath, ['-e', IDLE_PROCESS], { detached: true, stdio: 'ignore' });
  sentinel.unref();
  try {
    assert.ok(sentinel.pid && isRunning(sentinel.pid), 'the unrelated sentinel started');
    const args = ['-e', `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE_PROCESS)}], { stdio: 'inherit' });
      console.log('OWNED_CHILD_PID ' + child.pid); setInterval(() => {}, 1000);`];
    const assertStopped = async (result) => {
      const pid = Number(/OWNED_CHILD_PID (\d+)/.exec(result.stdout)?.[1]);
      assert.ok(pid, 'owned descendant started before termination');
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!isRunning(pid)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`owned descendant ${pid} survived termination`);
    };
    const timeout = await runCommand(process.execPath, args, root, path.join(directory, 'timeout.log'), 1500);
    assert.equal(timeout.timedOut, true); assert.notEqual(timeout.code, 0);
    await assertStopped(timeout);
    assert.ok(isRunning(sentinel.pid), 'an unrelated process survived the deadline');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    let cancelled;
    try { cancelled = await runCommand(process.execPath, args, root, path.join(directory, 'cancelled.log'), 5000, controller.signal); }
    finally { clearTimeout(timer); }
    assert.equal(cancelled.timedOut, false); assert.equal(cancelled.cancelled, true); assert.notEqual(cancelled.code, 0);
    await assertStopped(cancelled);
    assert.ok(isRunning(sentinel.pid), 'an unrelated process survived cancellation');
    return { timedOutTreeStopped: true, cancelledTreeStopped: true, unrelatedProcessSurvived: true };
  } finally {
    sentinel.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// A descendant outside the owned tree that keeps the output open after its
// launcher exited cannot be stopped, and must not hang the runner either: the
// runner stops waiting for it and fails the phase, whatever the launcher's own
// exit code was, so teardown still runs.
export async function checkRetainedOutputIsBounded(root, { settleMs = 1000 } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-retained-'));
  let retainer;
  try {
    const args = ['-e', `const { spawn } = require('node:child_process');
      const retainer = spawn(process.execPath, ['-e', ${JSON.stringify(IDLE_PROCESS)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
      console.log('RETAINING_PID ' + retainer.pid); retainer.unref();`];
    const started = Date.now();
    const result = await runCommand(process.execPath, args, root, path.join(directory, 'retained.log'), 30000, undefined, { settleMs });
    const elapsed = Date.now() - started;
    retainer = Number(/RETAINING_PID (\d+)/.exec(result.stdout)?.[1]);
    assert.ok(retainer, 'the retaining descendant started');
    assert.equal(result.code, 0, 'the launcher itself exited successfully');
    assert.equal(result.timedOut, false);
    assert.match(result.error ?? '', /still open/);
    assert.equal(phaseSucceeded(result), false, 'retained output fails the phase');
    assert.ok(elapsed < 20000, `the runner settled in ${elapsed} ms instead of waiting for the descendant`);
    return { retainedOutputBounded: true };
  } finally {
    if (retainer) { try { process.kill(retainer); } catch { /* already gone */ } }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
