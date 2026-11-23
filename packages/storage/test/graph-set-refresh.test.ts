import { describe, expect, it, vi } from 'vitest';
import { GraphSetIndexStore, OxigraphStore, type QueryOptions } from '../src/index.js';
import { STORE_GRAPH_CATALOG_MAX_BYTES_ENV, isStoreInternalLimitError } from '../src/graph-catalog-internal-limit.js';
import { BackgroundGraphSetRevalidation, graphSetRevalidationDelayMs, type CurrentGraphCatalogReadOptions } from '../src/graph-set-refresh.js';
import { listStoredContextGraphOwnerCandidates } from '../src/stored-context-graph-owners.js';
import { CountingStore, q } from './graph-set-index-store-harness.js';

const CACHED = 'did:dkg:context-graph:cached';
const EXTERNAL = 'did:dkg:context-graph:external';

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Lets pending background work run: two macrotask turns. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** Whether a read is still waiting once pending work has had its turns. */
async function stillWaiting(read: Promise<unknown>): Promise<boolean> {
  let answered = false;
  void read.then(() => { answered = true; }, () => { answered = true; });
  await settle();
  return !answered;
}

/** A warm index over a store holding CACHED, with EXTERNAL written behind its back. */
async function warmIndex(options: ConstructorParameters<typeof GraphSetIndexStore>[1] = {}) {
  const clock = { now: 1_000 };
  const inner = new OxigraphStore();
  await inner.insert([q(CACHED)]);
  const counting = new CountingStore(inner);
  const store = new GraphSetIndexStore(counting, { revalidateMs: 100, revalidate: 'background', now: () => clock.now, ...options });
  await expect(store.listGraphs()).resolves.toEqual([CACHED]);
  await inner.insert([q(EXTERNAL)]);
  return { clock, inner, counting, store };
}

