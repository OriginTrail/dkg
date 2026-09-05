import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { runProcessTree } from '../../ci/run-process-tree.mjs';

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('a timed command terminates its child and grandchild on Windows and POSIX', { timeout: 15_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-process-tree-'));
  const pidFile = path.join(dir, 'pids.json');
  let pids = [];
  t.after(() => {
    for (const pid of pids) {
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const grandchild = 'setInterval(() => {}, 1000)';
  const child = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });
    grandchild.once('spawn', () => fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify([process.ppid, process.pid, grandchild.pid])));
    setInterval(() => {}, 1000);
  `;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const running = runProcessTree(process.execPath, ['-e', parent], { stdio: 'ignore', timeout: 4000 });
  for (let attempt = 0; !fs.existsSync(pidFile) && attempt < 100; attempt += 1) await delay(30);
  assert.ok(fs.existsSync(pidFile), 'child must record the live process tree before timeout');
  pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(pids.length, 3);
  assert.ok(pids.every(alive), 'all three generations are running');
  const result = await running;
  assert.match(result.error?.message ?? '', /Command timed out/);
  assert.doesNotMatch(result.error.message, /cleanup failed/);
  for (let attempt = 0; pids.some(alive) && attempt < 100; attempt += 1) await delay(30);
  assert.deepEqual(pids.filter(alive), [], 'root, child and grandchild must all be gone');
});

test('process-tree runner preserves exit codes and spawn failures', async () => {
  const failed = await runProcessTree(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore', timeout: 4000 });
  assert.equal(failed.status, 7);
  assert.equal(failed.error, undefined);
  const missing = await runProcessTree(path.join(os.tmpdir(), 'missing-ci-command'), [], { stdio: 'ignore' });
  assert.equal(missing.error?.code, 'ENOENT');
});
