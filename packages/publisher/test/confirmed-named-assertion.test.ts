import { afterEach, expect, it, vi } from 'vitest';
import { getBytes } from 'ethers';
import { canonicalGraphScopedAuthorSealFromAssertionSealV1, canonicalizeCanonicalGraphScopedAuthorSealV1, parseCanonicalGraphScopedAuthorSealV1, assertionLifecycleUri, contextGraphAssertionUri,
  contextGraphMetaUri, createGraphKnowledgeAssetScope, knowledgeAssetLayerGraphUri, MemoryLayer } from '@origintrail-official/dkg-core';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { reconcileConfirmedNamedAssertion, assertConfirmedNamedAssertionSeal, confirmedNamedAssertionSealQuads } from '../src/confirmed-named-assertion.js';
import { assertionRecoverySealGraph, assertionRecoverySealSubject } from '../src/assertion-seal-recovery.js';

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
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(stores.splice(0).map(s => s.close())); });
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
  await reconcileConfirmedNamedAssertion(s, target, proof, source === 'admitted' ? seal : undefined);
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
  const s = store(); vi.spyOn(s, 'query').mockResolvedValueOnce({ type: 'bindings', bindings: [] });
  const insert = vi.spyOn(s, 'insert');
  await expect(reconcileConfirmedNamedAssertion(s, target, proof, seal)).rejects.toThrow('evidence read unavailable');
  expect(insert).not.toHaveBeenCalled();
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