describe('a warm graph catalog that is due', () => {
  it('answers every caller from the warm catalog while one background flight refreshes it', async () => {
    const { clock, counting, store } = await warmIndex();
    const scan = gate();
    counting.listGraphsGate = scan.promise;
    clock.now += 100;

    // The full read is held open, and no caller waits for it.
    const answers = await Promise.all(Array.from({ length: 5 }, () => store.listGraphs()));
    expect(answers).toEqual(Array.from({ length: 5 }, () => [CACHED]));
    expect(counting.listGraphsCalls).toBe(2);
    expect(counting.listGraphsOptions.at(-1)).toMatchObject({ priority: 'background', source: 'graph-set-index.revalidate' });

    scan.open();
    await vi.waitFor(async () => expect(await store.listGraphs()).toEqual([CACHED, EXTERNAL]));
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('drops the catalog when a background flight passes the internal limit, so reads fail as a cold seed does', async () => {
    const previous = process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV];
    try {
      const { clock, inner, store } = await warmIndex();
      await inner.insert(Array.from({ length: 20 }, (_, n) => q(`did:dkg:context-graph:grown/${'x'.repeat(40)}/${n}`)));
      process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV] = '512';
      clock.now += 100;

      // The read that finds the catalog due is still answered from it; once the flight fails, reads fail.
      await expect(store.listGraphs()).resolves.toEqual([CACHED]);
      const failure = await vi.waitFor(async () => {
        const error = await store.listGraphs().then(() => undefined, (caught: unknown) => caught);
        expect(isStoreInternalLimitError(error)).toBe(true);
        return error;
      });
      expect(failure).toMatchObject({ code: 'STORE_INTERNAL_LIMIT', limitBytes: 512 });

      // Once the catalog fits again, the next read seeds it.
      delete process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV];
      await expect(store.listGraphs()).resolves.toContain(EXTERNAL);
    } finally {
      if (previous === undefined) delete process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV];
      else process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV] = previous;
    }
  });

  it('keeps a catalog published after a background flight began when that flight then passes the internal limit', async () => {
    const previous = process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV];
    // The full read after `held` is set reports that it arrived and waits, then lists the store as it is; every other read lists at once.
    class HeldListing extends CountingStore {
      held: { readonly arrived: () => void; readonly release: Promise<void> } | null = null;
      override async listGraphs(options?: QueryOptions): Promise<string[]> {
        this.listGraphsCalls++;
        this.listGraphsOptions.push(options);
        const held = this.held;
        this.held = null;
        if (held) {
          held.arrived();
          await held.release;
        }
        return this.inner.listGraphs(options);
      }
    }
    try {
      const clock = { now: 1_000 };
      const inner = new OxigraphStore();
      await inner.insert([q(CACHED)]);
      const listing = new HeldListing(inner);
      const store = new GraphSetIndexStore(listing, { revalidateMs: 100, revalidate: 'background', now: () => clock.now });
      await expect(store.listGraphs()).resolves.toEqual([CACHED]);

      // The catalog is due; the background flight it starts is held before it lists.
      const grown = Array.from({ length: 20 }, (_, n) => q(`did:dkg:context-graph:grown/${'x'.repeat(40)}/${n}`));
      process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV] = '512';
      const arrived = gate();
      const release = gate();
      listing.held = { arrived: arrived.open, release: release.promise };
      clock.now += 100;
      await expect(store.listGraphs()).resolves.toEqual([CACHED]);
      await arrived.promise;

      // Meanwhile a current read, at a higher priority, publishes a catalog that fits.
      await inner.insert([q(EXTERNAL)]);
      const current: CurrentGraphCatalogReadOptions = { currentCatalog: true };
      await expect(store.listGraphs(current as QueryOptions)).resolves.toEqual([CACHED, EXTERNAL]);
      const reads = listing.listGraphsCalls;

      // The store then grows past the internal limit, so the held flight fails there once released. Its failure
      // must not drop the newer catalog: the next read is answered from it, with no full read, which would fail.
      await inner.insert(grown);
      release.open();
      await settle();
      await expect(store.listGraphs()).resolves.toEqual([CACHED, EXTERNAL]);
      expect(listing.listGraphsCalls).toBe(reads);
    } finally {
      if (previous === undefined) delete process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV];
      else process.env[STORE_GRAPH_CATALOG_MAX_BYTES_ENV] = previous;
    }
  });

  it('keeps serving the last catalog, and backs off, when a background flight fails otherwise', async () => {
    const { clock, counting, store } = await warmIndex({ revalidateFailureBackoffMs: 50 });
    counting.failListGraphs = true;
    clock.now += 100;

    await expect(store.listGraphs()).resolves.toEqual([CACHED]);
    await settle();
    expect(counting.listGraphsCalls).toBe(2);
    clock.now += 49;
    await expect(store.listGraphs()).resolves.toEqual([CACHED]);
    await settle();
    expect(counting.listGraphsCalls).toBe(2);

    counting.failListGraphs = false;
    clock.now += 1;
    await expect(store.listGraphs()).resolves.toEqual([CACHED]);
    await vi.waitFor(async () => expect(await store.listGraphs()).toEqual([CACHED, EXTERNAL]));
    expect(counting.listGraphsCalls).toBe(3);
  });

  it('makes a current read wait for the revalidation, while every other read is answered warm', async () => {
    const { clock, counting, store } = await warmIndex();
    const scan = gate();
    counting.listGraphsGate = scan.promise;
    clock.now += 100;

    await expect(store.listGraphsByPrefix('did:dkg:context-graph:')).resolves.toEqual([CACHED]);
    // Unscoped-query admission reads the stored owners as a current read.
    const owners = listStoredContextGraphOwnerCandidates(store, {});
    expect(await stillWaiting(owners)).toBe(true);
    await expect(store.listGraphs()).resolves.toEqual([CACHED]);
    scan.open();
    await expect(owners).resolves.toEqual(['cached', 'external']);
  });

  it('makes the caller wait with revalidate: blocking, as before', async () => {
    const { clock, counting, store } = await warmIndex({ revalidate: 'blocking' });
    const scan = gate();
    counting.listGraphsGate = scan.promise;
    clock.now += 100;

    const read = store.listGraphs();
    expect(await stillWaiting(read)).toBe(true);
    scan.open();
    await expect(read).resolves.toEqual([CACHED, EXTERNAL]);
  });

  it('makes the caller wait by default, so a due read sees graphs written outside the index', async () => {
    // Without a mode the store blocks: a node that has just synced metadata
    // through another path reads it on the next due read, not a refresh later.
    const { clock, counting, store } = await warmIndex({ revalidate: undefined });
    const scan = gate();
    counting.listGraphsGate = scan.promise;
    clock.now += 100;

    const read = store.listGraphs();
    expect(await stillWaiting(read)).toBe(true);
    scan.open();
    await expect(read).resolves.toEqual([CACHED, EXTERNAL]);
  });

  it('still makes a read wait for a cold seed, a dirty rebuild and a store that revalidates on every read', async () => {
    const inner = new OxigraphStore();
    await inner.insert([q(CACHED)]);
    for (const options of [{ revalidate: 'background' as const }, { revalidate: 'background' as const, revalidateMs: 0 }]) {
      const counting = new CountingStore(inner);
      const store = new GraphSetIndexStore(counting, options);
      for (const prepare of [
        async () => undefined,
        async () => store.update!(`INSERT DATA { GRAPH <${EXTERNAL}> { <urn:s> <urn:p> "v" } }`),
      ]) {
        await prepare();
        const scan = gate();
        counting.listGraphsGate = scan.promise;
        const read = store.listGraphs();
        expect(await stillWaiting(read), JSON.stringify(options)).toBe(true);
        scan.open();
        await expect(read).resolves.toContain(CACHED);
        counting.listGraphsGate = null;
      }
    }
  });
});

