// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_COMMAND_OUTPUT_BYTES, RemoteCanaryError } from './common.mjs';
import { createRequesterV1, runBoundedCommandV1 } from './transport.mjs';

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
