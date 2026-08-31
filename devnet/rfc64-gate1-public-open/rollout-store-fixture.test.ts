import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { renderBlazegraphNamespaceXml } from '@origintrail-official/dkg-storage';

import {
  cleanupRolloutStoreFixture,
  createRolloutStoreFixture,
  type RolloutStoreFixture,
} from './rollout-store-fixture.js';
import {
  createBlazegraphRolloutStoreBinding,
  createOxigraphRolloutStoreBinding,
  rolloutStoreBindingFromEnv,
  rolloutStoreBindingToEnv,
} from './rollout-store-config.js';

const BLAZEGRAPH_URL = 'http://127.0.0.1:9999/bigdata/namespace/kb/sparql';

test('loads the canonical Blazegraph namespace contract from storage', () => {
  const namespaceXml = renderBlazegraphNamespaceXml(
    'rfc64-runtime-contract-probe',
  );
  assert.match(namespaceXml, /rfc64-runtime-contract-probe/u);
});

test('round-trips complete Oxigraph and Blazegraph store bindings through the process environment', () => {
  const oxigraph = createOxigraphRolloutStoreBinding({
    dataDir: '/tmp/round-trip-oxigraph',
    sentinelGraph: 'urn:dkg:rfc64:rollout-store-sentinel:round-trip:oxigraph',
  });
  assert.deepEqual(
    rolloutStoreBindingFromEnv(
      rolloutStoreBindingToEnv(oxigraph),
      '/tmp/round-trip-oxigraph',
    ),
    oxigraph,
  );

  const blazegraph = createBlazegraphRolloutStoreBinding({
    endpoint: 'http://127.0.0.1:9999/bigdata/namespace/round-trip/sparql',
    sentinelGraph: 'urn:dkg:rfc64:rollout-store-sentinel:round-trip:blazegraph',
  });
  assert.deepEqual(
    rolloutStoreBindingFromEnv(
      rolloutStoreBindingToEnv(blazegraph),
      '/tmp/ignored-for-blazegraph',
    ),
    blazegraph,
  );
});

test('bounds a Blazegraph namespace request that never returns', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    createRolloutStoreFixture({
      backendInput: 'blazegraph',
      blazegraphTestUrl: BLAZEGRAPH_URL,
      fetchImpl: hangingFetch,
      requestTimeoutMs: 20,
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some((entry) => entry instanceof Error && entry.name === 'TimeoutError'),
  );
  assert(Date.now() - startedAt < 500, 'namespace setup did not settle within its deadline');
});

test('cleans an attempted namespace when creation commits but its response is lost', async () => {
  const deleted: string[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.method === 'POST') throw new Error('namespace committed but response was lost');
    if (init?.method === 'DELETE') {
      deleted.push(String(input));
      return new Response('', { status: 200 });
    }
    throw new Error(`unexpected fixture request ${String(init?.method)}`);
  }) as typeof fetch;
  await assert.rejects(
    createRolloutStoreFixture({
      backendInput: 'blazegraph',
      blazegraphTestUrl: BLAZEGRAPH_URL,
      fetchImpl,
      requestTimeoutMs: 60,
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.length === 2
      && error.errors.every((entry) => (
        entry instanceof Error && /namespace committed but response was lost/u.test(entry.message)
      )),
  );
  assert.equal(deleted.length, 2, 'every indeterminate creation must receive a reconciliation delete');
  assert.ok(deleted.some((url) => /\/namespace\/rfc64-rollout-.*-author-0$/u.test(url)));
  assert.ok(deleted.some((url) => /\/namespace\/rfc64-rollout-.*-receiver-0$/u.test(url)));
});

test('bounds cleanup when Blazegraph accepts namespaces but never deletes them', async () => {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.method === 'POST') return new Response('', { status: 201 });
    return hangingFetch(input, init);
  }) as typeof fetch;
  const fixture = await createRolloutStoreFixture({
    backendInput: 'blazegraph',
    blazegraphTestUrl: BLAZEGRAPH_URL,
    fetchImpl,
    requestTimeoutMs: 20,
    storeDataDirs: { author: ['/tmp/author'], receiver: ['/tmp/receiver'] },
  });
  const startedAt = Date.now();
  await assert.rejects(
    fixture.dispose(),
    (error: unknown) => error instanceof AggregateError
      && error.message === 'Blazegraph namespace cleanup failed'
      && error.errors.length === 2,
  );
  assert(Date.now() - startedAt < 500, 'namespace cleanup did not settle within its deadline');
});

test('isolates fresh Blazegraph data directories and reuses restart endpoints', async () => {
  const fetchImpl: typeof fetch = async () => new Response('', { status: 201 });
  const fixture = await createRolloutStoreFixture({
    backendInput: 'blazegraph',
    blazegraphTestUrl: BLAZEGRAPH_URL,
    fetchImpl,
    storeDataDirs: {
      author: ['/tmp/author'],
      receiver: ['/tmp/receiver-a', '/tmp/receiver-b'],
    },
  });
  const first = fixture.bindingForRole('receiver', '/tmp/receiver-a');
  const restarted = fixture.bindingForRole('receiver', '/tmp/receiver-a');
  const fresh = fixture.bindingForRole('receiver', '/tmp/receiver-b');
  if (
    first.backend !== 'blazegraph'
    || restarted.backend !== 'blazegraph'
    || fresh.backend !== 'blazegraph'
  ) {
    throw new Error('Blazegraph fixture returned a non-Blazegraph binding');
  }
  assert.equal(
    first.endpoint,
    restarted.endpoint,
  );
  assert.notEqual(
    first.endpoint,
    fresh.endpoint,
  );
  assert.throws(
    () => fixture.bindingForRole('receiver', '/tmp/receiver-c'),
    /no registered receiver store/u,
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
    bindingForRole: () => createBlazegraphRolloutStoreBinding({
      endpoint: BLAZEGRAPH_URL,
      sentinelGraph: 'urn:dkg:rfc64:rollout-store-sentinel:cleanup',
    }),
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
