import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRestartMetadata, unchangedCohortMetadata, bindingMatchesCapturedOperation } from './restart-metadata-proof.mjs';
import { faultEvidenceFixture } from './fault-evidence-fixture.mjs';
const { graph, subject, fault, rows } = faultEvidenceFixture();
const dkg = 'http://dkg.io/ontology/';
const row = (p, value, type = 'literal') => ({ g: { type: 'uri', value: graph }, s: { type: 'uri', value: subject },
  p: { type: 'uri', value: dkg + p }, o: { type, value } });
test('accepts complete original metadata in its authoritative graph', () => {
  assert.deepEqual(verifyRestartMetadata(fault, rows), { metadataGraph: graph, originalSealAndIntent: true, lifecycleComplete: true });
});
test('rejects relocation of otherwise identical metadata', () => {
  const result = verifyRestartMetadata(fault, rows.map(r => ({ ...r, g: { type: 'uri', value: 'urn:wrong-meta' } })));
  assert.equal(result.originalSealAndIntent, false); assert.equal(result.lifecycleComplete, false);
});
test('rejects lifecycle-only relocation even with original seal and intent intact', () => {
  const result = verifyRestartMetadata(fault, rows.map(r => ['state', 'memoryLayer', 'swmShareComplete', 'swmCurrentAssertion', 'assertionGraph'].some(p => r.p.value === dkg + p) ? { ...r, g: { type: 'uri', value: 'urn:wrong-meta' } } : r));
  assert.equal(result.originalSealAndIntent, true); assert.equal(result.lifecycleComplete, false);
});
test('rejects changed RDF metadata terms and duplicate lifecycle values', () => {
  const changed = rows.map(r => r.p.value === dkg + 'promoteOperationIntent' ? { ...r, o: { ...r.o, datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString', 'xml:lang': 'fr' } } : r);
  assert.equal(verifyRestartMetadata(fault, changed).originalSealAndIntent, false);
  assert.equal(verifyRestartMetadata(fault, [...rows, row('state', 'promoted')]).lifecycleComplete, false);
});

test('rejects a non-IRI metadata graph even with the same lexical graph name', () => {
  const result = verifyRestartMetadata(fault, rows.map(r => ({ ...r, g: { type: 'bnode', value: graph } })));
  assert.equal(result.originalSealAndIntent, false); assert.equal(result.lifecycleComplete, false);
});

test('preserves the earlier cohort while allowing the additional crash asset', () => {
  const old = [row('shareOperationId', 'original'), { ...row('state', 'promoted'), s: { type: 'uri', value: 'urn:second-asset' } }];
  const subjects = [subject, 'urn:second-asset'];
  assert.equal(unchangedCohortMetadata(old, [...old, { ...row('state', 'promoted'), s: { type: 'uri', value: 'urn:new-asset' } }], graph, subjects), true);
  assert.equal(unchangedCohortMetadata(old, old.slice(0, 1), graph, subjects), false);
  assert.equal(unchangedCohortMetadata(old, old.map(r => ({ ...r, g: { type: 'uri', value: 'urn:wrong' } })), graph, subjects), false);
  assert.equal(unchangedCohortMetadata(old, old.map(r => ({ ...r, o: { ...r.o, datatype: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString', 'xml:lang': 'fr' } })), graph, subjects), false);
});

test('incomplete original capture cannot certify restart identity', () => {
  for (const missing of ['all', 'promoteOperationIntent', 'shareOperationId', 'authorAttestationR']) {
    const partial = structuredClone(fault);
    partial.metadataAtFault.quads = missing === 'all' ? [] : partial.metadataAtFault.quads.filter(q => q.predicate !== dkg + missing);
    assert.equal(verifyRestartMetadata(partial, rows).originalSealAndIntent, false);
  }
});

test('restart queue binding must match the complete captured operation', () => {
  const intent = JSON.parse(JSON.parse(fault.metadataAtFault.quads.find(q => q.predicate === dkg + 'promoteOperationIntent').object));
  const binding = { version: 1, sealDigest: '0x' + 'ab'.repeat(32), inventoryRequired: true, intent };
  assert.equal(bindingMatchesCapturedOperation(fault, binding), true);
  for (const change of [{ operationId: 'replacement' }, { timestampMs: 2 }, { confirmationRequired: true },
    { accessPolicy: 'ownerOnly' }, { allowedPeers: ['different'] }, { publisherPeerId: 'different' }]) {
    assert.equal(bindingMatchesCapturedOperation(fault, { ...binding, intent: { ...intent, ...change } }), false);
  }
  assert.equal(bindingMatchesCapturedOperation(fault, undefined), false);
  const incomplete = structuredClone(fault);
  incomplete.metadataAtFault.quads = incomplete.metadataAtFault.quads.filter(q => q.predicate !== dkg + 'shareOperationId');
  assert.equal(bindingMatchesCapturedOperation(incomplete, binding), false);
});

test('restart lifecycle fields require IRI subjects and predicates', () => {
  const fields = new Set(['state', 'memoryLayer', 'swmShareComplete', 'swmCurrentAssertion', 'assertionGraph'].map(p => dkg + p));
  for (const term of ['s', 'p']) {
    const changed = rows.map(r => fields.has(r.p.value) ? { ...r, [term]: { ...r[term], type: 'bnode' } } : r);
    const proof = verifyRestartMetadata(fault, changed);
    assert.equal(proof.originalSealAndIntent, true); assert.equal(proof.lifecycleComplete, false);
  }
});

test('restart inventory must name the operation in the original validated recovery binding', async () => {
  const { verifyInventoryOperations } = await import('./inventory-operation-proof.mjs');
  const { inventoryScopeFixture } = await import('./inventory-scope-fixture.mjs');
  const { verifyInventoryScope } = await import('./inventory-scope.mjs');
  const campaign = { contextGraphId: 'restart-operation', author: '0x' + '11'.repeat(20) }, name = 'restart';
  const intent = JSON.parse(JSON.parse(fault.metadataAtFault.quads.find(q => q.predicate === dkg + 'promoteOperationIntent').object));
  const binding = { version: 1, sealDigest: '0x' + 'ab'.repeat(32), inventoryRequired: true, intent };
  const valid = bindingMatchesCapturedOperation(fault, binding); assert.equal(valid, true);
  const rdf = rows.map(r => ({ ...r, g: { type: 'uri', value: `did:dkg:context-graph:${campaign.contextGraphId}/_meta` },
    s: r.s.value === subject ? { type: 'uri', value: `urn:dkg:assertion:${campaign.contextGraphId}:${campaign.author}:${name}` } : r.s }));
  for (const operation of [intent.operationId, 'replacement-operation']) {
    const f = inventoryScopeFixture(campaign, [{ assertion_coordinate: name, share_operation_id: operation }], [{ assertionCoordinate: name }]);
    assert.equal(verifyInventoryScope(campaign, f.capture, f.catalogs, f.status).valid, true);
    const proof = verifyInventoryOperations(campaign, [name], f.capture.swm, rdf, [{ name, operationId: binding.intent.operationId, valid }]);
    assert.equal(proof.exact, operation === intent.operationId);
  }
});
