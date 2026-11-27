import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { remoteScripts } from './jpb-output.mjs';
import { readJpbThroughNos } from './profiles/jpb-nos-read.mjs';

const script = fileURLToPath(new URL('./jpb-read.py', import.meta.url));
const harness = fileURLToPath(new URL('./test-support/run-jpb-read.py', import.meta.url));
const owner = '0xf77258a965ba13adc77bca85da7c6a287272959a';
const graph = owner + '/jpb-data';
const prefix = 'did:dkg:context-graph:' + graph + '/_working_memory/' + owner + '/';
const snapshot = 'urn:dmaast:jpb:trace:snapshot:6876805538656718c1b000b3b141edeccbef8465076ee8f81d4c7ac95d46591a';
const selected = [
  'urn:dmaast:jpb:trace:record:bf97e8ad8bb03b08c855013bfde5d8b4371f76458adfb1aef8da298f25e4bfda',
  'urn:dmaast:jpb:trace:record:cbf0c0755a087cc12b70234e7e9a8d3ea88d4bd75c822cf12de230962665ec2e',
  'urn:dmaast:jpb:trace:record:3789e86fc7cc194875b600483ee6930267f262959f5a36ebe8d94b3912ed7906',
];
const operations = ['CUT', 'USILU', 'EBAVM'];
const capturedAt = '2026-10-18T00:00:00.000Z';
const description = 'Ébavurer 🛠 "outil"\navec \\ et ž';
const peerId = '12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5';
const completePath = ['/api/status', '/api/query'];
const xsd = 'http://www.w3.org/2001/XMLSchema#';

