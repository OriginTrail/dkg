import test from 'node:test';
import assert from 'node:assert/strict';
import { readJpbThroughNos } from './profiles/jpb-nos-read.mjs';

for (const representation of ['bare-iris', 'rdf-terms', 'binding-objects', 'rdf-unicode', 'language-literals', 'null-date']) test(`nOS JPB reader decodes typed dates, escaped records and IRI columns (${representation})`, async () => {
  let ids;
  const iri = value => representation === 'binding-objects' ? { type: 'uri', value } : representation === 'bare-iris' ? value : `<${value}>`;
  const literal = (value, datatype) => {
    if (representation === 'binding-objects') return { type: 'literal', value, datatype };
    const text = JSON.stringify(value);
    if (representation === 'rdf-unicode') return text.replaceAll('🙂', '\\U0001F642').replaceAll('ž', '\\u017E') + `^^<${datatype}>`;
    return text + (representation === 'language-literals' ? '@en' : `^^<${datatype}>`);
  };
  const result = await readJpbThroughNos(async (_path, body) => {
    ids = [...body.sparql.matchAll(/VALUES \?recordVersion \{ <([^>]+)>/g)].map(m => m[1]);
    assert.equal(ids.length, 3);
    return { result: { bindings: ids.map((recordVersion, i) => ({
      recordVersion: iri(recordVersion), recordJson: literal(JSON.stringify({ table: 'GAMME', source: { organisation: 'JPB' },
        fields: { COFRAIS: ['CUT', 'USILU', 'EBAVM'][i], NAF: '62633', GA_DES: 'A "quoted" operation\nwith \\ and ž 🙂' } }), 'http://www.w3.org/2001/XMLSchema#string'),
      logicalRecord: iri('urn:test:record:' + i), snapshot: iri('urn:test:snapshot'), sourceEvidence: iri('urn:test:evidence'),
      evidenceCapturedAt: representation === 'null-date' ? null : literal('2026-10-18T00:00:00.000Z', 'http://www.w3.org/2001/XMLSchema#dateTime'),
    })) } };
  }, { orderNo: '62633' });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].operation, 'A "quoted" operation\nwith \\ and ž 🙂');
  assert.equal(result.records[0].recordId, ids[0]);
  assert.equal(result.records[0].logicalId, 'urn:test:record:0');
  assert.equal(result.records[0].evidence.snapshot, 'urn:test:snapshot');
  assert.equal(result.records[0].evidence.sourceEvidence, 'urn:test:evidence');
  assert.equal(result.records[0].evidence.capturedAt, representation === 'null-date' ? null : '2026-10-18T00:00:00.000Z');
  assert.equal(result.source.freshSqlFetch, false);
});
