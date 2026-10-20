import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DKGAgent } from '../src/dkg-agent.js';
import type { PreparedContentCacheConfig } from '../src/sync/responder/prepared-content-cache.js';
import { registerSyncHandler, type ExperimentalExactBatchResponderResources } from '../src/sync/responder/sync-handler.js';
import { resolveExactBatchStreamEnabled } from '../src/sync/sync-switches.js';
import { exactAssetExportFixture } from './fixtures/exact-asset-export.js';

const directories: string[] = [];
const agents: DKGAgent[] = [];
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop();
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

it.each([
  { nodeRole: 'core' as const, persistent: true, enabled: true },
  { nodeRole: 'edge' as const, persistent: true, enabled: false },
  { nodeRole: 'core' as const, persistent: false, enabled: false },
  { nodeRole: undefined, persistent: true, enabled: false },
  { nodeRole: 'core' as const, persistent: true, enabled: false, override: { enabled: false } },
  { nodeRole: 'edge' as const, persistent: true, enabled: true, override: { enabled: true, maxBytes: 4096 } },
])('normalizes cache defaults at agent creation: %j', async ({ nodeRole, persistent, enabled, override }) => {
  const dataDir = persistent ? await mkdtemp(join(tmpdir(), 'default-core-')) : undefined;
  if (dataDir) directories.push(dataDir);
  const agent = await DKGAgent.create({ name: 'CacheDefaults', nodeRole, dataDir,
    preparedContentCache: override as PreparedContentCacheConfig | undefined });
  agents.push(agent);
  expect(agent.config.preparedContentCache).toMatchObject({ enabled });
  if (enabled) expect(agent.config.preparedContentCache).toMatchObject({
    directory: join(dataDir!, 'prepared-content-v1'), maxBytes: 1024 ** 3, maxEntries: 8192, ttlMs: 21_600_000,
    ...override,
  });
});

it('reuses default core exports after restart and still rejects a changed public policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'core-default-cache-'));
  directories.push(directory);
  const agent = await DKGAgent.create({ name: 'PersistentCoreCache', nodeRole: 'core', dataDir: directory });
  agents.push(agent);
  const f = exactAssetExportFixture(4);
  const start = () => {
    let resources!: ExperimentalExactBatchResponderResources;
    const owner = registerSyncHandler({
      register: () => {}, protocolSync: '/test/default-cache', syncDeniedResponse: 'denied',
      syncPageSize: 8192, sharedMemoryTtlMs: 0, store: f.store, peerId: 'core',
      preparedContentCache: agent.config.preparedContentCache,
      dataDir: directory, parseSyncRequest: bytes => JSON.parse(new TextDecoder().decode(bytes)),
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
