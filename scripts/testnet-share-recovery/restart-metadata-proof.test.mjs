import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRestartMetadata, unchangedCohortMetadata } from './restart-metadata-proof.mjs';
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
