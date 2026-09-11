// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RemoteCanaryError,
  validateRemoteCanaryConfigV1,
} from './certify.mjs';
import { baseConfig } from './test-support.mjs';

test('strict config rejects inline credentials and multiple receivers', () => {
  assert.throws(
    () => validateRemoteCanaryConfigV1(baseConfig({
      lifecycle: {
        receiverNodeId: 'beta-receiver',
        stop: { argv: ['control', '--token=inline'] },
        start: { argv: ['control', 'start'] },
      },
    })),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'inline-command-secret-rejected',
  );

  const config = baseConfig();
  config.nodes.push({
    id: 'gamma-receiver',
    role: 'receiver',
    baseUrl: 'https://gamma.internal.example',
    auth: { kind: 'none' },
  });
  config.contextGraphs.push({
    id: 'second-canary',
    expectedMode: 'catalog',
    sourceNodeId: 'alpha-source',
    receiverNodeId: 'gamma-receiver',
  });
  assert.throws(
    () => validateRemoteCanaryConfigV1(config),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'exactly-one-receiver-required',
  );
});

test('the standards-based config validator enforces authorization body shape', () => {
  const valid = baseConfig();
  assert.doesNotThrow(() => validateRemoteCanaryConfigV1(valid));

  const invalid = baseConfig();
  invalid.authorizationChecks.unauthorized.body = 'probe';
  assert.throws(
    () => validateRemoteCanaryConfigV1(invalid),
    (error) => error instanceof RemoteCanaryError && error.code === 'config-shape',
  );
});

test('normalization resolves the canonical execution topology once', () => {
  const config = validateRemoteCanaryConfigV1(baseConfig());
  const contextGraph = config.contextGraphs[0];
  assert.equal(contextGraph.source, config.nodes[0]);
  assert.equal(contextGraph.receiver, config.nodes[1]);
  assert.equal(config.lifecycle.receiver, contextGraph.receiver);
  assert.equal(config.authorizationChecks.unauthorized.node, contextGraph.receiver);
  assert.match(contextGraph.contextGraphRef, /^cg:[0-9a-f]{20}$/u);
  assert.match(contextGraph.source.nodeRef, /^node:[0-9a-f]{20}$/u);
});

test('schema owns numeric bounds while normalization applies canonical defaults', () => {
  const normalized = validateRemoteCanaryConfigV1(baseConfig({ timing: {} }));
  assert.deepEqual(normalized.timing, {
    requestTimeoutMs: 10_000,
    pollIntervalMs: 2_000,
    propagationTimeoutMs: 120_000,
    catchupTimeoutMs: 240_000,
    parityTimeoutMs: 120_000,
  });
  const config = baseConfig({ timing: { requestTimeoutMs: 999 } });
  assert.throws(
    () => validateRemoteCanaryConfigV1(config),
    (error) => error instanceof RemoteCanaryError && error.code === 'config-shape',
  );
});

test('config requires mandatory basic graph patterns for both ASK evidence fields', () => {
  for (const field of ['vmAskSparql', 'catalogSwmAskSparql']) {
    for (const sparql of [
      'ASK {}',
      'ASK { BIND("constant" AS ?x) }',
      'ASK { OPTIONAL { <urn:known> ?p ?o } }',
      'ASK { { <urn:known> ?p ?o } UNION {} }',
      'ASK { ?s ?p ?o }',
      'ASK { _:asset ?p ?o }',
      'ASK { [] ?p ?o }',
    ]) {
      const config = baseConfig();
      config.contextGraphs[0][field] = sparql;
      assert.throws(
        () => validateRemoteCanaryConfigV1(config),
        (error) => error instanceof RemoteCanaryError
          && error.code.endsWith('query-must-depend-on-data'),
        `${field}: ${sparql}`,
      );
    }
  }
});
test('standards ASK parsing preserves ordinary prefixed and literal syntax', () => {
  for (const sparql of [
    'ASK WHERE { <urn:known> a "value"@en . }',
    'PREFIX ex: <urn:example:> ASK { ex:subject ex:count 42 . }',
    'ASK { <urn:known> <urn:value> "1"^^<http://www.w3.org/2001/XMLSchema#integer> }',
  ]) {
    const config = baseConfig();
    config.contextGraphs[0].vmAskSparql = sparql;
    assert.doesNotThrow(() => validateRemoteCanaryConfigV1(config), sparql);
  }
});

test('standards ASK parsing rejects updates and non-ASK queries', () => {
  for (const [sparql, expectedCode] of [
    ['INSERT DATA { <urn:x> <urn:y> <urn:z> }', 'vm-query-must-be-read-only'],
    ['SELECT * WHERE { <urn:x> ?p ?o }', 'vm-query-must-be-ask'],
  ]) {
    const config = baseConfig();
    config.contextGraphs[0].vmAskSparql = sparql;
    assert.throws(
      () => validateRemoteCanaryConfigV1(config),
      (error) => error instanceof RemoteCanaryError && error.code === expectedCode,
    );
  }
});

test('config rejects swapped authorization modes and common inline secret forms', () => {
  for (const [field, authentication, code] of [
    ['unauthorized', 'node', 'unauthorized-authentication-mode'],
    ['revoked', 'none', 'revoked-authentication-mode'],
  ]) {
    const config = baseConfig();
    config.authorizationChecks[field].authentication = authentication;
    assert.throws(
      () => validateRemoteCanaryConfigV1(config),
      (error) => error instanceof RemoteCanaryError && error.code === code,
    );
  }
  for (const secretArgv of [
    ['curl', '-H', 'Authorization: Bearer top-secret'],
    ['curl', '--user', 'operator:password'],
    ['env', 'QUICKNODE_API_KEY=top-secret', 'collector'],
  ]) {
    const config = baseConfig();
    config.lifecycle.stop = { argv: secretArgv };
    assert.throws(
      () => validateRemoteCanaryConfigV1(config),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'inline-command-secret-rejected',
    );
  }

  for (const field of ['unauthorized', 'revoked']) {
    for (const required of ['bodyCodePointer', 'expectedCodes']) {
      const config = baseConfig();
      delete config.authorizationChecks[field][required];
      assert.throws(
        () => validateRemoteCanaryConfigV1(config),
        (error) => error instanceof RemoteCanaryError && error.code === 'config-shape',
        `${field}.${required}`,
      );
    }
  }
});
