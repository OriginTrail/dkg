import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { discoverVitestFiles } from '../../ci/discover-vitest-files.mjs';

const root = path.resolve('example-package');
const success = (records) => ({ status: 0, stdout: JSON.stringify(records) });

test('Vitest discovery normalizes paths without prescribing a directory or extension', () => {
  const files = discoverVitestFiles(root, { run: (command, args, options) => {
    assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['exec', 'vitest', 'list', '--filesOnly', '--json']);
    assert.equal(options.cwd, root);
    assert.equal(options.timeout, 60_000);
    return success([{ file: path.join(root, 'src', 'nested', '..', 'example.test.mts') }, { file: './spec/thing.spec.js' }]);
  } });
  assert.deepEqual(files, ['spec/thing.spec.js', 'src/example.test.mts']);
});

for (const [name, result] of [
  ['spawn error', { error: new Error('ENOENT'), status: null }],
  ['nonzero exit', { status: 1, stderr: 'config failed' }],
  ['killed process', { status: null, signal: 'SIGKILL' }],
  ['malformed JSON', { status: 0, stdout: '{' }],
  ...[[], null, {}, [null], [1], [{}], [{ file: 2 }], [{ file: '' }],
    [{ file: '.' }], [{ file: root }], [{ file: '..' }], [{ file: '../outside.test.ts' }],
    [{ file: path.resolve(root, '../other/outside.test.ts') }], [{ file: 'spec/a\n.test.ts' }],
    [{ file: 'spec/a\r.test.ts' }], [{ file: 'spec/a\0.test.ts' }],
    [{ file: 'src/a.mts' }, { file: './src/a.mts' }],
  ].map((records, index) => [`invalid records ${index}`, success(records)]),
]) {
  test(`Vitest discovery rejects ${name}`, () => {
    assert.throws(() => discoverVitestFiles(root, { run: () => result }));
  });
}
