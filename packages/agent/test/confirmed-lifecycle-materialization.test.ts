import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { assertionLifecycleUri, contextGraphMetaUri, TypedEventBus, encodeAccessRequest, decodeAccessResponse } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { AccessHandler, readConfirmedGraphKnowledgeAssetMetadataEnvelope, readLocallyTrustedKnowledgeAssetControlEnvelope, replaceLocallyTrustedKnowledgeAssetControlEnvelope, overlayLocallyTrustedKnowledgeAssetControls } from '@origintrail-official/dkg-publisher';
import { resolveConfirmedGraphScopedVm } from '../src/confirmed-graph-scoped-vm-resolver.js';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { recoverReceiptBackedGraphScopedEvidence } from '../src/receipt-backed-graph-scoped-evidence.js';
import { getBytes, hexlify } from 'ethers';
import * as evidence from '../src/named-ka-vm-lifecycle-evidence.js';
import * as materialization from '../src/named-ka-vm-lifecycle-materialization.js';
import { decodeLifecycleRepairJournal, encodeLifecycleRepairJournal, lifecycleRepairKey, lifecycleMaterializationWire } from '../src/named-ka-vm-lifecycle-repair-journal.js';
import { normalizeLifecycleRepairInput } from '../src/named-ka-vm-lifecycle-evidence.js';
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
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, input.publishedUal,
    { assertionVersion: input.assertionVersion, merkleRoot: getBytes(input.merkleRoot) },
    { publisherPeerId: 'test-publisher', accessPolicy: 'allowList', allowedPeers: ['test-reader'] });
  const { materialization: _snapshot, ...legacy } = input;
  expect(await owner.submit(legacy)).toBe('repaired');
});

