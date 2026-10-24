import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { ownProcess } from '../../testing/owned-process.mjs';

function child(code) {
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('spawn errors and early closes retain diagnostics and prevent readiness', async () => {
  const missing = ownProcess(spawn('/definitely-not-a-dkg-test-executable', [], { stdio: ['ignore', 'pipe', 'pipe'] }));
  await assert.rejects(missing.ready(() => undefined, { timeoutMs: 2000 }), /ENOENT/);
  await missing.closed;
  const failed = ownProcess(child("process.stdout.write('partial Hub'); process.stderr.write('late failure'); process.exitCode = 7;"), { label: 'fixture' });
  await assert.rejects(failed.ready(() => undefined, { timeoutMs: 2000 }), /code 7[\s\S]*late failure[\s\S]*partial Hub/);
  await assert.rejects(failed.waitForExit(), /code 7/);
});

test('successful readiness returns a live child and idempotent teardown waits for close', async (t) => {
  const live = ownProcess(child("console.log('READY'); setInterval(() => {}, 1000);"));
  t.after(() => live.stop());
  assert.equal(await live.ready(({ stdout }) => stdout().includes('READY') ? 42 : undefined, { timeoutMs: 2000 }), 42);
  assert.equal(live.child.exitCode, null);
  const first = live.stop();
  assert.equal(first, live.stop());
  await first;
  const result = await live.closed;
  assert.ok(result.signal || result.code !== null);
});

test('readiness timeout aborts probes, escalates SIGTERM and awaits the owned close', async (t) => {
  const live = ownProcess(child("process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);"), { label: 'unready fixture', graceMs: 30 });
  t.after(() => live.stop());
  await live.ready(({ stdout }) => stdout().includes('READY') ? true : undefined, { timeoutMs: 2000 });
  let signal;
  await assert.rejects(live.ready((context) => { signal = context.signal; return undefined; }, { timeoutMs: 40 }), /timed out[\s\S]*READY/);
  assert.equal(signal.aborted, true);
  const result = await live.closed;
  assert.equal(result.signal, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
});

test('completion accepts only a zero exit and readiness errors also close the child', async (t) => {
  const done = ownProcess(child("console.log('finished');"));
  assert.match((await done.waitForExit(2000)).stdout, /finished/);
  const live = ownProcess(child('setInterval(() => {}, 1000);'));
  t.after(() => live.stop());
  await assert.rejects(live.ready(() => { throw new Error('invalid manifest'); }), /invalid manifest/);
  await live.closed;
});
