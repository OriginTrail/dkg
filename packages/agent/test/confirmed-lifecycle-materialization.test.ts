import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { readConfirmedGraphKnowledgeAssetMetadataEnvelope, readLocallyTrustedKnowledgeAssetControlEnvelope, replaceLocallyTrustedKnowledgeAssetControlEnvelope, overlayLocallyTrustedKnowledgeAssetControls } from '@origintrail-official/dkg-publisher';
import { getBytes } from 'ethers';
import * as materialization from '../src/named-ka-vm-lifecycle-materialization.js';
import { decodeLifecycleRepairJournal, encodeLifecycleRepairJournal, lifecycleRepairKey, normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { NamedKaVmLifecycleRepair } from '../src/named-ka-vm-lifecycle-repair.js';
import { confirmedLifecycleExecutionCapabilities } from '../src/named-ka-vm-lifecycle-executor.js';
import { confirmedMaterializationFixture } from './_helpers/confirmed-materialization-fixture.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(privateContent = false, version = '1') {
  const dir = await mkdtemp(join(tmpdir(), 'dkg-confirmed-payload-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'store.nq'), store = new OxigraphStore(path); cleanups.push(() => store.close());
  const source = confirmedMaterializationFixture(privateContent, undefined, version);
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
it('retains the obligation when the single attempt barrier belongs to a retired worker', async () => {
  const { owner, input, store, journal, advance } = await fixture();
  const capture = store.commitment!.capture.bind(store.commitment);
  const captures = vi.spyOn(store.commitment!, 'capture').mockImplementationOnce(() => async () => {
    throw Object.assign(new Error('original payload worker retired'), { code: 'OXIGRAPH_WORKER_COMMIT_OWNER_CHANGED' });
  }).mockImplementation(capture);
  expect(await owner.submit(input)).toBe('pending');
  expect(captures).toHaveBeenCalledOnce();
  expect(await journal()).toHaveLength(1);
  advance(); await owner.runDue(); expect(await journal()).toHaveLength(0);
});

it('captures and invokes exactly one barrier for the complete materialized attempt', async () => {
  const { owner, input, store } = await fixture();
  const original = store.commitment!.capture.bind(store.commitment);
  const barriers: ReturnType<typeof vi.fn>[] = [];
  const captures = vi.spyOn(store.commitment!, 'capture').mockImplementation(() => {
    const barrier = vi.fn(original()); barriers.push(barrier); return barrier;
  });
  expect(await owner.submit(input)).toBe('repaired');
  expect(captures).toHaveBeenCalledOnce(); expect(barriers[0]).toHaveBeenCalledOnce();
});
it('restores restricted version 2 over inherited public version 1 through retry and durable reopen', async () => {
  const { owner, input: source, store, path, chain, journal } = await fixture(false, '2');
  const input = { ...source, materialization: { ...source.materialization!, metadataQuads: source.materialization!.metadataQuads
    .filter(q => q.predicate !== 'http://dkg.io/ontology/allowedPeer')
    .map(q => q.predicate === 'http://dkg.io/ontology/accessPolicy' ? { ...q, object: '"ownerOnly"' } : q) } };
  const meta = contextGraphMetaUri(input.contextGraphId);
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, input.publishedUal,
    { assertionVersion: '1', merkleRoot: getBytes(input.merkleRoot) },
    { publisherPeerId: 'old-publisher', accessPolicy: 'public', allowedPeers: [] });
  expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, meta, input.publishedUal, input.materialization.metadataQuads)).toMatchObject({ accessPolicy: 'public' });
  expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, meta, input.publishedUal, input.materialization.metadataQuads, {}, 'exact')).toBeUndefined();
  const update = store.atomicUpdate.bind(store);
  vi.spyOn(store, 'atomicUpdate').mockImplementationOnce(async () => { throw new Error('temporary materialization pressure'); }).mockImplementation(update);
  expect(await owner.submit(input)).toBe('pending'); expect(await journal()).toHaveLength(1);
  await owner.stop(); await store.close();
  const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
  const retry = new NamedKaVmLifecycleRepair({ dataDir: dirname(path), now: () => 10_000, warn: () => {},
    ...confirmedLifecycleExecutionCapabilities({ store: reopened, chain, dataDir: dirname(path), writeLocks: new Map(), readTimeoutMs: 1000 }) });
  cleanups.push(() => retry.stop()); await retry.runDue(); expect(await journal()).toHaveLength(0);
  const durable = new OxigraphStore(path); cleanups.push(() => durable.close());
  expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(durable, meta, input.publishedUal, input.materialization.metadataQuads)).toEqual({ publisherPeerId: 'test-publisher', accessPolicy: 'ownerOnly', allowedPeers: [] });
  const hostileSync = source.materialization!.metadataQuads.map(q => q.predicate === 'http://dkg.io/ontology/accessPolicy' ? { ...q, object: '"public"' } : q);
  const overlay = await overlayLocallyTrustedKnowledgeAssetControls(durable, meta, input.publishedUal, hostileSync);
  expect(overlay.filter(q => q.predicate === 'http://dkg.io/ontology/accessPolicy').map(q => q.object)).toEqual(['"ownerOnly"']);
  expect(overlay.filter(q => q.predicate === 'http://dkg.io/ontology/allowedPeer')).toHaveLength(0);
});
it('preserves controls already anchored to the exact version and root', async () => {
  const { owner, input, store } = await fixture();
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, input.publishedUal,
    { assertionVersion: input.assertionVersion, merkleRoot: getBytes(input.merkleRoot) },
    { publisherPeerId: 'local-owner', accessPolicy: 'ownerOnly', allowedPeers: [] });
  expect(await owner.submit(input)).toBe('repaired');
  expect(await store.query(`ASK { GRAPH <${contextGraphMetaUri(input.contextGraphId)}> { <${input.publishedUal}> <http://dkg.io/ontology/accessPolicy> "ownerOnly" } }`)).toMatchObject({ value: true });
  expect(await readLocallyTrustedKnowledgeAssetControlEnvelope(store, contextGraphMetaUri(input.contextGraphId), input.publishedUal, input.materialization!.metadataQuads)).toEqual({ publisherPeerId: 'local-owner', accessPolicy: 'ownerOnly', allowedPeers: [] });
});

