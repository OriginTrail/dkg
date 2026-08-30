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

function indexEntry(mode, objectId, filePath) {
  return Buffer.concat([
    Buffer.from(`${mode} ${objectId} 0\t`),
    filePath,
    Buffer.from([0]),
  ]);
}

function batchBlob(objectId, contents) {
  return Buffer.concat([
    Buffer.from(`${objectId} blob ${contents.length}\n`),
    contents,
    Buffer.from('\n'),
  ]);
}

function batchCheck(objectId, contents) {
  return Buffer.from(`${objectId} blob ${contents.length}\n`);
}

test('enumerates every tracked path once and classifies file buffers', () => {
  const calls = [];
  const cleanObject = 'a'.repeat(40);
  const brokenObject = 'b'.repeat(40);
  const cleanContents = Buffer.from('const clean = true;');
  const brokenContents = Buffer.from([0x23, 0x20, 0x00, 0x62]);
  const offenders = findTrackedFilesWithNul({
    repoRoot: '/repo',
    spawnProcess(command, args, options) {
      calls.push([command, args]);
      if (args[0] === 'ls-files') {
        return result(0, Buffer.concat([
          indexEntry('100644', cleanObject, Buffer.from('clean.ts')),
          indexEntry('100644', brokenObject, Buffer.from('broken.md')),
          indexEntry('120000', 'd'.repeat(40), Buffer.from('payload-link')),
          indexEntry('160000', 'e'.repeat(40), Buffer.from('nested-repository')),
        ]));
      }
      if (args[1] === '--batch-check') {
        assert.equal(options.input.toString('ascii'), `${cleanObject}\n${brokenObject}\n`);
        return result(0, Buffer.concat([
          batchCheck(cleanObject, cleanContents),
          batchCheck(brokenObject, brokenContents),
        ]));
      }
      assert.deepEqual(args, ['cat-file', '--batch']);
      assert.equal(options.input.toString('ascii'), `${cleanObject}\n${brokenObject}\n`);
      return result(0, Buffer.concat([
        batchBlob(cleanObject, cleanContents),
        batchBlob(brokenObject, brokenContents),
      ]));
    },
  });

  assert.deepEqual(offenders, [Buffer.from('broken.md')]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0][1], ['ls-files', '--stage', '-z']);
});

test('preserves and inspects invalid UTF-8 pathname bytes even with a binary-looking suffix', () => {
  const invalidPath = Buffer.concat([Buffer.from([0xff]), Buffer.from('.png')]);
  const objectId = 'c'.repeat(40);
  const offenders = findTrackedFilesWithNul({
    repoRoot: '/repo',
    spawnProcess(_command, args) {
      if (args[0] === 'ls-files') {
        return result(0, indexEntry('100644', objectId, invalidPath));
      }
      if (args[1] === '--batch-check') {
        return result(0, batchCheck(objectId, Buffer.from([0x61, 0x00, 0x62])));
      }
      return result(0, batchBlob(objectId, Buffer.from([0x61, 0x00, 0x62])));
    },
  });

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
  git('add', 'broken.mjs', 'docs/readme.md', 'future-source.cts');
  assert.equal(runTrackedTextNulCheck({ repoRoot, log() {}, logError() {} }), 0);
});

test('real Git scan skips symlinks instead of opening their NUL-containing targets', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-text-nul-symlink-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const git = (...args) => {
    const invocation = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(invocation.status, 0, invocation.stderr);
  };
  git('init', '--quiet');
  fs.writeFileSync(
    path.join(repoRoot, 'untracked-target.bin'),
    Buffer.from([0x61, 0x00, 0x62]),
  );
  fs.symlinkSync('untracked-target.bin', path.join(repoRoot, 'payload'));
  fs.writeFileSync(path.join(repoRoot, 'regular.txt'), Buffer.from([0x61, 0x00, 0x62]));
  git('add', 'payload', 'regular.txt');

  const offenders = findTrackedFilesWithNul({ repoRoot }).map((filePath) =>
    filePath.toString('utf8'));

  assert.deepEqual(offenders, ['regular.txt']);
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

test('the CLI accepts its default root and rejects incomplete or unknown options', () => {
  const defaultInvocation = spawnSync(process.execPath, [CHECKER_PATH], { encoding: 'utf8' });
  assert.equal(defaultInvocation.status, 0, defaultInvocation.stderr);

  const missingValue = spawnSync(process.execPath, [CHECKER_PATH, '--repo'], { encoding: 'utf8' });
  assert.equal(missingValue.status, 1);
  assert.match(missingValue.stderr, /argument missing|option.*repo/i);

  const unknownOption = spawnSync(process.execPath, [CHECKER_PATH, '--unknown'], { encoding: 'utf8' });
  assert.equal(unknownOption.status, 1);
  assert.match(unknownOption.stderr, /unknown option.*--unknown/i);
});

test('the CLI keeps the last repeated --repo value', (t) => {
  const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-text-nul-clean-'));
  const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dkg-text-nul-broken-'));
  t.after(() => {
    fs.rmSync(cleanRoot, { recursive: true, force: true });
    fs.rmSync(brokenRoot, { recursive: true, force: true });
  });
  for (const repoRoot of [cleanRoot, brokenRoot]) {
    const invocation = spawnSync('git', ['init', '--quiet'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(invocation.status, 0, invocation.stderr);
  }
  fs.writeFileSync(path.join(cleanRoot, 'source.mjs'), 'export const clean = true;\n');
  fs.writeFileSync(path.join(brokenRoot, 'source.mjs'), Buffer.from([0x61, 0x00, 0x62]));
  for (const repoRoot of [cleanRoot, brokenRoot]) {
    const invocation = spawnSync('git', ['add', '--all'], { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(invocation.status, 0, invocation.stderr);
  }

  const cleanLast = spawnSync(
    process.execPath,
    [CHECKER_PATH, '--repo', brokenRoot, '--repo', cleanRoot],
    { encoding: 'utf8' },
  );
  assert.equal(cleanLast.status, 0, cleanLast.stderr);

  const brokenLast = spawnSync(
    process.execPath,
    [CHECKER_PATH, '--repo', cleanRoot, '--repo', brokenRoot],
    { encoding: 'utf8' },
  );
  assert.equal(brokenLast.status, 1);
  assert.match(brokenLast.stderr, /source\.mjs/);
});
