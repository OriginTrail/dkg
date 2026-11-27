import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameCapturedTerm, capturedTermIdentity, bindingTermIdentity, sameCapturedQuads } from './rdf-term-identity.mjs';
const literal = { type: 'literal', value: 'intent' };
for (const [name, before, after, expected] of [
  ['plain literal', '"intent"', literal, true],
  ['explicit string', '"intent"^^<http://www.w3.org/2001/XMLSchema#string>', literal, true],
  ['changed language', '"intent"', { ...literal, 'xml:lang': 'fr' }, false],
  ['changed datatype', '"intent"', { ...literal, datatype: 'urn:other' }, false],
  ['changed lexical value', '"intent"', { ...literal, value: 'different' }, false],
  ['literal to URI', '"intent"', { type: 'uri', value: 'intent' }, false],
  ['URI to literal', 'urn:identity', { type: 'literal', value: 'urn:identity' }, false],
  ['URI to blank node', 'urn:identity', { type: 'bnode', value: 'urn:identity' }, false],
  ['same language', '"intent"@FR', { ...literal, 'xml:lang': 'fr' }, true],
  ['changed typed lexical value', '"01"^^<urn:number>', { type: 'literal', value: '1', datatype: 'urn:number' }, false],
  ['escaped value', '"line\\n\\u00e9"', { type: 'literal', value: 'line\né' }, true],
]) test(name, () => assert.equal(sameCapturedTerm(before, after), expected));
test('rejects malformed and inconsistent evidence', () => {
  assert.throws(() => capturedTermIdentity('"bad'));
  assert.throws(() => bindingTermIdentity({ ...literal, 'xml:lang': 'fr', datatype: 'urn:other' }));
});
test('exact quad comparison preserves graph, cardinality and complete RDF terms', () => {
  const captured = [{ subject: 'urn:s', predicate: 'urn:p', object: '"value"@FR', graph: 'urn:g' }];
  const row = { s: { type: 'uri', value: 'urn:s' }, p: { type: 'uri', value: 'urn:p' },
    o: { type: 'literal', value: 'value', 'xml:lang': 'fr' }, g: { type: 'uri', value: 'urn:g' } };
  assert.equal(sameCapturedQuads(captured, [row]), true);
  assert.equal(sameCapturedQuads(captured, [row, row]), false);
  assert.equal(sameCapturedQuads(captured, [{ ...row, g: { type: 'uri', value: 'urn:other' } }]), false);
  assert.equal(sameCapturedQuads(captured, [{ ...row, o: { type: 'literal', value: 'value' } }]), false);
  assert.equal(sameCapturedQuads(captured, [{ ...row, s: { type: 'bnode', value: 'urn:s' } }]), false);
  const construct = [{ ...captured[0], graph: '' }];
  assert.throws(() => sameCapturedQuads(construct, [row]));
  assert.equal(sameCapturedQuads(construct, [row], 'urn:g'), true);
  assert.equal(sameCapturedQuads(construct, [row], 'urn:other'), false);
});
