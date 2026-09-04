import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findTrackedFilesWithNul,
  readTrackedBlobs,
  runTrackedTextNulCheck,
  TRACKED_BINARY_PATHS,
} from '../../ci/check-tracked-text-nul.mjs';

const CHECKER_PATH = fileURLToPath(new URL('../../ci/check-tracked-text-nul.mjs', import.meta.url));

test('scans every semantic blob record yielded by the Git adapter', () => {
  const offenders = findTrackedFilesWithNul({
    readTrackedBlobs: () => [
      { filePath: Buffer.from('clean.ts'), contents: Buffer.from('const clean = true;') },
      { filePath: Buffer.from('broken.md'), contents: Buffer.from([0x23, 0x00, 0x62]) },
    ],
  });

  assert.deepEqual(offenders, [Buffer.from('broken.md')]);
});

test('does not allow invalid UTF-8 paths to acquire a binary suffix exception', () => {
  const objectId = 'a'.repeat(40);
  const filePath = Buffer.concat([Buffer.from([0xff]), Buffer.from('.png')]);
  const contents = Buffer.from([0x61, 0x00, 0x62]);
  const spawnProcess = (_command, args, options) => {
    if (args[0] === 'ls-files') {
      return {
        status: 0,
        stdout: Buffer.concat([
          Buffer.from(`100644 ${objectId} 0\t`, 'ascii'),
          filePath,
          Buffer.from([0]),
        ]),
        stderr: Buffer.alloc(0),
      };
    }
    assert.equal(Buffer.from(options.input).toString('ascii'), `${objectId}\n`);
    if (args[1] === '--batch-check') {
      return {
        status: 0,
        stdout: Buffer.from(`${objectId} blob ${contents.length}\n`, 'ascii'),
        stderr: Buffer.alloc(0),
      };
    }
    return {
      status: 0,
      stdout: Buffer.concat([
        Buffer.from(`${objectId} blob ${contents.length}\n`, 'ascii'),
        contents,
        Buffer.from('\n'),
      ]),
      stderr: Buffer.alloc(0),
    };
  };

  assert.deepEqual([...readTrackedBlobs({ spawnProcess })], [{ filePath, contents }]);
});

test('Git adapter reads staged regular blobs and never follows symlinks', (t) => {
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
  fs.writeFileSync(path.join(repoRoot, 'untracked-target.bin'), Buffer.from([0x61, 0x00, 0x62]));
  fs.symlinkSync('untracked-target.bin', path.join(repoRoot, 'payload'));
  git('add', '--all');
  git('reset', '--quiet', 'untracked-target.bin');

  // The adapter reads the staged object, not this clean worktree replacement.
  fs.writeFileSync(path.join(repoRoot, 'broken.mjs'), 'export const clean = true;\n');
  const catFileInputs = [];
  const recordingSpawn = (command, args, options) => {
    if (command === 'git' && args[0] === 'cat-file') {
      catFileInputs.push(Buffer.from(options.input ?? '').toString('ascii'));
    }
    return spawnSync(command, args, options);
  };
  const records = [...readTrackedBlobs({ repoRoot, spawnProcess: recordingSpawn })];
  const recordPaths = records.map(({ filePath }) => filePath.toString('utf8'));
  assert.equal(records.find(({ filePath }) => filePath.equals(Buffer.from('broken.mjs')))
    ?.contents.includes(0), true);
  assert.equal(recordPaths.includes('payload'), false);
  assert.equal(recordPaths.includes('untracked-target.bin'), false);
  const imageObjectId = spawnSync('git', ['rev-parse', ':image.png'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).stdout.trim();
  assert.equal(recordPaths.includes('image.png'), false);
  assert.equal(catFileInputs.some((input) => input.includes(imageObjectId)), false);

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

  fs.writeFileSync(path.join(repoRoot, 'docs', 'readme.md'), '# clean\n');
  fs.writeFileSync(path.join(repoRoot, 'future-source.cts'), 'export const clean = true;\n');
  git('add', 'broken.mjs', 'docs/readme.md', 'future-source.cts');
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
