import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope, readLocallyTrustedKnowledgeAssetControlEnvelope } from '@origintrail-official/dkg-publisher';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleExecutionCapabilities } from '../src/named-ka-vm-lifecycle-executor.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(privateContent = false) {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-confirmed-payload-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.nq'), store = new OxigraphStore(path); cleanups.push(() => store.close());
  const source = confirmedMaterializationFixture(privateContent);
  let now = 1_000;
  const owner = new NamedKaVmLifecycleRepair({ dataDir: dir, now: () => now, warn: () => {},
    ...confirmedLifecycleExecutionCapabilities({ store, chain: source.chain, dataDir: dir, writeLocks: new Map(), readTimeoutMs: 1000 }) });
  cleanups.push(() => owner.stop());
  const journal = async () => JSON.parse(await readFile(join(dir, 'named-ka-vm-lifecycle-repairs.json'), 'utf8')).entries;
  return { ...source, store, owner, journal, path, advance: () => { now += 5_000; } };
}
it.each([false, true])('restores missing public payload and complete metadata with private commitment=%s, durable before close', async privateContent => {
  const { owner, input, store, path, graph, publicQuads, journal } = await fixture(privateContent);
  expect(await owner.submit(input)).toBe('repaired');
  expect(await journal()).toHaveLength(0);
  const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
  expect(await reopened.query(`CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${graph}> { ?s ?p ?o } }`)).toMatchObject({ type: 'quads', quads: publicQuads.map(q => ({ ...q, graph: '' })) });
  expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(reopened, { contextGraphId: input.contextGraphId, ual: input.publishedUal })).toMatchObject({ state: 'confirmed', envelope: { assertionVersion: '1', privateTripleCount: privateContent ? 2 : 0 } });
  expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(reopened, contextGraphMetaUri(input.contextGraphId), input.publishedUal, input.materialization!.metadataQuads)).toMatchObject({ accessPolicy: 'allowList', allowedPeers: ['test-reader'] });
  expect(await store.countQuads(graph)).toBe(1);
});
it('replaces wrong content of the same count without changing a newer draft or confirmed access metadata', async () => {
  const { owner, input, store, graph } = await fixture();
  await store.insert(input.materialization!.metadataQuads.slice());
  await store.insert([{ ...input.materialization!.publicQuads[0], object: '"wrong same-count content"', graph }]);
  const lifecycle = assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name);
  const meta = contextGraphMetaUri(input.contextGraphId);
  const draft = [{ subject: lifecycle, predicate: 'http://dkg.io/ontology/state', object: '"created"', graph: meta },
    { subject: lifecycle, predicate: 'http://dkg.io/ontology/memoryLayer', object: '"WM"', graph: meta }];
  await store.insert(draft);
  expect(await owner.submit(input)).toBe('repaired');
  expect(await store.query(`ASK { GRAPH <${graph}> { <urn:payload> <urn:value> "original public payload" } }`)).toMatchObject({ value: true });
  expect(await store.query(`ASK { GRAPH <${meta}> { <${lifecycle}> <http://dkg.io/ontology/state> "created" . <${input.publishedUal}> <http://dkg.io/ontology/accessPolicy> "allowList" } }`)).toMatchObject({ value: true });
});
it('retains snapshot-less legacy evidence on missing content and upgrades matching evidence without another publication', async () => {
  const { owner, input, store, journal } = await fixture();
  const { materialization: _snapshot, ...legacy } = input;
  expect(await owner.submit(legacy)).toBe('pending'); expect(await journal()).toHaveLength(1);
  expect(await store.countQuads()).toBe(0);
  expect(await owner.submit(input)).toBe('repaired'); expect(await journal()).toHaveLength(0);
});
it('verifies existing payload for snapshot-less queue recovery', async () => {
  const { owner, input, store, graph } = await fixture(true);
  await store.insert([...input.materialization!.metadataQuads, ...input.materialization!.publicQuads.map(q => ({ ...q, graph }))]);
  const { materialization: _snapshot, ...legacy } = input;
  expect(await owner.submit(legacy)).toBe('repaired');
});
it('keeps a repair pending without overwriting a newer local VM version', async () => {
  const { owner, input, store, graph, journal } = await fixture();
  await store.insert(input.materialization!.metadataQuads.map(q => q.predicate === 'http://dkg.io/ontology/assertionVersion' ? { ...q, object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' } : q));
  await store.insert([{ ...input.materialization!.publicQuads[0], object: '"newer payload"', graph }]);
  expect(await owner.submit(input)).toBe('pending'); expect(await journal()).toHaveLength(1);
  expect(await store.query(`ASK { GRAPH <${graph}> { <urn:payload> <urn:value> "newer payload" } }`)).toMatchObject({ value: true });
});
it('rejects a tampered recovery payload before touching the graph store', async () => {
  const { owner, input, store } = await fixture();
  const query = vi.spyOn(store, 'query');
  await expect(owner.submit({ ...input, materialization: { ...input.materialization!, publicQuads: [{ ...input.materialization!.publicQuads[0], object: '"tampered"' }] } })).rejects.toThrow('public recovery snapshot');
  expect(query).not.toHaveBeenCalled();
});
it('retains the obligation when payload verification belongs to a retired worker even if the metadata barrier succeeds', async () => {
  const { owner, input, store, journal, advance } = await fixture();
  const capture = store.commitment!.capture.bind(store.commitment);
  const captures = vi.spyOn(store.commitment!, 'capture').mockImplementationOnce(() => async () => {
    throw Object.assign(new Error('original payload worker retired'), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  }).mockImplementation(capture);
  expect(await owner.submit(input)).toBe('pending');
  expect(captures.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(await journal()).toHaveLength(1);
  advance(); await owner.runDue(); expect(await journal()).toHaveLength(0);
});
