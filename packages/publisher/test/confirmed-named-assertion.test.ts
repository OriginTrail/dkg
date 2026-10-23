import { afterEach, expect, it, vi } from 'vitest';
import { getBytes } from 'ethers';
import { NoChainAdapter } from '@origintrail-official/dkg-chain';
import { canonicalGraphScopedAuthorSealFromAssertionSealV1, canonicalizeCanonicalGraphScopedAuthorSealV1, parseCanonicalGraphScopedAuthorSealV1, assertionLifecycleUri, contextGraphAssertionUri,
  contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer, TypedEventBus, generateEd25519Keypair } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { reconcileConfirmedNamedAssertion, assertConfirmedNamedAssertionSeal, confirmedNamedAssertionSealQuads } from '../src/confirmed-named-assertion.js';
import { assertionRecoverySealGraph, assertionRecoverySealSubject } from '../src/assertion-seal-recovery.js';
import { DKGPublisher } from '../src/dkg-publisher.js';
import { generateSubGraphRegistration } from '../src/metadata.js';
import { ASSERTION_RESERVATION_PREDICATES } from '../src/assertion-reservation.js';

const author = '0x1111111111111111111111111111111111111111', id = (BigInt(author) << 96n) | 1n;
const target = { contextGraphId: 'confirmed-reconcile', agentAddress: author, name: 'asset', packedKaId: id,
  assertionVersion: '1', merkleRoot: '12'.repeat(32), publicationDeployment: { chainId: '31337', lifecycleAddress: author },
  kaUal: `did:dkg:mock:31337/${author}/1` };
const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1({ merkleRoot: getBytes(`0x${target.merkleRoot}`), authorAddress: author,
  authorAttestationR: getBytes(`0x${'34'.repeat(32)}`), authorAttestationVS: getBytes(`0x${'56'.repeat(32)}`), authorSchemeVersion: 1,
  chainId: 31337n, kav10Address: author, reservedKaId: id, finalizedAtIso: '2026-01-01T00:00:00.000Z',
  contentScopeVersion: 2, kaUal: target.kaUal, assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0 });
const proof = { assertionVersion: '1', publicTripleCount: 1, privateTripleCount: 0, merkleRoot: target.merkleRoot, batchId: id.toString(),
  assertionGraph: knowledgeAssetLayerGraphUri(target.contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(target.kaUal, '1')) };
const meta = contextGraphMetaUri(target.contextGraphId), active = contextGraphAssertionUri(target.contextGraphId, author, target.name);
const archiveGraph = assertionRecoverySealGraph(target.contextGraphId), archive = assertionRecoverySealSubject(target.contextGraphId, target.name, author);
const lifecycle = assertionLifecycleUri(target.contextGraphId, author, target.name), stores: OxigraphStore[] = [];
const store = () => { const value = new OxigraphStore(); stores.push(value); return value; };
const publisher = async (s: OxigraphStore) => new DKGPublisher({ store: s, chain: new NoChainAdapter(),
  eventBus: new TypedEventBus(), keypair: await generateEd25519Keypair() });
