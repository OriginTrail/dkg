import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createStudioProvider } from './studio-provider.mjs';
import { compileStudio } from './studio-definition.mjs';
import { createStudioMcpService } from './studio-mcp-service.mjs';
import { createStudioMcpHttp, studioMcpFlags } from './studio-mcp-http.mjs';
import { createStudioNativeRunner } from './studio-native-runner.mjs';
import { loadNosStudioSession } from './nos-studio-session.mjs';
import { readOnlyDefinition } from './studio-mcp-contract.mjs';
import { componentRegistry } from './component-registry.mjs';
import { createNosNodeClient } from './nos-node-transport.mjs';

const owner = { id: 'person-one', role: 'owner', accountId: 'account-test' };
const actor = { ...owner, startedBy: 'agent:one', agentVersion: 'version-1', toolDigest: 'd'.repeat(64), approvalDecisionId: 'decision-1' };
const definition = { id: '123e4567-e89b-42d3-a456-426614174099', name: 'Read-only data', entryId: 'map',
  nodes: [{ id: 'map', componentId: 'edit-fields', kaRef: 'urn:demo:n8n:component:edit-fields:unit', sourceHash: 'a'.repeat(64),
    params: { fields: { result: '{{ $json.value }}' }, keepInput: 'yes' }, x: 0, y: 0 }], edges: [] };
