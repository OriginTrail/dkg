import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { MockChainAdapter, type ContextGraphStorageRange } from '@origintrail-official/dkg-chain';

import {
  CONTEXT_GRAPH_STORAGE_DISCOVERY_PAGE_SIZE,
  ContextGraphStorageDiscovery,
  createInMemoryContextGraphStorageDiscoveryStore,
  mergeOnChainContextGraphFacts,
  onChainContextGraphIdentityDiffers,
  sameOnChainContextGraphFacts,
  toContextGraphListOnChainFacts,
  type ContextGraphStorageDiscoveryRecord,
  type ContextGraphStorageDiscoveryStore,
  type OnChainContextGraphFacts,
} from '../src/context-graph-storage-discovery.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

async function chainWith(count: number): Promise<MockChainAdapter> {
  const chain = new MockChainAdapter();
  for (let i = 1; i <= count; i++) {
    await chain.createOnChainContextGraph({
      accessPolicy: i % 3 === 0 ? 1 : 0,
      publishPolicy: i % 2 === 0 ? 0 : 1,
      nameHash: ethers.keccak256(ethers.toUtf8Bytes(`cg-${i}`)),
    });
  }
  return chain;
}

class RecordingStore implements ContextGraphStorageDiscoveryStore {
  value: unknown;
  saves = 0;
  failSaveAt: number | undefined;

  async load(): Promise<unknown> {
    return this.value === undefined ? undefined : structuredClone(this.value);
  }

  async save(checkpoint: unknown): Promise<void> {
    this.saves += 1;
    if (this.failSaveAt === this.saves) throw new Error('disk full');
    this.value = structuredClone(checkpoint);
  }
}

