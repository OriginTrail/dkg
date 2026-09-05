import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectJunitResults } from '../junit-results.mjs';
import { runVitestJunit } from '../../ci/run-vitest-junit.mjs';

test('JUnit parser counts executed cases and ignores escaped logs and skipped cases', () => {
  assert.deepEqual(inspectJunitResults('<?xml version="1.0"?><testsuites tests="2"><testsuite><testcase name="works &amp; passes"><system-out><![CDATA[<skipped/>]]></system-out></testcase><testcase><skipped/></testcase></testsuite></testsuites>'), { executedTests: 1, skippedTests: 1 });
});

test('empty, all-skipped, failing, malformed and non-JUnit reports cannot emit coverage receipts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-junit-results-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'packages/example');
  fs.mkdirSync(path.join(pkg, 'src'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ devDependencies: { vitest: '*' } }));
  fs.writeFileSync(path.join(pkg, 'src/main.ts'), 'export const answer = 42;');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty'], { cwd: root });
  const receipt = path.join(pkg, 'test-results/example.coverage.json');
  const run = (xml) => runVitestJunit(['--lane', 'example'], { repoRoot: root, coverage: true, spawnProcess: () => {
    fs.mkdirSync(path.join(pkg, 'coverage'), { recursive: true });
    const file = path.join(pkg, 'src/main.ts');
    fs.writeFileSync(path.join(pkg, 'coverage/coverage-final.json'), JSON.stringify({ [file]: { path: file } }));
    fs.writeFileSync(path.join(pkg, 'test-results/example.xml'), xml);
    return { status: 0 };
  } });
  const valid = '<testsuite tests="1"><testcase name="passes"/></testsuite>';
  for (const xml of ['', '<testsuites/>', '<testsuite tests="99"/>', '<testsuite tests="2"><testcase/></testsuite>', '<testsuite tests="1" skipped="1"><testcase/></testsuite>', '<testsuites tests="2"><testsuite tests="1"><testcase/></testsuite></testsuites>', '<testsuite><testcase><skipped/></testcase></testsuite>', '<testsuite><testcase><failure/></testcase></testsuite>', '<testsuite errors="1"><testcase/></testsuite>', '<testsuite><testcase/></wrong>', '<not-junit/>']) {
    assert.equal(run(valid), 0);
    assert.equal(run(xml), 1, xml);
    assert.equal(fs.existsSync(receipt), false, 'stale receipt must also be removed');
  }
  assert.equal(run(valid), 0);
  assert.equal(JSON.parse(fs.readFileSync(receipt)).executedTests, 1);
});
