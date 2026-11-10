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


for (const [invalid, change, message] of [
  ['foreign record', rows => { rows[0].recordVersion = 'urn:foreign:record'; }, /source scope/],
  ['foreign order', rows => { rows[0].record.fields.NAF = '62634'; }, /source scope/],
  ['foreign organization', rows => { rows[0].record.source.organisation = 'Other'; }, /source scope/],
  ['foreign table', rows => { rows[0].record.table = 'OTHER'; }, /source scope/],
  ['missing row', rows => rows.pop(), /missing, duplicated or truncated/],
  ['extra duplicate row', rows => rows.push(structuredClone(rows[0])), /missing, duplicated or truncated/],
  ['duplicate record with distinct operations', rows => { rows[1].recordVersion = rows[0].recordVersion; }, /missing, duplicated or truncated/],
  ['duplicate record as bracketed IRI', rows => { rows[1].recordVersion = `<${rows[0].recordVersion}>`; }, /missing, duplicated or truncated/],
  ['duplicate record as binding object', rows => { rows[1].recordVersion = { type: 'uri', value: rows[0].recordVersion }; }, /missing, duplicated or truncated/],
  ['missing operation', rows => { delete rows[0].record.fields.COFRAIS; }, /operation selection/],
  ['duplicate operation', rows => { rows[0].record.fields.COFRAIS = rows[1].record.fields.COFRAIS; }, /operation selection/],
  ['foreign operation', rows => { rows[0].record.fields.COFRAIS = 'OTHER'; }, /operation selection/],
]) test(`nOS JPB reader rejects ${invalid} before returning records`, async () => {
  let calls = 0;
  await assert.rejects(readJpbThroughNos(async (path, body) => {
    calls++;
    assert.equal(path, 'query');
    assert.equal(body.view, 'working-memory');
    const ids = [...body.sparql.matchAll(/VALUES \?recordVersion \{ <([^>]+)>/g)].map(m => m[1]);
    assert.equal(ids.length, 3);
    const rows = ids.map((recordVersion, i) => ({ recordVersion,
      record: { table: 'GAMME', source: { organisation: 'JPB' }, fields: { COFRAIS: ['CUT', 'USILU', 'EBAVM'][i], NAF: '62633' } },
      logicalRecord: 'urn:test:logical:' + i, snapshot: 'urn:test:snapshot', sourceEvidence: 'urn:test:evidence', evidenceCapturedAt: null }));
    change(rows);
    return { result: { bindings: rows.map(({ record, ...row }) => ({ ...row, recordJson: { type: 'literal', value: JSON.stringify(record) } })) } };
  }, { orderNo: '62633' }), message);
  assert.equal(calls, 1);
});
