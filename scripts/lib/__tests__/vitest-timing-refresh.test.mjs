import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadVitestTimings } from '../../ci/load-vitest-timings.mjs';
import { PACKAGE_SPECS } from '../../ci/plan-vitest-shard.mjs';
import {
  TIMED_PACKAGE_DIRECTORIES, parseEstimate, parseJunitReport, parseSource, parseVitestLog, refreshTimings,
} from '../../ci/refresh-vitest-timings.mjs';

const script = fileURLToPath(new URL('../../ci/refresh-vitest-timings.mjs', import.meta.url));
const commit = 'a'.repeat(40);
const E = '\u001b';

// A shard job log as `gh api .../jobs/ID/logs --allow-escape-sequences` saves it:
// byte-order mark, a timestamp on every line and the default reporter's colours.
function jobLog({ pkg = 'cli', shard = 1, files, importTime = '3.00s', declared = files.length, summaryExtra = '', runs = 1, report = true, extra = [] }) {
  const passed = (file, ms) => ` ${E}[32m✓${E}[39m ${file} ${E}[2m(${E}[22m${E}[2m3 tests${E}[22m${E}[2m)${E}[22m${E}[32m ${ms}${E}[2mms${E}[22m${E}[39m`;
  const skipped = (file) => ` ${E}[2m${E}[90m↓${E}[39m${E}[22m ${file} ${E}[2m(${E}[22m${E}[2m2 tests${E}[22m${E}[2m | ${E}[22m${E}[33m2 skipped${E}[39m${E}[2m)${E}[22m`;
  const lines = [
    '##[group]Run node scripts/ci/run-vitest-lanes.mjs --job "$GITHUB_JOB" --row "$DKG_CI_ROW"',
    ...Array(runs).fill(`${E}[1m${E}[46m RUN ${E}[49m${E}[22m ${E}[36mv4.0.18 ${E}[39m${E}[90m/home/runner/work/dkg/dkg/packages/${pkg}${E}[39m`),
    ...files.map(([file, ms]) => (ms === null ? skipped(file) : passed(file, ms))),
    `     ${E}[33m✓${E}[39m a slow test of the last file ${E}[33m 1234${E}[2mms${E}[22m${E}[39m`,
    ...extra,
    `${E}[2m Test Files ${E}[22m ${E}[1m${E}[32m${files.length} passed${E}[39m${E}[22m${summaryExtra}${E}[90m (${declared})${E}[39m`,
    `${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m9 passed${E}[39m${E}[22m${E}[90m (9)${E}[39m`,
    `${E}[2m   Duration ${E}[22m 10.00s${E}[2m (transform 1.00s, setup 0ms, import ${importTime}, tests 5.00s, environment 0ms)${E}[22m`,
    ...(report ? [`JUNIT report written to /home/runner/work/dkg/dkg/packages/${pkg}/test-results/${pkg}-${shard}.xml`] : []),
  ];
  return '﻿' + lines.map((line) => `2026-11-11T12:11:51.9783390Z ${line}`).join('\n') + '\n';
}

