// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateCommandV1 } from './command-policy.mjs';
import { RemoteCanaryError } from './errors.mjs';

test('command policy rejects concatenated curl authorization headers', () => {
  for (const header of [
    '-HAuthorization: Bearer top-secret',
    '-Hauthorization : bAsIc dXNlcjpwYXNz',
    '--header=AUTHORIZATION:Bearer top-secret',
  ]) {
    assert.throws(
      () => validateCommandV1({ argv: ['curl', header, 'https://collector.invalid'] }),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'inline-command-secret-rejected',
      header,
    );
  }
});

test('command policy preserves legitimate concatenated curl headers', () => {
  assert.deepEqual(
    validateCommandV1({
      argv: ['curl', '-HAccept: application/json', 'https://collector.invalid'],
    }),
    {
      argv: ['curl', '-HAccept: application/json', 'https://collector.invalid'],
    },
  );
});