const claim = (p: DKGPublisher, name: string, subGraphName?: string) => p.assertionCreate(target.contextGraphId, name, author, subGraphName,
  { expectedKaNumber: 1n, allocateKaNumber: async () => ({ number: 1n, reservedUal: target.kaUal }) });
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(s => s.close())); });
it.each([undefined, 'scope'])('restores the same stable reservation normal creation writes while preserving the newer draft in scope %s', async subGraphName => {
  const s = store(), p = await publisher(s), peer = 'peer-owner';
  if (subGraphName) await s.insert(generateSubGraphRegistration({ contextGraphId: target.contextGraphId, subGraphName,
    createdBy: author, timestamp: new Date() }));
  await p.assertionCreate(target.contextGraphId, target.name, peer, subGraphName,
    { allocateKaNumber: async () => ({ number: 1n, reservedUal: target.kaUal }) });
  await p.assertionWrite(target.contextGraphId, target.name, peer,
    [{ subject: 'urn:newer', predicate: 'urn:value', object: '"keep draft"' }], subGraphName);
  const own = assertionLifecycleUri(target.contextGraphId, peer, target.name, subGraphName);
  await s.insert([{ subject: own, graph: meta, predicate: 'http://dkg.io/ontology/assertionVersion',
    object: '"2"^^<http://www.w3.org/2001/XMLSchema#integer>' }]);
  const read = () => s.query(`SELECT ?p ?o WHERE { GRAPH <${meta}> { <${own}> ?p ?o } } ORDER BY ?p ?o`);
  const before = await read(); expect(before.type).toBe('bindings');
  const stable = new Set<string>(Object.values(ASSERTION_RESERVATION_PREDICATES));
  for (const predicate of stable) await s.deleteByPattern({ graph: meta, subject: own, predicate });
  await reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: peer, subGraphName }, { ...proof,
    assertionGraph: knowledgeAssetLayerGraphUri(target.contextGraphId, MemoryLayer.VerifiableMemory,
      createGraphKnowledgeAssetScope(target.kaUal, '1'), subGraphName) }, seal);
  const after = await read(); expect(after.type).toBe('bindings');
  if (before.type !== 'bindings' || after.type !== 'bindings') throw new Error('bindings required');
  expect(after.bindings.filter(row => stable.has(row.p!))).toEqual(before.bindings.filter(row => stable.has(row.p!)));
  expect(after.bindings.filter(row => !stable.has(row.p!))).toEqual(before.bindings.filter(row => !stable.has(row.p!)));
  expect((await p.assertionQuery(target.contextGraphId, target.name, peer, subGraphName)).map(q => q.object)).toEqual(['"keep draft"']);
});
it.each(['assertionVersion','batchId','merkleRoot','publicTripleCount','privateTripleCount','privateMerkleRoot','assertionGraph'])(
  'rejects a conflicting materialization %s', field => {
    const wrong = { ...proof, [field]: field.endsWith('Count') ? 2 : 'different' };
    expect(() => assertConfirmedNamedAssertionSeal(seal, target, wrong)).toThrow('Invalid confirmed');
  });
it.each(['assertionVersion','packedKaId','merkleRoot','kaUal','publicationDeployment'])(
  'rejects conflicting confirmed target %s', field => {
    const wrong = { ...target, [field]: field === 'packedKaId' ? id + 1n : field === 'publicationDeployment' ? { chainId: '1', lifecycleAddress: author } : 'different' };
    expect(() => assertConfirmedNamedAssertionSeal(seal, wrong, proof)).toThrow('Invalid confirmed');
  });
