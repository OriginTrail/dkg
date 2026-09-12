// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { askQueryV1 } from './query.mjs';

test('ASK helper preserves the exact node, graph, query, view, and response', async () => {
  const node = { id: 'receiver' };
  const calls = [];
  const request = {
    json: async (...args) => {
      calls.push(args);
      return { result: { type: 'boolean', value: true } };
    },
  };

  assert.equal(await askQueryV1(
    node,
    'did:dkg:otp/2043/0x0123456789abcdef0123456789abcdef01234567/42',
    'ASK { <urn:subject> <urn:predicate> "value" . }',
    'shared-working-memory',
    request,
  ), true);
  assert.deepEqual(calls, [[
    node,
    'POST',
    '/api/query',
    {
      sparql: 'ASK { <urn:subject> <urn:predicate> "value" . }',
      contextGraphId: 'did:dkg:otp/2043/0x0123456789abcdef0123456789abcdef01234567/42',
      view: 'shared-working-memory',
    },
  ]]);
});

test('ASK helper accepts only a true boolean query result', async () => {
  const node = { id: 'source' };
  const cases = [
    null,
    [],
    {},
    { result: null },
    { result: [] },
    { result: { type: 'bindings', value: true } },
    { result: { type: 'boolean', value: false } },
  ];
  for (const result of cases) {
    const request = { json: async () => result };
    assert.equal(await askQueryV1(
      node,
      'did:dkg:otp/2043/0x0123456789abcdef0123456789abcdef01234567/42',
      'ASK {}',
      'verifiable-memory',
      request,
    ), false);
  }
});