function harness(
  chain: MockChainAdapter,
  store: ContextGraphStorageDiscoveryStore,
  options: { now?: () => number; apply?: (record: ContextGraphStorageDiscoveryRecord) => void } = {},
) {
  const reads: Array<[bigint, number]> = [];
  const applied: string[] = [];
  const known = new Set<string>();
  const logs: string[] = [];
  let readRange = (fromId: bigint, maxIds: number, signal?: AbortSignal) =>
    chain.readContextGraphStorageRange({ fromId, maxIds, ...(signal ? { signal } : {}) });
  const discovery = new ContextGraphStorageDiscovery({
    store,
    readRange: (fromId, maxIds, signal) => {
      reads.push([fromId, maxIds]);
      return readRange(fromId, maxIds, signal);
    },
    apply: (record) => {
      options.apply?.(record);
      applied.push(record.contextGraphId);
      const isNew = !known.has(record.contextGraphId);
      known.add(record.contextGraphId);
      return { isNew, changed: isNew };
    },
    log: (message) => logs.push(message),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    discovery,
    reads,
    applied,
    logs,
    overrideReadRange(next: typeof readRange) {
      readRange = next;
    },
  };
}

describe('ContextGraphStorageDiscovery', () => {
  it('enumerates every id in durable pages on a fresh pass', async () => {
    const chain = await chainWith(40);
    const store = new RecordingStore();
    const { discovery, reads } = harness(chain, store);

    const result = await discovery.discover();

    expect(result).toMatchObject({ discovered: 40, read: 40, complete: true, nextId: 41n, latestId: 40n });
    expect(reads).toEqual([
      [1n, CONTEXT_GRAPH_STORAGE_DISCOVERY_PAGE_SIZE],
      [17n, CONTEXT_GRAPH_STORAGE_DISCOVERY_PAGE_SIZE],
      [33n, CONTEXT_GRAPH_STORAGE_DISCOVERY_PAGE_SIZE],
    ]);
    expect(store.saves).toBe(3);
    const saved = store.value as { nextId: string; entries: Array<{ contextGraphId: string }> };
    expect(saved.nextId).toBe('41');
    expect(saved.entries.map((entry) => entry.contextGraphId)).toEqual(
      Array.from({ length: 40 }, (_, i) => String(i + 1)),
    );
  });

  it('bounds a pass by its id budget and resumes at the durable cursor after a restart', async () => {
    const chain = await chainWith(40);
    const store = new RecordingStore();
    const first = harness(chain, store);

    const partial = await first.discovery.discover({ idBudget: 20 });
    expect(partial).toMatchObject({ discovered: 20, read: 20, complete: false, nextId: 21n });
    expect(first.reads).toEqual([[1n, 16], [17n, 4]]);

    const restarted = harness(chain, store);
    const hydrated = await restarted.discovery.loadRecords();
    expect(hydrated.map((record) => record.contextGraphId)).toEqual(
      Array.from({ length: 20 }, (_, i) => String(i + 1)),
    );
    expect(restarted.reads).toEqual([]);
    await expect(restarted.discovery.cursor()).resolves.toBe(21n);

    const rest = await restarted.discovery.discover();
    expect(restarted.reads[0]).toEqual([21n, 16]);
    expect(rest).toMatchObject({ discovered: 20, read: 20, complete: true, nextId: 41n });
    expect(restarted.applied).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 21)));
  });

  it('spends two view calls on a quiet pass and saves nothing', async () => {
    const chain = await chainWith(3);
    const store = new RecordingStore();
    const { discovery, reads } = harness(chain, store);
    await discovery.discover();
    const saves = store.saves;

    const quiet = await discovery.discover();

    expect(quiet).toMatchObject({ discovered: 0, read: 0, complete: true, nextId: 4n });
    expect(reads.at(-1)).toEqual([4n, 16]);
    expect(store.saves).toBe(saves);

    await chain.createOnChainContextGraph({ accessPolicy: 0, publishPolicy: 1 });
    await expect(discovery.discover()).resolves.toMatchObject({ discovered: 1, nextId: 5n });
  });

  it('replays a page whose checkpoint save failed instead of skipping it', async () => {
    const chain = await chainWith(20);
    const store = new RecordingStore();
    store.failSaveAt = 2;
    const { discovery, applied } = harness(chain, store);

    await expect(discovery.discover()).rejects.toThrow('disk full');
    await expect(discovery.cursor()).resolves.toBe(17n);

    await discovery.discover();
    // Ids 17..20 were applied once before the failed save and again on replay.
    expect(applied.filter((id) => id === '17')).toHaveLength(2);
    await expect(discovery.cursor()).resolves.toBe(21n);
  });

  it('leaves an applied page unsaved when cancelled after local work', async () => {
    const chain = await chainWith(3);
    const store = new RecordingStore();
    const controller = new AbortController();
    const { discovery } = harness(chain, store, {
      apply: (record) => {
        if (record.contextGraphId === '3') controller.abort(new Error('shutting down'));
      },
    });

    await expect(discovery.discover({ signal: controller.signal })).rejects.toThrow('shutting down');
    expect(store.saves).toBe(0);
    await expect(discovery.cursor()).resolves.toBe(1n);
  });

  it('stops at an id that is not readable yet and reports it', async () => {
    const chain = await chainWith(3);
    (chain as any).contextGraphs.delete(2n);
    const store = new RecordingStore();
    const { discovery, logs } = harness(chain, store);

    const result = await discovery.discover();

    expect(result).toMatchObject({ discovered: 1, complete: false, nextId: 2n });
    expect(logs.join('\n')).toMatch(/id 2 is not readable yet/);
  });

  it('restarts from id 1 when the ContextGraphStorage address moves under the same scope', async () => {
    const chain = await chainWith(2);
    const store = new RecordingStore();
    const { discovery, reads, logs, overrideReadRange } = harness(chain, store);
    await discovery.discover();

    overrideReadRange(async (fromId, maxIds) => {
      const range = await chain.readContextGraphStorageRange({ fromId, maxIds });
      return { ...range, storageAddress: '0x' + 'dd'.repeat(20) } satisfies ContextGraphStorageRange;
    });
    const result = await discovery.discover();

    expect(logs.join('\n')).toMatch(/moved from 0x(c6){20} to 0x(dd){20}/);
    expect(reads.slice(-2)).toEqual([[3n, 16], [1n, 16]]);
    expect(result).toMatchObject({ nextId: 3n, complete: true });
    expect((store.value as { storageAddress: string }).storageAddress).toBe('0x' + 'dd'.repeat(20));
  });

  it('ignores an unreadable checkpoint visibly and enumerates afresh', async () => {
    const chain = await chainWith(2);
    const store = new RecordingStore();
    store.value = { version: 1, nextId: 'not-a-number', entries: [] };
    const { discovery, logs, reads } = harness(chain, store);

    await discovery.discover();

    expect(logs.join('\n')).toMatch(/ignoring an unreadable checkpoint/);
    expect(reads[0]).toEqual([1n, 16]);
  });

  it('rejects malformed checkpoint fields and drops facts beyond the cursor', async () => {
    const chain = await chainWith(1);
    const valid = await (async () => {
      const store = new RecordingStore();
      await harness(chain, store).discovery.discover();
      return store.value as Record<string, any>;
    })();
    const variants: Array<[string, (value: Record<string, any>) => unknown]> = [
      ['not an object', () => 'garbage'],
      ['array', () => []],
      ['version', (value) => ({ ...value, version: 2 })],
      ['storage address', (value) => ({ ...value, storageAddress: 'nope' })],
      ['refresh cursor', (value) => ({ ...value, refreshNextId: 7 })],
      ['refresh time', (value) => ({ ...value, lastRefreshAt: -1 })],
      ['entries', (value) => ({ ...value, entries: {} })],
      ['entry shape', (value) => ({ ...value, entries: [null] })],
      ['entry id', (value) => ({ ...value, entries: [{ ...value.entries[0], contextGraphId: '0' }] })],
      ['entry owner', (value) => ({ ...value, entries: [{ ...value.entries[0], owner: 'x' }] })],
      ['entry active', (value) => ({ ...value, entries: [{ ...value.entries[0], active: 1 }] })],
      ['entry time', (value) => ({ ...value, entries: [{ ...value.entries[0], createdAt: 1.5 }] })],
      ['entry policy', (value) => ({ ...value, entries: [{ ...value.entries[0], accessPolicy: 256 }] })],
      ['entry authority', (value) => ({ ...value, entries: [{ ...value.entries[0], publishAuthority: 5 }] })],
      ['entry hash', (value) => ({ ...value, entries: [{ ...value.entries[0], nameHash: '0x12' }] })],
      ['entry block', (value) => ({ ...value, entries: [{ ...value.entries[0], observedAtBlock: -2 }] })],
    ];
    for (const [label, mutate] of variants) {
      const store = new RecordingStore();
      store.value = mutate(structuredClone(valid));
      const { discovery, logs } = harness(chain, store);
      await expect(discovery.cursor(), label).resolves.toBe(1n);
      expect(logs, label).toHaveLength(1);
    }

    const beyond = new RecordingStore();
    beyond.value = {
      ...structuredClone(valid),
      refreshNextId: '1',
      entries: [valid.entries[0], { ...valid.entries[0], contextGraphId: '9' }],
    };
    const loaded = await harness(chain, beyond).discovery.loadRecords();
    expect(loaded.map((record) => record.contextGraphId)).toEqual(['1']);
  });

  it('refreshes mutable facts at most once per interval and resumes an unfinished generation', async () => {
    const chain = await chainWith(40);
    const store = new RecordingStore();
    let now = 1_000_000;
    const { discovery, reads, applied } = harness(chain, store, { now: () => now });
    await discovery.discover();
    const readsAfterDiscovery = reads.length;

    await expect(discovery.refresh()).resolves.toMatchObject({ due: false, read: 0 });
    expect(reads.length).toBe(readsAfterDiscovery);

    now += DAY_MS;
    chain.getContextGraph(5n)!.active = false;
    const partial = await discovery.refresh({ idBudget: 24 });
    expect(partial).toMatchObject({ due: true, read: 24, complete: false });
    expect(reads.slice(readsAfterDiscovery)).toEqual([[1n, 16], [17n, 8]]);

    const rest = await discovery.refresh({ idBudget: 24 });
    expect(rest).toMatchObject({ due: true, read: 16, complete: true });
    expect(reads.slice(-1)).toEqual([[25n, 16]]);
    const saved = store.value as { refreshNextId: string | null; lastRefreshAt: number; entries: any[] };
    expect(saved.refreshNextId).toBeNull();
    expect(saved.lastRefreshAt).toBe(now);
    expect(saved.entries.find((entry) => entry.contextGraphId === '5').active).toBe(false);
    expect(applied.filter((id) => id === '5')).toHaveLength(2);

    await expect(discovery.refresh()).resolves.toMatchObject({ due: false });
  });

  it('has nothing to refresh before the first enumeration', async () => {
    const chain = await chainWith(0);
    const { discovery } = harness(chain, new RecordingStore());
    await expect(discovery.refresh()).resolves.toMatchObject({ due: false, read: 0, nextId: 1n });
  });

  it('abandons a refresh generation when the storage address moves', async () => {
    const chain = await chainWith(2);
    const store = new RecordingStore();
    let now = 0;
    const { discovery, overrideReadRange } = harness(chain, store, { now: () => now });
    await discovery.discover();
    now += DAY_MS;
    overrideReadRange(async (fromId, maxIds) => ({
      ...(await chain.readContextGraphStorageRange({ fromId, maxIds })),
      storageAddress: '0x' + 'ee'.repeat(20),
    }));

    await expect(discovery.refresh()).resolves.toMatchObject({ complete: false });
    await expect(discovery.cursor()).resolves.toBe(1n);
  });

  it('stops a refresh at an unreadable id and keeps its frontier', async () => {
    const chain = await chainWith(3);
    const store = new RecordingStore();
    let now = 0;
    const { discovery } = harness(chain, store, { now: () => now });
    await discovery.discover();
    now += DAY_MS;
    (chain as any).contextGraphs.delete(2n);

    await expect(discovery.refresh()).resolves.toMatchObject({ read: 1, complete: false });
    expect((store.value as { refreshNextId: string }).refreshNextId).toBe('2');
  });

  it('validates its configuration', () => {
    const store = createInMemoryContextGraphStorageDiscoveryStore();
    const base = { store, readRange: async () => { throw new Error('unused'); }, apply: () => ({ isNew: false, changed: false }) };
    expect(() => new ContextGraphStorageDiscovery({ ...base, pageSize: 0 })).toThrow(RangeError);
    const discovery = new ContextGraphStorageDiscovery(base);
    return expect(discovery.discover({ idBudget: 0 })).rejects.toThrow(RangeError);
  });

  it('keeps the in-memory store isolated from caller mutation', async () => {
    const store = createInMemoryContextGraphStorageDiscoveryStore();
    await expect(store.load()).resolves.toBeUndefined();
    const value = { nested: { n: 1 } };
    await store.save(value);
    value.nested.n = 2;
    await expect(store.load()).resolves.toEqual({ nested: { n: 1 } });
  });
});