it.each(['admitted','active','archive'] as const)('restores identity using %s original evidence and makes repeat reconciliation idempotent', async source => {
  const s = store();
  if (source !== 'admitted') await s.insert(confirmedNamedAssertionSealQuads(seal, source === 'active' ? active : archive, source === 'active' ? meta : archiveGraph));
  const reads = vi.spyOn(s, 'query');
  await reconcileConfirmedNamedAssertion(s, target, proof, source === 'admitted' ? seal : undefined);
  expect(reads.mock.calls.filter(([, options]) => options?.source === 'agent.publish.confirmedNamedEvidence')).toHaveLength(1);
  expect(await s.query(`ASK { GRAPH <${meta}> { <${lifecycle}> <http://dkg.io/ontology/reservedUal> "${target.kaUal}" } }`)).toMatchObject({ value: true });
  const insert = vi.spyOn(s, 'insert'), update = vi.spyOn(s, 'replaceSubject');
  await reconcileConfirmedNamedAssertion(s, target, proof, seal);
  expect(insert).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
it('leaves missing or malformed original evidence pending', async () => {
  const s = store(); await s.insert([{ subject: active, graph: meta, predicate: 'http://dkg.io/ontology/authorAddress', object: '"torn"' }]);
  await expect(reconcileConfirmedNamedAssertion(s, target, proof)).rejects.toThrow('awaits its authenticated');
});
it('preserves a newer archive and active draft', async () => {
  const s = store(), newer = { ...seal, assertionVersion: '2' } as typeof seal;
  await s.insert([...confirmedNamedAssertionSealQuads(newer, archive, archiveGraph), { subject: active, graph: meta, predicate: 'urn:draft', object: '"keep"' }]);
  const update = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('newer archived seal');
  expect(update).not.toHaveBeenCalled(); expect(await s.query(`ASK { GRAPH <${meta}> { <${active}> <urn:draft> "keep" } }`)).toMatchObject({ value: true });
});
it('rejects surviving reservation conflicts', async () => {
  const s = store(); await s.insert([{ subject: lifecycle, graph: meta, predicate: 'http://dkg.io/ontology/kaId', object: '"2"' }]);
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('reservation conflicts');
});
it.each([
  ['http://dkg.io/ontology/reservedUal', JSON.stringify(target.kaUal.replace(/\/1$/, '/2'))],
  ['http://dkg.io/ontology/reservedUal', JSON.stringify(target.kaUal.replace('mock:31337', 'mock:31338'))],
  ['http://dkg.io/ontology/kaId', '"1garbage"'],
])('refuses genuinely conflicting reservation values before writing: %s %s', async (predicate, object) => {
  const s = store(); await s.insert([{ subject: lifecycle, graph: meta, predicate, object }]);
  const insert = vi.spyOn(s, 'insert'), replace = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('reservation conflicts');
  expect(insert).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});
it('requires atomic archive replacement and propagates executed failures', async () => {
  const s = store(); const update = vi.spyOn(s, 'replaceSubject').mockRejectedValueOnce(new Error('archive write failed'));
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('archive write failed');
  expect(update).toHaveBeenCalledOnce();
});

it('does not overwrite a malformed archive', async () => {
  const s = store(); await s.insert([{ subject: archive, graph: archiveGraph, predicate: 'http://dkg.io/ontology/authorAddress', object: '"torn"' }]);
  const replace = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow();
  expect(replace).not.toHaveBeenCalled();
});
it('refuses an unavailable archive replacement capability', async () => {
  const s = store(); Object.defineProperty(s, 'replaceSubject', { value: undefined });
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('requires atomic seal replacement');
});

it('propagates unavailable store reads before any writes', async () => {
  const s = store(), query = s.query.bind(s);
  vi.spyOn(s, 'query').mockImplementation((sparql, ...args) => args[0]?.source === 'agent.publish.confirmedNamedEvidence'
    ? Promise.resolve({ type: 'bindings', bindings: [] }) : query(sparql, ...args));
  const insert = vi.spyOn(s, 'insert');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('evidence read unavailable');
  expect(insert).not.toHaveBeenCalled();
});
it('refuses over-budget evidence before any reconciliation mutation', async () => {
  const s = store();
  await s.insert(Array.from({ length: 257 }, (_, i) => ({ subject: archive, graph: archiveGraph, predicate: `urn:extra:${i}`, object: '"retained"' })));
  const insert = vi.spyOn(s, 'insert'), replace = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('bounded row limit');
  expect(insert).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});
it('does not accept a stored seal from a different root or identity', async () => {
  const s = store();
  await s.insert(confirmedNamedAssertionSealQuads({ ...seal, assertionMerkleRoot: `0x${'99'.repeat(32)}` } as typeof seal, active, meta));
  await s.insert(confirmedNamedAssertionSealQuads({ ...seal, reservedKaId: (id + 1n).toString() } as typeof seal, archive, archiveGraph));
  await expect(reconcileConfirmedNamedAssertion(s, target, proof)).rejects.toThrow('awaits its authenticated');
});

it('recognizes the intact original seal independent of canonical model property order while preserving a newer archive', async () => {
  const s = store();
  const parsed = parseCanonicalGraphScopedAuthorSealV1(canonicalizeCanonicalGraphScopedAuthorSealV1(seal));
  expect(JSON.stringify(parsed)).not.toBe(JSON.stringify(seal));
  await s.insert([...confirmedNamedAssertionSealQuads(seal, active, meta),
    ...confirmedNamedAssertionSealQuads({ ...seal, assertionVersion: '2' } as typeof seal, archive, archiveGraph)]);
  const replace = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, parsed)).resolves.toBeUndefined();
  expect(replace).not.toHaveBeenCalled();
});

