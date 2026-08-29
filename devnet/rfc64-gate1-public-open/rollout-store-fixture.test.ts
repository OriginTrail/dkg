import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  cleanupRolloutStoreFixture,
  createRolloutStoreFixture,
  type RolloutStoreFixture,
} from './rollout-store-fixture.js';

const BLAZEGRAPH_URL = 'http://127.0.0.1:9999/bigdata/namespace/kb/sparql';

test('bounds a Blazegraph namespace request that never returns', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    createRolloutStoreFixture({
      backendInput: 'blazegraph',
      blazegraphTestUrl: BLAZEGRAPH_URL,
      fetchImpl: hangingFetch,
      requestTimeoutMs: 20,
    }),
    (error: unknown) => error instanceof Error && error.name === 'TimeoutError',
  );
  assert(Date.now() - startedAt < 500, 'namespace setup did not settle within its deadline');
});

test('bounds cleanup when Blazegraph accepts namespaces but never deletes them', async () => {
  let calls = 0;
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls += 1;
    if (calls <= 2) return new Response('', { status: 201 });
    return hangingFetch(input, init);
  }) as typeof fetch;
  const fixture = await createRolloutStoreFixture({
    backendInput: 'blazegraph',
    blazegraphTestUrl: BLAZEGRAPH_URL,
    fetchImpl,
    requestTimeoutMs: 20,
    storesPerRole: { author: 1, receiver: 1 },
  });
  const startedAt = Date.now();
  await assert.rejects(
    fixture.dispose(),
    /could not clean isolated Blazegraph namespaces/u,
  );
  assert(Date.now() - startedAt < 500, 'namespace cleanup did not settle within its deadline');
});

test('isolates fresh Blazegraph data directories and reuses restart endpoints', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 201 });
  const fixture = await createRolloutStoreFixture({
    backendInput: 'blazegraph',
    blazegraphTestUrl: BLAZEGRAPH_URL,
    fetchImpl,
    storesPerRole: { author: 1, receiver: 2 },
  });
  const first = fixture.envForRole('receiver', '/tmp/receiver-a');
  const restarted = fixture.envForRole('receiver', '/tmp/receiver-a');
  const fresh = fixture.envForRole('receiver', '/tmp/receiver-b');
  assert.equal(
    first.DKG_RFC64_GATE1_BLAZEGRAPH_URL,
    restarted.DKG_RFC64_GATE1_BLAZEGRAPH_URL,
  );
  assert.notEqual(
    first.DKG_RFC64_GATE1_BLAZEGRAPH_URL,
    fresh.DKG_RFC64_GATE1_BLAZEGRAPH_URL,
  );
  assert.throws(
    () => fixture.envForRole('receiver', '/tmp/receiver-c'),
    /exhausted its receiver store pool/u,
  );
  await fixture.dispose();
});

test('removes every temporary root when remote fixture cleanup fails', async () => {
  const createdRoots = await Promise.all([
    mkdtemp(join(tmpdir(), 'rfc64-rollout-cleanup-a-')),
    mkdtemp(join(tmpdir(), 'rfc64-rollout-cleanup-b-')),
  ]);
  const roots = [...createdRoots];
  const failingFixture = {
    backend: 'blazegraph',
    envForRole: () => ({}),
    assertGraphExact: async () => undefined,
    dispose: async () => { throw new Error('remote cleanup failed'); },
  } satisfies RolloutStoreFixture;
  await assert.rejects(
    cleanupRolloutStoreFixture(failingFixture, roots),
    /rollout store fixture cleanup failed/u,
  );
  assert.deepEqual(roots, []);
  await Promise.all(createdRoots.map(async (path) => {
    await assert.rejects(access(path), { code: 'ENOENT' });
  }));
});

const hangingFetch = (async (
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal;
  const keepEventLoopAlive = setInterval(() => undefined, 1_000);
  const rejectAborted = () => {
    clearInterval(keepEventLoopAlive);
    reject(signal?.reason);
  };
  if (signal?.aborted) {
    rejectAborted();
    return;
  }
  signal?.addEventListener('abort', rejectAborted, { once: true });
})) as typeof fetch;