describe('on-chain Context Graph facts', () => {
  const base: OnChainContextGraphFacts = {
    onChainId: '32',
    nameHash: '0x' + '11'.repeat(32),
    owner: '0x' + '22'.repeat(20),
    accessPolicy: 0,
    publishPolicy: 1,
    publishAuthority: null,
    createdAt: null,
    active: null,
    observedAtBlock: 100,
  };

  it('lets the newer observation win while keeping fields it does not carry', () => {
    const storage: OnChainContextGraphFacts = {
      ...base,
      publishPolicy: 0,
      publishAuthority: '0x' + '33'.repeat(20),
      createdAt: 1_790_000_000,
      active: false,
      observedAtBlock: 200,
    };
    expect(mergeOnChainContextGraphFacts(base, storage)).toEqual(storage);
    // An older event arriving late cannot erase what the newer read saw.
    expect(mergeOnChainContextGraphFacts(storage, base)).toEqual(storage);
    const event: OnChainContextGraphFacts = { ...base, owner: null, publishPolicy: null, observedAtBlock: 300 };
    expect(mergeOnChainContextGraphFacts(storage, event)).toEqual({ ...storage, observedAtBlock: 300 });
    expect(mergeOnChainContextGraphFacts(undefined, base)).toEqual(base);
  });

  it('replaces the facts outright when a write-once field changes', () => {
    const replaced: OnChainContextGraphFacts = { ...base, nameHash: '0x' + '99'.repeat(32), observedAtBlock: 101 };
    expect(onChainContextGraphIdentityDiffers(base, replaced)).toBe(true);
    expect(onChainContextGraphIdentityDiffers(base, { ...base, owner: null })).toBe(false);
    expect(onChainContextGraphIdentityDiffers(base, { ...base, accessPolicy: 1 })).toBe(true);
    expect(onChainContextGraphIdentityDiffers({ ...base, createdAt: 1 }, { ...base, createdAt: 2 })).toBe(true);
    expect(mergeOnChainContextGraphFacts(base, replaced)).toEqual(replaced);
  });

  it('compares facts field by field', () => {
    expect(sameOnChainContextGraphFacts(undefined, base)).toBe(false);
    expect(sameOnChainContextGraphFacts(base, { ...base })).toBe(true);
    expect(sameOnChainContextGraphFacts(base, { ...base, active: false })).toBe(false);
  });

  it('projects the chain facts for a list row', () => {
    expect(toContextGraphListOnChainFacts({
      ...base,
      accessPolicy: 1,
      publishPolicy: 0,
      publishAuthority: '0x' + '33'.repeat(20),
      createdAt: 1_756_944_000,
      active: true,
    })).toEqual({
      id: '32',
      access: 'private',
      publishPolicy: 'curated',
      publishAuthority: '0x' + '33'.repeat(20),
      owner: '0x' + '22'.repeat(20),
      createdAt: '2025-09-04T00:00:00.000Z',
      active: true,
      nameHash: '0x' + '11'.repeat(32),
      observedAtBlock: 100,
    });
    expect(toContextGraphListOnChainFacts(base)).toMatchObject({
      access: 'public',
      publishPolicy: 'open',
      createdAt: null,
      active: null,
    });
    expect(toContextGraphListOnChainFacts({ ...base, accessPolicy: 7, publishPolicy: null })).toMatchObject({
      access: 'unknown',
      publishPolicy: null,
    });
    expect(toContextGraphListOnChainFacts({ ...base, accessPolicy: null, publishPolicy: 9 })).toMatchObject({
      access: 'unknown',
      publishPolicy: 'unknown',
    });
  });
});
