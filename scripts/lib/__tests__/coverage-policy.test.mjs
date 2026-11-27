import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectCoverage, hasRuntimeCode, changedCoverage, changedLinesFromDiff } from '../../ci/check-coverage.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-coverage-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'coverage'));
  fs.writeFileSync(path.join(root, 'src/used.ts'), 'export const value = 1;');
  const totals = { lines: { total: 1, covered: 1, pct: 100 } };
  const report = { total: totals, [path.join(root, 'src/used.ts')]: totals };
  const write = () => fs.writeFileSync(path.join(root, 'coverage/coverage-summary.json'), JSON.stringify(report));
  write();
  fs.writeFileSync(path.join(root, 'coverage/lcov.info'), 'SF:src/used.ts\nDA:1,1\nend_of_record\n');
  return { root, report, write };
}

test('an unimported executable module must not disappear from the denominator', (t) => {
  const f = fixture(t);
  inspectCoverage(f.root);
  fs.writeFileSync(path.join(f.root, 'src/forgotten.ts'), 'export function deny() { return false; }');
  assert.throws(() => inspectCoverage(f.root), /source missing.*forgotten/);
});

test('helpers and missing reports cannot produce a passing coverage verdict', (t) => {
  const f = fixture(t);
  f.report[path.join(f.root, 'test/helper.ts')] = f.report.total;
  f.write();
  assert.throws(() => inspectCoverage(f.root), /non-production files/);
  fs.unlinkSync(path.join(f.root, 'coverage/coverage-summary.json'));
  assert.throws(() => inspectCoverage(f.root), /ENOENT/);
});

test('type-only modules are distinguished from barrels, constants and side effects', () => {
  assert.equal(hasRuntimeCode('types.ts', 'export interface A { x: string }; export type B = A;'), false);
  assert.equal(hasRuntimeCode('index.ts', 'export { value } from "./used.js";'), true);
  assert.equal(hasRuntimeCode('types.ts', 'export enum Permission { Read, Write }'), true);
  assert.equal(hasRuntimeCode('boot.ts', 'import "./install.js";'), true);
});

test('changed coverage counts executable lines, including zero-hit new branches', () => {
  const root = '/repo';
  const diff = '+++ b/packages/core/src/auth.ts\n@@ -1 +1,3 @@\n+example\n';
  const changes = changedLinesFromDiff(diff);
  const coverage = { lines: new Map([['/repo/packages/core/src/auth.ts', new Map([[1, 1], [3, 0]])]]) };
  assert.throws(() => changedCoverage(coverage, changes, root, 90), /1\/2.*auth.ts:3/);
  coverage.lines.get('/repo/packages/core/src/auth.ts').set(3, 1);
  assert.equal(changedCoverage(coverage, changes, root, 90).percent, 100);
});

test('deletions have no added executable lines and empty reports fail closed', (t) => {
  assert.equal(changedLinesFromDiff('+++ b/a.ts\n@@ -1,3 +1,0 @@').get('a.ts').size, 0);
  const f = fixture(t);
  f.report.total.lines.total = 0;
  f.write();
  assert.throws(() => inspectCoverage(f.root), /no executable lines/);
});