describe('the revalidation cadence', () => {
  it('waits the interval, or twenty times the last refresh when that is longer', () => {
    expect(graphSetRevalidationDelayMs(30_000, 100)).toBe(30_000);
    expect(graphSetRevalidationDelayMs(30_000, 2_000)).toBe(40_000);
    expect(graphSetRevalidationDelayMs(100, -5)).toBe(100);
  });

  it('revalidates a current read on the interval, before a stretched cadence is due', async () => {
    const clock = { now: 1_000 };
    class SlowListing extends CountingStore {
      override async listGraphs(options?: QueryOptions): Promise<string[]> {
        clock.now += 50;
        return super.listGraphs(options);
      }
    }
    const counting = new SlowListing(new OxigraphStore());
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100, revalidate: 'background', now: () => clock.now });
    const current: QueryOptions & CurrentGraphCatalogReadOptions = { currentCatalog: true };
    await store.listGraphs();
    // The seed published at 1,050: the cadence is due at 2,050, the interval at 1,150.
    clock.now = 1_149;
    await store.readGraphInventory(undefined, current);
    expect(counting.listGraphsCalls).toBe(1);
    clock.now = 1_150;
    await store.listGraphs();
    await settle();
    expect(counting.listGraphsCalls).toBe(1);
    await store.readGraphInventory(undefined, current);
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('starts the next revalidation no sooner than twenty times the last one took', async () => {
    const clock = { now: 1_000 };
    class SlowListing extends CountingStore {
      override async listGraphs(options?: QueryOptions): Promise<string[]> {
        clock.now += 50;
        return super.listGraphs(options);
      }
    }
    const counting = new SlowListing(new OxigraphStore());
    const store = new GraphSetIndexStore(counting, { revalidateMs: 100, revalidate: 'background', now: () => clock.now });
    await store.listGraphs();
    // The seed took 50 ms and published at 1,050, so the catalog is due at 2,050.
    clock.now = 2_049;
    await store.listGraphs();
    await settle();
    expect(counting.listGraphsCalls).toBe(1);
    clock.now = 2_050;
    await store.listGraphs();
    await settle();
    expect(counting.listGraphsCalls).toBe(2);
  });

  it('runs one background revalidation at a time and reports its failure to its owner', async () => {
    const runner = new BackgroundGraphSetRevalidation();
    const work = gate();
    const failures: unknown[] = [];
    let started = 0;
    const refresh = async () => { started++; await work.promise; throw new Error('scan failed'); };
    runner.start(refresh, (error) => failures.push(error));
    runner.start(refresh, (error) => failures.push(error));
    expect(runner.active).toBe(true);
    work.open();
    await runner.idle();
    expect(started).toBe(1);
    expect(runner.active).toBe(false);
    expect(failures).toEqual([new Error('scan failed')]);

    // A catalog published while a flight runs makes that flight's failure stale: it is not reported.
    const later = gate();
    runner.start(async () => { await later.promise; throw new Error('stale scan failed'); }, (error) => failures.push(error));
    runner.notePublished();
    later.open();
    await runner.idle();
    expect(failures).toEqual([new Error('scan failed')]);
  });
});
