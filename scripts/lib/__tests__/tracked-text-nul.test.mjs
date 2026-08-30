import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findTrackedTextFilesWithNul,
  TRACKED_TEXT_PATHS,
} from '../../ci/check-tracked-text-nul.mjs';

function result(status, stdout = Buffer.alloc(0), stderr = Buffer.alloc(0)) {
  return { status, stdout, stderr, error: undefined, signal: null };
}

test('uses git grep PCRE results without invoking the fallback', () => {
  const calls = [];
  const offenders = findTrackedTextFilesWithNul({
    repoRoot: '/repo',
    spawnProcess(command, args) {
      calls.push([command, args]);
      return result(0, Buffer.from('packages/agent/src/broken.ts\0'));
    },
  });

  assert.deepEqual(offenders, ['packages/agent/src/broken.ts']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1].slice(0, 6), ['grep', '-z', '-l', '-P', '\\x00', '--']);
  assert.equal(calls[0][1].includes('-I'), false);
});

test('falls back to byte-level reads when Git was built without PCRE', () => {
  const calls = [];
  const files = new Map([
    ['/repo/clean.ts', Buffer.from('const clean = true;')],
    ['/repo/broken.md', Buffer.from([0x23, 0x20, 0x00, 0x62, 0x61, 0x64])],
  ]);
  const offenders = findTrackedTextFilesWithNul({
    repoRoot: '/repo',
    spawnProcess(command, args) {
      calls.push([command, args]);
      if (args[0] === 'grep') {
        return result(128, Buffer.alloc(0), Buffer.from(
          'fatal: cannot use Perl-compatible regexes when not compiled with USE_LIBPCRE',
        ));
      }
      return result(0, Buffer.from('clean.ts\0broken.md\0'));
    },
    readFile(filePath) {
      return files.get(filePath);
    },
  });

  assert.deepEqual(offenders, ['broken.md']);
  assert.deepEqual(calls.map(([, args]) => args[0]), ['grep', 'ls-files']);
});

test('the allowlist covers source text but excludes known binary artifact extensions', () => {
  assert.equal(TRACKED_TEXT_PATHS.includes('*.ts'), true);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.md'), true);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.png'), false);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.pdf'), false);
  assert.equal(TRACKED_TEXT_PATHS.includes('*.zip'), false);
});
