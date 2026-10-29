import { mock, test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFor } from '../regressions/profiles.mjs';
import { inspectExecution, verifyDiscovery } from '../regressions/results.mjs';
import { SHARED_EXECUTION_INPUTS, proofIdentity, sha256, verifyIdentity } from '../regressions/identity.mjs';
import { discoveryInvocation, validateRecord, validateRegressions, validateEvidence } from '../regressions/registry.mjs';
import { analyzeTestSource } from '../disabled-test-scanner.mjs';
import { PHASE_ORDER, PREREQUISITE_PHASES, phaseSucceeded, requirePrerequisite, sidePhases } from '../regressions/phases.mjs';
import { commandInvocation, pnpmCommand, runCommand } from '../regressions/subprocess.mjs';
import { checkInstalledPnpm, checkOwnedProcessTermination, checkRetainedOutputIsBounded } from '../regressions/launcher-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const record = JSON.parse(fs.readFileSync(path.join(root, 'test-policy/regressions/GH-2782.json'), 'utf8'));
const profile = profileFor(record);
const discovered = [{ file: profile.file, name: profile.discoveryName }];
const inventory = [{ file: profile.file, execution: [{ lane: 'tornado-agent', cadence: 'required' }] }];
const shards = [{ files: [profile.file.replace('packages/agent/', '')], config: 'vitest.unit.config.ts', inventory: 'unit', index: 5, report: 'agent-5.xml' }];
const clone = (value) => structuredClone(value);

test('registry resolves exact assertion through discovered required inventory and shard', () => {
  assert.equal(validateRecord(record, 'GH-2782.json', inventory, discovered, shards).shard, 5);
});
for (const [name, edit, inv, disc, plans, reason] of [
  ['missing owner', (r) => { delete r.owner; }, inventory, discovered, shards, /ownership/],
  ['missing file', () => {}, [], discovered, shards, /inventory/],
  ['undiscovered assertion', () => {}, inventory, [], shards, /undiscovered/],
  ['ambiguous assertion', () => {}, inventory, [...discovered, ...discovered], shards, /ambiguous/],
  ['optional-only route', () => {}, [{ file: profile.file, execution: [{ lane: 'tornado-agent', cadence: 'manual' }] }], discovered, shards, /inventory/],
  ['optional case claimed as required', (r) => { r.execution.cadence = 'manual'; }, inventory, discovered, shards, /optional/],
  ['disabled/discovery-excluded lane', () => {}, inventory, discovered, [], /exactly one/],
  ['renamed assertion', (r) => { r.test.fullName = 'a new title'; }, inventory, discovered, shards, /test binding/],
]) test(`registry rejects ${name}`, () => {
  const changed = clone(record); edit(changed);
  assert.throws(() => validateRecord(changed, 'GH-2782.json', inv, disc, plans), reason);
});
test('registry rejects duplicate stable IDs before discovery', () => {
  assert.throws(() => validateRegressions(root, inventory, { records: [{ file: 'GH-2782.json', record }, { file: 'other.json', record }] }), /duplicate/);
});
test('discovery rejects zero and ambiguous matches', () => {
  assert.throws(() => verifyDiscovery([], profile, root), /undiscovered/);
  const row = { file: path.join(root, profile.file), name: profile.discoveryName };
  assert.throws(() => verifyDiscovery([row, row], profile, root), /ambiguous/);
});

