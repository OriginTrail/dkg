import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './proof.mjs';

export async function checkInstalledPnpm(root) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-pnpm-launch-'));
  try {
    const result = await runCommand(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--version'], root, path.join(temp, 'pnpm.log'), 30000);
    assert.equal(result.error, undefined); assert.equal(result.code, 0); assert.equal(result.timedOut, false);
    assert.equal(result.stdout.trim(), '10.28.1');
    return { pnpm: result.stdout.trim(), invocation: result.invocation };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function checkOwnedProcessTermination(root) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-process-'));
  try {
    const args = ['-e', `const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      console.log('OWNED_CHILD_PID ' + child.pid); setInterval(() => {}, 1000);`];
    const assertStopped = async (result) => {
      const pid = Number(/OWNED_CHILD_PID (\d+)/.exec(result.stdout)?.[1]);
      assert.ok(pid, 'owned descendant started before termination');
      for (let attempt = 0; attempt < 20; attempt++) {
        try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`owned descendant ${pid} survived termination`);
    };
    const timeout = await runCommand(process.execPath, args, root, path.join(directory, 'timeout.log'), 1500);
    assert.equal(timeout.timedOut, true); assert.notEqual(timeout.code, 0);
    await assertStopped(timeout);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    let cancelled;
    try { cancelled = await runCommand(process.execPath, args, root, path.join(directory, 'cancelled.log'), 5000, controller.signal); }
    finally { clearTimeout(timer); }
    assert.equal(cancelled.timedOut, false); assert.notEqual(cancelled.code, 0);
    await assertStopped(cancelled);
    return { timedOutTreeStopped: true, cancelledTreeStopped: true };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
