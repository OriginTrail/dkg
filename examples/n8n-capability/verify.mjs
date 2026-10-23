import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { GraphComputer } from '../../packages/graph-computer/dist/index.js';
const { Wallet } = createRequire(new URL('../../packages/graph-computer/package.json', import.meta.url))('ethers');
const state = resolve(process.argv[2]);
const connection = JSON.parse(readFileSync(join(state, 'client.json'), 'utf8'));
const n8n = JSON.parse(readFileSync(join(state, 'n8n.json'), 'utf8'));
const evidence = JSON.parse(readFileSync(join(state, 'evidence.json'), 'utf8'));
const signer = new Wallet(readFileSync(connection.keyFile, 'utf8').trim());
const clientFor = signer => new GraphComputer({ nodeUrl: connection.nodeUrl, peerId: connection.peerId, signer, retries: 0 });
const client = clientFor(signer), operation = { graphId: connection.graphId, operationIri: connection.kaRef };
async function executions() {
  const response = await fetch(n8n.baseUrl + '/api/v1/executions?workflowId=' + n8n.grant.workflowId + '&limit=100',
    { headers: { 'X-N8N-API-KEY': readFileSync(n8n.apiTokenFile, 'utf8').trim() }, redirect: 'error' });
  assert.equal(response.status, 200);
  return (await response.json()).data.map(item => item.id).sort();
}
const before = await executions();
const replay = await client.programs.invoke({ ...operation, inputs: [{ text: '  hello dkg  ' }], invocationId: evidence.invocationId });
assert.equal(replay.outputs[0].n8nExecutionId, evidence.n8nExecutionId);
assert.equal(replay.outputs[0].output.text, 'HELLO DKG');
await assert.rejects(client.programs.invoke({ ...operation, inputs: [{ text: 12 }] }), error => error.status === 422);
await assert.rejects(clientFor(Wallet.createRandom()).programs.invoke({ ...operation, inputs: [{ text: 'denied' }] }), error => error.status === 403);
const prefix = connection.nodeUrl + '/spike/ka/accounts/account-a/capabilities';
const inventory = await fetch(prefix, { headers: { authorization: 'Bearer l1-viewer-a' } });
const catalog = await inventory.json(); assert.equal(catalog.canInvoke, false); assert.equal(catalog.capabilities[0].kaRef, connection.kaRef);
const input = { kaRef: connection.kaRef, sourceHash: evidence.sourceHash, input: { text: 'denied' }, invocationId: randomUUID() };
const viewer = await fetch(prefix + '/invoke', { method: 'POST', headers: { authorization: 'Bearer l1-viewer-a', 'content-type': 'application/json' }, body: JSON.stringify(input) });
assert.equal(viewer.status, 403);
const stale = await fetch(prefix + '/invoke', { method: 'POST', headers: { authorization: 'Bearer l1-owner-a', 'content-type': 'application/json' }, body: JSON.stringify({ ...input, sourceHash: '0'.repeat(64) }) });
assert.equal(stale.status, 409);
const foreign = await fetch(prefix.replace('account-a', 'account-b'), { headers: { authorization: 'Bearer l1-owner-a' } });
assert.equal(foreign.status, 403);
let workflowMismatchVerified = false;
if (process.argv.includes('--check-workflow-change')) {
  const key = readFileSync(n8n.apiTokenFile, 'utf8').trim();
  const path = n8n.baseUrl + '/api/v1/workflows/' + n8n.grant.workflowId;
  const api = async (url, body, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(url, { method, redirect: 'error', headers: { 'X-N8N-API-KEY': key, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(r.ok, true, `n8n fixture update: HTTP ${r.status}`); return r.json();
  };
  const original = await api(path);
  const approved = { name: original.name, nodes: original.activeVersion.nodes, connections: original.activeVersion.connections, settings: original.settings };
  const changed = structuredClone(approved); changed.nodes.find(node => node.id === 'normalize').parameters.assignments.assignments[0].value = '={{ $json.body.input.text.toLowerCase() }}';
  try {
    await api(path, changed, 'PUT'); await api(path + '/publish', {});
    await assert.rejects(client.programs.invoke({ ...operation, inputs: [{ text: 'must not execute' }] }), error => [409, 422, 502].includes(error.status));
    assert.deepEqual(await executions(), before); workflowMismatchVerified = true;
  } finally { await api(path, approved, 'PUT'); await api(path + '/publish', {}); }
}
assert.deepEqual(await executions(), before);
const report = { replayVerified: true, invalidInputDenied: true, signedUnauthorizedCallerDenied: true,
  viewerDenied: true, foreignAccountDenied: true, staleKaRevisionDenied: true, workflowMismatchVerified,
  n8nExecutionsUnchanged: true, n8nExecutionId: evidence.n8nExecutionId };
writeFileSync(join(state, 'regression-evidence.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