// Actual Vitest reports from disposable hermetic fixtures. These exercise the
// same classifier as the historical runner; no fabricated status-only reports.
test('proof classifier rejects actual empty, skipped, wrong and import-failed runs', { timeout: 60000 }, async () => {
  const fixture = fs.mkdtempSync(path.join(root, 'node_modules/.regression-runner-'));
  const file = path.join(fixture, profile.file);
  const config = path.join(fixture, 'vitest.config.mts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(config, `import { defineConfig } from 'vitest/config'; export default defineConfig({test:{include:['packages/agent/test/*.test.ts'],allowOnly:false,pool:'forks',maxWorkers:1}});`);
  const observation = { error: 'Cannot acknowledge join approval: durable subscription intent or host state is missing',
    current: false, subscriptionWatermark: 0, saves: 0, rows: 0, sameSubscription: true };
  const emit = `process.stdout.write('REGRESSION_RUNTIME GH-2782 ' + process.version + '\\n');process.stdout.write(${JSON.stringify(`REGRESSION_OBSERVATION GH-2782 ${JSON.stringify(observation)}\n`)});`;
  const body = `import { describe, it, expect } from 'vitest'; describe(${JSON.stringify(profile.suite)},()=>{it(${JSON.stringify(profile.title)},()=>{${emit}expect(1,${JSON.stringify(profile.assertion)}).toBe(2);});});`;
  try {
    let index = 0;
    const run = async (source, filter) => {
      fs.writeFileSync(file, source);
      const report = path.join(fixture, `report-${index}.json`);
      const result = await runCommand(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', fixture, '--config', config,
        ...(filter ? ['-t', filter] : []), '--reporter=json', `--outputFile=${report}`], root, path.join(fixture, `run-${index++}.log`), 15000);
      assert.equal(result.timedOut, false);
      assert.ok(fs.existsSync(report), 'real Vitest must produce its report');
      return { result, report: JSON.parse(fs.readFileSync(report, 'utf8')) };
    };
    const valid = await run(body);
    assert.equal(inspectExecution(valid.report, valid.result, profile, fixture, 'bad').status, 'failed');
    for (const [label, source, filter, reason] of [
      ['zero selected', body, '^no selected regression$', /skipped|zero selected/],
      ['skipped assertion', body.replace('it(', 'it.skip('), undefined, /skipped/],
      ['wrong failing assertion', body.replace(JSON.stringify(profile.title), '"unrelated failure"'), undefined, /wrong failing assertion/],
      ['import failure', "import 'does-not-exist-regression-fixture';\n" + body, undefined, /zero selected/],
      ['unrelated failure in named test', body.replace(JSON.stringify(profile.assertion), '"unrelated behavior"'), undefined, /intended behavioral/],
    ]) {
      const invalid = await run(source, filter);
      assert.throws(() => inspectExecution(invalid.report, invalid.result, profile, fixture, 'bad'), reason, label);
      if (label === 'skipped assertion') {
        assert.throws(() => validateRegressions(fixture, inventory, { records: [{ file: 'GH-2782.json', record }],
          discover: () => discovered, shards }), /disabled or focused/);
      }
    }
    const green = await run(body.replace('.toBe(2)', '.toBe(1)'));
    assert.equal(inspectExecution(green.report, green.result, profile, fixture, 'candidate').status, 'passed');
    assert.throws(() => inspectExecution(green.report, green.result, profile, fixture, 'bad'), /intended behavioral/);
    assert.throws(() => inspectExecution(valid.report, { ...valid.result, timedOut: true }, profile, fixture, 'bad'), /timeout/);
    // A phase whose child exited successfully but was cancelled is never evidence,
    // even with a passing report.
    assert.throws(() => inspectExecution(green.report, { ...green.result, cancelled: true }, profile, fixture, 'candidate'), /cancellation/);

    // Report paths are read with the rules of the machine that produced them, so
    // a Windows receipt validates on any host and a POSIX one does too.
    const reportNamed = (name) => ({ ...structuredClone(green.report), testResults: [{ ...structuredClone(green.report.testResults[0]), name }] });
    const windowsReport = reportNamed(`C:/Temp/candidate/${profile.file}`);
    assert.equal(inspectExecution(windowsReport, green.result, profile, 'C:\\Temp\\candidate', 'candidate', 'win32').status, 'passed');
    assert.throws(() => inspectExecution(windowsReport, green.result, profile, 'C:\\Temp\\candidate', 'candidate', 'linux'), /wrong file/);
    assert.throws(() => inspectExecution(windowsReport, green.result, profile, 'C:\\Temp\\elsewhere', 'candidate', 'win32'), /wrong file/);
    assert.throws(() => inspectExecution(reportNamed('C:/Temp/candidate/packages/agent/test/other.test.ts'), green.result, profile, 'C:\\Temp\\candidate', 'candidate', 'win32'), /wrong file/);
    assert.equal(inspectExecution(reportNamed(`/Users/dev/candidate/${profile.file}`), green.result, profile, '/Users/dev/candidate', 'candidate', 'darwin').status, 'passed');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('proof identity rejects stale test and runner bytes, and stale receipt digest', () => {
  const actual = proofIdentity(root, profile);
  for (const file of [profile.file, 'scripts/qa-prove-regression.mjs']) {
    const stale = { ...actual, [file]: sha256('previous bytes') };
    assert.throws(() => verifyIdentity(actual, stale), /stale test\/fixture or proof identity/);
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-identity-'));
  try {
    // The evidence validator must reach the input identity check and reject it.
    for (const [file, hash] of Object.entries(actual)) {
      const target = path.join(temp, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target); assert.equal(sha256(fs.readFileSync(target)), hash);
    }
    const receipt = { schemaVersion: 1, caseId: record.id, status: 'proven', method: 'historical-replay',
      toolchain: { node: 'v22.23.2' }, cleanup: { bad: 'removed', candidate: 'removed' }, identity: actual };
    const bytes = JSON.stringify(receipt); fs.writeFileSync(path.join(temp, 'receipt.json'), bytes);
    const withProof = { ...record, proof: { status: 'proven', receipt: 'receipt.json', receiptSha256: sha256(bytes) } };
    fs.appendFileSync(path.join(temp, profile.file), '\n// stale fixture\n');
    assert.throws(() => validateEvidence(temp, withProof, profile), /stale test\/fixture or proof identity/);
    assert.throws(() => validateEvidence(temp, { ...withProof, proof: { ...withProof.proof, receiptSha256: sha256('old receipt') } }, profile), /stale proof receipt identity/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('proof identities isolate each selected case while retaining shared execution inputs', () => {
  const other = profileFor(JSON.parse(fs.readFileSync(path.join(root, 'test-policy/regressions/GH-2741.json'), 'utf8')));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-profile-identity-'));
  const saved = [profile, other].map((selected) => proofIdentity(root, selected));
  try {
    for (const file of new Set(saved.flatMap((identity) => Object.keys(identity)))) {
      const target = path.join(temp, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target);
    }
    fs.appendFileSync(path.join(temp, profile.definitionFile), '\n// selected case change\n');
    assert.throws(() => verifyIdentity(proofIdentity(temp, profile), saved[0]), /stale/);
    assert.doesNotThrow(() => verifyIdentity(proofIdentity(temp, other), saved[1]));
    fs.copyFileSync(path.join(root, profile.definitionFile), path.join(temp, profile.definitionFile));
    // Registering another case edits the register, and the validator is no evidence producer:
    // neither is fingerprinted, so neither invalidates an existing receipt.
    for (const file of ['scripts/lib/regressions/profiles.mjs', 'scripts/lib/regressions/registry.mjs']) {
      for (const identity of saved) assert.ok(!(file in identity), `${file} is not part of a receipt identity`);
      const target = path.join(temp, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, file), target); fs.appendFileSync(target, '\n// registering another case\n');
      for (const [index, selected] of [profile, other].entries()) {
        assert.doesNotThrow(() => verifyIdentity(proofIdentity(temp, selected), saved[index]), file);
      }
    }
    // Every shared execution input invalidates every receipt.
    for (const file of SHARED_EXECUTION_INPUTS) {
      const target = path.join(temp, file); const original = fs.readFileSync(target);
      fs.appendFileSync(target, '\n// shared execution change\n');
      for (const [index, selected] of [profile, other].entries()) {
        assert.throws(() => verifyIdentity(proofIdentity(temp, selected), saved[index]), /stale/, `${file} for ${selected.caseId}`);
      }
      fs.writeFileSync(target, original);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Windows pnpm launch preserves arguments without command-interpreter expansion', () => {
  const args = ['--version', 'spaces and "quotes"', '%PATH%', '!expanded!', '& echo unsafe | > file', '^regex$'];
  for (const entry of ['C:\\Program Files\\pnpm\\pnpm.cjs', 'C:\\Corepack\\pnpm.js', 'C:\\Tools\\pnpm.exe']) {
    const invocation = commandInvocation('pnpm.cmd', args, { platform: 'win32', env: { npm_execpath: entry }, node: 'C:\\Node\\node.exe' });
    if (entry.endsWith('.exe')) assert.deepEqual(invocation, { command: entry, args });
    else assert.deepEqual(invocation, { command: 'C:\\Node\\node.exe', args: [entry, ...args] });
  }
  for (const entry of [undefined, 'pnpm.cjs', 'C:\\Tools\\npm-cli.js', 'C:\\Tools\\pnpm.cmd']) {
    assert.throws(() => commandInvocation('pnpm.cmd', args, { platform: 'win32', env: { npm_execpath: entry } }), /through pnpm/);
  }
  assert.deepEqual(commandInvocation(process.execPath, args, { platform: 'win32' }), { command: process.execPath, args });
});

test('bounded proof launcher executes the installed pinned pnpm version', { timeout: 35000 }, async () => {
  await checkInstalledPnpm(root);
});

test('bounded subprocess runner stops only its own timed-out or cancelled child', { timeout: 15000 }, async () => {
  // The check keeps an unrelated sentinel process alive through both cleanups and asserts it survives.
  assert.deepEqual(await checkOwnedProcessTermination(root),
    { timedOutTreeStopped: true, cancelledTreeStopped: true, unrelatedProcessSurvived: true });
});

// A launcher that exits while a descendant outside its tree keeps the output
// open, the way an unreachable Windows descendant does after taskkill.
const retainingLauncher = ['-e', `const { spawn } = require('node:child_process');
  const retainer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
  console.log('RETAINING_PID ' + retainer.pid); retainer.unref();`];

test('a descendant that keeps the output open cannot hang the runner', { timeout: 30000 }, async () => {
  assert.deepEqual(await checkRetainedOutputIsBounded(root), { retainedOutputBounded: true });
});

test('an abort after the launcher exited is recorded and never reads as a successful phase', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-abort-'));
  let retainer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 700);
    let result;
    try { result = await runCommand(process.execPath, retainingLauncher, root, path.join(temp, 'retained.log'), 30000, controller.signal, { settleMs: 3000 }); }
    finally { clearTimeout(timer); }
    retainer = Number(/RETAINING_PID (\d+)/.exec(result.stdout)?.[1]);
    assert.equal(result.code, 0, 'the launcher exited successfully before the abort');
    assert.equal(result.signal, null);
    assert.equal(result.cancelled, true);
    assert.equal(phaseSucceeded(result), false);
    assert.throws(() => requirePrerequisite(result, 'install'), /install failed; no behavioral proof \(cancelled\)/);
    // An abort that arrives before the command starts is recorded the same way.
    const aborted = new AbortController(); aborted.abort();
    const early = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], root, path.join(temp, 'early.log'), 30000, aborted.signal);
    assert.equal(early.cancelled, true); assert.equal(phaseSucceeded(early), false);
  } finally {
    if (retainer) { try { process.kill(retainer); } catch { /* already gone */ } }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

// A launcher that exits while an ordinary child, in the launcher's own process
// group, keeps the output open.
const groupLauncher = ['-e', `const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
  console.log('GROUP_CHILD_PID ' + child.pid); child.unref();`];

test('output still open after the launcher exited stops the descendants the runner owns, and nothing else', {
  timeout: 30000,
  skip: process.platform === 'win32' && 'Windows has no process group the runner can signal after the launcher exited',
}, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-group-'));
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  sentinel.unref();
  let descendant;
  try {
    const result = await runCommand(process.execPath, groupLauncher, root, path.join(temp, 'group.log'), 60000, undefined, { settleMs: 500 });
    descendant = Number(/GROUP_CHILD_PID (\d+)/.exec(result.stdout)?.[1]);
    assert.ok(descendant, 'the descendant started');
    assert.match(result.error ?? '', /still open/);
    assert.equal(result.timedOut, false);
    assert.equal(phaseSucceeded(result), false);
    let running = true;
    for (let attempt = 0; attempt < 60 && running; attempt++) {
      try { process.kill(descendant, 0); await new Promise((resolve) => setTimeout(resolve, 50)); } catch (error) { assert.equal(error.code, 'ESRCH'); running = false; }
    }
    assert.equal(running, false, 'the descendant in the owned process group was stopped');
    assert.doesNotThrow(() => process.kill(sentinel.pid, 0), 'an unrelated process survived');
  } finally {
    sentinel.kill();
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already stopped */ } }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('a log that cannot be written fails the phase and stops the child instead of throwing', { timeout: 30000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-log-'));
  const marker = 'LOG-WRITE-FAILS-HERE';
  const writeSync = fs.writeSync;
  // Only the command's own output fails, so the test reporter's writes are untouched.
  const failing = mock.method(fs, 'writeSync', (fd, data, ...rest) => {
    if (Buffer.isBuffer(data) && data.includes(marker)) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return writeSync(fd, data, ...rest);
  });
  try {
    const result = await runCommand(process.execPath, ['-e', `console.log(${JSON.stringify(marker)}); setInterval(() => {}, 1000)`],
      root, path.join(temp, 'full.log'), 20000, undefined, { settleMs: 2000 });
    assert.ok(failing.mock.callCount() > 0, 'the log write was attempted');
    assert.match(result.error ?? '', /cannot write the phase log: ENOSPC/);
    assert.equal(result.timedOut, false);
    assert.equal(phaseSucceeded(result), false);
    assert.equal(result.signal, 'SIGKILL', 'the owned child was stopped rather than left to its deadline');
  } finally {
    failing.mock.restore();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('live results and serialized phases are held to one prerequisite contract', () => {
  const completed = { code: 0, signal: null, timedOut: false };
  const phases = (side = 'bad', overrides = {}) => PHASE_ORDER.map((name) => ({ side, name, ...completed, ...overrides[name] }));
  assert.deepEqual(sidePhases(phases(), 'bad').prerequisites.map((phase) => phase.name), [...PREREQUISITE_PHASES]);
  for (const [label, defect] of [['a non-zero exit', { code: 1 }], ['a signal', { signal: 'SIGKILL' }], ['a launch or output error', { error: 'spawn failed' }],
    ['a deadline', { timedOut: true }], ['a cancellation', { cancelled: true }]]) {
    for (const name of PREREQUISITE_PHASES) {
      assert.throws(() => requirePrerequisite({ ...completed, ...defect }, name), /no behavioral proof/, `${label} in the live ${name}`);
      assert.throws(() => sidePhases(phases('bad', { [name]: defect }), 'bad'), /missing successful prerequisites/, `${label} in the recorded ${name}`);
    }
  }
  // Order and completeness come from the contract, not from array positions.
  assert.throws(() => sidePhases([...phases()].reverse(), 'bad'), /prerequisites/);
  assert.throws(() => sidePhases(phases().slice(1), 'bad'), /prerequisites/);
  assert.throws(() => sidePhases(phases().slice(0, -1), 'bad'), /prerequisites/);
  assert.throws(() => sidePhases([...phases(), phases()[1]], 'bad'), /prerequisites/);
  assert.throws(() => requirePrerequisite(completed, 'execution'), /unknown prerequisite/);
  // The execution is addressed by name and keeps each side's own expectation.
  const both = [...phases('bad', { execution: { code: 1 } }), ...phases('candidate')];
  assert.equal(sidePhases(both, 'bad').execution.code, 1);
  assert.equal(sidePhases(both, 'candidate').execution.side, 'candidate');
});

test('registry discovery and proof execution resolve the same Windows pnpm invocation', () => {
  const options = { platform: 'win32', env: { npm_execpath: 'C:\\Program Files\\pnpm\\pnpm.cjs' }, node: 'C:\\Node\\node.exe' };
  assert.equal(pnpmCommand('win32'), 'pnpm.cmd'); assert.equal(pnpmCommand('linux'), 'pnpm');
  const pnpmArgs = ['--dir', 'packages/agent', 'exec', 'vitest', 'list', '--config', 'vitest.unit.config.ts',
    profile.file.replace('packages/agent/', ''), '--json'];
  const discovery = discoveryInvocation([profile], options);
  assert.deepEqual(discovery, commandInvocation('pnpm.cmd', pnpmArgs, options));
  assert.deepEqual(discovery, { command: 'C:\\Node\\node.exe', args: [options.env.npm_execpath, ...pnpmArgs] });
  assert.deepEqual(discoveryInvocation([profile], { platform: 'linux' }), { command: 'pnpm', args: pnpmArgs });
  assert.throws(() => discoveryInvocation([profile], { platform: 'win32', env: {} }), /through pnpm/);
});

test('registry rejects skipped assertions even with a general disabled-test waiver', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-waiver-'));
  const pragma = ['test', 'disable', 'allow'].join('-') + ':';
  const source = `import { describe, it } from 'vitest';
describe(${JSON.stringify(profile.suite)}, () => {
// ${pragma} D1 #2782 -- owner=agent lane=tornado-agent expires=${new Date(Date.now() + 86400000).toISOString().slice(0, 10)} reviewed debt
it.skip(${JSON.stringify(profile.title)}, () => {});
});
`;
  try {
    const file = path.join(temp, profile.file); fs.mkdirSync(path.dirname(file), { recursive: true });
    const unproven = { ...record, proof: { status: 'unproven', method: 'historical-replay', receipt: null } };
    for (const text of [source, source.replace(pragma, pragma.toUpperCase())]) {
      fs.writeFileSync(file, text);
      assert.equal(analyzeTestSource(text, profile.file).disabled.length, 0, 'the general waiver would hide this disabled test');
      const raw = analyzeTestSource(text, profile.file, { applyWaivers: false });
      assert.equal(raw.disabled.length, 1); assert.equal(raw.disabled[0].api, 'it.skip');
      assert.equal(raw.disabled[0].line, 4, 'the original source location is preserved');
      assert.throws(() => validateRegressions(temp, inventory, { records: [{ file: 'GH-2782.json', record: unproven }],
        discover: () => discovered, shards }), /disabled or focused/);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
