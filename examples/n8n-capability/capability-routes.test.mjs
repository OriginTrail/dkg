import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createCapabilityBridge } from './bridge.mjs';
import { component } from './component-registry.mjs';
import { streamedBodyOverflow } from './test-support/http-body-overflow.mjs';

const prefix = '/spike/ka/accounts/account-a/capabilities', eventPath = '/spike/ka/events/11223344-1234-4234-8234-123456789abc';
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'capability-route-')), calls = [];
  const graphId = 'route-fixture', owner = '0x' + '1'.repeat(40), kaRef = 'urn:fixture:component', sourceHash = 'a'.repeat(64);
  const descriptor = component('edit-fields'), source = { sourceHash, source: 'export function run() {}', label: 'Fixture', language: 'typescript-v1', version: '1', authorAgentAddress: owner };
  const output = { kind: 'n8n-result', n8nExecutionId: '42', output: { ok: true } }, rawOutputs = [JSON.stringify(output)];
  const bridge = createCapabilityBridge({ graphId, owner,
    agent: { query: async query => ({ bindings: query.includes('orderedOutputs')
      ? rawOutputs.map(value => ({ g: `did:dkg:context-graph:${graphId}/_working_memory/${owner}/1`, output: { value } }))
      : [{ program: kaRef }] }) },
    client: { programs: { getSource: async () => source, getApproval: async () => ({ binding: { contextGraphId: graphId, operationIri: kaRef, enabled: true, executorAgentAddress: owner, allowedCallerAgentAddresses: [owner], n8n: {}, program: { ...source, contextGraphId: graphId, programIri: kaRef, programLayer: 'wm' } } }), listApprovals: async () => [],
      invoke: async value => { calls.push({ handler: 'invoke', value }); return { ...value, executionIri: 'urn:execution:fixture', rawOutputs, outputs: [output], persisted: true }; } } },
    definitions: [{ kind: 'component', kaRef, descriptor }],
    config: { n8nNative: { workflows: [] }, programBindings: [{ contextGraphId: graphId, operationIri: kaRef, enabled: true, program: { sourceHash }, n8n: {} }] },
    studioOptions: { state, headerCredential: { id: 'fixture', name: 'Fixture' }, credentials: {} },
  });
  for (const [service, methods] of [[bridge.studio, ['list', 'save', 'run', 'activate']], [bridge.workflows, ['list', 'save', 'run']], [bridge.reusable, ['save', 'publish']]])
    for (const method of methods) service[method] = async value => { calls.push({ handler: method, value }); return method === 'list' ? [] : { handler: method, value }; };
  bridge.studio.history = async (ref, disclose) => ({ ref, disclosed: disclose(false) });
  bridge.studio.event = async (key, value) => { calls.push({ handler: 'event', key, value }); return value; };
  const invocation = { kaRef, sourceHash, invocationId: '11223344-1234-4234-8234-123456789abc',
    input: { itemsJson: '[{}]', paramsJson: JSON.stringify(Object.fromEntries(Object.entries(descriptor.parameters).map(([key, p]) => [key, p.default]))), executionId: '' } };
  async function send(path, method, role = 'owner', value = {}, chunks) {
    const req = Readable.from(chunks ?? [Buffer.from(JSON.stringify(value))]); let reads = 0;
    const iterator = req.iterator.bind(req); req.iterator = options => { reads++; return iterator(options); };
    req.url = path; req.method = method; req.headers = role ? { authorization: 'Bearer l1-' + role + '-a' } : {};
    let status, body;
    await bridge.handle(req, { writeHead: s => { status = s; }, end: text => { body = JSON.parse(text); } }, path.split('?')[0]);
    return { status, body, reads };
  }
  return { send, calls, invocation, handle: (req, res) => bridge.handle(req, res, req.url), close() { bridge.close(); rmSync(state, { recursive: true, force: true }); } };
}