it('retains snapshot-less v2 recovery without exact controls, then denies private access after authenticated repair and durable reopen', async () => {
  const { owner, input, store, graph, path, journal, chain } = await fixture(true, '2');
  const meta = contextGraphMetaUri(input.contextGraphId), dkg = 'http://dkg.io/ontology/';
  const visible = input.materialization!.metadataQuads.filter(q => q.predicate !== dkg + 'allowedPeer')
    .map(q => q.predicate === dkg + 'accessPolicy' ? { ...q, object: '"public"' } : q);
  await store.insert([{ subject: `did:dkg:context-graph:${input.contextGraphId}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph', graph: meta },
    ...visible, ...input.materialization!.publicQuads.map(q => ({ ...q, graph }))]);
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, input.publishedUal,
    { assertionVersion: '1', merkleRoot: getBytes(input.merkleRoot) },
    { publisherPeerId: 'old-owner', accessPolicy: 'public', allowedPeers: [] });
  const { materialization: _snapshot, ...legacy } = input;
  expect(await owner.submit(legacy)).toBe('pending'); expect(await journal()).toHaveLength(1);
  await owner.stop(); await store.close();
  const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
  let now = 10_000;
  const retry = new NamedKaVmLifecycleRepair({ dataDir: dirname(path), now: () => now, warn: () => {},
    ...confirmedLifecycleExecutionCapabilities({ store: reopened, chain, dataDir: dirname(path), writeLocks: new Map(), readTimeoutMs: 1000 }) });
  cleanups.push(() => retry.stop()); await retry.runDue(); expect(await journal()).toHaveLength(1);
  expect(await reopened.query(`ASK { GRAPH <${meta}> { <${assertionLifecycleUri(input.contextGraphId, input.agentAddress, input.name)}> <${dkg}vmCurrentAssertion> ?root } }`)).toMatchObject({ value: false });
  // Independent receiver-authenticated evidence supplies exact v2 ownership; no publication occurs.
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(reopened, input.publishedUal,
    { assertionVersion: '2', merkleRoot: getBytes(input.merkleRoot) },
    { publisherPeerId: 'current-owner', accessPolicy: 'ownerOnly', allowedPeers: [] });
  now = 20_000; await retry.runDue(); expect(await journal()).toHaveLength(0);
  const durable = new OxigraphStore(path); cleanups.push(() => durable.close());
  expect(await durable.query(`ASK { GRAPH <${meta}> { <${input.publishedUal}> <${dkg}accessPolicy> "ownerOnly"; <${dkg}publisherPeerId> "current-owner" } }`)).toMatchObject({ value: true });
  const handler = new AccessHandler(durable, new TypedEventBus());
  const response = decodeAccessResponse(await handler.handler(encodeAccessRequest({ kaUal: input.publishedUal,
    requesterPeerId: 'unauthorized-peer', paymentProof: new Uint8Array(), requesterSignature: new Uint8Array() }),
    { toString: () => 'unauthorized-peer' } as Parameters<typeof handler.handler>[1]));
  expect(response.granted).toBe(false); expect(response.rejectionReason).toBe('Access denied: owner-only policy');
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
  const normalize = vi.spyOn(evidence, 'normalizeLifecycleRepairInput');
  for (let attempt = 3; attempt < 6; attempt += 1) {
    decoded.get(lifecycleRepairKey(unrelated))!.attempts = attempt;
    const wire = encodeLifecycleRepairJournal(decoded);
    expect(wire.entries[0]![1].input.materialization!.publicQuads).toBe([...decoded.values()][0]!.input.materialization!.publicQuads);
    JSON.stringify(wire);
  }
  expect(normalize).not.toHaveBeenCalled();
});

it('reconciles visible policy for matching v2 content and preserves receipt provenance before durable retirement', async () => {
  const { owner, input: source, store, path, graph, journal } = await fixture(true, '2');
  const input = { ...source, materialization: { ...source.materialization!, metadataQuads: source.materialization!.metadataQuads
    .filter(q => q.predicate !== 'http://dkg.io/ontology/allowedPeer')
    .map(q => q.predicate === 'http://dkg.io/ontology/accessPolicy' ? { ...q, object: '"ownerOnly"' } : q) } };
  const meta = contextGraphMetaUri(input.contextGraphId), receipt = '0x' + 'ef'.repeat(32);
  const inherited = input.materialization.metadataQuads.map(q => q.predicate === 'http://dkg.io/ontology/accessPolicy'
    ? { ...q, object: '"public"' } : q.predicate === 'http://dkg.io/ontology/transactionHash' ? { ...q, object: JSON.stringify(receipt) } : q);
  await store.insert([{ subject: `did:dkg:context-graph:${input.contextGraphId}`, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'https://dkg.network/ontology#ContextGraph', graph: meta },
    ...inherited, ...input.materialization.publicQuads.map(q => ({ ...q, graph })),
    { subject: input.publishedUal, predicate: 'urn:receipt-note', object: '"preserve"', graph: meta }]);
  await replaceLocallyTrustedKnowledgeAssetControlEnvelope(store, input.publishedUal,
    { assertionVersion: '1', merkleRoot: getBytes(input.merkleRoot) },
    { publisherPeerId: 'old-publisher', accessPolicy: 'public', allowedPeers: [] });
  expect(await owner.submit(input)).toBe('repaired'); expect(await journal()).toHaveLength(0);
  const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
  expect(await reopened.query(`ASK { GRAPH <${meta}> { <${input.publishedUal}> <http://dkg.io/ontology/accessPolicy> "ownerOnly"; <http://dkg.io/ontology/transactionHash> "${receipt}"; <urn:receipt-note> "preserve" } }`)).toMatchObject({ value: true });
  const handler = new AccessHandler(reopened, new TypedEventBus());
  const response = decodeAccessResponse(await handler.handler(encodeAccessRequest({ kaUal: input.publishedUal,
    requesterPeerId: 'unauthorized-peer', paymentProof: new Uint8Array(), requesterSignature: new Uint8Array() }),
    { toString: () => 'unauthorized-peer' } as Parameters<typeof handler.handler>[1]));
  expect(response.granted).toBe(false); expect(response.rejectionReason).toBe('Access denied: owner-only policy');
});

it.each(['publicTripleCount', 'privateTripleCount', 'privateMerkleRoot', 'batchId', 'subGraphName', 'kaUal', 'transactionHash'])(
  'repairs conflicting immutable %s while preserving receipt provenance, then resolves after durable reopen', async field => {
    const { owner, input, store, path, graph, journal } = await fixture(true);
    const dkg = 'http://dkg.io/ontology/', meta = contextGraphMetaUri(input.contextGraphId), receipt = '0x' + 'ef'.repeat(32);
    const corrupt = field === 'privateMerkleRoot' ? JSON.stringify('cd'.repeat(32))
      : field === 'subGraphName' ? '"wrong-subgraph"' : field === 'kaUal' ? 'urn:wrong-ka' : '"99"^^<http://www.w3.org/2001/XMLSchema#integer>';
    await store.insert([...input.materialization!.metadataQuads.filter(q => q.predicate !== dkg + field)
      .map(q => q.predicate === dkg + 'transactionHash' ? { ...q, object: JSON.stringify(receipt) }
        : field === 'publicTripleCount' && q.predicate === dkg + 'merkleRoot' ? { ...q, object: JSON.stringify('0x' + input.merkleRoot.replace(/^0x/, '').toUpperCase()) } : q),
      { subject: input.materialization!.kaUal, predicate: dkg + field, object: corrupt, graph: meta },
      { subject: input.materialization!.kaUal, predicate: 'urn:receipt-note', object: '"preserve"', graph: meta },
      ...input.materialization!.publicQuads.map(q => ({ ...q, graph }))]);
    const resolve = (target: OxigraphStore) => resolveConfirmedGraphScopedVm(target, { contextGraphId: input.contextGraphId,
      ual: input.materialization!.kaUal, merkleRoot: getBytes(input.merkleRoot), kaId: input.packedKaId,
      batchId: input.packedKaId, assertionVersion: BigInt(input.assertionVersion) });
    if (field !== 'privateTripleCount') expect(await resolve(store)).toMatchObject({ status: 'invalid' });
    expect(await owner.submit(input)).toBe('repaired'); expect(await journal()).toHaveLength(0);
    const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
    expect(await resolve(reopened)).toMatchObject({ status: 'verified', envelope: { publicTripleCount: 1, privateTripleCount: 2, batchId: input.packedKaId } });
    expect(await reopened.query(`ASK { GRAPH <${meta}> { <${input.materialization!.kaUal}> <${dkg}transactionHash> "${field === 'transactionHash' ? '0x' + '34'.repeat(32) : receipt}"; <urn:receipt-note> "preserve" } }`)).toMatchObject({ value: true });
  });
it('validates admission once and executes the same frozen proof through retries and journal round-trips', async () => {
  const { owner, input, store, advance } = await fixture(true);
  const apply = vi.spyOn(materialization, 'applyMaterializedConfirmedLifecycle');
  const normalize = vi.spyOn(evidence, 'normalizeLifecycleRepairInput');
  const capture = store.commitment!.capture.bind(store.commitment);
  vi.spyOn(store.commitment!, 'capture').mockImplementationOnce(() => async () => { throw new Error('retry'); }).mockImplementation(capture);
  expect(await owner.submit(input)).toBe('pending');
  const command = apply.mock.calls[0]![1], model = command.materialization!;
  expect(Object.isFrozen(command)).toBe(true); expect(Object.isFrozen(model.proof)).toBe(true);
  advance(); await owner.runDue();
  expect(apply).toHaveBeenCalledTimes(2); expect(apply.mock.calls[1]![1].materialization).toBe(model);
  expect(normalize).toHaveBeenCalledOnce();
  const entries = new Map([[lifecycleRepairKey(command), { input: command, attempts: 0, nextAttemptAt: 0 }]]);
  const decoded = decodeLifecycleRepairJournal(JSON.parse(JSON.stringify(encodeLifecycleRepairJournal(entries))));
  const reopened = [...decoded.values()][0]!.input;
  expect(reopened.materialization).toEqual(model); expect(reopened.materialization).not.toBe(model);
  expect(Object.isFrozen(reopened.materialization)).toBe(true);
  const wire = lifecycleMaterializationWire(model);
  expect(wire).not.toHaveProperty('proof'); expect(wire.publicQuads).toBe(model.publicQuads);
  expect(() => normalizeLifecycleRepairInput({ ...command, materialization: { ...wire, publicQuads: [] } })).toThrow('public recovery snapshot');
  for (const changed of [{ merkleRoot: 'ab'.repeat(32) }, { packedKaId: command.packedKaId + 1n },
    { assertionVersion: '2' }, { contextGraphId: 'another-graph' }, { subGraphName: 'another-subgraph' }]) {
    expect(() => normalizeLifecycleRepairInput({ ...command, ...changed })).toThrow();
  }
});

it('restores admitted receipt provenance over exact receiptless content before durable retirement', async () => {
  const { owner, input, store, path, graph, journal } = await fixture(true);
  const dkg = 'http://dkg.io/ontology/', meta = contextGraphMetaUri(input.contextGraphId);
  const receiptless = input.materialization!.metadataQuads.filter(q => q.predicate !== dkg + 'transactionHash')
    .map(q => q.predicate === dkg + 'confirmationKind' ? { ...q, object: '"finalized-materialization"' } : q);
  await store.insert([...receiptless, ...input.materialization!.publicQuads.map(q => ({ ...q, graph })),
    { subject: input.publishedUal, predicate: 'urn:receipt-note', object: '"preserve"', graph: meta }]);
  expect(await owner.submit(input)).toBe('repaired'); expect(await journal()).toHaveLength(0);
  const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
  const resolved = await resolveConfirmedGraphScopedVm(reopened, { contextGraphId: input.contextGraphId,
    ual: input.materialization!.kaUal, merkleRoot: getBytes(input.merkleRoot), kaId: input.packedKaId,
    batchId: input.packedKaId, assertionVersion: BigInt(input.assertionVersion) });
  expect(resolved).toMatchObject({ status: 'verified', envelope: { transactionHash: '0x' + '34'.repeat(32) } });
  if (resolved.status !== 'verified') throw new Error('verified materialization required');
  const resolveReceipt = vi.fn(async () => ({ status: 'confirmed', receipt: {
    txHash: '0x' + '34'.repeat(32), blockNumber: 12, blockHash: '0x' + '56'.repeat(32), txIndex: 3,
    merkleRoot: getBytes(input.merkleRoot), publisherAddress: input.agentAddress,
    kaId: input.packedKaId, batchId: input.packedKaId, startKAId: input.packedKaId, endKAId: input.packedKaId,
  } }));
  const recovered = await recoverReceiptBackedGraphScopedEvidence({ store: reopened,
    chain: { chainId: 'mock:31337', getMerkleRootCount: async () => 1n,
      resolveCanonicalFinalizationReceipt: resolveReceipt } as unknown as ChainAdapter,
    contextGraphId: input.contextGraphId, scope: { ual: input.publishedUal, assertionVersion: '1' },
    head: { kaUal: input.publishedUal, assertionVersion: '1', publicQuadsDigest: resolved.publicQuadsDigest,
      publicTripleCount: resolved.envelope.publicTripleCount, privateTripleCount: resolved.envelope.privateTripleCount,
      privateMerkleRoot: resolved.envelope.privateMerkleRoot && hexlify(resolved.envelope.privateMerkleRoot) }, merkleRoot: getBytes(input.merkleRoot),
    publisherAddress: input.agentAddress, kaId: input.packedKaId, batchId: input.packedKaId, onChainContextGraphId: 1n });
  expect(recovered).toMatchObject({ status: 'recovered', evidence: { transactionHash: '0x' + '34'.repeat(32) } });
  expect(resolveReceipt).toHaveBeenCalledExactlyOnceWith('0x' + '34'.repeat(32));
  expect(await reopened.query(`ASK { GRAPH <${meta}> { <${input.publishedUal}> <${dkg}confirmationKind> "transaction"; <urn:receipt-note> "preserve"; <${dkg}accessPolicy> "allowList" } }`)).toMatchObject({ value: true });
});

it('propagates exact-content store failures without replacing or retiring evidence', async () => {
  const { owner, input, store, journal, advance } = await fixture();
  const query = store.query.bind(store), update = vi.spyOn(store, 'atomicUpdate');
  const fault = vi.spyOn(store, 'query').mockImplementation(async (sparql, options) => {
    if (options?.source === 'agent.publish.confirmedLifecyclePayload') throw new Error('payload store unavailable');
    return query(sparql, options);
  });
  expect(await owner.submit(input)).toBe('pending'); expect(await journal()).toHaveLength(1);
  expect(update).not.toHaveBeenCalled(); fault.mockRestore(); advance(); await owner.runDue();
  expect(await journal()).toHaveLength(0);
});

it.each(['missing', 'duplicate', 'malformed', 'different'])(
  'does not preserve a receipt with a %s stored root despite otherwise matching coordinates', async kind => {
    const { owner, input, store, path, graph } = await fixture(true);
    const dkg = 'http://dkg.io/ontology/', meta = contextGraphMetaUri(input.contextGraphId);
    const rows = input.materialization!.metadataQuads.filter(q => q.predicate !== dkg + 'merkleRoot')
      .map(q => q.predicate === dkg + 'transactionHash' ? { ...q, object: JSON.stringify('0x' + 'ef'.repeat(32)) } : q);
    const row = (object: string) => ({ subject: input.publishedUal, predicate: dkg + 'merkleRoot', object, graph: meta });
    if (kind !== 'missing') rows.push(row(JSON.stringify(kind === 'malformed' ? 'invalid' : 'ab'.repeat(32))));
    if (kind === 'duplicate') rows.push(row(JSON.stringify(input.merkleRoot)));
    await store.insert([...rows, ...input.materialization!.publicQuads.map(q => ({ ...q, graph }))]);
    expect(await owner.submit(input)).toBe('repaired');
    const reopened = new OxigraphStore(path); cleanups.push(() => reopened.close());
    expect(await readConfirmedGraphKnowledgeAssetMetadataEnvelope(reopened, { contextGraphId: input.contextGraphId,
      ual: input.publishedUal })).toMatchObject({ state: 'confirmed', envelope: { transactionHash: '0x' + '34'.repeat(32) } });
  });
