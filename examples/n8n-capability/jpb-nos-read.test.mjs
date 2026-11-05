import test from 'node:test';
import assert from 'node:assert/strict';
import { readJpbThroughNos } from './profiles/jpb-nos-read.mjs';
test('nOS JPB reader preserves typed RDF dates and escaped record literals', async () => {
  const result = await readJpbThroughNos(async (_path, body) => {
    const ids = [...body.sparql.matchAll(/VALUES \?recordVersion \{ <([^>]+)>/g)].map(m => m[1]);
    assert.equal(ids.length, 3);
    return { result: { bindings: ids.map((recordVersion, i) => ({
      recordVersion, recordJson: JSON.stringify(JSON.stringify({ table: 'GAMME', source: { organisation: 'JPB' },
        fields: { COFRAIS: ['CUT', 'USILU', 'EBAVM'][i], NAF: '62633', GA_DES: 'A "quoted" operation' } })) + '^^<http://www.w3.org/2001/XMLSchema#string>',
      logicalRecord: 'urn:test:record:' + i, snapshot: 'urn:test:snapshot', sourceEvidence: 'urn:test:evidence',
      evidenceCapturedAt: '"2026-10-18T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
    })) } };
  }, { orderNo: '62633' });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].operation, 'A "quoted" operation');
  assert.equal(result.records[0].evidence.capturedAt, '2026-10-18T00:00:00.000Z');
  assert.equal(result.source.freshSqlFetch, false);
});
