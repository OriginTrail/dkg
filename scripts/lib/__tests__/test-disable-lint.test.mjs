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

test('file audit reports declarations only from active test sources', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-scope-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixtures = new Map([
    ['src/widget.spec.ts', "// test.skip('commented');\nconst example = \"xit('string')\";"],
    ['packages/example/test/support.ts', "test.skip('active support', () => {});"],
    ['src/support.ts', "test.skip('ordinary source', () => {});"],
    ['node_modules/example/test/dependency.ts', "test.skip('dependency', () => {});"],
    ['dist/tests/compiled.ts', "test.skip('distribution output', () => {});"],
    ['build/test/generated.ts', "test.skip('build output', () => {});"],
    ['coverage/test/instrumented.ts', "test.skip('coverage output', () => {});"],
    ['test/archive/legacy.test.ts', "test.skip('archived test', () => {});"],
    ['tests/archive/legacy.test.ts', "test.skip('archived tests', () => {});"],
  ]);
  const fixturePaths = [];
  for (const [relativePath, source] of fixtures) {
    const fixturePath = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, source);
    fixturePaths.push(fixturePath);
  }

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--files', ...fixturePaths], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  const activePath = path.join(fixtureRoot, 'packages/example/test/support.ts');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${activePath}:1:1: D1 test.skip`);
});

test('file audit accepts only nearby matching ticketed D1 pragmas with reasons', (t) => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'test-disable-pragma-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const fixturePath = path.join(fixtureRoot, 'pragma.test.ts');
  fs.writeFileSync(fixturePath, [
    '// test-disable-allow: D1 #123 -- unavailable on the Windows runner',
    "test.skip('ticket number', () => {});",
    '',
    '// test-disable-allow: D1 https://github.com/OriginTrail/dkg/issues/456 -- upstream fix pending',
    "it.todo('issue URL');",
    '',
    '// test-disable-allow: D1 DKG-789 -- migration remains in progress',
    "xdescribe('tracker key', () => {});",
    '',
    '// test-disable-allow: D2 #100 -- wrong rule',
    "test.skip('wrong rule', () => {});",
    '// test-disable-allow: D1 -- missing ticket',
    "xit('missing ticket', () => {});",
    '// test-disable-allow: D1 #101 --',
    "xtest('missing reason', () => {});",
    '// test-disable-allow: D1 #102 -- outside the allowed window',
    '',
    '',
    '',
    "describe.skip('distant pragma', () => {});",
    '',
    '// test-disable-allow: D1 #103 -- exactly three lines above',
    '',
    '',
    "test.todo('window boundary');",
  ].join('\n'));

  const result = spawnSync(process.execPath, [LINT_SCRIPT, '--files', fixturePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    `${fixturePath}:11:1: D1 test.skip`,
    `${fixturePath}:13:1: D1 xit`,
    `${fixturePath}:15:1: D1 xtest`,
    `${fixturePath}:20:1: D1 describe.skip`,
  ]);
});
