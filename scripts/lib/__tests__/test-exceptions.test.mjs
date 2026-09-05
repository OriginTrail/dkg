import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectTestExceptions } from '../test-exceptions.mjs';

const inspect = (source) => inspectTestExceptions(source, 'example.test.ts', new Date('2026-09-05T00:00:00Z'));
test('focused aliases and chained each are rejected, comments and strings are not code', () => {
  assert.deepEqual(inspect("import { test as check } from 'vitest';\ncheck.only.each([1])('case', () => {});\nfit('focused', () => {});").focused, [2, 3]);
  assert.deepEqual(inspect("// test.only('not a call')\nconst text = \"it.only('text')\";\nclient.only();").focused, []);
});
test('temporary test exceptions require an owner, execution obligation and a valid unexpired deadline', () => {
  const marker = '// test-disable-allow: D1 #123 -- repair pending owner=storage lane=tornado-blazegraph expires=';
  assert.deepEqual(inspect(marker + '2026-09-10').invalidExceptions, []);
  for (const date of ['2026-09-04', '2026-12-01', '2026-09-31', 'invalid']) assert.deepEqual(inspect(marker + date).invalidExceptions, [1]);
  assert.deepEqual(inspect('// test-disable-allow: D1 #123 -- no owner').invalidExceptions, [1]);
  assert.deepEqual(inspect('// test-disable-allow: D1 #123 -- missing lane owner=storage expires=2026-09-10').invalidExceptions, [1]);
  assert.deepEqual(inspect('const fixture = "// test-disable-allow: D1 #123 -- example";').invalidExceptions, []);
});