async function fixture(t, runner) {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-test-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const compiled = compileStudio(definition, { graphId: 'test', owner: '0x' + 'a'.repeat(40), fixture: true, providerId: 'native-one' });
  const published = { ...compiled.workflow, id: 'native-one', versionId: 'v1', active: true };
  const config = { n8nNative: { workflows: [], baseUrl: 'http://127.0.0.1:1', apiTokenFile: join(state, 'api'), webhookTokenFile: join(state, 'webhook') } };
  writeFileSync(config.n8nNative.apiTokenFile, 'fixture-api-token'.repeat(3));
  writeFileSync(config.n8nNative.webhookTokenFile, 'fixture-hook-token'.repeat(3));
  let provider;
  const open = () => provider = createStudioProvider({ state, config, graphId: 'test', owner: '0x' + 'a'.repeat(40), fetchImpl: async () => Response.json(published) });
  open(); t.after(() => provider.close());
  await provider.recordSavedNative(compiled);
  const input = (runKey = 'run-one') => ({ kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256, runKey, arguments: { value: 'sensitive-input' } });
  const service = () => createStudioMcpService({ provider, installation: config.n8nNative, accountId: owner.accountId, profile: null, ...(runner ? { runner } : {}) });
  return { state, compiled, published, config, input, get provider() { return provider; }, service,
    restart() { provider.close(); open(); return service(); } };
}
function controllable() {
  let count = 0, status = 'running', loseAck = false, badPin = false;
  return { get count() { return count; }, set status(v) { status = v; }, set loseAck(v) { loseAck = v; }, set badPin(v) { badPin = v; },
    runner: { async prepare() { if (badPin) throw Error('changed pin'); return 'v1'; },
      async dispatch() { count++; if (loseAck) throw Error('lost acknowledgement'); return String(count); },
      async inspect() { return { status, ...(status === 'succeeded' ? { output: { items: [{ result: 'private-output' }], ports: {} } } : {}) }; } } };
}
test('saved pins and scalar arguments are mandatory; failed preflight cannot execute', async t => {
  const c = controllable(), f = await fixture(t, c.runner), s = f.service(), pin = { kaRef: f.input().kaRef, workflowSha256: f.input().workflowSha256 };
  assert.equal(s.list(owner)[0].workflowSha256, pin.workflowSha256);
  assert.equal(s.get(pin, owner).approvalKind, 'saved-workflow');
  for (const value of [{ ...f.input(), workflowSha256: 'b'.repeat(64) }, { ...f.input(), arguments: { value: {} } },
    { ...f.input(), startedBy: 'agent:forged' }, { ...f.input(), arguments: { constructor: 'no' } }]) await assert.rejects(s.run(value, actor));
  await assert.rejects(s.run(f.input(), { ...actor, accountId: 'other' }));
  c.badPin = true;
  assert.equal((await s.run(f.input(), actor)).status, 'failed');
  assert.equal(c.count, 0);
  assert.throws(() => s.withdraw(pin, actor));
  s.withdraw(pin, owner);
  assert.equal(s.list(owner).length, 0);
  assert.equal(s.get(pin, owner).approved, false);
  await assert.rejects(s.run(f.input('new'), actor));
});
test('timeout and restart retain one account slot; repeat is inspection, owner Test is independent', async t => {
  const c = controllable(), f = await fixture(t, c.runner); let s = f.service();
  assert.equal((await s.run(f.input(), actor)).status, 'running');
  s = f.restart();
  assert.equal((await s.run(f.input(), actor)).status, 'running');
  assert.equal(c.count, 1);
  await assert.rejects(s.run(f.input('second'), { ...actor, startedBy: 'agent:two' }), { code: 'STUDIO_BUSY' });
  assert.equal((await s.run(f.input('owner-test'), owner)).status, 'running');
  assert.equal(c.count, 2);
  c.status = 'succeeded';
  const done = await s.readRun({ runKey: 'run-one' }, actor);
  assert.equal(done.status, 'succeeded'); assert.equal(done.approvalDecisionId, actor.approvalDecisionId);
  assert.deepEqual(done.output.items, [{ result: 'private-output' }]);
  assert.equal((await s.run(f.input('second'), actor)).status, 'succeeded');
  assert.equal(c.count, 3);
  const rows = JSON.stringify(f.provider.db.prepare('SELECT * FROM studio_tool_runs').all());
  assert.doesNotMatch(rows, /sensitive-input|private-output/);
});
test('lost acknowledgement is never redispatched or released by a new service instance', async t => {
  const c = controllable(); c.loseAck = true;
  const f = await fixture(t, c.runner); let s = f.service();
  assert.equal((await s.run(f.input(), actor)).status, 'unconfirmed');
  s = f.restart(); c.status = 'succeeded';
  assert.equal((await s.run(f.input(), actor)).status, 'unconfirmed');
  await assert.rejects(s.run(f.input('second'), actor), { code: 'STUDIO_BUSY' });
  await assert.rejects(s.run({ ...f.input(), arguments: { value: 'changed' } }, actor), { code: 'STUDIO_RUN_KEY_CONFLICT' });
  await assert.rejects(s.run(f.input(), { ...actor, agentVersion: 'other-version' }), { code: 'STUDIO_RUN_KEY_CONFLICT' });
  assert.equal(c.count, 1);
});
test('cross-worker reservation wins once, and failed native completion releases capacity', async t => {
  const c = controllable(), f = await fixture(t, c.runner), a = f.service(), b = f.service();
  const results = await Promise.allSettled([a.run(f.input('one'), actor), b.run(f.input('two'), actor)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(c.count, 1);
  c.status = 'failed';
  assert.equal((await b.run(f.input('three'), actor)).status, 'failed');
  assert.equal(c.count, 2);
});
test('read-only admission uses an explicit list; no HTTP, file, wait, loop, subworkflow or Program', () => {
  const unsupported = componentRegistry.filter(d => ['Integrations', 'Files', 'Events'].includes(d.category)
    || ['loop-items', 'execute-workflow'].includes(d.id));
  for (const d of unsupported) {
    const params = Object.fromEntries(Object.entries(d.parameters).map(([key, p]) => [key, p.default]));
    const altered = { ...definition, nodes: [{ ...definition.nodes[0], componentId: d.id, kaRef: 'urn:demo:n8n:component:' + d.id + ':unit', params }] };
    assert.throws(() => readOnlyDefinition(altered, null));
  }
});
test('withdrawal suppresses retained output but still reconciles terminal capacity', async t => {
  const c = controllable(), f = await fixture(t, c.runner), s = f.service();
  await s.run(f.input(), actor);
  s.withdraw({ kaRef: f.input().kaRef, workflowSha256: f.input().workflowSha256 }, owner);
  c.status = 'succeeded';
  const result = await s.readRun({ runKey: 'run-one' }, actor);
  assert.equal(result.status, 'succeeded'); assert.equal(result.output, undefined);
});
test('native HTTP dispatch checks acknowledgement and verifies exact execution/version/run identity', async t => {
  const f = await fixture(t), { compiled, published } = f;
  let count = 0, execution;
  const native = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    assert.equal(req.url, '/webhook/dkg-capability-native-one');
    assert.equal(JSON.parse(body).invocationId, 'native-run'); count++;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ executionId: '42' }));
  });
  await new Promise(resolve => native.listen(0, '127.0.0.1', resolve)); t.after(() => native.close());
  const runner = createStudioNativeRunner({ api: async path => path.startsWith('/workflows') ? published : execution },
    { ...f.config.n8nNative, baseUrl: 'http://127.0.0.1:' + native.address().port });
  const workflow = { ...compiled, published };
  assert.equal(await runner.prepare(workflow), 'v1');
  assert.equal(await runner.dispatch(workflow, 'native-run', { itemsJson: '[{}]' }), '42');
  const checkpoint = { execution_id: '42', version_id: 'v1' };
  execution = { id: '42', workflowId: 'native-one', status: 'running' };
  assert.equal((await runner.inspect(workflow, checkpoint, 'native-run')).status, 'running');
  execution = { id: '42', workflowId: 'native-one', workflowVersionId: 'v1', status: 'success', workflowData: published,
    data: { resultData: { runData: {
      'Receive input': [{ data: { main: [[{ json: { body: { invocationId: 'native-run' } } }]] } }],
      [compiled.grant.result.nodes[0]]: [{ data: { main: [[{ json: { answer: 42 } }]] } }],
    } } } };
  assert.deepEqual((await runner.inspect(workflow, checkpoint, 'native-run')).output.items, [{ answer: 42 }]);
  await assert.rejects(runner.inspect(workflow, checkpoint, 'wrong-run'));
  execution.workflowVersionId = 'v2'; await assert.rejects(runner.inspect(workflow, checkpoint, 'native-run'));
  execution.workflowVersionId = 'v1';
  execution.data.resultData.runData[compiled.grant.result.nodes[0]][0].data.main[0] = Array.from({ length: 21 }, () => ({ json: { answer: 42 } }));
  assert.equal((await runner.inspect(workflow, checkpoint, 'native-run')).status, 'failed');
  execution.data.resultData.runData[compiled.grant.result.nodes[0]] = 'malformed';
  assert.equal((await runner.inspect(workflow, checkpoint, 'native-run')).status, 'failed');
  execution.workflowVersionId = 'v1'; execution.status = 'error';
  assert.equal((await runner.inspect(workflow, checkpoint, 'native-run')).status, 'failed');
  assert.equal(count, 1);
});
test('HTTP MCP authenticates before dispatch, rejects browser/bearer/forged authority, and supports run lookup', async t => {
  const c = controllable(), f = await fixture(t, c.runner), service = f.service();
  const secret = 'fixture-service-secret'.repeat(3), secretFile = join(f.state, 'service-key');
  writeFileSync(secretFile, secret); const file = join(f.state, 'session.json');
  writeFileSync(file, JSON.stringify({ accountId: owner.accountId, controlPlaneUrl: 'http://127.0.0.1:4610', secretFile }));
  const session = loadNosStudioSession(file);
  const server = createServer(createStudioMcpHttp({ service, session, agentEnabled: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'x-nos-workflows-secret': secret, 'x-nos-workflows-account': owner.accountId,
    'x-nos-workflows-principal': owner.id, 'x-nos-workflows-role': 'owner',
    'x-nos-workflows-started-by': actor.startedBy, 'x-nos-workflows-agent-version': actor.agentVersion,
    'x-nos-workflows-tool-digest': actor.toolDigest, 'x-nos-workflows-approval-decision': actor.approvalDecisionId };
  const call = (method, params, h = headers) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  assert.equal((await (await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).json()).result.serverInfo.name, 'nos-studio');
  // Exercise the actual MCP SDK transport, not just our JSON fixtures.
  const require = createRequire(new URL('../../packages/cli/package.json', import.meta.url));
  const { Client } = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
  const { StreamableHTTPClientTransport } = await import(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js'));
  const client = new Client({ name: 'studio-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'studio_run_read'));
  await client.close();
  const tools = (await (await call('tools/list', {})).json()).result.tools;
  assert.ok(tools.some(t => t.name === 'studio_run')); assert.ok(!tools.some(t => t.name === 'studio_withdraw'));
  for (const h of [{ ...headers, origin: 'http://127.0.0.1:4620' }, { ...headers, authorization: 'Bearer customer' },
    { ...headers, 'x-nos-workflows-account': 'other' }, { ...headers, 'x-nos-workflows-approval-decision': '' },
    { ...headers, 'x-nos-workflows-role': 'viewer' }]) assert.equal((await call('tools/list', {}, h)).status, 403);
  const run = await (await call('tools/call', { name: 'studio_run', arguments: f.input() })).json();
  assert.equal(run.result.structuredContent.status, 'running');
  const read = await (await call('tools/call', { name: 'studio_run_read', arguments: { runKey: 'run-one' } })).json();
  assert.equal(read.result.structuredContent.agentVersion, actor.agentVersion);
  const injected = await (await call('tools/call', { name: 'studio_run', arguments: { ...f.input('new'), approvedBy: 'forged' } })).json();
  assert.equal(injected.result.isError, true); assert.equal(c.count, 1);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'studio_run', arguments: f.input('new') } }) })).status, 400);
});
test('MCP and agent preview are separate explicit development gates', () => {
  assert.deepEqual(studioMcpFlags({}), { enabled: false, agentEnabled: false });
  for (const env of [{ NOS_STUDIO_MCP: 'true' }, { NOS_STUDIO_MCP: '1', NODE_ENV: 'production' },
    { NOS_STUDIO_MCP_AGENT_PREVIEW: '1', NODE_ENV: 'development' }]) assert.throws(() => studioMcpFlags(env));
});
test('agent DKG callbacks preserve approver, starter and audit correlation in trusted service context', async () => {
  let body;
  const call = createNosNodeClient({ accountId: owner.accountId, controlPlaneUrl: 'http://127.0.0.1:1', secret: () => 'service' },
    { ...actor, runKey: 'run-one' }, async (_url, init) => { body = JSON.parse(init.body); return Response.json({ kind: 'answer', status: 200, body: {} }); });
  await call('query', { query: 'SELECT * WHERE {}' });
  assert.equal(body.approvedBy, owner.id); assert.equal(body.startedBy, actor.startedBy);
  assert.equal(body.agentVersion, actor.agentVersion); assert.equal(body.approvalDecisionId, actor.approvalDecisionId);
  assert.equal(body.runKey, 'run-one');
});
