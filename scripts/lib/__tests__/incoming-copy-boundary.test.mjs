import assert from 'node:assert/strict';
import test from 'node:test';
import { findIncomingCopyBoundaryViolations } from '../incoming-copy-boundary.mjs';

const allowed = { rewrite: ['packages/a/src/accept.ts'] };

test('accepts exactly the pinned source users', () => {
  assert.deepEqual(findIncomingCopyBoundaryViolations([
    { path: 'packages/a/src/accept.ts', text: 'rewrite(copy)' },
    { path: 'packages/b/src/verify.ts', text: 'hash(bytes)' },
    { path: 'packages/b/test/verify.test.ts', text: 'rewrite(copy)' },
  ], allowed), []);
});

test('reports a new user and a pinned file that stopped using the symbol', () => {
  assert.deepEqual(findIncomingCopyBoundaryViolations([
    { path: 'packages/a/src/accept.ts', text: 'hash(bytes)' },
    { path: 'packages/b/src/verify.ts', text: 'rewrite(bytes)' },
  ], allowed), [
    'packages/b/src/verify.ts: uses rewrite, which only packages/a/src/accept.ts may use',
    'packages/a/src/accept.ts: no longer uses rewrite; remove it from the allowlist in '
      + 'scripts/lib/incoming-copy-boundary.mjs',
  ]);
});
