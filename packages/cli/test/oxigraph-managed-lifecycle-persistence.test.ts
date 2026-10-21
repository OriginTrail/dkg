import { expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertionLifecycleUri, contextGraphAssertionUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { createTripleStore, type TripleStore } from '@origintrail-official/dkg-storage';
import { NamedKaVmLifecycleRepair } from '../../agent/src/named-ka-vm-lifecycle-repair.js';
import { applyMaterializedConfirmedLifecycle } from '../../agent/src/named-ka-vm-lifecycle-materialization.js';
import { confirmedMaterializationFixture } from '../../agent/test/_helpers/confirmed-materialization-fixture.js';
import { readLifecycleRepairJournalFile } from '../../agent/test/_helpers/read-lifecycle-repair-journal.js';
import { resolveConfirmedGraphScopedVm } from '../../agent/src/confirmed-graph-scoped-vm-resolver.js';
import { getBytes } from 'ethers';
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dkg-managed-lifecycle-')));
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
  expect(managed).not.toBeUndefined();
  try {
    store = await createTripleStore(managed!.storeConfig);
    expect(store.commitment?.durability).toBe('restart-durable');
    expect(store.commitment?.capture).toBeTypeOf('function');
    const { input, graph: vmGraph } = confirmedMaterializationFixture();
    const { contextGraphId: cg, agentAddress: author, name } = input, hash = input.merkleRoot.replace(/^0x/, '');
    const meta = contextGraphMetaUri(cg), lifecycle = assertionLifecycleUri(cg, author, name);
    const assertion = contextGraphAssertionUri(cg, author, name), ontology = 'http://dkg.io/ontology/';
    await store.insert([
      { graph: meta, subject: lifecycle, predicate: `${ontology}swmCurrentAssertion`, object: JSON.stringify(hash) },
      { graph: meta, subject: lifecycle, predicate: `${ontology}state`, object: '"shared"' },
      { graph: meta, subject: lifecycle, predicate: `${ontology}memoryLayer`, object: '"SWM"' },
      { graph: meta, subject: assertion, predicate: `${ontology}memoryLayer`, object: '"SWM"' },
    ]);
    const journal = async () => readLifecycleRepairJournalFile(join(root, 'named-ka-vm-lifecycle-repairs.json'));
    // Chain confirmation is an already admitted immutable input. This test uses
    // the actual production journal owner, writer, runtime factory and endpoint.
    repair = new NamedKaVmLifecycleRepair({ writeLocks: new Map(), dataDir: root, warn: vi.fn(), isCurrent: async () => true,
      apply: candidate => applyMaterializedConfirmedLifecycle(store!, candidate, { persistence: 'restart-durable' }) });
    let entered!: () => void;
    const syncing = new Promise<void>(resolve => { entered = resolve; });
    barrier.location = location; barrier.entered = entered;
    barrier.release = new Promise<void>(resolve => { release = resolve; });
    const submission = repair.submit(input);
    let settled = false; void submission.then(() => { settled = true; }, () => { settled = true; });
    await Promise.race([syncing, submission.then(outcome => { throw new Error(`Repair returned ${outcome} before reaching the held WAL barrier`); })]);
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
      GRAPH <${vmGraph}> { <urn:payload> <urn:value> "original public payload" } }`)).toMatchObject({ value: true });
    expect((await journal()).size).toBe(0);
    expect(await resolveConfirmedGraphScopedVm(fresh, { contextGraphId: cg, ual: input.materialization!.kaUal,
      merkleRoot: getBytes(input.merkleRoot), kaId: input.packedKaId, batchId: input.packedKaId, assertionVersion: 1n })).toMatchObject({ status: 'verified' });
  } finally {
    barrier.location = null; release(); await repair?.stop(); await fresh?.close(); await store?.close();
    await managed?.handle.stop(); await rm(root, { recursive: true, force: true });
  }
}, 180_000);