test('bridge returns HTTP 413 for unfinished uploads at both route byte limits', async () => {
  const f = fixture();
  try {
    for (const [path, limit] of [[prefix + '/studio/save', 16384], ['/spike/ka/demo-data', 4096]]) {
      const res = await streamedBodyOverflow(f.handle, { path, limit, headers: { authorization: 'Bearer l1-owner-a' } });
      assert.equal(res.status, 413); assert.equal(res.body.code, 'POC_REQUEST_REJECTED');
      assert.equal(res.destroyedBeforeResponse, false); assert.equal(res.headers.connection, 'close');
    }
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});

test('bridge dispatches every capability route and rejects methods and viewer writes before body reads', async () => {
  const f = fixture();
  try {
    const inspect = '/inspect?kaRef=' + f.invocation.kaRef + '&sourceHash=' + f.invocation.sourceHash;
    for (const [path, method] of [['', 'GET'], ['/invoke', 'POST'], [inspect, 'GET'], ['/workflows', 'GET'],
      ['/workflows/save', 'POST'], ['/workflows/run', 'POST'], ['/studio', 'GET'], ['/studio/save', 'POST'],
      ['/studio/components', 'POST'], ['/studio/run', 'POST'], ['/studio/invoke', 'POST'], ['/studio/activation', 'POST'], ['/studio/history?kaRef=urn:fixture', 'GET']]) {
      const owner = await f.send(prefix + path, method, 'owner', f.invocation);
      assert.equal(owner.status, 200, path);
      assert.equal(owner.reads, method === 'POST' ? 1 : 0, path);
      const before = f.calls.length, viewer = await f.send(prefix + path, method, 'viewer', f.invocation);
      assert.equal(viewer.status, method === 'POST' ? 403 : 200, path);
      if (method === 'POST') { assert.equal(viewer.reads, 0); assert.equal(f.calls.length, before); }
      const after = f.calls.length, wrong = await f.send(prefix + path, method === 'POST' ? 'GET' : 'POST');
      assert.equal(wrong.status, 405, path); assert.equal(wrong.reads, 0); assert.equal(f.calls.length, after);
    }
    const before = f.calls.length;
    for (const path of [prefix + '/unknown', prefix + '/studio/invoke/extra', prefix.replace('account-a', 'account-b')])
      assert.equal((await f.send(path, 'POST')).status, 403);
    assert.equal((await f.send(prefix + '/studio/save', 'POST', null)).status, 403);
    assert.equal(f.calls.length, before);
  } finally { f.close(); }
});

test('bridge preserves delegated events and bounds common JSON parsing without splitting Unicode', async () => {
  const f = fixture();
  try {
    const value = { text: 'Ébavurer – € 🔧' }, bytes = Buffer.from(JSON.stringify(value));
    const chunks = Array.from(bytes, (_, i) => bytes.subarray(i, i + 1));
    const event = await f.send(eventPath, 'POST', null, value, chunks);
    assert.equal(event.status, 200); assert.deepEqual(event.body, value);
    assert.equal(f.calls.at(-1).key, eventPath.split('/').at(-1));
    const before = f.calls.length;
    assert.equal((await f.send(eventPath, 'GET', null)).status, 405); assert.equal(f.calls.length, before);
    for (const [path, limit, role] of [[prefix + '/studio/save', 16384, 'owner'], [eventPath, 16384, null], ['/spike/ka/demo-data', 4096, null]]) {
      const text = 'É' + 'x'.repeat(limit - Buffer.byteLength(JSON.stringify({ text: 'É' })));
      const input = Buffer.from(JSON.stringify({ text })); assert.equal(input.length, limit);
      const accepted = await f.send(path, 'POST', role, undefined, [input.subarray(0, 10), input.subarray(10)]);
      assert.equal(accepted.status, 200, path);
      const count = f.calls.length;
      assert.equal((await f.send(path, 'POST', role, undefined, [input, Buffer.from(' ')])).status, 413, path);
      assert.equal(f.calls.length, count);
    }
  } finally { f.close(); }
});

test('bridge keeps optional demo bodies and required route JSON distinct', async () => {
  const f = fixture();
  try {
    for (const method of ['GET', 'POST']) {
      const empty = await f.send('/spike/ka/demo-data', method, null, undefined, []);
      assert.equal(empty.status, 200); assert.equal(Object.hasOwn(empty.body, 'received'), false);
      const value = { text: '鋼 🔧' };
      const supplied = await f.send('/spike/ka/demo-data', method, null, undefined, [JSON.stringify(value)]);
      assert.equal(supplied.status, 200); assert.deepEqual(supplied.body.received, value);
    }
    for (const [path, code] of [[prefix + '/studio/save', 'POC_REQUEST_REJECTED'], [eventPath, 'EVENT_UNCONFIRMED']]) {
      for (const chunks of [[], ['{']]) {
        const rejected = await f.send(path, 'POST', 'owner', undefined, chunks);
        assert.equal(rejected.status, 400); assert.equal(rejected.body.code, code);
      }
    }
    assert.deepEqual(f.calls, []);
  } finally { f.close(); }
});