it.each([undefined, 'scope'])('restores a reservation that normal allocation protects in scope %s', async subGraphName => {
  const s = store(), p = await publisher(s);
  await s.insert(generateSubGraphRegistration({ contextGraphId: target.contextGraphId, subGraphName: 'scope', createdBy: author, timestamp: new Date() }));
  const scopedTarget = { ...target, subGraphName }, scopedProof = { ...proof, assertionGraph: knowledgeAssetLayerGraphUri(
    target.contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(target.kaUal, '1'), subGraphName) };
  await reconcileConfirmedNamedAssertion(s, scopedTarget, scopedProof, seal);
  const snapshot = await s.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o');
  await expect(claim(p, 'another-name', subGraphName)).rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  expect(await s.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } } ORDER BY ?g ?s ?p ?o')).toEqual(snapshot);
  await expect(claim(p, 'other-scope', subGraphName === undefined ? 'scope' : undefined)).resolves.toBeTypeOf('string');
});

it('refuses restoration before mutating a slot already claimed by another name', async () => {
  const s = store(), p = await publisher(s); await claim(p, 'existing-owner');
  const insert = vi.spyOn(s, 'insert'), replace = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  expect(insert).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});

it.each([
  ['http://www.w3.org/ns/prov#wasAttributedTo', 'did:dkg:agent:0x2222222222222222222222222222222222222222'],
  ['http://dkg.io/ontology/subGraphName', '"wrong-scope"'],
])('refuses conflicting surviving ownership field %s', async (predicate, object) => {
  const s = store(); await s.insert([{ subject: lifecycle, graph: meta, predicate, object }]);
  const insert = vi.spyOn(s, 'insert');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('reservation conflicts');
  expect(insert).not.toHaveBeenCalled();
});

it('shares the normal allocation lock while restoring a reservation', async () => {
  const s = store(), p = await publisher(s);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const insert = s.insert.bind(s);
  vi.spyOn(s, 'insert').mockImplementation(async rows => {
    if (rows.some(q => q.subject === lifecycle && q.predicate === 'http://dkg.io/ontology/kaId')) { enter(); await held; }
    return insert(rows);
  });
  const repair = reconcileConfirmedNamedAssertion(s, target, proof, seal); await entered;
  let settled = false;
  const competing = claim(p, 'racing-name').then(() => 'unexpected-success', error => error.code).finally(() => { settled = true; });
  try { await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false); }
  finally { release(); await repair; }
  expect(await competing).toBe('KA_SLOT_ALREADY_CLAIMED');
});

it('restores a peer-owned KA without confusing a different wallet at the same number', async () => {
  const s = store(), p = await publisher(s), peer = 'peer-owner', otherWallet = `0x${'22'.repeat(20)}`;
  await p.assertionCreate(target.contextGraphId, 'other-wallet', peer, undefined, {
    allocateKaNumber: async () => ({ number: 1n, reservedUal: `did:dkg:mock:31337/${otherWallet}/1` }),
  });
  await expect(reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: peer }, proof, seal)).resolves.toBeUndefined();
  const subject = assertionLifecycleUri(target.contextGraphId, peer, target.name);
  expect(await s.query(`ASK { GRAPH <${meta}> { <${subject}> <http://www.w3.org/ns/prov#wasAttributedTo> <did:dkg:agent:${peer}>;
    <http://dkg.io/ontology/reservedUal> "${target.kaUal}" } }`)).toMatchObject({ value: true });
  await expect(p.assertionCreate(target.contextGraphId, 'same-wallet', 'different-peer', undefined, {
    allocateKaNumber: async () => ({ number: 1n, reservedUal: target.kaUal }),
  })).rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
});

