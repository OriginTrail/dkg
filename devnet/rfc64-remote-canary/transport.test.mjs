// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import { RemoteCanaryError } from './errors.mjs';
import {
  MAX_COMMAND_OUTPUT_BYTES,
  createRequesterV1,
  runBoundedCommandV1,
} from './transport.mjs';

const MAX_HTTP_BODY_BYTES = 1_048_576;

test('bounded commands succeed and pass argv literally without a shell', async () => {
  const literal = 'literal;$(printf never-executed)';
  const result = await runBoundedCommandV1({
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      literal,
    ],
  });
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), [literal]);
});

test('bounded commands reject timeout', async () => {
  await assert.rejects(
    runBoundedCommandV1({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1_000)'],
    }, 50),
    (error) => error instanceof RemoteCanaryError && error.code === 'command-timeout',
  );
});

test('bounded commands reject oversized stdout and stderr', async () => {
  for (const stream of ['stdout', 'stderr']) {
    await assert.rejects(
      runBoundedCommandV1({
        argv: [
          process.execPath,
          '-e',
          `process.${stream}.write('x'.repeat(Number(process.argv[1])))`,
          String(MAX_COMMAND_OUTPUT_BYTES + 1),
        ],
      }),
      (error) => error instanceof RemoteCanaryError
        && error.code === 'command-output-too-large',
      stream,
    );
  }
});

test('oversized command output is discarded while a SIGTERM-resistant child drains', {
  skip: process.platform === 'win32',
}, async () => {
  let samples = 0;
  let maxRetainedBytes = 0;
  await assert.rejects(
    runBoundedCommandV1({
      argv: [
        process.execPath,
        '-e',
        [
          "process.on('SIGTERM', () => {});",
          "const chunk = 'x'.repeat(65536);",
          'function write() {',
          '  while (process.stdout.write(chunk)) {}',
          "  process.stdout.once('drain', write);",
          '}',
          'write();',
        ].join('\n'),
      ],
    }, 5_000, {
      terminationGraceMs: 100,
      observeRetainedOutputBytes: ({ stdoutBytes, stderrBytes }) => {
        samples += 1;
        maxRetainedBytes = Math.max(maxRetainedBytes, stdoutBytes + stderrBytes);
      },
    }),
    (error) => error instanceof RemoteCanaryError
      && error.code === 'command-output-too-large',
  );
  assert.ok(samples > 2, 'child output was drained after termination started');
  assert.ok(maxRetainedBytes <= MAX_COMMAND_OUTPUT_BYTES);
});

test('bounded commands reject spawn failures', async () => {
  await assert.rejects(
    runBoundedCommandV1({ argv: ['/definitely/missing-rfc64-command'] }),
    (error) => error instanceof RemoteCanaryError && error.code === 'command-start-failed',
  );
});

test('reachability does not misclassify credential failures as an offline node', async () => {
  const request = createRequesterV1({
    fetchFn: async () => new Response(null, { status: 200 }),
    readFileFn: async () => { throw new Error('missing'); },
    secrets: new Map(),
    timing: { requestTimeoutMs: 1_000 },
  });
  await assert.rejects(
    request.reachable({
      id: 'receiver',
      baseUrl: 'https://receiver.invalid',
      auth: { kind: 'bearer-file', secretFile: '/missing' },
    }),
    (error) => error instanceof RemoteCanaryError && error.code === 'auth-secret-read-failed',
  );
});

test('canonical bounded response reader preserves the canary HTTP byte ceiling', async () => {
  let responseBytes = MAX_HTTP_BODY_BYTES;
  const request = createRequesterV1({
    fetchFn: async () => new Response(new Uint8Array(responseBytes)),
    readFileFn: async () => '',
    secrets: new Map(),
    timing: { requestTimeoutMs: 1_000 },
  });
  const node = {
    id: 'bounded-response',
    baseUrl: 'https://bounded.invalid',
    auth: { kind: 'none' },
  };

  const exact = await request.raw(node, 'GET', '/api/status');
  assert.equal(Buffer.byteLength(exact.text), MAX_HTTP_BODY_BYTES);
  responseBytes += 1;
  await assert.rejects(
    request.raw(node, 'GET', '/api/status'),
    (error) => error instanceof RemoteCanaryError && error.code === 'node-response-too-large',
  );
});

test('certification requests reject cross-origin and path-changing redirects', async () => {
  let redirectLocation = '/substitute';
  let substitutedRequests = 0;
  const target = createServer((request, response) => {
    substitutedRequests += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetAddress = target.address();
  assert.equal(typeof targetAddress, 'object');

  const redirector = createServer((request, response) => {
    if (request.url === '/substitute') {
      substitutedRequests += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(307, { Location: redirectLocation });
    response.end();
  });
  redirector.listen(0, '127.0.0.1');
  await once(redirector, 'listening');
  const redirectorAddress = redirector.address();
  assert.equal(typeof redirectorAddress, 'object');

  const request = createRequesterV1({
    fetchFn: globalThis.fetch,
    readFileFn: async () => '',
    secrets: new Map(),
    timing: { requestTimeoutMs: 1_000 },
  });
  const node = {
    id: 'redirector',
    baseUrl: `http://127.0.0.1:${redirectorAddress.port}`,
    auth: { kind: 'none' },
  };
  const probes = [
    ['status', () => request.json(node, 'GET', '/api/status')],
    ['reachability', () => request.reachable(node)],
    ['query', () => request.json(node, 'POST', '/api/query', {
      contextGraphId: 'opaque',
      sparql: 'ASK { ?s ?p ?o }',
      view: 'shared-working-memory',
    })],
    ['authorization', () => request.raw(
      node,
      'GET',
      '/api/rfc64/unauthorized-probe',
      undefined,
      'none',
    )],
  ];
  try {
    for (const [redirectKind, location] of [
      ['cross-origin', `http://127.0.0.1:${targetAddress.port}/substitute`],
      ['path-changing', '/substitute'],
    ]) {
      redirectLocation = location;
      for (const [probeKind, probe] of probes) {
        await assert.rejects(
          probe(),
          (error) => error instanceof RemoteCanaryError && error.code === 'node-redirect-rejected',
          `${redirectKind} ${probeKind}`,
        );
      }
    }
    assert.equal(substitutedRequests, 0);
  } finally {
    const closed = Promise.all([once(redirector, 'close'), once(target, 'close')]);
    redirector.close();
    target.close();
    redirector.closeAllConnections?.();
    target.closeAllConnections?.();
    await closed;
  }
});
