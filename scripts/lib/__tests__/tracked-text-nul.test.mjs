import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  findTrackedTextFilesWithNul,
  runTrackedTextNulCheck,
  TRACKED_TEXT_PATHS,
} from '../../ci/check-tracked-text-nul.mjs';

function result(status, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) {
  return { status, stdout, stderr, error: undefined, signal: null };
}

test('enumerates tracked text once and classifies file buffers', () => {
  const calls = [];
  const files = new Map([
    [Buffer.from('/repo/clean.ts').toString('hex'), Buffer.from('const clean = true;')],
    [Buffer.from('/repo/broken.md').toString('hex'), Buffer.from([0x23, 0x20, 0x00, 0x62])],
  ]);
  const offenders = findTrackedTextFilesWithNul({
    repoRoot: '/repo',
    spawnProcess(command, args) {
      calls.push([command, args]);
      return result(0, Buffer.from('clean.ts\0broken.md\0'));
    },
    readFile(filePath) {
      assert.equal(Buffer.isBuffer(filePath), true);
      return files.get(filePath.toString('hex'));
    },
  });

  assert.deepEqual(offenders, [Buffer.from('broken.md')]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 3), ['ls-files', '-z', '--']);
});

test('preserves invalid UTF-8 pathname bytes through file lookup', () => {
  const invalidPath = Buffer.from([0xff, 0x2e, 0x74, 0x73]);
  let openedPath;
  const offenders = findTrackedTextFilesWithNul({
    repoRoot: '/repo',
    spawnProcess() {
      return result(0, Buffer.concat([invalidPath, Buffer.from([0])]));
    },
    readFile(filePath) {
      openedPath = filePath;
      return Buffer.from([0x61, 0x00, 0x62]);
    },
  });

  assert.equal(Buffer.isBuffer(openedPath), true);
  assert.deepEqual(openedPath, Buffer.concat([Buffer.from('/repo/'), invalidPath]));
  assert.deepEqual(offenders, [invalidPath]);
});

test('real Git checkout fails for tracked NUL files and passes after cleanup', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-text-nul-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const git = (...args) => {
    const invocation = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(invocation.status, 0, invocation.stderr);
  };
  git('init', '--quiet');
  fs.mkdirSync(path.join(repoRoot, 'docs'));
  fs.writeFileSync(path.join(repoRoot, 'broken.mjs'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(repoRoot, 'docs', 'readme.md'), Buffer.from([0x23, 0x00, 0x20]));
  git('add', '--all');

  const errors = [];
  assert.equal(runTrackedTextNulCheck({
    repoRoot,
    log() {},
    logError(message) { errors.push(message); },
  }), 1);
  assert.match(errors.join('\n'), /broken\.mjs/);
  assert.match(errors.join('\n'), /docs\/readme\.md/);

  fs.writeFileSync(path.join(repoRoot, 'broken.mjs'), 'export const clean = true;\n');
  fs.writeFileSync(path.join(repoRoot, 'docs', 'readme.md'), '# clean\n');
  assert.equal(runTrackedTextNulCheck({ repoRoot, log() {}, logError() {} }), 0);
});

test('the allowlist covers source text but excludes known binary artifact extensions', () => {
  assert.equal(TRACKED_TEXT_PATHS.includes('*.ts'), true);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.md'), true);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.png'), false);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.pdf'), false);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.zip'), false);
});
