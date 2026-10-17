import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameCapturedTerm, capturedTermIdentity, bindingTermIdentity } from './rdf-term-identity.mjs';
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
