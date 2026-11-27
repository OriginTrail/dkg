import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { ownProcess } from '../../testing/owned-process.mjs';

function child(code) {
  return spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
}

test('typed process consumers can supply termination and readiness cancellation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-process-types-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.symlinkSync(path.resolve(import.meta.dirname, '../../../node_modules'), path.join(root, 'node_modules'), 'junction');
  const consumer = path.join(root, 'consumer.mts');
  const module = path.resolve(import.meta.dirname, '../../testing/owned-process.mjs').replaceAll('\\', '/');
  fs.writeFileSync(consumer, `import type { ChildProcess } from 'node:child_process';
import { ownProcess } from ${JSON.stringify(module)};
declare const child: ChildProcess;
const controller = new AbortController();
const owner = ownProcess(child, { kill: signal => { const typed: NodeJS.Signals = signal; child.kill(typed); } });
const ready: Promise<number> = owner.ready(({ signal }) => signal.aborted ? undefined : 1, { signal: controller.signal });
void ready;
`);
  const program = ts.createProgram([consumer], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022, noEmit: true, strict: true, skipLibCheck: false });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n',
  }));
});

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

test('external cancellation aborts a pending readiness probe and awaits teardown', async t => {
  const live = ownProcess(child("console.log('READY'); setInterval(() => {}, 1000);"));
  t.after(() => live.stop());
  await live.ready(({ stdout }) => stdout().includes('READY') ? true : undefined, { timeoutMs: 2000 });
  const controller = new AbortController();
  let probeSignal;
  const ready = live.ready(({ signal }) => {
    probeSignal = signal;
    controller.abort(new Error('cancelled fixture'));
    return new Promise(() => {});
  }, { signal: controller.signal, timeoutMs: 2000 });
  await assert.rejects(ready, /cancelled fixture/);
  assert.equal(probeSignal.aborted, true);
  assert.ok((await live.closed).signal);
});

test('custom termination target preserves graceful stop and escalation policy', async t => {
  const spawned = child("process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000);");
  const signals = [];
  const live = ownProcess(spawned, { graceMs: 30, kill: signal => { signals.push(signal); spawned.kill(signal); } });
  t.after(() => live.stop());
  await live.ready(({ stdout }) => stdout().includes('READY') ? true : undefined, { timeoutMs: 2000 });
  await live.stop();
  assert.deepEqual(signals, process.platform === 'win32' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL']);
  assert.equal((await live.closed).signal, process.platform === 'win32' ? 'SIGTERM' : 'SIGKILL');
});
