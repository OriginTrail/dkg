import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAgentTimings } from '../../ci/load-agent-timings.mjs';

const script = fileURLToPath(new URL('../../ci/refresh-agent-timings.py', import.meta.url));
const commit = 'a'.repeat(40);
const suite = (index, attributes = '') => `<testsuite name="test/file-${index}.test.ts" time="0.0011" tests="1" ${attributes}><testcase name="passes"/></testsuite>`;
const report = (body) => `<testsuites>${body}</testsuites>`;

function fixture(t, { count = 10, edit = (xml) => xml, zip = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent JUnit '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reports = path.join(root, 'reports');
  fs.mkdirSync(reports);
  for (let index = 0; index < count; index += 1) {
    fs.writeFileSync(path.join(reports, `${index}.xml`), edit(report(suite(index)), index));
  }
  if (zip) {
    const result = spawnSync('python3', ['-c',
      'from pathlib import Path; import sys,zipfile; p=Path(sys.argv[1]); z=zipfile.ZipFile(p/"reports.zip","w"); [(z.write(f,"nested/"+f.name),f.unlink()) for f in sorted(p.glob("*.xml"))]; z.close()',
      reports], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const output = path.join(root, 'output', 'agent.json');
  const result = spawnSync('python3', [script, reports, '--run-id', '123', '--commit', commit, '--output', output], { encoding: 'utf8' });
  return { result, output };
}

for (const zip of [false, true]) {
  test(`timing refresh accepts ${zip ? 'ZIP' : 'extracted XML'} and rounds up milliseconds without weighting skipped suites`, (t) => {
    const { result, output } = fixture(t, { zip, edit: (xml, index) => index === 0
      ? report(suite(index) + '<testsuite name="test/skipped.test.ts" time="0" tests="1" skipped="1"><testcase name="skipped"><skipped/></testcase></testsuite>')
      : xml });
    assert.equal(result.status, 0, result.stderr);
    const raw = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(raw.schemaVersion, 1);
    assert.deepEqual(raw.source, { runId: 123, commit, url: 'https://github.com/OriginTrail/dkg/actions/runs/123' });
    const normalized = loadAgentTimings(output);
    assert.equal(normalized.perFileOverheadMs, 1100);
    assert.equal(Object.keys(normalized.bodyWeightsMs).length, 10);
    assert.ok(Object.values(normalized.bodyWeightsMs).every((value) => value === 2));
    assert.ok(!Object.hasOwn(normalized.bodyWeightsMs, 'test/skipped.test.ts'));
  });
}

const invalidFixtures = [
  ['failed suite', { edit: (xml, i) => i === 0 ? report(suite(i, 'failures="1"')) : xml }, /failed suite/],
  ['errored suite', { edit: (xml, i) => i === 0 ? report(suite(i, 'errors="1"')) : xml }, /failed suite/],
  ['duplicate suite', { edit: (xml, i) => i === 1 ? report(suite(0)) : xml }, /duplicate test suite/],
  ['malformed XML', { edit: (xml, i) => i === 0 ? '<testsuites>' : xml }, /ParseError/],
  ['wrong XML root', { edit: (xml, i) => i === 0 ? '<report/>' : xml }, /expected a Vitest testsuites report/],
  ['invalid duration', { edit: (xml) => xml.replace('0.0011', 'nan') }, /invalid duration/],
  ['negative duration', { edit: (xml) => xml.replace('0.0011', '-1') }, /invalid duration/],
  ['unsafe path', { edit: (xml) => xml.replace('test/file-', 'test/../file-') }, /unexpected agent test path/],
  ['missing suite fields', { edit: (xml) => xml.replace('tests="1"', '') }, /KeyError/],
  ['all skipped', { edit: (xml, i) => report(suite(i, 'skipped="1"')) }, /expected all ten agent reports/],
  ...[0, 9, 11].map((count) => [`${count} reports`, { count }, /expected all ten agent reports/]),
];

for (const [name, options, error] of invalidFixtures) {
  test(`timing refresh rejects ${name} without publishing a baseline`, (t) => {
    const { result, output } = fixture(t, options);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.ok(!fs.existsSync(output));
  });
}
