import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findTrackedFilesWithNul,
  runTrackedTextNulCheck,
  TRACKED_BINARY_PATHS,
} from '../../ci/check-tracked-text-nul.mjs';

const CHECKER_PATH = fileURLToPath(new URL('../../ci/check-tracked-text-nul.mjs', import.meta.url));

function result(status, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) {
  return { status, stdout, stderr, error: undefined, signal: null };
}

test('enumerates every tracked path once and classifies file buffers', () => {
  const calls = [];
  const files = new Map([
    [Buffer.from('/repo/clean.ts').toString('hex'), Buffer.from('const clean = true;')],
    [Buffer.from('/repo/broken.md').toString('hex'), Buffer.from([0x23, 0x20, 0x00, 0x62])],
  ]);
  const offenders = findTrackedFilesWithNul({
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
  assert.deepEqual(calls[0][1], ['ls-files', '-z']);
});

test('preserves and inspects invalid UTF-8 pathname bytes even with a binary-looking suffix', () => {
  const invalidPath = Buffer.concat([Buffer.from([0xff]), Buffer.from('.png')]);
  let openedPath;
  const offenders = findTrackedFilesWithNul({
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

test('real Git checkout checks unknown formats and exempts only explicit binaries', (t) => {
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
  fs.writeFileSync(path.join(repoRoot, 'future-source.cts'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(repoRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
  git('add', '--all');

  const errors = [];
  assert.equal(runTrackedTextNulCheck({
    repoRoot,
    log() {},
    logError(message) { errors.push(message); },
  }), 1);
  assert.match(errors.join('\n'), /broken\.mjs/);
  assert.match(errors.join('\n'), /docs\/readme\.md/);
  assert.match(errors.join('\n'), /future-source\.cts/);
  assert.doesNotMatch(errors.join('\n'), /image\.png/);

  fs.writeFileSync(path.join(repoRoot, 'broken.mjs'), 'export const clean = true;\n');
  fs.writeFileSync(path.join(repoRoot, 'docs', 'readme.md'), '# clean\n');
  fs.writeFileSync(path.join(repoRoot, 'future-source.cts'), 'export const clean = true;\n');
  assert.equal(runTrackedTextNulCheck({ repoRoot, log() {}, logError() {} }), 0);
});

test('the binary exception inventory is narrow and explicit', () => {
  assert.equal(TRACKED_BINARY_PATHS.suffixes.includes('.png'), true);
  assert.equal(TRACKED_BINARY_PATHS.suffixes.includes('.zip'), true);
  assert.equal(TRACKED_BINARY_PATHS.suffixes.includes('.ts'), false);
  assert.equal(TRACKED_BINARY_PATHS.suffixes.includes('.cts'), false);
});

test('the trusted CLI ignores a candidate-owned checker implementation', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-untrusted-text-nul-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const git = (...args) => {
    const invocation = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(invocation.status, 0, invocation.stderr);
  };
  git('init', '--quiet');
  fs.mkdirSync(path.join(repoRoot, 'scripts', 'ci'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'ci', 'check-tracked-text-nul.mjs'),
    'process.exitCode = 0;\n',
  );
  fs.writeFileSync(path.join(repoRoot, 'unrecognized-source'), Buffer.from([0x61, 0x00, 0x62]));
  git('add', '--all');

  const invocation = spawnSync(process.execPath, [CHECKER_PATH, '--repo', repoRoot], {
    encoding: 'utf8',
  });
  assert.equal(invocation.status, 1);
  assert.match(invocation.stderr, /unrecognized-source/);
});