it('refuses another peer owner already reserving the actual sealed wallet/number', async () => {
  const s = store(), p = await publisher(s);
  await p.assertionCreate(target.contextGraphId, 'existing-peer', 'peer-one', undefined, {
    allocateKaNumber: async () => ({ number: 1n, reservedUal: target.kaUal }),
  });
  const insert = vi.spyOn(s, 'insert'), replace = vi.spyOn(s, 'replaceSubject');
  await expect(reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: 'peer-two' }, proof, seal))
    .rejects.toMatchObject({ code: 'KA_SLOT_ALREADY_CLAIMED' });
  expect(insert).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
});

it('shares the physical wallet allocation lock between peer-owned recovery and normal creation', async () => {
  const s = store(), p = await publisher(s), peer = 'peer-owner';
  const subject = assertionLifecycleUri(target.contextGraphId, peer, target.name);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const insert = s.insert.bind(s);
  vi.spyOn(s, 'insert').mockImplementation(async rows => {
    if (rows.some(q => q.subject === subject && q.predicate === 'http://dkg.io/ontology/kaId')) { enter(); await held; }
    return insert(rows);
  });
  const repair = reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: peer }, proof, seal); await entered;
  let settled = false;
  const competing = p.assertionCreate(target.contextGraphId, 'racing-peer', 'another-peer', undefined,
    { allocateKaNumber: async () => ({ number: 1n, reservedUal: target.kaUal }) })
    .then(() => 'unexpected-success', error => error.code).finally(() => { settled = true; });
  try { await new Promise(resolve => setTimeout(resolve, 20)); expect(settled).toBe(false); }
  finally { release(); await repair; }
  expect(await competing).toBe('KA_SLOT_ALREADY_CLAIMED');
});

it('preserves case-sensitive peer ownership while normalizing EVM owner casing', async () => {
  const s = store(), peer = 'PeerOwner';
  await s.insert([{ subject: assertionLifecycleUri(target.contextGraphId, peer, target.name), graph: meta,
    predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: 'did:dkg:agent:peerowner' }]);
  await expect(reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: peer }, proof, seal)).rejects.toThrow('reservation conflicts');
  const walletOwner = '0xa32f1cc125401b55911678847426759094055b2d';
  await s.insert([{ subject: assertionLifecycleUri(target.contextGraphId, walletOwner, target.name), graph: meta,
    predicate: 'http://www.w3.org/ns/prov#wasAttributedTo', object: `did:dkg:agent:${walletOwner.toUpperCase().replace('0X', '0x')}` }]);
  await expect(reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: walletOwner }, proof, seal)).resolves.toBeUndefined();
});

it('accepts the ordinary UAL aliases during confirmed restoration without changing their stored spelling', async () => {
  const s = store(), wallet = '0xa32f1cc125401b55911678847426759094055b2d', packed = (BigInt(wallet) << 96n) | 1n;
  const ual = `did:dkg:mock:31337/${wallet}/1`, peer = 'alias-owner';
  const aliased = ` \u00a0did:dkg:mock:31337/${wallet.toUpperCase().replace('0X', '0x')}/0001 \u00a0`;
  const own = assertionLifecycleUri(target.contextGraphId, peer, target.name);
  await s.insert([{ subject: own, graph: meta, predicate: 'http://dkg.io/ontology/kaId', object: '"1"' },
    { subject: own, graph: meta, predicate: 'http://dkg.io/ontology/reservedUal', object: JSON.stringify(aliased) }]);
  const rows = () => s.query(`SELECT ?ual WHERE { GRAPH <${meta}> { <${own}> <http://dkg.io/ontology/reservedUal> ?ual } }`);
  const before = await rows();
  await expect(reconcileConfirmedNamedAssertion(s, { ...target, agentAddress: peer, packedKaId: packed, kaUal: ual },
    { ...proof, batchId: packed.toString(), assertionGraph: knowledgeAssetLayerGraphUri(target.contextGraphId, MemoryLayer.VerifiableMemory, createGraphKnowledgeAssetScope(ual, '1')) },
    { ...seal, reservedKaId: packed.toString(), kaUal: ual, authorAddress: wallet } as typeof seal)).resolves.toBeUndefined();
  expect(await rows()).toEqual(before);
});
