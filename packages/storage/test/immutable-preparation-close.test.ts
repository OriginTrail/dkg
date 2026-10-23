import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTripleStore, OxigraphStore, type TripleStore, type TripleStoreDecorator } from '../src/index.js';

const gate = vi.hoisted(() => ({ directory: '', entered: false, fail: false,
  held: undefined as Promise<void> | undefined, release: undefined as (() => void) | undefined }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args), path = String(args[0]);
    if (gate.directory && path.startsWith(gate.directory + sep) && /^[a-f0-9]{64}$/.test(basename(path))) {
      const sync = file.sync.bind(file);
      file.sync = async () => { gate.entered = true; await gate.held;
        if (gate.fail) throw Object.assign(new Error('held preparation EIO'), { code: 'EIO' });
        await sync(); };
    }
    return file;
  } };
});
const roots: string[] = [], stores: TripleStore[] = [];
afterEach(async () => {
  gate.release?.(); gate.held = undefined; gate.directory = ''; gate.entered = false; gate.fail = false;
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.close().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() { const value = await realpath(await mkdtemp(join(tmpdir(), 'dkg-preparation-close-'))); roots.push(value); return value; }
it('persists a small accepted factory insert before close acknowledgement with default changelog disabled', async () => {
  const path = join(await root(), 'store.nq');
  const child = fileURLToPath(new URL('./fixtures/graph-index-close-process.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [child, path], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined(); expect(result.stdout, result.stderr).toContain('write-and-close-ack');
  expect(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.status !== 0)).toBe(true);
  const reopened = await createTripleStore({ backend: 'oxigraph-persistent', options: { path } }); stores.push(reopened);
  await expect(reopened.query('ASK { GRAPH <urn:close> { <urn:accepted> <urn:value> "small" } }')).resolves.toMatchObject({ value: true });
});
it.each([true, false])('persists an accepted small insert before immediate flush acknowledgement (index=%s)', async graphSetIndex => {
  const path = join(await root(), 'store.nq');
  const child = fileURLToPath(new URL('./fixtures/graph-index-close-process.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [child, path, 'flush', String(graphSetIndex)], { encoding: 'utf8', timeout: 15_000 });
  expect(result.error).toBeUndefined(); expect(result.stdout, result.stderr).toContain('write-and-flush-ack');
  expect(result.signal === 'SIGKILL' || (process.platform === 'win32' && result.status !== 0)).toBe(true);
  const reopened = await createTripleStore({ backend: 'oxigraph-persistent', options: { path }, graphSetIndex }); stores.push(reopened);
  await expect(reopened.query('ASK { GRAPH <urn:close> { <urn:accepted> <urn:value> "small" } }')).resolves.toMatchObject({ value: true });
});
it.each([true, false].flatMap(graphSetIndex => [false, true].map(fail => ({ graphSetIndex, fail }))))
('drains real file preparation before close (index=$graphSetIndex, failure=$fail)', async ({ graphSetIndex, fail }) => {
  const directory = await root(), path = join(directory, 'store.nq'), blobDir = join(directory, 'literal-files');
  const config = { backend: 'oxigraph-persistent', options: { path }, graphSetIndex, changelog: false,
    largeLiteralStorage: { directory: blobDir, thresholdBytes: 64 } };
  const store = await createTripleStore(config); stores.push(store);
  let backend = store;
  while ('innerStore' in backend) backend = (backend as TripleStoreDecorator).innerStore;
  expect(backend).toBeInstanceOf(OxigraphStore);
  const close = vi.spyOn(backend, 'close');
  gate.directory = blobDir; gate.fail = fail; gate.held = new Promise(resolve => { gate.release = resolve; });
  const graph = 'urn:close/_shared_memory', value = JSON.stringify('held immutable bytes '.repeat(64));
  const quad = (subject: string, object: string) => ({ graph, subject, predicate: 'urn:value', object });
  const write = store.insert([quad('urn:held', value)]).then(() => 'ack', error => error.code);
  let small: Promise<void> | undefined, closing: Promise<void> | undefined, again: Promise<void> | undefined;
  let callsWhileHeld = -1, lateOutcome = '', sameClose = false;
  try {
    await vi.waitFor(() => expect(gate.entered).toBe(true));
    let smallDone = false;
    small = store.insert([quad('urn:small', '"small"')]).then(() => { smallDone = true; });
    await vi.waitFor(() => expect(smallDone).toBe(true));
    closing = store.close(); again = store.close(); sameClose = closing === again;
    callsWhileHeld = close.mock.calls.length;
    lateOutcome = await store.insert([quad('urn:late', '"late"')]).then(() => 'ack', error => error.message);
  } finally {
    gate.release!(); await Promise.allSettled([write, small, closing, again]);
  }
  const outcome = await write;
  const reopened = await createTripleStore(config); stores.push(reopened);
  const held = await reopened.query(`ASK { GRAPH <${graph}> { <urn:held> <urn:value> ${value} } }`);
  const smallResult = await reopened.query(`ASK { GRAPH <${graph}> { <urn:small> <urn:value> "small" } }`);
  const late = await reopened.query(`ASK { GRAPH <${graph}> { <urn:late> <urn:value> "late" } }`);
  expect({ callsWhileHeld, sameClose, outcome, held, smallResult, late, backendCloses: close.mock.calls.length })
    .toMatchObject({ callsWhileHeld: 0, sameClose: true, outcome: fail ? 'EIO' : 'ack', held: { value: !fail },
      smallResult: { value: true }, late: { value: false }, backendCloses: 1 });
  expect(lateOutcome).toContain('closing');
});
