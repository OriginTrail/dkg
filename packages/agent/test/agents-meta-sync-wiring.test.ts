import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wiring guard for the sync-storm mitigation (Chunk 1). The pure resolver is
// unit-tested in `agents-meta-policy.test.ts`, but that alone would stay
// green if someone reverted the production call site back to
// `nodeRole==='core' ? true`. This test exercises the REAL call site with a
// stubbed `runDurableSync` and asserts the `syncAgentsMeta` value it actually
// passes through, so such a regression fails here.
//
// OT-RFC-59: `syncFromPeerDetailed` now delegates the legacy lane to
// `runLegacyDurableSync` (which owns the syncAgentsMeta resolution + the
// runDurableSync call), so the fake `this` must carry that method too. The
// changelog branch is skipped because `this.store` is absent (asChangelogReader
// returns null).

// Replace `runDurableSync` so `syncFromPeerDetailed` never touches the store /
// network — we only capture the options object it forwards. `importOriginal`
// preserves any co-exports (types are erased; `runDurableSync` is the only
// runtime export today) so the module graph stays intact.
vi.mock('../src/sync/requester/durable-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sync/requester/durable-sync.js')>();
  return { ...actual, runDurableSync: vi.fn(async () => ({})) };
});

import { runDurableSync } from '../src/sync/requester/durable-sync.js';
import { LifecycleSyncMethods } from '../src/dkg-agent-lifecycle.js';

const mockedRunDurableSync = vi.mocked(runDurableSync);

/**
 * Minimal `this` for `syncFromPeerDetailed`. Only `config` and the three
 * `.bind(this)` methods are touched while it builds the options object; every
 * other dependency lives in a closure that `runDurableSync` (stubbed) never
 * invokes, so they can be omitted / left as no-ops.
 */
// Loosely typed on purpose: only the fields `syncFromPeerDetailed` reads while
// building its options object are provided (see comment above). Matches the
// established fake-`this` pattern in imported-artifact.test.ts.
function fakeAgent(config: { nodeRole?: 'core' | 'edge'; syncAgentsMeta?: boolean }): any {
  return {
    config,
    store: undefined, // no ChangelogStore ⇒ asChangelogReader null ⇒ legacy lane runs
    // The legacy lane the changelog dispatch delegates to; it owns the
    // syncAgentsMeta resolution + the (stubbed) runDurableSync call.
    runLegacyDurableSync: LifecycleSyncMethods.prototype.runLegacyDurableSync,
    createContextGraphSyncDeadline: () => Date.now() + 60_000,
    fetchSyncPages: async () => ({}),
    processDurableBatchInWorker: async () => ({}),
    insertSyncedQuadsAndInvalidateListCache: async () => {},
    syncCheckpoints: new Map<string, number>(),
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  };
}

async function passedSyncAgentsMeta(
  config: { nodeRole?: 'core' | 'edge'; syncAgentsMeta?: boolean },
): Promise<boolean> {
  await LifecycleSyncMethods.prototype.syncFromPeerDetailed.call(
    fakeAgent(config),
    'peer-remote',
    ['did:dkg:context-graph:agents'],
  );
  expect(mockedRunDurableSync).toHaveBeenCalledTimes(1);
  return mockedRunDurableSync.mock.calls[0][0].syncAgentsMeta as boolean;
}

describe('syncFromPeerDetailed wires the resolved syncAgentsMeta into durable sync', () => {
  const originalEnv = process.env.DKG_SYNC_AGENTS_META;

  beforeEach(() => {
    mockedRunDurableSync.mockClear();
    delete process.env.DKG_SYNC_AGENTS_META;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DKG_SYNC_AGENTS_META;
    else process.env.DKG_SYNC_AGENTS_META = originalEnv;
  });

  it('passes syncAgentsMeta=false for a default core config (so the requester skip fires)', async () => {
    // Regression trap: a revert to `nodeRole==='core' ? true` would make this true.
    expect(await passedSyncAgentsMeta({ nodeRole: 'core' })).toBe(false);
  });

  it('passes syncAgentsMeta=true when DKG_SYNC_AGENTS_META=1 opts a core in', async () => {
    process.env.DKG_SYNC_AGENTS_META = '1';
    expect(await passedSyncAgentsMeta({ nodeRole: 'core' })).toBe(true);
  });

  it('passes syncAgentsMeta=true when config explicitly opts in, over env', async () => {
    process.env.DKG_SYNC_AGENTS_META = '0';
    expect(await passedSyncAgentsMeta({ nodeRole: 'core', syncAgentsMeta: true })).toBe(true);
  });

  it('always passes a strict boolean (never undefined) so `=== false` can match', async () => {
    const value = await passedSyncAgentsMeta({ nodeRole: 'edge' });
    expect(typeof value).toBe('boolean');
  });
});