function fixture(representation = 'binding-objects') {
  const iri = value => representation === 'binding-objects' ? { type: 'uri', value } : value;
  const literal = (value, datatype) => {
    if (representation === 'binding-objects') return { type: 'literal', value, datatype };
    const encoded = JSON.stringify(value);
    if (representation === 'plain-literals') return encoded;
    if (representation === 'escaped-unicode') return encoded.replaceAll('É', '\\u00c9').replaceAll('🛠', '\\ud83d\\udee0') + `^^<${datatype}>`;
    return encoded + (representation === 'language-literals' ? '@fr' : `^^<${datatype}>`);
  };
  const rows = selected.map((recordVersion, i) => ({ recordVersion: iri(recordVersion),
    recordJson: literal(JSON.stringify({ table: 'GAMME', source: { organisation: 'JPB' }, fields: {
      COFRAIS: operations[i], NAF: '62633', PARTNUMBER: 'fictional-part', PHASE: String(i + 1), GA_DES: description,
    } }), xsd + 'string'),
    logicalRecord: iri('urn:fixture:logical:' + i), snapshot: iri(snapshot), sourceEvidence: iri('urn:fixture:source'),
    evidenceCapturedAt: representation === 'null-date' ? null : literal(capturedAt, xsd + 'dateTime'),
  }));
  return { hostname: 'dmaast-mainnet-edge-2', payload: { orderNo: '62633' }, status: { peerId }, response: { result: { bindings: rows } } };
}
function run(value) {
  // Execute the exact production SSH bundle, including its trusted specification.
  const result = spawnSync('python3', [harness, script], { input: JSON.stringify({ ...value, readerSource: remoteScripts['jpb-read.py'] }), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function refused(result, paths = completePath, error = 'AssertionError') {
  assert.equal(result.ok, false, 'Untrusted rows must not be accepted as source evidence');
  assert.equal(result.error, error, result.message);
  assert.equal(result.printed, '', 'No accepted records may be printed on rejection');
  assert.equal(result.result, undefined);
  assert.deepEqual(result.calls.map(call => call.path), paths);
}
function editRecord(row, change) {
  const record = JSON.parse(row.recordJson.value); change(record); row.recordJson.value = JSON.stringify(record);
}

for (const representation of ['binding-objects', 'plain-literals', 'typed-literals', 'escaped-unicode', 'language-literals', 'null-date'])
  test(`actual SSH reader decodes the complete pinned selection (${representation})`, () => {
    const result = run(fixture(representation));
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.calls.map(call => call.path), completePath);
    assert.deepEqual(result.calls.map(call => call.method), ['GET', 'POST']);
    assert.ok(result.calls.every(call => call.authorized && call.timeout === 8));
    assert.deepEqual(result.reads, [2 * 1024 * 1024 + 1, 2 * 1024 * 1024 + 1]);
    const { sparql, ...scope } = result.calls[1].body;
    assert.deepEqual(scope, { contextGraphId: graph, view: 'working-memory', includeContextGraphPartitions: true });
    assert.deepEqual([...sparql.matchAll(/GRAPH <([^>]+)>/g)].map(m => m[1]), ['4085', '14902', '4081', '17347'].map(id => prefix + id));
    assert.deepEqual([...sparql.matchAll(/VALUES \?recordVersion \{ <([^>]+)> \}/g)].map(m => m[1]), selected);
    assert.deepEqual([...sparql.matchAll(/GRAPH <([^>]+)> \{ VALUES \?recordVersion \{ <([^>]+)> \}/g)].map(m => m.slice(1)),
      selected.map((id, i) => [prefix + ['4085', '14902', '4081'][i], id]));
    assert.ok(sparql.includes(`VALUES ?snapshot { <${snapshot}> }`));
    assert.match(sparql, /SELECT DISTINCT \?recordVersion \?recordJson \?logicalRecord \?snapshot \?sourceEvidence \?evidenceCapturedAt WHERE/);
    assert.match(sparql, /\?snapshot d:hasRecord \?recordVersion; d:supportedBy \?evidenceVersion/);
    assert.match(sparql, /\?evidenceVersion d:reference \?sourceEvidence; d:capturedAt \?evidenceCapturedAt/);
    assert.match(sparql, /LIMIT 4$/);
    const { source, records } = result.result;
    assert.match(source.responseSha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(source.readAt)));
    assert.deepEqual(source, { node: 'JPB', peerId, contextGraphId: graph, orderNo: '62633',
      querySha256: createHash('sha256').update(sparql).digest('hex'), readAt: source.readAt,
      responseSha256: source.responseSha256, freshSqlFetch: false, selection: 'pinned-snapshot', snapshot });
    assert.deepEqual(records, selected.map((recordId, i) => ({ operationCode: operations[i], recordId,
      logicalId: 'urn:fixture:logical:' + i, orderNo: '62633', partNumber: 'fictional-part', routePhase: String(i + 1), operation: description,
      evidence: { contextGraphId: graph, snapshot, sourceEvidence: 'urn:fixture:source',
        capturedAt: representation === 'null-date' ? null : capturedAt, responseSha256: source.responseSha256,
        readAt: source.readAt, selection: 'pinned-snapshot; not latest SQL state' }, meaning: 'planned-route-reference; not operation execution' })));
  });

test('actual SSH reader accepts a complete selection in a different response order', () => {
  const value = fixture(); value.response.result.bindings.reverse();
  const result = run(value); assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.result.records.map(row => row.recordId), [...selected].reverse());
});

test('SSH and nOS use the same query and normalized provenance for the shared selection', async () => {
  const normalize = result => ({
    records: result.records.map(({ evidence, ...record }) => {
      const { readAt: _time, responseSha256: _hash, ...provenance } = evidence;
      return { ...record, evidence: provenance };
    }),
    source: (({ readAt: _time, responseSha256: _hash, peerId: _peer, ...source }) => source)(result.source),
  });
  for (const representation of ['binding-objects', 'plain-literals', 'typed-literals', 'escaped-unicode', 'language-literals', 'null-date']) {
    const value = fixture(representation), ssh = run(value);
    assert.equal(ssh.ok, true, ssh.message);
    const nos = await readJpbThroughNos(async (path, body) => {
      assert.equal(path, 'query'); assert.deepEqual(body, ssh.calls[1].body);
      return value.response;
    }, value.payload);
    assert.deepEqual(normalize(nos), normalize(ssh.result), representation);
  }
});

test('actual SSH reader rejects duplicate bare record IRIs with distinct operations', () => {
  const value = fixture('plain-literals'), rows = value.response.result.bindings;
  rows[1].recordVersion = rows[0].recordVersion;
  refused(run(value));
});

for (const [name, change] of [
  ['foreign record', rows => { rows[0].recordVersion.value = 'urn:foreign:record'; }],
  ['missing record', rows => { rows.pop(); }],
  ['extra duplicate record', rows => { rows.push(structuredClone(rows[0])); }],
  ['duplicate identity with distinct operations', rows => { rows[1].recordVersion = structuredClone(rows[0].recordVersion); }],
  ['duplicate identity in different RDF representations', rows => { rows[1].recordVersion = rows[0].recordVersion.value; }],
  ['foreign table', rows => { editRecord(rows[0], r => { r.table = 'OTHER'; }); }],
  ['foreign order', rows => { editRecord(rows[0], r => { r.fields.NAF = '62634'; }); }],
  ['foreign organisation', rows => { editRecord(rows[0], r => { r.source.organisation = 'Other'; }); }],
  ['missing operation', rows => { editRecord(rows[0], r => { delete r.fields.COFRAIS; }); }],
  ['duplicate operation', rows => { editRecord(rows[0], r => { r.fields.COFRAIS = 'USILU'; }); }],
  ['foreign operation', rows => { editRecord(rows[0], r => { r.fields.COFRAIS = 'OTHER'; }); }],
]) test(`actual SSH reader rejects ${name} without returning evidence`, () => {
  const value = fixture(); change(value.response.result.bindings); refused(run(value));
});

for (const [name, change, paths] of [
  ['host', f => { f.hostname = 'another-host'; }, []],
  ['peer', f => { f.status.peerId = 'another-peer'; }, ['/api/status']],
  ['order request', f => { f.payload.orderNo = '62634'; }, []],
  ['extra request field', f => { f.payload.limit = 3; }, []],
  ['missing query result', f => { f.response = {}; }, completePath],
  ['non-array bindings', f => { f.response.result.bindings = {}; }, completePath],
]) test(`actual SSH reader refuses invalid ${name}`, () => {
  const value = fixture(); change(value); refused(run(value), paths);
});

test('actual SSH reader refuses malformed record JSON without returning evidence', () => {
  const value = fixture(); value.response.result.bindings[0].recordJson.value = '{malformed';
  refused(run(value), completePath, 'JSONDecodeError');
});

test('actual SSH reader refuses malformed RDF literals without returning evidence', () => {
  const value = fixture('typed-literals'); value.response.result.bindings[0].recordJson = '"unterminated';
  refused(run(value), completePath, 'JSONDecodeError');
});

test('actual SSH reader refuses unavailable query responses without returning evidence', () => {
  const value = fixture(); value.httpErrors = { '/api/query': 503 };
  refused(run(value), completePath, 'HTTPError');
});

test('actual SSH reader refuses oversized query responses without returning evidence', () => {
  const value = fixture(); value.oversizedPath = '/api/query';
  const result = run(value); refused(result); assert.match(result.message, /Response exceeds limit/);
});
