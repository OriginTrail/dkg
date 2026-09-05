import assert from 'node:assert/strict';
import test from 'node:test';
import { checkMochaReport } from '../../ci/check-mocha-report.mjs';

test('a Mocha report must contain real completed tests and no failures', () => {
  const report = { stats: { tests: 2, passes: 1, pending: 1, failures: 0, duration: 10 }, tests: [{}, {}], passes: [{}], pending: [{}], failures: [] };
  assert.equal(checkMochaReport(report).pending, 1);
  assert.throws(() => checkMochaReport({}), /complete test inventory/);
  assert.throws(() => checkMochaReport({ ...report, tests: [] }), /inconsistent outcome totals/);
  assert.throws(() => checkMochaReport({
    ...report,
    stats: { ...report.stats, passes: 0, failures: 1 },
    passes: [],
    failures: [{}],
  }), /failures/);
  assert.throws(() => checkMochaReport({
    ...report,
    stats: { ...report.stats, tests: 1, passes: 0 },
    tests: [{}],
    passes: [],
  }), /passing tests/);
  assert.throws(() => checkMochaReport({ ...report, stats: { ...report.stats, pending: 0 } }), /inconsistent outcome totals/);
  assert.throws(() => checkMochaReport({ ...report, pending: [] }), /inconsistent outcome totals/);
});

test('Hardhat-installed Mocha JSON reporter writes into a missing parent directory', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createRequire } = await import('node:module');
  const { spawnSync } = await import('node:child_process');
  const require = createRequire(new URL('../../../packages/evm-module/package.json', import.meta.url));
  const hardhatRequire = createRequire(require.resolve('hardhat/package.json'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-mocha-reporter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'reporter.cjs');
  const output = path.join(root, 'missing/test-results/solidity.json');
  fs.writeFileSync(file, "it('executes a real Mocha case', () => require('node:assert/strict').equal(2 + 2, 4));");
  const child = spawnSync(process.execPath, ['-e', `
    const Mocha = require(process.argv[1]);
    const mocha = new Mocha({ reporter: 'json', reporterOptions: { output: process.argv[3] } });
    mocha.addFile(process.argv[2]);
    mocha.run((failures) => { process.exitCode = failures ? 1 : 0; });
  `, hardhatRequire.resolve('mocha'), file, output], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(checkMochaReport(JSON.parse(fs.readFileSync(output, 'utf8'))).passed, 1);
});
