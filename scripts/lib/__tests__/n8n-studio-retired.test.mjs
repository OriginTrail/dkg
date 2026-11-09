import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createCapabilityBridge } from '../../../examples/n8n-capability/bridge.mjs';
import { component } from '../../../examples/n8n-capability/component-registry-v1.mjs';

const owner = '0x' + '1'.repeat(40);
const approval = (graphId, kaRef, sourceHash) => ({ binding: { contextGraphId: graphId, operationIri: kaRef, enabled: true,
  executorAgentAddress: owner, allowedCallerAgentAddresses: [owner], n8n: {},
  program: { contextGraphId: graphId, programIri: kaRef, programLayer: 'wm', sourceHash, authorAgentAddress: owner } } });

test('invalid inputs on a retired leaf give a confirmed upgrade error before dispatching n8n', async () => {
  const state = mkdtempSync(join(tmpdir(), 'retired-ka-unit-'));
  const graphId = 'n8n-capability-poc', kaRef = 'urn:demo:n8n:component:http-request:e360cc6e6621', sourceHash = 'a'.repeat(64);
  let dispatched = 0;
  const bridge = createCapabilityBridge({ graphId, owner: '0x' + '1'.repeat(40),
    agent: { async query() { return { bindings: [{ program: kaRef }] }; } },
    client: { programs: { getApproval: async () => approval(graphId, kaRef, sourceHash), async getSource() { return { sourceHash, authorAgentAddress: owner, label: 'HTTP Request', version: '1.0.0' }; },
      async invoke() { dispatched++; throw Error('outcome-unknown'); } } },
    config: { programBindings: [{ contextGraphId: graphId, operationIri: kaRef, enabled: true, program: { sourceHash }, n8n: {} }],
      n8nNative: { workflows: [] } },
    definitions: [{ kind: 'component', kaRef, descriptor: component('http-request'), enabled: true, retired: true }],
    studioOptions: { state, headerCredential: { id: 'unit', name: 'Unit fixture' }, credentials: {} },
  });
  try {
    // In-memory HTTP objects only: no socket, token file or network request.
    const request = Readable.from([Buffer.from(JSON.stringify({ kaRef, sourceHash, invocationId: randomUUID(),
      input: { itemsJson: '[{}]', paramsJson: JSON.stringify({ url: 'https://api.open-meteo.com/v1/forecast', method: 'GET', body: { hello: 'DKG' } }), executionId: '' } }))]);
    request.method = 'POST'; request.headers = { authorization: 'Bearer l1-owner-a' };
    let status, body;
    const response = { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } };
    assert.equal(await bridge.handle(request, response, '/spike/ka/accounts/account-a/capabilities/studio/invoke'), true);
    assert.equal(status, 400); assert.equal(body.code, 'INVALID_WORKFLOW');
    assert.match(body.error, /Use current component version/); assert.equal(dispatched, 0);
    // Valid older requests remain eligible for reconciliation under the same pin.
    const retry = Readable.from([Buffer.from(JSON.stringify({ kaRef, sourceHash, invocationId: randomUUID(),
      input: { itemsJson: '[{}]', paramsJson: JSON.stringify({ url: 'http://127.0.0.1:4631/spike/ka/demo-data', method: 'GET', body: {} }), executionId: '' } }))]);
    retry.method = 'POST'; retry.headers = request.headers;
    await bridge.handle(retry, response, '/spike/ka/accounts/account-a/capabilities/studio/invoke');
    assert.equal(dispatched, 1); assert.equal(body.code, 'POC_REQUEST_REJECTED');
  } finally { bridge.close(); rmSync(state, { recursive: true, force: true }); }
});

for (const id of ['google-sheets', 'google-drive']) for (const route of ['/invoke', '/studio/invoke']) {
  test(`${id} requires export authorization on ${route} before SDK dispatch`, async () => {
    const state = mkdtempSync(join(tmpdir(), 'export-gate-')), tokenFile = join(state, 'export');
    const secret = 'fixture-export-key-'.repeat(3); writeFileSync(tokenFile, secret);
    const graphId = 'test-export', kaRef = 'urn:test:' + id, sourceHash = 'a'.repeat(64), descriptor = component(id);
    let dispatches = 0;
    const bridge = createCapabilityBridge({ graphId, owner: '0x' + '1'.repeat(40), exportTokenFile: tokenFile,
      agent: { query: async () => ({ bindings: [{ program: kaRef }] }) },
      client: { programs: { getApproval: async () => approval(graphId, kaRef, sourceHash), getSource: async () => ({ sourceHash, authorAgentAddress: owner, version: '1' }), invoke: async () => { dispatches++; throw Error('fixture-stop'); } } },
      config: { programBindings: [{ contextGraphId: graphId, operationIri: kaRef, enabled: true, program: { sourceHash }, n8n: {} }], n8nNative: { workflows: [] } },
      definitions: [{ kind: 'component', kaRef, descriptor, enabled: true, requiresExportAuthorization: true }],
      studioOptions: { state, headerCredential: { id: 'unit', name: 'Unit' }, credentials: {} } });
    try {
      for (const token of [undefined, 'wrong-key', secret]) {
        const request = Readable.from([Buffer.from(JSON.stringify({ kaRef, sourceHash, invocationId: randomUUID(), input: {
          itemsJson: JSON.stringify(descriptor.sampleItems), paramsJson: JSON.stringify(Object.fromEntries(Object.entries(descriptor.parameters).map(([k,v]) => [k,v.default]))), executionId: '' } }))]);
        request.method = 'POST'; request.headers = { authorization: 'Bearer l1-owner-a', ...(token ? { 'x-dkg-export-token': token } : {}) };
        let status; const response = { writeHead(v) { status = v; }, end() {} };
        await bridge.handle(request, response, '/spike/ka/accounts/account-a/capabilities' + route);
        if (token !== secret) { assert.equal(status, 403); assert.equal(dispatches, 0); }
        else assert.equal(dispatches, 1);
      }
    } finally { bridge.close(); rmSync(state, { recursive: true, force: true }); }
  });
}
