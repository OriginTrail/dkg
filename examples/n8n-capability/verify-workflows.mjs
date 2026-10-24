import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { compileWorkflow } from './workflow-definition.mjs';

const state = resolve(process.argv[2]);
const { nodeUrl } = JSON.parse(readFileSync(join(state, 'client.json'), 'utf8'));
const prefix = '/spike/ka/accounts/account-a/capabilities';
const headers = { authorization: 'Bearer l1-owner-a', 'content-type': 'application/json' };
async function request(path, body, overrides = {}) {
  const response = await fetch(nodeUrl + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...overrides },
    signal: AbortSignal.timeout(60000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, value: await response.json() };
}
const catalog = await request(prefix); assert.equal(catalog.status, 200);
const parse = catalog.value.capabilities.find(c => c.kind === 'csv-parse'), map = catalog.value.capabilities.find(c => c.kind === 'csv-map');
assert.ok(parse?.available && map?.available);
const file = join(state, 'workflow-builder-verification-v2.json');
const pending = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {
  definition: { id: randomUUID(), name: 'nOS self-service CSV', savedAt: new Date().toISOString(),
    nodes: [
      { id: 'parse', kind: 'csv-parse', kaRef: parse.kaRef, sourceHash: parse.sourceHash, x: 100, y: 150, config: {} },
      { id: 'map', kind: 'csv-map', kaRef: map.kaRef, sourceHash: map.sourceHash, x: 420, y: 150, config: { mapping: [{ source: 0, target: 'Name' }, { source: 2, target: 'Email' }] } },
    ], edges: [{ from: 'parse', to: 'map' }] },
  invocationId: randomUUID(), input: { csv: 'first_name,last_name,email\nAna,Novak,ana@example.com\nLuka,Kovac,luka@example.com\n' },
};
pending.malformedInvocationId ??= randomUUID();
writeFileSync(file, JSON.stringify(pending, null, 2), { mode: 0o600 });
const expected = compileWorkflow(pending.definition);
const save = await request(prefix + '/workflows/save', pending.definition); assert.equal(save.status, 200, JSON.stringify(save.value));
assert.equal(save.value.kaRef, expected.kaRef); assert.equal(save.value.sourceHash, expected.sourceHash); assert.equal(save.value.approved, true); assert.equal(save.value.readbackVerified, true);
assert.deepEqual((await request(prefix + '/workflows/save', pending.definition)).value, save.value);
const inventory = await request(prefix + '/workflows'); assert.equal(inventory.status, 200); assert.ok(inventory.value.workflows.some(w => w.kaRef === expected.kaRef));
const inspect = await request(prefix + '/inspect?' + new URLSearchParams({ kaRef: expected.kaRef, sourceHash: expected.sourceHash }));
assert.equal(inspect.status, 200); assert.equal(inspect.value.source, expected.source); assert.equal(inspect.value.layer, 'wm');
const components = JSON.parse(readFileSync(join(state, 'csv-components.json'), 'utf8'));
const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'), { readOnly: true });
const ids = () => db.prepare('SELECT id FROM execution_entity WHERE workflowId IN (?, ?) ORDER BY id').all(...[parse, map].map(c => components.components.find(x => x.kaRef === c.kaRef).grant.workflowId)).map(row => row.id);
const invoke = { kaRef: expected.kaRef, sourceHash: expected.sourceHash, invocationId: pending.invocationId, input: pending.input };
const run = await request(prefix + '/workflows/run', invoke); assert.equal(run.status, 200, JSON.stringify(run.value));
assert.equal(run.value.persisted, true); assert.equal(run.value.readbackVerified, true); assert.equal(run.value.steps.length, 2);
assert.deepEqual(run.value.output, { ok: true, columns: ['Name', 'Email'], rows: [['Ana', 'ana@example.com'], ['Luka', 'luka@example.com']], error: '' });
const beforeReplay = ids();
assert.deepEqual((await request(prefix + '/workflows/run', invoke)).value, run.value); assert.deepEqual(ids(), beforeReplay);
const mapWorkflow = components.components.find(c => c.kaRef === map.kaRef).grant.workflowId;
const mapperIds = () => db.prepare('SELECT id FROM execution_entity WHERE workflowId = ? ORDER BY id').all(mapWorkflow).map(row => row.id);
const beforeMalformedMap = mapperIds();
const malformedInput = { ...invoke, invocationId: pending.malformedInvocationId, input: { csv: 'name,email\n"unclosed,value' } };
const malformed = await request(prefix + '/workflows/run', malformedInput);
assert.equal(malformed.status, 200, JSON.stringify(malformed.value)); assert.equal(malformed.value.status, 'input-rejected'); assert.equal(malformed.value.steps.length, 1);
const afterMalformed = ids(); assert.deepEqual(mapperIds(), beforeMalformedMap);
assert.deepEqual((await request(prefix + '/workflows/run', malformedInput)).value, malformed.value); assert.deepEqual(ids(), afterMalformed);
assert.equal((await request(prefix + '/workflows/save', pending.definition, { authorization: 'Bearer l1-viewer-a' })).status, 403);
assert.equal((await request(prefix + '/workflows/run', invoke, { authorization: 'Bearer l1-viewer-a' })).status, 403);
assert.equal((await request(prefix + '/workflows/save', pending.definition, { origin: 'https://foreign.example' })).status, 403);
assert.equal((await request(prefix.replace('account-a', 'account-b') + '/workflows/save', pending.definition)).status, 403);
assert.equal((await request(prefix + '/workflows/run', { ...invoke, sourceHash: 'f'.repeat(64) })).status, 409);
assert.equal((await request(prefix + '/workflows/save', { ...pending.definition, nodes: pending.definition.nodes.map(n => ({ ...n, sourceHash: 'f'.repeat(64) })) })).status, 409);
const google = catalog.value.capabilities.find(c => c.kind === 'google-sheets-export');
if (google?.available) {
  const withGoogle = structuredClone(pending.definition); withGoogle.id = randomUUID();
  withGoogle.nodes.push({ id: 'google', kind: google.kind, kaRef: google.kaRef, sourceHash: google.sourceHash, x: 750, y: 150, config: { title: 'Not dispatched without an export key' } });
  withGoogle.edges.push({ from: 'map', to: 'google' });
  assert.equal((await request(prefix + '/workflows/save', withGoogle)).status, 403);
  assert.equal((await request(prefix + '/workflows')).value.workflows.some(w => w.definition.id === withGoogle.id), false);
}
assert.deepEqual(ids(), afterMalformed); db.close();
const report = { workflow: save.value, receipt: run.value, invalidInputReceipt: malformed.value, sourceReadbackVerified: true, completedReplayVerified: true,
  saveReplayVerified: true, invalidCsvStoppedBeforeMapping: true, invalidCsvReplayVerified: true, viewerDenied: true, foreignAccountDenied: true, foreignOriginDenied: true, stalePinsDenied: true, unprivilegedGoogleParentDenied: true };
writeFileSync(join(state, 'workflow-builder-evidence-v2.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify(report));
