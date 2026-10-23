import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const state = resolve(process.argv[2]);
const connection = JSON.parse(readFileSync(join(state, 'client.json'), 'utf8'));
const n8n = JSON.parse(readFileSync(join(state, 'n8n.json'), 'utf8'));
const components = JSON.parse(readFileSync(join(state, 'csv-components.json'), 'utf8'));
const apiKey = readFileSync(n8n.apiTokenFile, 'utf8').trim();
const prefix = connection.nodeUrl + '/spike/ka/accounts/account-a/capabilities';
const auth = { authorization: 'Bearer l1-owner-a', 'content-type': 'application/json' };
const catalog = await (await fetch(prefix, { headers: auth })).json();
const capability = kind => { const found = catalog.capabilities.find(c => c.kind === kind); assert.ok(found, `Missing ${kind} KA`); return found; };
assert.equal(new Set(components.components.map(c => c.kaRef)).size, 3);
const pendingFile = join(state, 'csv-verification-invocations.json');
const pending = existsSync(pendingFile) ? JSON.parse(readFileSync(pendingFile, 'utf8')) : {};
async function n8nApi(path) {
  const r = await fetch(new URL('/api/v1/' + path, n8n.baseUrl), { redirect: 'error', headers: { 'X-N8N-API-KEY': apiKey } });
  assert.equal(r.status, 200); return r.json();
}
async function executions(kind) {
  const workflow = components.components.find(c => c.kind === kind).grant.workflowId;
  return (await n8nApi('executions?workflowId=' + workflow + '&limit=100')).data.map(e => e.id).sort();
}
async function invoke(label, kind, input, exportToken) {
  const selected = capability(kind);
  const request = { kaRef: selected.kaRef, sourceHash: selected.sourceHash, input };
  if (pending[label]) assert.deepEqual(pending[label], { ...request, invocationId: pending[label].invocationId }, 'Inspect the saved invocation before changing its input');
  else { pending[label] = { ...request, invocationId: randomUUID() }; writeFileSync(pendingFile, JSON.stringify(pending, null, 2), { mode: 0o600 }); }
  const send = () => fetch(prefix + '/invoke', { method: 'POST', headers: { ...auth, ...(exportToken ? { 'x-dkg-export-token': exportToken } : {}) }, body: JSON.stringify(pending[label]) });
  const response = await send(), receipt = await response.json();
  assert.equal(response.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.persisted, true); assert.equal(receipt.readbackVerified, true);
  const before = await executions(kind);
  const replay = await send(); assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), receipt);
  assert.deepEqual(await executions(kind), before, 'A completed retry dispatched n8n again');
  return receipt;
}
const csv = '\uFEFFfirst_name,last_name,email,team\r\nAna,Novak,ana@example.com,Research\r\n"Luka, Jr.",Kovac,luka@example.com,"Operations\nteam"\r\n';
const parsed = await invoke('parse', 'csv-parse', { csv });
assert.deepEqual(parsed.output, { ok: true, columns: ['first_name', 'last_name', 'email', 'team'], rows: [['Ana', 'Novak', 'ana@example.com', 'Research'], ['Luka, Jr.', 'Kovac', 'luka@example.com', 'Operations\nteam']], error: '' });
const { columns, rows } = parsed.output;
const mapped = await invoke('map', 'csv-map', { columns, rows, mapping: [{ source: 0, target: 'Name' }, { source: 2, target: 'Email' }] });
assert.deepEqual(mapped.output, { ok: true, columns: ['Name', 'Email'], rows: [['Ana', 'ana@example.com'], ['Luka, Jr.', 'luka@example.com']], error: '' });
const malformed = await invoke('malformed', 'csv-parse', { csv: 'name,email\n"unclosed,value' });
assert.equal(malformed.output.ok, false); assert.deepEqual(malformed.output.rows, []);
const nodeProof = [];
for (const [receipt, expected] of [[parsed, ['CSV to binary', 'Extract from CSV']], [mapped, ['Map fields']]]) {
  const execution = await n8nApi('executions/' + receipt.n8nExecutionId + '?includeData=true');
  assert.equal(execution.status, 'success');
  const nodes = Object.keys(execution.data.resultData.runData);
  for (const name of expected) assert.ok(nodes.includes(name), `Real n8n node did not run: ${name}`);
  nodeProof.push({ kaRef: receipt.kaRef, n8nExecutionId: receipt.n8nExecutionId, nodes });
}
const mapCap = capability('csv-map');
const beforeInvalidMap = await executions('csv-map');
const invalid = await fetch(prefix + '/invoke', { method: 'POST', headers: auth, body: JSON.stringify({ kaRef: mapCap.kaRef, sourceHash: mapCap.sourceHash, invocationId: randomUUID(), input: { columns, rows, mapping: [{ source: 0, target: 'Name' }, { source: 2, target: 'Name' }] } }) });
assert.notEqual(invalid.status, 200);
assert.deepEqual(await executions('csv-map'), beforeInvalidMap);
const google = capability('google-sheets-export');
const googleDefinition = components.components.find(c => c.kind === 'google-sheets-export');
const googleWorkflow = await n8nApi('workflows/' + googleDefinition.grant.workflowId);
assert.equal(googleWorkflow.nodes.filter(n => n.type === 'n8n-nodes-base.googleSheets').length, 2);
assert.equal(googleWorkflow.active, google.available);
const exportInput = { columns: mapped.output.columns, rows: mapped.output.rows, title: 'DKG CSV KA PoC' };
const beforeGoogle = await executions('google-sheets-export');
const withoutKey = await fetch(prefix + '/invoke', { method: 'POST', headers: auth, body: JSON.stringify({ kaRef: google.kaRef, sourceHash: google.sourceHash, invocationId: randomUUID(), input: exportInput }) });
assert.equal(withoutKey.status, google.available ? 403 : 409);
assert.deepEqual(await executions('google-sheets-export'), beforeGoogle);
let exported;
if (process.argv.includes('--export')) {
  assert.equal(google.available, true, 'Connect a Google credential and restart the DKG PoC first');
  exported = await invoke('export', 'google-sheets-export', exportInput, readFileSync(components.exportTokenFile, 'utf8').trim());
  assert.equal(exported.output.rowCount, rows.length);
  assert.ok(exported.output.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/d/' + exported.output.spreadsheetId + '/'));
}
const report = { parsed, mapped, malformedCsvRejected: true, duplicateMappingRejected: true, nodeProof, completedReplayVerified: true,
  google: exported ?? { available: google.available, unprivilegedExportDenied: true, connectionRequired: !google.available } };
writeFileSync(join(state, 'csv-evidence.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
