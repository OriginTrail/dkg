import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LINT_SCRIPT = path.join(REPO_ROOT, 'scripts/test-disable-lint.mjs');

test('file audit reports direct disabled declarations at their source locations', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-lint-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixturePath = path.join(fixtureRoot, 'test/direct.test.ts');
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(fixturePath, [
    "test.skip('skipped test', () => {});",
    "it.todo('todo test');",
    "describe.skip('skipped suite', () => {});",
    "xit('legacy it', () => {});",
    "xtest('legacy test', () => {});",
    "xdescribe('legacy suite', () => {});",
    "test('active test', () => {});",
  ].join('\n'));

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--files', fixturePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${fixturePath}:1:1: D1 test.skip`,
    `${fixturePath}:2:1: D1 it.todo`,
    `${fixturePath}:3:1: D1 describe.skip`,
    `${fixturePath}:4:1: D1 xit`,
    `${fixturePath}:5:1: D1 xtest`,
    `${fixturePath}:6:1: D1 xdescribe`,
  ]);
});