function junit(files, suiteAttributes = '') {
  const suites = files.map(([file, ms]) => (ms === null
    ? `<testsuite name="${file}" tests="2" failures="0" errors="0" skipped="2" time="0"></testsuite>`
    : `<testsuite name="${file}" tests="3" failures="0" errors="0" skipped="0" time="${ms / 1000}" ${suiteAttributes}><testcase classname="${file}" name="passes" time="0.001"></testcase></testsuite>`));
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<testsuites name="vitest tests" tests="9" failures="0" errors="0" time="1">\n${suites.join('\n')}\n</testsuites>\n`;
}

const SHARD_FILES = (a = 120, c = 30) => [[['test/a.test.ts', a], ['test/nested/b.test.ts', null]], [['test/c.test.ts', c]]];

function workspace(t, present = ['test/a.test.ts', 'test/nested/b.test.ts', 'test/c.test.ts', 'test/new.test.ts']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitest timings '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  for (const file of present) write(path.join('packages/cli', file), '');
  // Two-shard cli runs; logs by default, JUnit files on request.
  const run = (name, shards = SHARD_FILES(), { format = 'log', imports = ['3.00s', '900ms'] } = {}) => {
    shards.forEach((files, index) => (format === 'log'
      ? write(`${name}/cli-${index + 1}.log`, jobLog({ shard: index + 1, files, importTime: imports[index] }))
      : write(`${name}/vitest-cli-${index + 1}-of-${shards.length}/cli/test-results/cli-${index + 1}.xml`, junit(files))));
    return path.join(root, name);
  };
  return { root, write, run };
}

const refresh = (root, sources, options = {}) => refreshTimings({
  packageName: 'cli', shardCount: 2, repoRoot: root,
  sources: sources.map((directory, index) => ({ runId: 100 + index, commit, directory })), ...options,
});

test('logs give each file its median duration across runs and the median import time per file', (t) => {
  const { root, run } = workspace(t);
  const sources = [run('one', SHARD_FILES(100, 30)), run('two', SHARD_FILES(200, 50)), run('three', SHARD_FILES(121, 40))];
  const { snapshot, dropped } = refresh(root, sources);
  assert.deepEqual(dropped, []);
  assert.deepEqual(snapshot.bodyWeightsMs, { 'test/a.test.ts': 121, 'test/c.test.ts': 40, 'test/nested/b.test.ts': 0 });
  // Shard 1 imports two files in 3 s, shard 2 one file in 900 ms: the median of 1500 and 900 per file.
  assert.equal(snapshot.perFileOverheadMs, 1200);
  assert.equal(snapshot.aggregation, 'median');
  assert.deepEqual(snapshot.sources[0], { runId: 100, commit, url: 'https://github.com/OriginTrail/dkg/actions/runs/100' });
  assert.equal(refresh(root, sources.slice(0, 2)).snapshot.bodyWeightsMs['test/a.test.ts'], 150, 'an even count averages the middle pair');
  assert.ok(!Object.hasOwn(snapshot, 'estimatedBodyWeightsMs'));
});

test('JUnit reports give the same weights as the job logs of the same run', (t) => {
  const { root, run } = workspace(t);
  const fromLogs = refresh(root, [run('logs')], { perFileOverheadMs: 7 }).snapshot;
  const fromJunit = refresh(root, [run('junit', SHARD_FILES(), { format: 'xml' })], { perFileOverheadMs: 7 }).snapshot;
  assert.deepEqual(fromJunit, fromLogs);
  assert.throws(() => refresh(root, [path.join(root, 'junit')]), /JUnit reports carry no import time/);
  assert.deepEqual(parseJunitReport(junit([['test/a.test.ts', 0.4]]), 'x.xml'), [{ file: 'test/a.test.ts', ms: 0 }]);
});

test('reports of other packages in a run directory are skipped', (t) => {
  const { root, run, write } = workspace(t);
  const directory = run('mixed');
  write('mixed/chain-1.log', jobLog({ pkg: 'chain', files: [['test/z.test.ts', 9]] }));
  write('mixed/vitest-tornado-core-chain-1/chain/test-results/chain-1.xml', junit([['test/z.test.ts', 9]]));
  write('mixed/vitest-cli-1-of-2/cli/test-results/cli-1.coverage.json', '{}');
  assert.deepEqual(Object.keys(refresh(root, [directory]).snapshot.bodyWeightsMs), ['test/a.test.ts', 'test/c.test.ts', 'test/nested/b.test.ts']);
});

test('measured files that left the package are dropped', (t) => {
  const { root, run } = workspace(t, ['test/a.test.ts', 'test/nested/b.test.ts']);
  const { snapshot, dropped } = refresh(root, [run('one')]);
  assert.deepEqual(dropped, ['test/c.test.ts']);
  assert.ok(!Object.hasOwn(snapshot.bodyWeightsMs, 'test/c.test.ts'));
  const empty = workspace(t, []);
  assert.throws(() => refresh(empty.root, [empty.run('one')]), /none of the measured files exist in packages\/cli/);
});

test('reviewed estimates stay apart from measurements and load as known weights', (t) => {
  const { root, run, write } = workspace(t);
  const directory = run('one');
  const estimate = parseEstimate('test/new.test.ts=4500', 'cli', root);
  const { snapshot } = refresh(root, [directory], { estimates: [estimate] });
  assert.deepEqual(snapshot.estimatedBodyWeightsMs, { 'test/new.test.ts': 4500 });
  const file = write('snapshot.json', JSON.stringify(snapshot));
  const loaded = loadVitestTimings(file, 'CLI');
  assert.equal(loaded.bodyWeightsMs['test/new.test.ts'], 4500);
  assert.equal(loaded.bodyWeightsMs['test/a.test.ts'], 120);
  assert.equal(loaded.perFileOverheadMs, snapshot.perFileOverheadMs);
  assert.ok(Object.isFrozen(loaded.bodyWeightsMs));

  assert.throws(() => refresh(root, [directory], { estimates: [['test/a.test.ts', 1]] }), /measured; drop the estimate/);
  assert.throws(() => refresh(root, [directory], { estimates: [estimate, estimate] }), /duplicate --estimate/);
  assert.throws(() => parseEstimate('test/missing.test.ts=1', 'cli', root), /does not exist in packages\/cli/);
  assert.throws(() => parseEstimate('test/new.test.ts', 'cli', root), /test\/NAME\.test\.ts=MILLISECONDS/);
  write('both.json', JSON.stringify({ ...snapshot, estimatedBodyWeightsMs: { 'test/a.test.ts': 1 } }));
  assert.throws(() => loadVitestTimings(path.join(root, 'both.json'), 'CLI'), /Invalid CLI timing snapshot .*test\/a\.test\.ts is both measured and estimated/);
  write('bad.json', JSON.stringify({ ...snapshot, estimatedBodyWeightsMs: { 'test/../x.test.ts': 1 } }));
  assert.throws(() => loadVitestTimings(path.join(root, 'bad.json'), 'CLI'), /invalid CLI test path/);
});

const failing = [
  ['a failed file', (files) => jobLog({ files }).replace(`${E}[32m✓${E}[39m test/a.test.ts`, `${E}[31m×${E}[39m test/a.test.ts`), /failed or incomplete test file test\/a\.test\.ts/],
  ['a summary with failures', (files) => jobLog({ files, summaryExtra: ` | ${E}[31m1 failed${E}[39m` }), /reports failed test files/],
  ['unhandled errors', (files) => jobLog({ files, extra: [`${E}[2m     Errors ${E}[22m ${E}[1m${E}[31m1 error${E}[39m${E}[22m`] }), /the run reports errors/],
  ['a missing summary', (files) => jobLog({ files }).split('\n').filter((line) => !line.includes('Duration')).join('\n'), /no summary/],
  ['a file count mismatch', (files) => jobLog({ files, declared: 3 }), /declares 3 test files but the log lists 2/],
  ['an unsafe path', (files) => jobLog({ files: [['test/../a.test.ts', 1], ...files.slice(1)] }), /unexpected test path/],
  ['two Vitest runs', (files) => jobLog({ files, runs: 2 }), /expected one Vitest run/],
  ['no JUnit report line', (files) => jobLog({ files, report: false }), /expected one cli JUnit report line, found 0/],
];
for (const [name, edit, error] of failing) {
  test(`a log with ${name} fails the refresh`, (t) => {
    const { root, run, write } = workspace(t);
    const directory = run('one');
    write('one/cli-1.log', edit(SHARD_FILES()[0]));
    assert.throws(() => refresh(root, [directory]), error);
  });
}

test('every run must provide each expected shard exactly once', (t) => {
  const { root, run, write } = workspace(t);
  const partial = run('partial', SHARD_FILES().slice(0, 1));
  assert.throws(() => refresh(root, [partial]), /missing cli reports cli-2\.xml/);
  const duplicate = run('duplicate');
  write('duplicate/again/cli-1.xml', junit([['test/other.test.ts', 1]]));
  assert.throws(() => refresh(root, [duplicate]), /duplicate cli report cli-1\.xml/);
  const unexpected = run('unexpected');
  write('unexpected/cli-3.xml', junit([['test/other.test.ts', 1]]));
  assert.throws(() => refresh(root, [unexpected]), /unexpected cli report cli-3\.xml/);
  const overlap = run('overlap', [SHARD_FILES()[0], [['test/a.test.ts', 5]]]);
  assert.throws(() => refresh(root, [overlap]), /test\/a\.test\.ts ran in two shards/);
});

test('JUnit reports must be passing Vitest reports with valid durations', (t) => {
  const { root, run, write } = workspace(t);
  const directory = run('one', SHARD_FILES(), { format: 'xml' });
  const report = path.join(directory, 'vitest-cli-1-of-2/cli/test-results/cli-1.xml');
  for (const [xml, error] of [
    [junit(SHARD_FILES()[0], 'failures="1"').replace(/failures="0" errors="0" skipped="0" /, ''), /failed test file test\/a\.test\.ts/],
    [junit(SHARD_FILES()[0]).replace('time="0.12"', 'time="nan"'), /invalid duration for test\/a\.test\.ts/],
    ['<report/>', /expected a Vitest testsuites report/],
  ]) {
    write(path.relative(root, report), xml);
    assert.throws(() => refresh(root, [directory], { perFileOverheadMs: 1 }), error);
  }
});

test('sources and run identities are validated', (t) => {
  const { root, run } = workspace(t);
  const directory = run('one');
  assert.deepEqual(parseSource(`42:${commit}:/tmp/a:b`), { runId: 42, commit, directory: '/tmp/a:b' });
  assert.throws(() => parseSource('42:abc123:/tmp/a'), /full commit SHA/);
  assert.throws(() => refreshTimings({ packageName: 'cli', shardCount: 2, repoRoot: root, sources: [] }), /at least one/);
  assert.throws(() => refreshTimings({
    packageName: 'cli', shardCount: 2, repoRoot: root,
    sources: [{ runId: 1, commit, directory }, { runId: 1, commit, directory }],
  }), /duplicate source run/);
  assert.throws(() => refresh(root, [directory], { shardCount: 0 }), /--shards must be a positive integer/);
  assert.throws(() => refreshTimings({ packageName: 'agent', sources: [] }), /unsupported package agent/);
  assert.equal(parseVitestLog(jobLog({ pkg: 'chain', files: [['test/z.test.ts', 1]] }), 'cli', 'chain.log'), undefined);
});

test('the executable writes the snapshot only when every input is usable', (t) => {
  const { root, run, write } = workspace(t);
  // The executable keeps files that exist in this checkout, so measure real ones.
  const [first, second, third] = fs.readdirSync(new URL('../../../packages/cli/test/', import.meta.url))
    .filter((name) => name.endsWith('.test.ts')).sort().map((name) => `test/${name}`);
  const good = run('good', [[[first, 120], [second, null]], [[third, 30]]]);
  const output = path.join(root, 'out', 'cli.json');
  const ok = spawnSync(process.execPath, [script, 'cli', '--shards', '2', '--per-file-overhead-ms', '5', '--output', output, `7:${commit}:${good}`], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Wrote 3 measured cli files from 1 runs \(per-file overhead 5 ms, 0 estimates\)/);
  assert.deepEqual(loadVitestTimings(output, 'CLI'), { perFileOverheadMs: 5, bodyWeightsMs: { [first]: 120, [second]: 0, [third]: 30 } });

  const bad = run('bad');
  write('bad/cli-2.log', 'truncated');
  const failedOutput = path.join(root, 'out', 'failed.json');
  const failed = spawnSync(process.execPath, [script, 'cli', '--shards', '2', '--output', failedOutput, `8:${commit}:${bad}`], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /refresh-vitest-timings: .*missing cli reports cli-2\.xml/);
  assert.ok(!fs.existsSync(failedOutput));
  for (const args of [[], ['agent', '--output', failedOutput], ['cli'], ['cli', '--output', failedOutput, '--shards', 'two', `8:${commit}:${good}`]]) {
    const usage = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /refresh-vitest-timings: /);
  }
  assert.ok(!fs.existsSync(failedOutput));
});

test('timed packages match the planner and the checked-in snapshots are loadable', () => {
  for (const [packageName, directory] of Object.entries(TIMED_PACKAGE_DIRECTORIES)) {
    const file = new URL(`../../ci/timings/${packageName}.json`, import.meta.url);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const loaded = loadVitestTimings(file, packageName);
    assert.equal(PACKAGE_SPECS[packageName].packageDirectory, directory);
    assert.equal(raw.package, packageName);
    assert.ok(raw.sources.length > 0 && raw.sources.every(({ runId, commit: sha, url }) => (
      Number.isInteger(runId) && /^[0-9a-f]{40}$/.test(sha) && url.endsWith(`/actions/runs/${runId}`))));
    assert.equal(PACKAGE_SPECS[packageName].perFileOverheadMs, loaded.perFileOverheadMs);
    assert.deepEqual(PACKAGE_SPECS[packageName].bodyWeightsMs, loaded.bodyWeightsMs);
    // An estimate covers a file no source run measured yet; the next refresh replaces it.
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    for (const estimated of Object.keys(raw.estimatedBodyWeightsMs ?? {})) {
      assert.ok(fs.existsSync(path.join(root, directory, estimated)), `${estimated} must exist`);
    }
  }
});