it('freezes admitted and decoded evidence while retry encoding does not revalidate retained payloads', () => {
  const source = confirmedMaterializationFixture().input;
  const admitted = normalizeLifecycleRepairInput(source);
  const entries = new Map([[lifecycleRepairKey(admitted), { input: admitted, attempts: 1, nextAttemptAt: 5_000, rejected: true }]]);
  const decoded = decodeLifecycleRepairJournal(JSON.parse(JSON.stringify(encodeLifecycleRepairJournal(entries))));
  for (const input of [admitted, [...decoded.values()][0]!.input]) {
    expect(Object.isFrozen(input)).toBe(true); expect(Object.isFrozen(input.publicationDeployment)).toBe(true);
    expect(Object.isFrozen(input.materialization)).toBe(true); expect(Object.isFrozen(input.materialization!.publicQuads)).toBe(true);
    expect(Object.isFrozen(input.materialization!.publicQuads[0])).toBe(true); expect(Object.isFrozen(input.materialization!.metadataQuads[0])).toBe(true);
    expect(() => { (input.materialization!.publicQuads[0] as { object: string }).object = '"tampered"'; }).toThrow();
  }
  const unrelated = normalizeLifecycleRepairInput({ ...source, name: 'independent-retry' });
  decoded.set(lifecycleRepairKey(unrelated), { input: unrelated, attempts: 2, nextAttemptAt: 20_000 });
  const normalize = vi.spyOn(materialization, 'normalizeLifecycleMaterialization');
  for (let attempt = 3; attempt < 6; attempt += 1) {
    decoded.get(lifecycleRepairKey(unrelated))!.attempts = attempt;
    const wire = encodeLifecycleRepairJournal(decoded);
    expect(wire.entries[0]![1].input.materialization).toBe([...decoded.values()][0]!.input.materialization);
    JSON.stringify(wire);
  }
  expect(normalize).not.toHaveBeenCalled();
});
