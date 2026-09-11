// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { verifyAuthorizationV1 } from './authorization.mjs';
import {
  RemoteCanaryError,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import {
  RECEIVER_SECRET,
  SOURCE_SECRET,
  baseConfig,
  jsonResponse,
} from './test-support.mjs';
import { createRequesterV1 } from './transport.mjs';

test('generic 404 cannot certify authorization even with a plausible denial body', async () => {
  const probes = [];
  const config = baseConfig();
  config.authorizationChecks.unauthorized = {
    kind: 'http',
    nodeId: 'beta-receiver',
    method: 'GET',
    path: '/api/typo',
    authentication: 'none',
    expectedStatuses: [404],
    bodyCodePointer: '/code',
    expectedCodes: ['RFC64_DENIED'],
    notFoundControlNodeId: 'alpha-source',
  };
  const validated = validateRemoteCanaryConfigV1(config);
  const fetchFn = async (input, options) => {
    const url = new URL(input);
    const authorization = new Headers(options.headers).get('authorization');
    if (url.pathname === '/api/typo') {
      probes.push({ authorization });
      return jsonResponse({ code: 'RFC64_DENIED' }, 404);
    }
    return jsonResponse({ code: 'RFC64_REVOKED' }, 403);
  };
  const request = createRequesterV1({
    fetchFn,
    readFileFn: async (path) => (
      path.includes('source') ? SOURCE_SECRET : RECEIVER_SECRET
    ),
    secrets: new Map(),
    timing: validated.timing,
  });
  await assert.rejects(
    verifyAuthorizationV1(validated.authorizationChecks, request),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'authorization-not-found-control-failed',
  );
  assert.equal(probes[0].authorization, null);
  assert.equal(probes[1].authorization, `Bearer ${SOURCE_SECRET}`);
});

test('real HTTP daemon authentication 401 cannot certify a nonexistent RFC-64 route', async () => {
  const server = createServer((request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 'AUTHENTICATION_REQUIRED' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const config = baseConfig();
  config.nodes[1].baseUrl = `http://127.0.0.1:${address.port}`;
  config.nodes[1].allowTailscaleHttp = true;
  config.authorizationChecks.unauthorized = {
    kind: 'http',
    nodeId: 'beta-receiver',
    method: 'GET',
    path: '/api/rfc64/typo',
    authentication: 'none',
    expectedStatuses: [401],
    bodyCodePointer: '/code',
    expectedCodes: ['RFC64_DENIED'],
  };
  config.authorizationChecks.revoked = {
    kind: 'not-exposed',
    reasonCode: 'revocation-api-not-exposed',
  };
  const validated = validateRemoteCanaryConfigV1(config);
  const request = createRequesterV1({
    fetchFn: globalThis.fetch,
    readFileFn: async () => RECEIVER_SECRET,
    secrets: new Map(),
    timing: validated.timing,
  });
  try {
    await assert.rejects(
      verifyAuthorizationV1(validated.authorizationChecks, request),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'authorization-denial-code-mismatch',
    );
  } finally {
    server.close();
    await once(server, 'close');
  }
});
