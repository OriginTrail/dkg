import { expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertionLifecycleUri, contextGraphAssertionUri, contextGraphLayerUri, contextGraphMetaUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { asTripleStorePersistenceCapability, createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair } from '../../agent/src/named-ka-vm-lifecycle-repair.js';
import { applyPublishedNamedKaVmLifecycle } from '../../agent/src/named-ka-vm-lifecycle.js';
import { decodeLifecycleRepairJournal } from '../../agent/src/named-ka-vm-lifecycle-repair-journal.js';
import { OXIGRAPH_VERSION } from '../src/daemon/oxigraph-binary.js';
import { startManagedOxigraph } from '../src/daemon/oxigraph-managed.js';
import { freePort, waitForCondition } from './fixtures/oxigraph-server-real-fixture.js';

const barrier = vi.hoisted(() => ({ location: null as string | null,
  entered: null as (() => void) | null, release: null as Promise<void> | null }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    if (barrier.location !== null && dirname(String(args[0])) === barrier.location
      && /^\d+\.log$/u.test(basename(String(args[0])))) {
      barrier.entered?.(); await barrier.release;
    }
    return actual.open(...args);
  } };
});

it('completes confirmed lifecycle repair through actual managed configuration only after WAL sync, then survives SIGKILL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dkg-managed-lifecycle-'));
  const location = join(root, 'rocksdb'), cacheDir = join(root, 'cache');
  if (process.env.DKG_TEST_OXIGRAPH_BINARY) {
    await mkdir(cacheDir, { recursive: true });
    await copyFile(process.env.DKG_TEST_OXIGRAPH_BINARY,
      join(cacheDir, `oxigraph-v${OXIGRAPH_VERSION}${process.platform === 'win32' ? '.exe' : ''}`));
  }
  let store: TripleStore | undefined, fresh: TripleStore | undefined;
  let repair: NamedKaVmLifecycleRepair | undefined;
  let release = () => {};
  const managed = await startManagedOxigraph({
    config: { store: { backend: 'oxigraph-server', options: { location, cacheDir, port: await freePort() } } },
    dataDir: root, readyTimeoutMs: 120_000,
  });
  expect(managed).not.toBeNull();
  try {
    store = await createTripleStore(managed!.storeConfig);
    expect(store.writesDurableOnAcknowledgement).not.toBe(true);
    expect(asTripleStorePersistenceCapability(store)).not.toBeNull();
    const cg = 'managed-lifecycle', author = `0x${'11'.repeat(20)}`, name = 'asset', hash = 'ab'.repeat(32);
    const packedKaId = (BigInt(author) << 96n) | 1n;
    const meta = contextGraphMetaUri(cg), lifecycle = assertionLifecycleUri(cg, author, name);
    const assertion = contextGraphAssertionUri(cg, author, name), ontology = 'http://dkg.io/ontology/';
    const vmGraph = contextGraphLayerUri(cg, MemoryLayer.VerifiableMemory, author, 1n);
    await store.insert([
      { graph: meta, subject: lifecycle, predicate: `${ontology}swmCurrentAssertion`, object: JSON.stringify(hash) },
      { graph: meta, subject: lifecycle, predicate: `${ontology}state`, object: '"shared"' },
      { graph: meta, subject: lifecycle, predicate: `${ontology}memoryLayer`, object: '"SWM"' },
      { graph: meta, subject: assertion, predicate: `${ontology}memoryLayer`, object: '"SWM"' },
      { graph: vmGraph, subject: 'urn:confirmed', predicate: 'urn:value', object: '"Confirmed"' },
    ]);
    const journal = async () => decodeLifecycleRepairJournal(JSON.parse(await readFile(join(root, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')));
    // Chain confirmation is an already admitted immutable input. This test uses
    // the actual production journal owner, writer, runtime factory and endpoint.
    repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: root, warn: vi.fn(), isCurrent: async () => true,
      apply: input => applyPublishedNamedKaVmLifecycle(store!, input) });
    let entered!: () => void;
    const syncing = new Promise<void>(resolve => { entered = resolve; });
    barrier.location = location; barrier.entered = entered;
    barrier.release = new Promise<void>(resolve => { release = resolve; });
    const submission = repair.submit({ contextGraphId: cg, agentAddress: author, name, merkleRoot: hash,
      assertionVersion: '1', packedKaId, publishedUal: `did:dkg:mock:31337/${author}/1` });
    let settled = false; void submission.then(() => { settled = true; });
    await syncing;
    expect(settled).toBe(false); expect((await journal()).size).toBe(1);
    // HTTP mutation succeeded and rows are visible, but evidence is still held.
    expect(await store.query(`ASK { GRAPH <${meta}> { <${lifecycle}> <${ontology}state> "published" } }`))
      .toMatchObject({ value: true });
    barrier.location = null; release();
    await expect(submission).resolves.toBe('repaired'); expect((await journal()).size).toBe(0);
    const generation = managed!.handle.getRecoveryState().generation;
    expect(managed!.handle.requestRestart('test crash after completed lifecycle WAL barrier')).toBe(true);
    expect(await waitForCondition(() => {
      const state = managed!.handle.getRecoveryState();
      return state.generation > generation && !state.recovering;
    }, 60_000)).toBe(true);
    fresh = await createTripleStore(managed!.storeConfig);
    expect(await fresh.query(`ASK { GRAPH <${meta}> { <${lifecycle}> <${ontology}state> "published" ;
      <${ontology}vmCurrentAssertion> "${hash}" ; <${ontology}assertionGraph> <${vmGraph}> ;
      <${ontology}memoryLayer> "VM" . <${assertion}> <${ontology}memoryLayer> "VM" . }
      GRAPH <${vmGraph}> { <urn:confirmed> <urn:value> "Confirmed" } }`)).toMatchObject({ value: true });
    expect((await journal()).size).toBe(0);
  } finally {
    barrier.location = null; release(); await repair?.stop(); await fresh?.close(); await store?.close();
    await managed?.handle.stop(); await rm(root, { recursive: true, force: true });
  }
}, 180_000);
