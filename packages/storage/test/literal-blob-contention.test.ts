import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asChangelogReader, createTripleStore, type TripleStore } from '../src/index.js';
import { immutableStorePreparation } from '../src/immutable-store-preparation.js';

const disk = vi.hoisted(() => ({ hold: null as Promise<void> | null, entered: false, syncs: 0 }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), sync = file.sync.bind(file);
    if (/[a-f0-9]{64}$/.test(String(args[0]))) file.sync = async () => {
      disk.entered = true; disk.syncs += 1; await disk.hold; await sync();
    };
    return file;
  } };
});
let root: string, store: TripleStore | undefined;
afterEach(async () => { await store?.close(); store = undefined; vi.restoreAllMocks(); disk.hold = null; disk.entered = false; disk.syncs = 0;
  if (root) await rm(root, { recursive: true, force: true }); });
const graph = 'urn:dkg:cg/_shared_memory';
const quad = (subject: string, object = '"small"') => ({ graph, subject, predicate: 'urn:value', object });
async function fixture(onAppend?: () => void) {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-blob-contention-')));
  store = await createTripleStore({ backend: 'oxigraph-worker', options: { path: join(root, 'store.nq') },
    graphSetIndex: true, changelog: { onAppend }, largeLiteralStorage: { directory: join(root, 'blobs'), thresholdBytes: 1024 } });
  await store.insert([quad('urn:seed')]);
  return store;
}
it('keeps blob persistence outside sequence allocation while small writes and reads progress', async () => {
  const f = await fixture(); let release!: () => void, smallDone = false;
  disk.hold = new Promise<void>(resolve => { release = resolve; });
  const large = f.insert([quad('urn:large', `"${'x'.repeat(80 * 1024)}"`)]);
  let small: Promise<void> | undefined;
  try {
    await vi.waitFor(() => expect(disk.entered).toBe(true));
    small = f.insert([quad('urn:small')]).then(() => { smallDone = true; });
    await expect(f.query(`ASK { GRAPH <${graph}> { <urn:large> ?p ?o } }`)).resolves.toMatchObject({ value: false });
    await vi.waitFor(() => expect(smallDone).toBe(true));
    expect((await asChangelogReader(f)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1, 2]);
    expect(await f.listGraphs()).toEqual([graph]);
  } finally { release(); await Promise.allSettled([large, small]); }
  await large; await small;
  expect((await asChangelogReader(f)!.readChanges(0, 10)).map(change => change.seq)).toEqual([1, 2, 3]);
  await f.insert([quad('urn:replay', `"${'x'.repeat(80 * 1024)}"`)]);
  expect(disk.syncs).toBe(1);
});

it('drains admitted preparation on close and refuses later writes before dispatch', async () => {
  const f = await fixture(); let release!: () => void, closed = false;
  disk.hold = new Promise<void>(resolve => { release = resolve; });
  const large = f.insert([quad('urn:large', `"${'y'.repeat(80 * 1024)}"`)]);
  const outcome = large.then(() => 'success', error => error);
  await vi.waitFor(() => expect(disk.entered).toBe(true));
  const closing = f.close().then(() => { closed = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    let lateError: unknown;
    const late = f.insert([quad('urn:late')]).catch(error => { lateError = error; });
    void late;
    await vi.waitFor(() => expect(lateError).toBeInstanceOf(Error));
    expect(String(lateError)).toContain('closing');
  } finally { release(); await outcome; await closing; store = undefined; }
  expect(await outcome).toBe('success');
});

it('does not lend an admitted preparation to a new callback write during close', async () => {
  let armed = false, callbackWrite: Promise<void> | undefined, callbackOutcome: unknown;
  const f = await fixture(() => {
    if (!armed) return;
    armed = false;
    callbackWrite = f.delete([quad('urn:seed')]).then(() => { callbackOutcome = 'success'; }, error => { callbackOutcome = error; });
  });
  let release!: () => void;
  disk.hold = new Promise<void>(resolve => { release = resolve; });
  const large = f.insert([quad('urn:large', `"${'z'.repeat(80 * 1024)}"`)]);
  await vi.waitFor(() => expect(disk.entered).toBe(true));
  armed = true;
  const closing = f.close();
  release(); await large; await closing; await callbackWrite; store = undefined;
  expect(callbackOutcome).toBeInstanceOf(Error);
  expect(String(callbackOutcome)).toContain('closing');
});

it('owns accepted preparation before it can synchronously initiate close', async () => {
  const f = await fixture(), preparation = immutableStorePreparation(f)!;
  const prepare = preparation.prepareImmutableQuads.bind(preparation);
  const innerClose = vi.spyOn((f as TripleStore & { innerStore: TripleStore }).innerStore, 'close');
  let closing: Promise<void> | undefined, release!: () => void;
  disk.hold = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(preparation, 'prepareImmutableQuads').mockImplementation(quads => {
    const ready = prepare(quads);
    closing = f.close();
    return ready;
  });
  const large = f.insert([quad('urn:synchronous-close', `"${'w'.repeat(80 * 1024)}"`)]);
  const outcome = large.then(() => 'success', error => error);
  try {
    await vi.waitFor(() => expect(disk.entered).toBe(true));
    expect(innerClose).not.toHaveBeenCalled();
  } finally { release(); await outcome; await closing; store = undefined; }
  expect(await outcome).toBe('success');
  expect(innerClose).toHaveBeenCalledOnce();
});
