import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./jpb-write.py', import.meta.url));
const harness = fileURLToPath(new URL('./test-support/run-jpb-write.py', import.meta.url));
const graph = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study';
function evidence() {
  const content = JSON.stringify({ kind: 'fictional-input-evidence', operation: "Ébavurer 🛠 l'outil",
    path: 'C:\\route\\u0041\\U0001F6E0', quantity: null });
  const digest = createHash('sha256').update(content).digest('hex'), subject = 'urn:fixture:evidence:' + digest;
  return { name: 'offline evidence/' + digest, digest, allowCreate: false, quads: [
    { subject, predicate: 'urn:nos:workflow:payload', object: JSON.stringify(content) },
    { subject, predicate: 'urn:nos:workflow:sha256', object: JSON.stringify(digest) },
    { subject, predicate: 'http://www.w3.org/ns/prov#wasGeneratedBy', object: 'urn:fixture:execution' },
  ] };
}
function run(payload, scenario = {}) {
  const result = spawnSync('python3', [harness, script], { input: JSON.stringify({ payload, scenario }), encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const creates = result => result.calls.filter(call => call.method === 'POST');
function refused(result) {
  assert.equal(result.ok, false); assert.equal(result.printed, '');
  assert.deepEqual(creates(result), []);
}

test('actual SSH writer refuses creation when uncertain evidence is absent', () => {
  const result = run(evidence(), { exists: false });
  refused(result); assert.equal(result.error, 'RuntimeError'); assert.match(result.message, /reconcile/);
});

test('actual SSH writer reconciles matching sealed evidence without creating or publishing', () => {
  const payload = evidence(), result = run(payload, { readback: [...payload.quads].reverse() });
  assert.equal(result.ok, true, result.message); assert.deepEqual(creates(result), []);
  assert.deepEqual(result.receipt, { contextGraphId: graph, name: payload.name,
    peerId: '12D3KooWNaxdaVran5jSeMFVKzm1nBESdpnQfeXCz6uzTrqSALC5', layer: 'wm', readbackVerified: true,
    created: false, tripleCount: 3, digest: payload.digest, metadata: { status: 'wm-sealed', reservedUal: 'urn:fixture:sealed-asset' } });
  assert.ok(result.calls.every(call => call.authorized && call.timeout === 40));
  for (const call of result.calls.filter(call => call.path.startsWith('/api/knowledge-assets/')))
    assert.deepEqual(call.query, { contextGraphId: [graph] });
});

const xsd = 'http://www.w3.org/2001/XMLSchema#';
for (const [name, serialize] of [
  ['explicit xsd:string', value => value + `^^<${xsd}string>`],
  ['RDF Unicode escapes', value => value.replaceAll('É', '\\u00C9').replaceAll('🛠', '\\U0001F6E0')],
  ['UTF-16 surrogate pair', value => value.replaceAll('🛠', '\\uD83D\\uDEE0')],
  ['RDF apostrophe escape', value => value.replaceAll("'", "\\'")],
]) test(`actual SSH writer reconciles ${name} without another POST`, () => {
  const payload = evidence(), readback = payload.quads.map(q => ({ ...q,
    object: q.object.startsWith('"') ? serialize(q.object) : q.object }));
  assert.equal(payload.allowCreate, false);
  const result = run(payload, { readback });
  assert.equal(result.ok, true, result.message); assert.deepEqual(creates(result), []);
  assert.equal(result.receipt.readbackVerified, true); assert.equal(result.receipt.digest, payload.digest);
});

for (const [name, requested, stored] of [
  ['integer', `"7"^^<${xsd}integer>`, `"\\u0037"^^<${xsd}integer>`],
  ['language', '"Équipement"@FR', '"\\u00C9quipement"@fr'],
]) test(`actual SSH writer preserves equivalent ${name} RDF`, () => {
  const payload = evidence(); payload.quads.push({ ...payload.quads[0], predicate: 'urn:fixture:typed', object: requested });
  const readback = payload.quads.map(q => q.predicate === 'urn:fixture:typed' ? { ...q, object: stored } : q);
  const result = run(payload, { readback });
  assert.equal(result.ok, true, result.message); assert.deepEqual(creates(result), []);
});

test('actual SSH writer reconciles bracketed resources and named graphs without dropping graph identity', () => {
  const payload = evidence(); payload.quads = payload.quads.map(q => ({ ...q, graph: 'urn:fixture:graph' }));
  const readback = payload.quads.map(q => Object.fromEntries(Object.entries(q).map(([key, value]) =>
    [key, value.startsWith('"') ? value : `<${value}>`])));
  const result = run(payload, { readback });
  assert.equal(result.ok, true, result.message); assert.deepEqual(creates(result), []);
  for (const graph of ['', 'urn:other']) {
    const changed = run(payload, { readback: readback.map(q => ({ ...q, graph })) });
    refused(changed); assert.match(changed.message, /readback differs/);
  }
});

test('actual SSH writer reconciles omitted and empty default graphs in either direction', () => {
  for (const explicit of [true, false]) {
    const payload = evidence(), readback = payload.quads.map(q => ({ ...q, ...(!explicit ? { graph: '' } : {}) }));
    if (explicit) payload.quads = payload.quads.map(q => ({ ...q, graph: '' }));
    const result = run(payload, { readback });
    assert.equal(result.ok, true, result.message); assert.deepEqual(creates(result), []);
  }
});

for (const change of ['moved', 'extra graph copy']) test(`actual SSH writer rejects ${change} quads`, () => {
  const payload = evidence(); payload.quads = payload.quads.map(q => ({ ...q, graph: '' }));
  const readback = change === 'moved' ? payload.quads.map(q => ({ ...q, graph: 'urn:unexpected' }))
    : [...payload.quads, { ...payload.quads[0], graph: 'urn:unexpected' }];
  const result = run(payload, { readback });
  refused(result); assert.match(result.message, /readback differs/);
});

for (const [name, change] of [
  ['literal value', value => value.replace('Ébavurer', 'Changed')],
  ['datatype', value => value + `^^<${xsd}anyURI>`],
  ['language', value => value + '@fr'],
]) test(`actual SSH writer rejects a changed payload ${name}`, () => {
  const payload = evidence(), readback = payload.quads.map(q => q.predicate === 'urn:nos:workflow:payload'
    ? { ...q, object: change(q.object) } : q);
  const result = run(payload, { readback });
  refused(result); assert.match(result.message, /readback differs/);
});

test('actual SSH writer refuses malformed RDF escapes and suffixes before creation or confirmation', () => {
  for (const object of ['"\\q"', '"\\U00110000"', '"\\U0000D800"', '"\\uD800"', '"\\uDE00"',
    '"unterminated', '"value"^^<relative>', '"value"@123']) {
    const payload = evidence(), readback = payload.quads.map((q, i) => i === 0 ? { ...q, object } : q);
    refused(run(payload, { readback }));
    refused(run({ ...payload, allowCreate: true, quads: readback }, { exists: false }));
  }
});

test('actual SSH writer creates only an explicitly permitted missing asset and verifies its sealed readback', () => {
  const payload = { ...evidence(), allowCreate: true }, result = run(payload, { exists: false });
  assert.equal(result.ok, true, result.message); assert.equal(result.receipt.created, true);
  assert.equal(creates(result).length, 1);
  assert.deepEqual(creates(result)[0].body, { contextGraphId: graph, name: payload.name, quads: payload.quads,
    finalize: true, alsoShareSwm: false, alsoPublishVm: false });
  assert.equal(result.receipt.readbackVerified, true);
  assert.equal(result.calls.at(-1).method, 'GET'); assert.equal(result.receipt.metadata.status, 'wm-sealed');
});

for (const change of ['changed', 'missing', 'extra']) test(`actual SSH writer rejects ${change} readback content`, () => {
  const payload = evidence(), readback = structuredClone(payload.quads);
  if (change === 'changed') readback[2].object = 'urn:fixture:another-execution';
  if (change === 'missing') readback.pop();
  if (change === 'extra') readback.push({ ...readback[2], object: 'urn:fixture:extra-execution' });
  const result = run(payload, { readback }); refused(result); assert.equal(result.error, 'AssertionError');
  assert.match(result.message, /readback differs/);
});

test('actual SSH writer rejects a false digest even when the entire RDF readback matches', () => {
  const payload = { ...evidence(), digest: '0'.repeat(64) }, result = run(payload);
  refused(result); assert.equal(result.error, 'AssertionError');
});

test('actual SSH writer cannot confirm an existing draft or a newly created draft', () => {
  const result = run(evidence(), { metadataStatus: 'wm-draft' }); refused(result); assert.equal(result.error, 'AssertionError');
  const created = run({ ...evidence(), allowCreate: true }, { exists: false, metadataStatus: 'wm-draft' });
  assert.equal(created.ok, false); assert.equal(created.printed, ''); assert.equal(creates(created).length, 1);
});

test('actual SSH writer does not treat metadata outages as missing assets', () => {
  const result = run({ ...evidence(), allowCreate: true }, { metadataError: 503 });
  refused(result); assert.equal(result.error, 'HTTPError');
});

for (const scenario of [{ hostname: 'different-host' }, { peerId: 'different-peer' }, { accessPolicy: 'public' }, { callerInvolved: false }])
  test(`actual SSH writer rejects the wrong execution scope: ${Object.keys(scenario)[0]}`, () => {
    const result = run({ ...evidence(), allowCreate: true }, scenario);
    refused(result); assert.equal(result.error, 'AssertionError');
  });
