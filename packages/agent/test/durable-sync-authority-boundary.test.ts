vi.mock('@origintrail-official/dkg-core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@origintrail-official/dkg-core')>(),
  exchangeExperimentalExactBatch: vi.fn(),
}));
import { afterEach, expect, it, vi } from 'vitest';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';
import { CG, ctx, createExactBatchHostFixture, storedRows } from './_helpers/exact-batch-host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

it.each(['graph', 'durable', 'exact'] as const)('ignores forged runtime authority at the public %s boundary', async entry => {
  vi.stubEnv('DKG_EXACT_BATCH_STREAM_ENABLED', '1');
  const f = createExactBatchHostFixture(cleanup), agent = f.host;
  agent.runLegacyDurableSyncDetailed = LifecycleSyncMethods.prototype.runLegacyDurableSyncDetailed;
  agent.runContextGraphSyncWithBackpressure = LifecycleSyncMethods.prototype.runContextGraphSyncWithBackpressure;
  // The provider's root disagrees with the received asset. An injected callback
  // would bypass that chain check and falsely accept it.
  agent.chain.getLatestMerkleRoot.mockResolvedValue(new Uint8Array(32).fill(99));
  const authority = { coalescing: 'owner-only', admitVerifiedPage: vi.fn(),
    isRegisteredPublic: vi.fn(() => true), authenticate: vi.fn(async (asset: unknown) => ({ asset })) };
  const options = { recoveryAuthority: authority, exactAssetSelection: f.selection,
    exactRecoveryTransportMode: 'stream-preferred' as const, totalTimeoutMs: 120000,
    fetchTimeoutMs: 120000, authenticationTimeoutMs: 30000 };
  const result = entry === 'graph'
    ? await LifecycleSyncMethods.prototype.runLegacyDurableSyncForContextGraphDetailed.call(agent, ctx, 'fixture-source', CG, 1, options)
    : entry === 'durable'
      ? await agent.runLegacyDurableSyncDetailed(ctx, 'fixture-source', [CG], undefined, undefined, undefined, options)
      : await LifecycleSyncMethods.prototype.syncExactKnowledgeAssetsFromPeerDetailed.call(agent, 'fixture-source', CG, f.selection, options);
  expect(result.committedExactAssetUals ?? []).toEqual([]);
  expect(agent.chain.getLatestMerkleRoot).toHaveBeenCalled();
  expect(authority.authenticate).not.toHaveBeenCalled();
  expect(authority.admitVerifiedPage).not.toHaveBeenCalled();
  expect(authority.isRegisteredPublic).not.toHaveBeenCalled();
  for (const item of f.items) expect(await storedRows(f.store, item.graph)).toBe(0);
});
