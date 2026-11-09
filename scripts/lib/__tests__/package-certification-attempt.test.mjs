import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordAttempt } from '../package-certification/attempt.mjs';
import { readJson } from '../package-certification/bundle.mjs';
import { startRegistry } from '../package-certification/registry.mjs';
import { fixture } from './package-certification-fixture.mjs';

function attempt(t) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'package-attempt-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  return { output, receipt: { outcome: 'INCOMPLETE', layouts: [], errors: [], evidence: [] } };
}

test('malformed reports and independent cleanup failures retain an incomplete receipt', async t => {
  const options = attempt(t), cleaned = [];
  options.receipt.layouts = [{ report: 'bad-report.json' }];
  await assert.rejects(recordAttempt({ ...options,
    work: () => fs.writeFileSync(path.join(options.output, 'bad-report.json'), '{partial'),
    cleanup: async safely => {
      await safely('cleanup', () => { throw new Error('first cleanup failed'); });
      await safely('cleanup', () => cleaned.push('second resource'));
    },
    verify: () => assert.fail('incomplete evidence must never be verified as PASS'),
  }), /INCOMPLETE/);
  const receipt = readJson(path.join(options.output, 'receipt.json'));
  assert.deepEqual(cleaned, ['second resource']);
  assert.equal(receipt.outcome, 'INCOMPLETE');
  assert.deepEqual(receipt.errors.map(e => e.phase), ['cleanup', 'report']);
  assert.deepEqual(receipt.evidence.map(e => e.path), ['bad-report.json']);
});

test('a failed observed case stays FAIL even if the execution wrapper returns normally', async t => {
  const options = attempt(t);
  options.receipt.layouts = [{ report: 'report.json' }];
  await assert.rejects(recordAttempt({ ...options,
    work: () => fs.writeFileSync(path.join(options.output, 'report.json'), JSON.stringify({ cases: [{ outcome: 'FAIL' }] })),
    cleanup: () => {}, verify: () => assert.fail('failed case must not reach verification'),
  }), /certification FAIL/);
  assert.equal(readJson(path.join(options.output, 'receipt.json')).outcome, 'FAIL');
});

for (const accepted of [true, false]) test(`PASS is persisted only after verification ${accepted ? 'succeeds' : 'rejects'}`, async t => {
  const options = attempt(t);
  const run = recordAttempt({ ...options, work: () => {}, cleanup: () => {},
    verify: async prospective => {
      assert.equal(prospective.outcome, 'PASS');
      assert.equal(readJson(path.join(options.output, 'receipt.json')).outcome, 'INCOMPLETE');
      await Promise.resolve();
      if (!accepted) throw new Error('final policy rejection');
    },
  });
  if (accepted) await run;
  else await assert.rejects(run, /INCOMPLETE/);
  const receipt = readJson(path.join(options.output, 'receipt.json'));
  assert.equal(receipt.outcome, accepted ? 'PASS' : 'INCOMPLETE');
  assert.deepEqual(receipt.errors, accepted ? [] : [{ phase: 'verification', message: 'final policy rejection' }]);
  assert.equal(fs.existsSync(path.join(options.output, 'receipt.json.tmp')), false);
});

test('SIGKILL during pending final verification leaves the durable receipt INCOMPLETE', { timeout: 15_000 }, async t => {
  const { output } = attempt(t);
  const moduleUrl = new URL('../package-certification/attempt.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { setTimeout } from 'node:timers/promises';
    import { recordAttempt } from ${JSON.stringify(moduleUrl)};
    await recordAttempt({ output: process.argv[1], receipt: { outcome: 'INCOMPLETE', layouts: [], errors: [], evidence: [] },
      work: () => {}, cleanup: () => {},
      verify: async receipt => { process.send(receipt.outcome); await setTimeout(60_000); },
    });
  `, output], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ended = once(child, 'exit');
  const [prospectiveOutcome] = await once(child, 'message');
  assert.equal(prospectiveOutcome, 'PASS');
  assert.equal(readJson(path.join(output, 'receipt.json')).outcome, 'INCOMPLETE');
  child.kill('SIGKILL');
  const [, signal] = await ended;
  assert.equal(signal, 'SIGKILL');
  assert.equal(readJson(path.join(output, 'receipt.json')).outcome, 'INCOMPLETE');
});

test('SIGTERM queued during synchronous verification cannot commit PASS', { timeout: 15_000 }, async t => {
  const { output } = attempt(t);
  const moduleUrl = new URL('../package-certification/attempt.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { recordAttempt } from ${JSON.stringify(moduleUrl)};
    try {
      await recordAttempt({ output: process.argv[1], receipt: { outcome: 'INCOMPLETE', layouts: [], errors: [], evidence: [] },
        work: () => {}, cleanup: () => {},
        verify: () => {
          process.kill(process.pid, 'SIGTERM');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        },
      });
    } catch { process.exitCode = 1; }
  `, output], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [code, signal] = await once(child, 'exit');
  const receipt = readJson(path.join(output, 'receipt.json'));
  assert.equal(receipt.outcome, 'INCOMPLETE');
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert.ok(receipt.errors.some(error => error.phase === 'cancellation' && error.message.includes('SIGTERM')));
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) test(`${signal} cannot leave a passing receipt; catchable signals run cleanup`, { timeout: 15_000 }, async t => {
  const { output } = attempt(t);
  const moduleUrl = new URL('../package-certification/attempt.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { setTimeout } from 'node:timers/promises';
    import { recordAttempt } from ${JSON.stringify(moduleUrl)};
    const output = process.argv[1];
    try {
      await recordAttempt({ output, receipt: { outcome: 'INCOMPLETE', layouts: [], errors: [], evidence: [] },
        work: async signal => { process.send('ready'); await setTimeout(60_000, undefined, { signal }); },
        cleanup: () => fs.writeFileSync(output + '/cleanup.log', 'cleaned'),
        verify: () => { throw new Error('cancelled run reached verification'); },
      });
    } catch { process.exitCode = 1; }
    process.disconnect();
  `, output], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const ended = once(child, 'exit');
  await once(child, 'message');
  assert.equal(readJson(path.join(output, 'receipt.json')).outcome, 'INCOMPLETE');
  child.kill(signal);
  const [code, exitSignal] = await ended;
  const receipt = readJson(path.join(output, 'receipt.json'));
  assert.equal(receipt.outcome, 'INCOMPLETE');
  if (signal === 'SIGKILL') {
    assert.equal(exitSignal, signal);
  } else {
    assert.equal(code, 1);
    assert.ok(receipt.errors.some(e => e.phase === 'cancellation' && e.message.includes(signal)));
    assert.equal(fs.readFileSync(path.join(output, 'cleanup.log'), 'utf8'), 'cleaned');
    assert.ok(receipt.evidence.some(e => e.path === 'cleanup.log'));
  }
});

test('registry cleanup aborts a stalled upstream instead of waiting for its timeout', { timeout: 10_000 }, async t => {
  const f = fixture(t);
  const upstream = http.createServer(() => {});
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const server = await startRegistry({ bundle: f.bundle, manifest: f.manifest, rpcUrl: '', log: path.join(f.root, 'registry.log'), upstream: `http://127.0.0.1:${upstream.address().port}` });
  const received = once(upstream, 'request');
  const request = fetch(`http://127.0.0.1:${server.port}/registry/third-party`).catch(() => undefined);
  await received;
  await server.close();
  await request;
  assert.match(fs.readFileSync(path.join(f.root, 'registry.log'), 'utf8'), /abort/i);
});
