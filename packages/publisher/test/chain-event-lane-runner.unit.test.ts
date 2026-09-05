import { describe, expect, it } from 'vitest';
import { createOperationContext } from '@origintrail-official/dkg-core';
import { createLaneFixture, lane, laneCursor, legacyCursor } from './_helpers/chain-event-lane-fixture.js';

describe('ChainEventLaneRunner scheduling and cursor ownership', () => {
  it('cold-starts full-history recovery and dispatches an old event without live-tail seeding', async () => {
    const f = createLaneFixture(10_000);
    const publish = lane('publish', ['KCCreated'], { kind: 'legacy-full-history' });
    const event = { type: 'KCCreated', blockNumber: 1, data: { marker: 'restored' } };
    f.state.events = [event];
    await f.runner([publish.spec]).poll();
    expect(f.state.filters).toEqual([{ eventTypes: ['KCCreated'], fromBlock: 1, toBlock: 9000 }]);
    expect(publish.state.events).toEqual([event]);
  });

  it('cold-starts live discovery near head and dispatches only selected events', async () => {
    const f = createLaneFixture(10_000);
    const discovery = lane('contextGraphDiscovery', ['NameClaimed', 'ContextGraphCreated']);
    const event = { type: 'ContextGraphCreated', blockNumber: 9990, data: { contextGraphId: 'new' } };
    f.state.events = [event, { ...event, type: 'ProfileCreated' }, { ...event, blockNumber: 1 }];
    await f.runner([discovery.spec]).poll();
    expect(f.state.filters).toEqual([{ eventTypes: ['NameClaimed', 'ContextGraphCreated'], fromBlock: 9501, toBlock: 10_000 }]);
    expect(discovery.state.events).toEqual([event]);
  });

  it('saves and restores the aggregate cursor when every active lane is eligible', async () => {
    const f = createLaneFixture();
    const a = lane('contextGraphDiscovery', ['ContextGraphCreated']);
    const b = lane('profileEvents', ['ProfileCreated']);
    const c = legacyCursor(50);
    await f.runner([a.spec, b.spec], c.cursor).poll();
    expect(f.state.filters.map((filter) => filter.fromBlock)).toEqual([51, 51]);
    expect(c.state.saves).toEqual([1000]);
    f.state.head = 1100;
    f.state.filters = [];
    await f.runner([a.spec, b.spec], c.cursor).poll();
    expect(f.state.filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[1001, 1100], [1001, 1100]]);
    expect(c.state.saves).toEqual([1000, 1100]);
  });

  it('does not advance an aggregate cursor beyond a failed lane, then retries its exact range', async () => {
    const f = createLaneFixture();
    const a = lane('contextGraphDiscovery', ['ContextGraphCreated']);
    const b = lane('profileEvents', ['ProfileCreated']);
    const c = legacyCursor(50);
    let fail = true;
    f.state.beforeScan = async (filter) => { if (fail && filter.eventTypes.includes('ProfileCreated')) throw new Error('RPC down'); };
    const runner = f.runner([a.spec, b.spec], c.cursor);
    await runner.poll();
    expect(c.state.saves).toEqual([50]); // successful sibling cannot skip the failed lane
    fail = false;
    f.state.now = 60_000;
    await runner.poll();
    expect(f.state.filters.at(-1)).toEqual({ eventTypes: ['ProfileCreated'], fromBlock: 51, toBlock: 1000 });
    expect(c.state.saves.at(-1)).toBe(1000);
  });

  it('does not use a context-only aggregate cursor for a later allocator backfill', async () => {
    const f = createLaneFixture();
    const discovery = lane('contextGraphDiscovery', ['ContextGraphCreated']);
    const allocator = lane('allocatorReconcile', ['KCCreated'], { kind: 'full-history' });
    allocator.state.enabled = false;
    const c = legacyCursor(900);
    const runner = f.runner([discovery.spec, allocator.spec], c.cursor);
    await runner.poll();
    expect(c.state.saves).toEqual([1000]);
    allocator.state.enabled = true;
    f.state.head = 1200;
    f.state.now = 20;
    await runner.poll();
    expect(f.state.filters.at(-1)).toEqual({ eventTypes: ['KCCreated'], fromBlock: 1, toBlock: 1200 });
    expect(c.state.loads).toBe(1);
    expect(c.state.saves).toEqual([1000]);
  });

  it('restores a legacy publish cursor without applying it to allocator history', async () => {
    const f = createLaneFixture(10_000);
    const publish = lane('publish', ['KCCreated'], { kind: 'legacy-full-history' });
    const allocator = lane('allocatorReconcile', ['KCCreated'], { kind: 'full-history' });
    const c = legacyCursor(9500);
    await f.runner([publish.spec, allocator.spec], c.cursor).poll();
    expect(f.state.filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[9501, 10_000], [1, 9000]]);
    expect(c.state.loads).toBe(1);
    expect(c.state.saves).toEqual([]);
  });

  it('does not use a saved per-lane publish cursor to skip allocator history', async () => {
    const f = createLaneFixture(10_000);
    const publish = lane('publish', ['KCCreated'], { kind: 'legacy-full-history' });
    const allocator = lane('allocatorReconcile', ['KCCreated'], { kind: 'full-history' });
    const c = laneCursor([['publish', 9500]]);
    await f.runner([publish.spec, allocator.spec], c.cursor).poll();
    expect(f.state.filters.map((filter) => filter.fromBlock)).toEqual([9501, 1]);
    expect(c.saves).toEqual([['publish', 10_000], ['allocatorReconcile', 9000]]);
  });

  it('restores and saves independent lane cursors across restart', async () => {
    const f = createLaneFixture();
    const a = lane('allowListUpdates', ['AllowListUpdated']);
    const b = lane('profileEvents', ['ProfileCreated']);
    const c = laneCursor([['allowListUpdates', 50], ['profileEvents', 800]]);
    await f.runner([a.spec, b.spec], c.cursor).poll();
    expect(f.state.filters.map((filter) => filter.fromBlock)).toEqual([51, 801]);
    expect(c.saves).toEqual([['allowListUpdates', 1000], ['profileEvents', 1000]]);
    f.state.head = 1100;
    await f.runner([a.spec, b.spec], c.cursor).poll();
    expect(f.state.filters.slice(-2).map((filter) => filter.fromBlock)).toEqual([1001, 1001]);
  });

  it('restores a newly enabled lane once and ignores inactive lanes', async () => {
    const f = createLaneFixture();
    const a = lane('profileEvents', ['ProfileCreated']);
    a.state.enabled = false;
    const c = laneCursor([['profileEvents', 900]]);
    const runner = f.runner([a.spec], c.cursor);
    await runner.restoreCurrentlyActive(createOperationContext('system'));
    await runner.poll();
    expect(c.loads).toEqual([]);
    expect(f.state.headReads).toBe(0);
    a.state.enabled = true;
    await runner.poll();
    f.state.now = 20;
    f.state.head = 1100;
    await runner.poll();
    expect(c.loads).toEqual(['profileEvents']);
    expect(f.state.filters.map((filter) => filter.fromBlock)).toEqual([901, 1001]);
  });

  it('continues safely when loading a persisted cursor fails', async () => {
    const f = createLaneFixture(10_000);
    const a = lane('allocatorReconcile', ['KCCreated'], { kind: 'full-history' });
    let loads = 0;
    const runner = f.runner([a.spec], { async loadLane() { loads++; throw new Error('disk read failed'); }, async saveLane() {} });
    await runner.poll();
    await runner.poll();
    expect(loads).toBe(1);
    expect(f.state.filters[0].fromBlock).toBe(1);
  });

  it('seeds a newly activated live publish after idle with a complete recent page', async () => {
    const f = createLaneFixture(20_000_000);
    const a = lane('publish', ['KCCreated'], { kind: 'isolated-live-tail', lookbackBlocks: 9000 });
    a.state.enabled = false;
    const runner = f.runner([a.spec]);
    await runner.poll();
    expect(f.state.filters).toEqual([]);
    f.state.head = 20_000_050;
    a.state.enabled = true;
    const event = { type: 'KCCreated', blockNumber: 19_995_000, data: {} };
    f.state.events = [event];
    await runner.poll();
    expect(f.state.filters).toEqual([{ eventTypes: ['KCCreated'], fromBlock: 19_991_051, toBlock: 20_000_050 }]);
    expect(a.state.events).toEqual([event]);
  });

  it('re-seeds near head after restored recovery clears, without replaying the entire gap', async () => {
    const f = createLaneFixture(2_000_000);
    const a = lane('publish', ['KCCreated'], { kind: 'legacy-full-history' });
    f.state.events = [
      { type: 'KCCreated', blockNumber: 1, data: { restored: true } },
      { type: 'KCCreated', blockNumber: 1_999_950, data: { restored: false } },
    ];
    a.state.dispatch = async () => { a.state.strategy = { kind: 'isolated-live-tail', lookbackBlocks: 9000 }; };
    const runner = f.runner([a.spec]);
    await runner.poll();
    await runner.poll();
    expect(f.state.filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[1, 9000], [1_991_001, 2_000_000]]);
    expect(a.state.events).toEqual(f.state.events);
  });

  it('does not rewind a recovered cursor already ahead of the live-tail seed', async () => {
    const f = createLaneFixture();
    const a = lane('publish', ['KCCreated'], { kind: 'legacy-full-history' });
    const runner = f.runner([a.spec], laneCursor([['publish', 900]]).cursor);
    await runner.poll();
    a.state.strategy = { kind: 'isolated-live-tail' };
    f.state.head = 1100;
    f.state.now = 20;
    await runner.poll();
    expect(f.state.filters.map((filter) => filter.fromBlock)).toEqual([901, 1001]);
  });

  it('tails active discovery and VM lanes on their cadence without duplicate head reads', async () => {
    const f = createLaneFixture();
    const a = lane('contextGraphDiscovery', ['ContextGraphCreated']);
    const b = lane('vmReconcile', ['KnowledgeAssetRegisteredToContextGraph']);
    const runner = f.runner([a.spec, b.spec]);
    await runner.poll();
    f.state.head = 1100;
    f.state.now = 19;
    await runner.poll();
    expect(f.state.filters).toHaveLength(2);
    f.state.now = 20;
    await runner.poll();
    expect(f.state.headReads).toBe(2);
    expect(f.state.filters.slice(-2).map((filter) => filter.fromBlock)).toEqual([1001, 1001]);
  });

  it('retries a callback failure from the same cursor after backoff', async () => {
    const f = createLaneFixture(100);
    const a = lane('profileEvents', ['ProfileCreated']);
    f.state.events = [{ type: 'ProfileCreated', blockNumber: 80, data: {} }];
    let failed = false;
    a.state.dispatch = async () => { if (!failed) { failed = true; throw new Error('apply failed'); } };
    const c = laneCursor();
    const runner = f.runner([a.spec], c.cursor);
    await runner.poll();
    expect(c.saves).toEqual([]);
    f.state.now = 59_999;
    await runner.poll();
    expect(f.state.filters).toHaveLength(1);
    f.state.now = 60_000;
    await runner.poll();
    expect(f.state.filters.map((filter) => filter.fromBlock)).toEqual([1, 1]);
    expect(c.saves).toEqual([['profileEvents', 100]]);
  });

  it('exponentially backs off repeated RPC failures and resets after success', async () => {
    const f = createLaneFixture(100);
    const a = lane('contextGraphDiscovery', ['ContextGraphCreated']);
    const c = laneCursor();
    let calls = 0;
    f.state.beforeScan = async () => { if ([1, 2, 4].includes(++calls)) throw new Error('RPC down'); };
    const runner = f.runner([a.spec], c.cursor);
    for (const now of [0, 60_000, 120_000, 180_000]) { f.state.now = now; await runner.poll(); }
    expect(f.state.filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[1, 100], [1, 100], [1, 100]]);
    expect(c.saves).toEqual([['contextGraphDiscovery', 100]]);
    f.state.head = 200;
    for (const now of [180_020, 240_019, 240_020]) { f.state.now = now; await runner.poll(); }
    expect(f.state.filters.slice(-2).map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[101, 200], [101, 200]]);
    expect(c.saves.at(-1)).toEqual(['contextGraphDiscovery', 200]);
  });

  it('caps repeated failure backoff at five minutes', async () => {
    const f = createLaneFixture(100);
    const a = lane('contextGraphDiscovery', ['ContextGraphCreated']);
    f.state.beforeScan = async () => { throw new Error('RPC down'); };
    const runner = f.runner([a.spec]);
    for (const now of [0, 60_000, 180_000, 420_000, 720_000, 1_020_000]) {
      f.state.now = now;
      await runner.poll();
      const attempts = f.state.filters.length;
      f.state.now = now + 1;
      await runner.poll();
      expect(f.state.filters).toHaveLength(attempts);
    }
    expect(f.state.filters).toHaveLength(6);
  });

  it('keeps headless scans due until a known head proves the lane is caught up', async () => {
    const f = createLaneFixture();
    f.state.head = undefined;
    const a = lane('vmReconcile', ['KnowledgeAssetRegisteredToContextGraph']);
    const runner = f.runner([a.spec], undefined, 1000);
    await runner.poll();
    await runner.poll();
    expect(f.state.filters.map((filter) => [filter.fromBlock, filter.toBlock])).toEqual([[1, 1000], [1001, 2000]]);
    f.state.head = 2000;
    await runner.poll();
    f.state.head = 2100;
    f.state.now = 19;
    await runner.poll();
    expect(f.state.filters).toHaveLength(2);
    f.state.now = 20;
    await runner.poll();
    expect(f.state.filters.at(-1)?.fromBlock).toBe(2001);
  });
});
