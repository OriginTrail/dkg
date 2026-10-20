import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePreparedContentCacheConfig } from '../src/sync/responder/prepared-content-cache.js';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../src/sync/responder/sync-handler.js';
import { resolveExactBatchStreamEnabled } from '../src/sync/sync-switches.js';
import { exactAssetExportFixture } from './fixtures/exact-asset-export.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('enables the compatible stream by default while preserving both explicit off switches', () => {
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', undefined);
  vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', undefined);
  expect(resolveExactBatchStreamEnabled()).toBe(true);
  vi.stubEnv('DKG_EXPERIMENTAL_EXACT_BATCH_STREAM', '0');
  expect(resolveExactBatchStreamEnabled()).toBe(false);
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
  expect(resolveExactBatchStreamEnabled()).toBe(true);
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '0');
  expect(resolveExactBatchStreamEnabled()).toBe(false);
});

it('enables durable copies only for persistent cores and preserves operator overrides', () => {
  const dataDir = join(tmpdir(), 'default-core');
  expect(resolvePreparedContentCacheConfig(undefined, dataDir, 'core')).toMatchObject({
    directory: join(dataDir, 'prepared-content-v1'), maxBytes: 1024 ** 3, maxEntries: 8192, ttlMs: 21_600_000,
  });
  expect(resolvePreparedContentCacheConfig(undefined, dataDir, 'edge')).toBeUndefined();
  expect(resolvePreparedContentCacheConfig(undefined, undefined, 'core')).toBeUndefined();
  expect(resolvePreparedContentCacheConfig({ enabled: false }, dataDir, 'core')).toBeUndefined();
  expect(resolvePreparedContentCacheConfig({ enabled: true, maxBytes: 4096 }, dataDir, 'core'))
    .toMatchObject({ maxBytes: 4096 });
});

it('reuses default core exports after restart and still rejects a changed public policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'core-default-cache-'));
  directories.push(directory);
  const f = exactAssetExportFixture(4);
  const start = () => {
    let resources!: ExperimentalExactBatchResponderResources;
    const owner = registerSyncHandler({
      register: () => {}, protocolSync: '/test/default-cache', syncDeniedResponse: 'denied',
      syncPageSize: 8192, sharedMemoryTtlMs: 0, store: f.store, peerId: 'core',
      dataDir: directory, nodeRole: 'core', parseSyncRequest: bytes => JSON.parse(new TextDecoder().decode(bytes)),
      authorizeSyncRequest: async () => true, logWarn: () => {}, logDebug: () => {},
      onExperimentalExactBatchResources: value => { resources = value; },
    });
    return { owner, cache: resources.exportCache };
  };
  const first = start();
  const cold = (await first.cache.acquireEncoded(f))!;
  const expected = cold.body.slice();
  try { await cold.assertCurrent(); } finally { cold.release(); }
  await first.owner.closeAndDrain();
  const second = start();
  try {
    const warm = (await second.cache.acquireEncoded(f))!;
    try {
      expect(warm.body).toEqual(expected);
      expect(warm.wholePayloadExports).toBe(0);
      expect(second.cache.stats().preparedCacheHits).toBe(1);
      await warm.assertCurrent();
    } finally { warm.release(); }
    f.meta.find(row => row.predicate === 'http://dkg.io/ontology/accessPolicy')!.object = '"private"';
    expect(await second.cache.acquireEncoded(f)).toBeNull();
  } finally { await second.owner.closeAndDrain(); }
});
