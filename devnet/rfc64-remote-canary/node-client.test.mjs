// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { createCanaryNodeClientV1 } from './node-client.mjs';
import { statusBody } from './test-support.mjs';

test('node client owns exact daemon routes, payloads, authentication, and decoding', async () => {
  const node = { id: 'receiver' };
  const calls = [];
  const status = statusBody();
  const client = createCanaryNodeClientV1({
    json: async (...args) => {
      calls.push(args);
      if (args[2] === '/api/status') return status;
      if (args[2] === '/api/query') return { result: { type: 'boolean', value: true } };
      if (args[2] === '/api/knowledge-assets') return { swmShared: true };
      throw new Error('unexpected JSON route');
    },
    raw: async (...args) => {
      calls.push(args);
      return calls.filter((call) => call.length === 5).length === 1
        ? { status: 403, text: '{"code":"RFC64_DENIED"}' }
        : { status: 204, text: '' };
    },
    reachable: async (...args) => {
      calls.push(args);
      return false;
    },
  });
  const query = {
    contextGraphId: 'did:dkg:otp/2043/0x0123456789abcdef0123456789abcdef01234567/42',
    sparql: 'ASK { <urn:subject> <urn:predicate> "value" . }',
    view: 'shared-working-memory',
  };
  const marker = {
    contextGraphId: query.contextGraphId,
    name: 'marker-name',
    quads: [{ subject: 'urn:subject', predicate: 'urn:predicate', object: '"value"' }],
    alsoShareSwm: true,
  };
  const probe = {
    method: 'POST',
    path: '/api/rfc64/authorization-probe',
    body: { contextGraphId: query.contextGraphId },
    authentication: 'none',
  };

  assert.deepEqual(await client.readCertificationStatus(node), status.rfc64Certification);
  assert.equal(await client.askQuery(node, query), true);
  assert.equal(await client.shareSwmMarker(node, marker), true);
  assert.equal(await client.reachable(node), false);
  assert.deepEqual(await client.probeAuthorization(node, probe), {
    status: 403,
    body: { code: 'RFC64_DENIED' },
  });
  assert.equal(await client.probeAuthorizationControl(node, {
    ...probe,
    authentication: 'node',
  }), 204);
  assert.deepEqual(calls, [
    [node, 'GET', '/api/status'],
    [node, 'POST', '/api/query', query],
    [node, 'POST', '/api/knowledge-assets', marker],
    [node],
    [node, probe.method, probe.path, probe.body, probe.authentication],
    [node, probe.method, probe.path, probe.body, 'node'],
  ]);
});

test('node client accepts only explicit positive ASK and marker-share receipts', async () => {
  const node = { id: 'source' };
  for (const result of [
    null,
    [],
    {},
    { result: null },
    { result: [] },
    { result: { type: 'bindings', value: true } },
    { result: { type: 'boolean', value: false } },
  ]) {
    const client = createCanaryNodeClientV1({ json: async () => result });
    assert.equal(await client.askQuery(node, {
      contextGraphId: 'cg',
      sparql: 'ASK {}',
      view: 'verifiable-memory',
    }), false);
  }
  for (const result of [null, [], {}, { swmShared: false }]) {
    const client = createCanaryNodeClientV1({ json: async () => result });
    assert.equal(await client.shareSwmMarker(node, {
      contextGraphId: 'cg',
      name: 'marker',
      quads: [],
      alsoShareSwm: true,
    }), false);
  }
});
