// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRemoteCanaryConfigV1 } from './certify.mjs';
import { askContextGraphPairsV1, askQueryV1 } from './query.mjs';
import { baseConfig } from './test-support.mjs';

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

test('paired catalog and VM ASK phases cap individual node requests at four', async () => {
  const template = baseConfig().contextGraphs[0];
  const contextGraphs = Array.from({ length: 5 }, (_, index) => ({
    ...template,
    id: `0x${(index + 1).toString(16).padStart(40, '0')}/testnet-canary`,
    vmAskSparql: `ASK { <urn:known:vm:${index}> ?p ?o }`,
    catalogSwmAskSparql: `ASK { <urn:known:swm:${index}> ?p ?o }`,
  }));
  const config = validateRemoteCanaryConfigV1(baseConfig({ contextGraphs }));
  for (const [queryField, view] of [
    ['catalogSwmAskSparql', 'shared-working-memory'],
    ['vmAskSparql', 'verifiable-memory'],
  ]) {
    let active = 0;
    let peak = 0;
    let completed = 0;
    const client = {
      askQuery: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setImmediate(resolve));
        active -= 1;
        completed += 1;
        return true;
      },
    };

    const result = await askContextGraphPairsV1(
      config.contextGraphs,
      queryField,
      view,
      client,
    );

    assert.equal(peak, 4, queryField);
    assert.equal(completed, contextGraphs.length * 2, queryField);
    assert.deepEqual(
      result,
      contextGraphs.map(() => ({ source: true, receiver: true })),
      queryField,
    );
  }
});
