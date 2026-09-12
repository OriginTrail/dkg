// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { askQueryV1 } from './query.mjs';

test('ASK helper delegates one typed query without changing its fields', async () => {
  const node = { id: 'receiver' };
  const calls = [];
  const client = {
    askQuery: async (...args) => {
      calls.push(args);
      return true;
    },
  };

  assert.equal(await askQueryV1(
    node,
    'did:dkg:otp/2043/0x0123456789abcdef0123456789abcdef01234567/42',
    'ASK { <urn:subject> <urn:predicate> "value" . }',
    'shared-working-memory',
    client,
  ), true);
  assert.deepEqual(calls, [[
    node,
    {
      sparql: 'ASK { <urn:subject> <urn:predicate> "value" . }',
      contextGraphId: 'did:dkg:otp/2043/0x0123456789abcdef0123456789abcdef01234567/42',
      view: 'shared-working-memory',
    },
  ]]);
});
