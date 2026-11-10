import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createStudioRepository } from './studio-repository.mjs';
import { createStudioProvider } from './studio-provider.mjs';
import { compileStudio, normalizeStudio } from './studio-definition.mjs';
import { createStudioMcpService } from './studio-mcp-service.mjs';
import { createStudioMcpHttp, studioMcpFlags } from './studio-mcp-http.mjs';
import { createStudioNativeRunner } from './studio-native-runner.mjs';
import { loadNosStudioSession } from './nos-studio-session.mjs';
import { canonical, readOnlyDefinition, runInput } from './studio-mcp-contract.mjs';
import { componentRegistry, component } from './component-registry.mjs';
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
  let provider, repository;
  const open = () => { repository = createStudioRepository(state); return provider = createStudioProvider({ repository, config, graphId: 'test', owner: '0x' + 'a'.repeat(40), fetchImpl: async () => Response.json(published) }); };
  open(); t.after(() => repository.close());
  repository.ensure(compiled);
  repository.nativeCreated(compiled.kaRef, compiled.grant.workflowId);
  repository.nativeGranted(compiled.kaRef, compiled.grant);
  repository.completeSave(compiled, 'native-n8n', false, await provider.savedNativeSnapshot(compiled));
  const input = (runKey = 'run-one') => ({ kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256, runKey, arguments: { value: 'sensitive-input' } });
  const service = () => createStudioMcpService({ repository, provider, installation: config.n8nNative, accountId: owner.accountId, ...(runner ? { runner } : {}) });
  return { state, compiled, published, config, input, get repository() { return repository; }, get provider() { return provider; }, service,
    restart() { repository.close(); open(); return service(); } };
}
function controllable() {
  let count = 0, status = 'running', loseAck = false, badPin = false;
  return { get count() { return count; }, set status(v) { status = v; }, set loseAck(v) { loseAck = v; }, set badPin(v) { badPin = v; },
    runner: { async prepare() { if (badPin) throw Error('changed pin'); return 'v1'; },
      async dispatch() { count++; if (loseAck) throw Error('lost acknowledgement'); return String(count); },
      async inspect() { return { status, ...(status === 'succeeded' ? { output: { items: [{ result: 'private-output' }], ports: {} } } : {}) }; } } };
}
async function nativeFixture(t) {
  const f = await fixture(t), state = { posts: 0, execution: null };
  const runner = createStudioNativeRunner({ api: async path => path.startsWith('/workflows') ? f.published : structuredClone(state.execution) },
    f.config.n8nNative, async (_url, options) => {
      const body = JSON.parse(options.body); state.posts++;
      const observer = createStudioRepository(f.state);
      try {
        const admitted = observer.mcp.run(owner.accountId, body.invocationId);
        assert.equal(admitted.status, 'unconfirmed');
        assert.deepEqual(admitted.checkpoint, { executionId: null, versionId: 'v1', runKey: body.invocationId,
          inputDigest: createHash('sha256').update(canonical(body.input)).digest('hex') });
      } finally { observer.close(); }
      state.execution = { id: '42', workflowId: f.compiled.grant.workflowId, workflowVersionId: 'v1', status: 'running', workflowData: f.published,
        data: { resultData: { runData: {
          'Receive input': [{ data: { main: [[{ json: { body } }]] } }],
          [f.compiled.grant.result.nodes[0]]: [{ data: { main: [[{ json: { value: 'private-output' } }]] } }],
        } } } };
      return Response.json({ executionId: '42' });
    });
  return { f, state, service: () => createStudioMcpService({ repository: f.repository, provider: f.provider,
    accountId: owner.accountId, runner }) };
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
  const rows = JSON.stringify(f.repository.db.prepare('SELECT * FROM studio_tool_runs').all());
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
  const c = controllable(), f = await fixture(t, c.runner), a = f.service();
  const other = createStudioRepository(f.state); t.after(() => other.close());
  const b = createStudioMcpService({ repository: other, provider: f.provider, accountId: owner.accountId, runner: c.runner });
  const results = await Promise.allSettled([a.run(f.input('one'), actor), b.run(f.input('two'), actor)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(c.count, 1);
  c.status = 'failed';
  assert.equal((await b.run(f.input('three'), actor)).status, 'failed');
  assert.equal(c.count, 2);
});
test('two repository connections reserve a matching run only once', async t => {
  const c = controllable(), f = await fixture(t, c.runner), a = f.service();
  const other = createStudioRepository(f.state); t.after(() => other.close());
  const b = createStudioMcpService({ repository: other, provider: f.provider, accountId: owner.accountId, runner: c.runner });
  await Promise.all([a.run(f.input(), actor), b.run(f.input(), actor)]);
  assert.equal(c.count, 1);
  await assert.rejects(b.run({ ...f.input(), arguments: { value: 'different' } }, actor), { code: 'STUDIO_RUN_KEY_CONFLICT' });
  assert.equal((await b.readRun({ runKey: 'run-one' }, actor)).status, 'running');
});
test('read-only admission uses an explicit list; no HTTP, file, wait, loop, subworkflow or Program', () => {
  const unsupported = componentRegistry.filter(d => ['Integrations', 'Files', 'Events'].includes(d.category)
    || d.id === 'execute-workflow');
  for (const d of unsupported) {
    const params = Object.fromEntries(Object.entries(d.parameters).map(([key, p]) => [key, p.default]));
    const altered = { ...definition, nodes: [{ ...definition.nodes[0], componentId: d.id, kaRef: 'urn:demo:n8n:component:' + d.id + ':unit', params }] };
    assert.throws(() => readOnlyDefinition(altered));
  }
  const loop = { ...definition, entryId: 'n0', nodes: ['loop-items', 'edit-fields', 'aggregate'].map((id, i) => ({
    id: 'n' + i, componentId: id, kaRef: 'urn:demo:n8n:component:' + id + ':unit', sourceHash: 'a'.repeat(64), x: i * 200, y: 0,
    params: Object.fromEntries(Object.entries(component(id).parameters).map(([k, p]) => [k, p.default])),
  })), edges: [[0,1,1,0],[1,0,0,0],[0,0,2,0]].map(([a,output,b,input]) => ({ from:'n'+a, output, to:'n'+b, input })) };
  assert.doesNotThrow(() => normalizeStudio(loop));
  assert.throws(() => readOnlyDefinition(loop), { code: 'STUDIO_WORKFLOW_NOT_READ_ONLY' });
});
test('withdrawal suppresses retained output but still reconciles terminal capacity', async t => {
  const c = controllable(), f = await fixture(t, c.runner), s = f.service();
  await s.run(f.input(), actor);
  s.withdraw({ kaRef: f.input().kaRef, workflowSha256: f.input().workflowSha256 }, owner);
  c.status = 'succeeded';
  const result = await s.readRun({ runKey: 'run-one' }, actor);
  assert.equal(result.status, 'succeeded'); assert.equal(result.output, undefined);
});
test('withdrawal during pending readback suppresses output and steps while durably releasing capacity', async t => {
  const c = controllable(), f = await fixture(t, c.runner), s = f.service();
  assert.equal((await s.run(f.input(), actor)).status, 'running');
  const other = createStudioRepository(f.state); t.after(() => other.close());
  const withdrawing = createStudioMcpService({ repository: other, provider: f.provider,
    accountId: owner.accountId, runner: c.runner });
  const started = Promise.withResolvers(), inspection = Promise.withResolvers();
  c.runner.inspect = async () => { started.resolve(); return inspection.promise; };
  const pending = s.readRun({ runKey: 'run-one' }, actor);
  await started.promise;
  assert.equal(other.mcp.activeAgentRun(owner.accountId).runKey, 'run-one');
  withdrawing.withdraw({ kaRef: f.input().kaRef, workflowSha256: f.input().workflowSha256 }, owner);
  inspection.resolve({ status: 'succeeded', output: { items: [{ result: 'private-output' }], ports: {} },
    steps: [{ output: { result: 'private-step-output' } }] });
  const result = await pending;
  assert.equal(result.status, 'succeeded');
  assert.equal(Object.hasOwn(result, 'output'), false);
  assert.equal(Object.hasOwn(result, 'steps'), false);
  assert.equal(other.mcp.run(owner.accountId, 'run-one').status, 'succeeded');
  assert.equal(other.mcp.activeAgentRun(owner.accountId), undefined);
  const reopened = f.restart();
  const retained = await reopened.readRun({ runKey: 'run-one' }, actor);
  assert.equal(retained.status, 'succeeded');
  assert.equal(Object.hasOwn(retained, 'output'), false);
  assert.equal(Object.hasOwn(retained, 'steps'), false);
  assert.equal(f.repository.mcp.activeAgentRun(owner.accountId), undefined);
  assert.equal(c.count, 1);
});
test('withdrawal and immutable saved snapshots survive repeat save and repository reopen', async t => {
  const c = controllable(), f = await fixture(t, c.runner), s = f.service();
  const pin = { kaRef: f.input().kaRef, workflowSha256: f.input().workflowSha256 };
  s.withdraw(pin, owner);
  const before = f.repository.mcp.savedNative(pin.kaRef);
  f.repository.completeSave(f.compiled, 'native-n8n', false, await f.provider.savedNativeSnapshot(f.compiled));
  assert.deepEqual(f.repository.mcp.savedNative(pin.kaRef), before);
  const reopened = f.restart();
  assert.deepEqual(f.repository.mcp.savedNative(pin.kaRef), before);
  assert.equal(reopened.list(owner).length, 0);
  assert.equal(reopened.get(pin, owner).approved, false);
  await assert.rejects(reopened.run(f.input(), actor), { code: 'STUDIO_WORKFLOW_WITHDRAWN' });
  assert.equal(c.count, 0);
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
  // Exercise the real preflight through admission: a changed published digest
  // must fail before the HTTP webhook is posted.
  published.nodes[0].parameters.unreviewed = true;
  const service = createStudioMcpService({ repository: f.repository, provider: f.provider, installation: f.config.n8nNative,
    accountId: owner.accountId, runner });
  assert.equal((await service.run(f.input('changed-native'), actor)).status, 'failed');
  assert.equal(count, 0);
  delete published.nodes[0].parameters.unreviewed;
  const input = runInput(f.input('native-run'), workflow);
  assert.equal(await runner.dispatch(workflow, 'native-run', input), '42');
  const checkpoint = { executionId: '42', versionId: 'v1', runKey: 'native-run',
    inputDigest: createHash('sha256').update(canonical(input)).digest('hex') };
  execution = { id: '42', workflowId: 'native-one', status: 'running' };
  assert.equal((await runner.inspect(workflow, checkpoint)).status, 'running');
  execution = { id: '42', workflowId: 'native-one', workflowVersionId: 'v1', status: 'success', workflowData: published,
    data: { resultData: { runData: {
      'Receive input': [{ data: { main: [[{ json: { body: { invocationId: 'native-run', input } } }]] } }],
      [compiled.grant.result.nodes[0]]: [{ data: { main: [[{ json: { answer: 42 } }]] } }],
    } } } };
  assert.deepEqual((await runner.inspect(workflow, checkpoint)).output.items, [{ answer: 42 }]);
  const received = execution.data.resultData.runData['Receive input'][0].data.main[0][0].json.body;
  assert.deepEqual(await runner.verifyCallback(workflow, checkpoint), received);
  // Both verification paths consume exactly the same persistence-independent
  // contract. No separately supplied run key or SQL-shaped alias is accepted.
  for (const changed of [{ executionId: '43' }, { versionId: 'v2' }, { runKey: 'wrong-run' },
    { inputDigest: 'b'.repeat(64) }, { inputDigest: null }]) {
    await assert.rejects(runner.inspect(workflow, { ...checkpoint, ...changed }), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
    await assert.rejects(runner.verifyCallback(workflow, { ...checkpoint, ...changed }), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  }
  execution.status = 'running';
  await assert.rejects(runner.verifyCallback(workflow, { ...checkpoint, inputDigest: null }), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  execution.status = 'success';
  for (const invalid of [undefined, { ...input, itemsJson: '[{"value":"another-input"}]' },
    { ...input, paramsJson: '{}' }, { ...input, executionId: 'other' }]) {
    received.input = invalid;
    await assert.rejects(runner.inspect(workflow, checkpoint), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
    await assert.rejects(runner.verifyCallback(workflow, checkpoint), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  }
  received.input = input;
  execution.workflowVersionId = 'v2'; await assert.rejects(runner.inspect(workflow, checkpoint));
  execution.workflowVersionId = 'v1';
  execution.data.resultData.runData[compiled.grant.result.nodes[0]][0].data.main[0] = Array.from({ length: 21 }, () => ({ json: { answer: 42 } }));
  assert.equal((await runner.inspect(workflow, checkpoint)).status, 'failed');
  execution.data.resultData.runData[compiled.grant.result.nodes[0]] = 'malformed';
  assert.equal((await runner.inspect(workflow, checkpoint)).status, 'failed');
  execution.workflowVersionId = 'v1'; execution.status = 'error';
  assert.equal((await runner.inspect(workflow, checkpoint)).status, 'failed');
  assert.equal(count, 1);
});
for (const status of ['success', 'error', 'canceled', 'crashed']) test(`native ${status} requires exact unique admitted input after restart before releasing capacity`, async t => {
  const { f, state, service } = await nativeFixture(t);
  let s = service();
  assert.equal((await s.run(f.input(), actor)).status, 'running');
  assert.equal(f.provider.db, undefined); // Persistence belongs to the injected repository.
  const admitted = f.repository.mcp.run(owner.accountId, 'run-one');
  f.restart(); s = service();
  assert.deepEqual(f.repository.mcp.run(owner.accountId, 'run-one'), admitted);
  state.execution.status = status;
  const original = structuredClone(state.execution);
  const received = e => e.data.resultData.runData['Receive input'][0].data.main[0][0].json.body;
  const pending = e => ({ node: { name: 'Receive input' }, data: { main: [[{ json: { body: structuredClone(received(e)) } }]] } });
  for (const [name, change] of [
    ['missing input', e => { delete received(e).input; }],
    ['changed arguments', e => { received(e).input.itemsJson = '[{"value":"other"}]'; }],
    ['changed parameters', e => { received(e).input.paramsJson = '{}'; }],
    ['changed execution input', e => { received(e).input.executionId = '42'; }],
    ['unexpected input field', e => { received(e).input.unexpected = true; }],
    ['foreign invocation', e => { received(e).invocationId = 'other-run'; }],
    ['duplicate Receive input task', e => { e.data.resultData.runData['Receive input'].push(structuredClone(e.data.resultData.runData['Receive input'][0])); }],
    ['duplicate Receive input item', e => { const items = e.data.resultData.runData['Receive input'][0].data.main[0]; items.push(structuredClone(items[0])); }],
    ['conflicting pending input', e => { e.data.executionData = { nodeExecutionStack: [pending(e)] };
      e.data.executionData.nodeExecutionStack[0].data.main[0][0].json.body.input.itemsJson = '[{"value":"other"}]'; }],
    ['pending-only terminal input', e => { e.data.executionData = { nodeExecutionStack: [pending(e)] }; delete e.data.resultData.runData['Receive input']; }],
  ]) {
    state.execution = structuredClone(original); change(state.execution);
    const result = await s.readRun({ runKey: 'run-one' }, actor);
    assert.equal(result.status, 'running', name);
    assert.equal(result.output, undefined, name);
    await assert.rejects(s.run(f.input('second'), actor), { code: 'STUDIO_BUSY' }, name);
    assert.equal(state.posts, 1, name);
  }
  state.execution = original;
  // Both representations may coexist only if they prove the same input.
  state.execution.data.executionData = { nodeExecutionStack: [pending(original)] };
  const result = await s.readRun({ runKey: 'run-one' }, actor);
  assert.equal(result.status, status === 'success' ? 'succeeded' : 'failed');
  assert.deepEqual(result.output?.items, status === 'success' ? [{ value: 'private-output' }] : undefined);
  assert.equal((await s.run(f.input('second'), actor)).status, 'running');
  assert.equal(state.posts, 2);
});

test('migration never invents an admitted input digest for legacy runs or releases their slot', async t => {
  const { f, state, service } = await nativeFixture(t);
  let s = service();
  assert.equal((await s.run(f.input(), actor)).status, 'running');
  f.repository.db.exec('ALTER TABLE studio_tool_runs DROP COLUMN input_sha256');
  const before = f.repository.mcp.run(owner.accountId, 'run-one');
  f.restart(); s = service();
  const after = f.repository.mcp.run(owner.accountId, 'run-one');
  assert.equal(after.checkpoint.inputDigest, null);
  assert.deepEqual(after, before);
  state.execution.status = 'success';
  assert.equal((await s.readRun({ runKey: 'run-one' }, actor)).output, undefined);
  assert.equal((await s.run(f.input(), actor)).status, 'running');
  assert.equal(f.repository.mcp.run(owner.accountId, 'run-one').checkpoint.inputDigest, null);
  await assert.rejects(s.run(f.input('second'), actor), { code: 'STUDIO_BUSY' });
  assert.equal(state.posts, 1);
});

test('HTTP MCP authenticates before dispatch, rejects browser/bearer/forged authority, and supports run lookup', async t => {
  const c = controllable(), f = await fixture(t, c.runner), service = f.service();
  const secret = 'fixture-service-secret'.repeat(3), secretFile = join(f.state, 'service-key');
  writeFileSync(secretFile, secret); const file = join(f.state, 'session.json');
  writeFileSync(file, JSON.stringify({ accountId: owner.accountId, controlPlaneUrl: 'http://127.0.0.1:4610', secretFile }));
  const session = loadNosStudioSession(file);
  const defaultServer = createServer(createStudioMcpHttp({ service, session }));
  await new Promise(resolve => defaultServer.listen(0, '127.0.0.1', resolve)); t.after(() => defaultServer.close());
  const server = createServer(createStudioMcpHttp({ service, session, agentEnabled: true }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const url = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'x-nos-workflows-secret': secret, 'x-nos-workflows-account': owner.accountId,
    'x-nos-workflows-principal': owner.id, 'x-nos-workflows-role': 'owner',
    'x-nos-workflows-started-by': actor.startedBy, 'x-nos-workflows-agent-version': actor.agentVersion,
    'x-nos-workflows-tool-digest': actor.toolDigest, 'x-nos-workflows-approval-decision': actor.approvalDecisionId };
  const call = (method, params, h = headers) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const defaultUrl = 'http://127.0.0.1:' + defaultServer.address().port;
  const listBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.equal((await fetch(defaultUrl, { method: 'POST', headers, body: listBody })).status, 403);
  const ownerHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) =>
    !['x-nos-workflows-started-by', 'x-nos-workflows-agent-version', 'x-nos-workflows-tool-digest', 'x-nos-workflows-approval-decision'].includes(key)));
  assert.equal((await fetch(defaultUrl, { method: 'POST', headers: ownerHeaders, body: listBody })).status, 200);
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
for (const [field, different] of [
  ['started-by', 'agent:two'],
  ['agent-version', 'version-2'],
  ['tool-digest', 'e'.repeat(64)],
  ['approval-decision', 'decision-2'],
  ['principal', 'person-two'],
]) test(`authenticated MCP run lookup isolates retained output from a different ${field}, including after reopen`, async t => {
  const { f, state, service } = await nativeFixture(t);
  const secret = 'fixture-lookup-service-secret'.repeat(3), secretFile = join(f.state, 'lookup-key');
  writeFileSync(secretFile, secret);
  const sessionFile = join(f.state, 'lookup-session.json');
  writeFileSync(sessionFile, JSON.stringify({ accountId: owner.accountId, controlPlaneUrl: 'http://127.0.0.1:4610', secretFile }));
  const session = loadNosStudioSession(sessionFile);
  const open = () => createStudioMcpHttp({ service: service(), session, agentEnabled: true });
  let handle = open();
  const server = createServer((req, res) => handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const ownerHeaders = { 'content-type': 'application/json', 'x-nos-workflows-secret': secret,
    'x-nos-workflows-account': owner.accountId, 'x-nos-workflows-principal': owner.id, 'x-nos-workflows-role': owner.role };
  const agentHeaders = { ...ownerHeaders, 'x-nos-workflows-started-by': actor.startedBy,
    'x-nos-workflows-agent-version': actor.agentVersion, 'x-nos-workflows-tool-digest': actor.toolDigest,
    'x-nos-workflows-approval-decision': actor.approvalDecisionId };
  const call = async (name, args, headers = agentHeaders) => {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
      method: 'tools/call', params: { name, arguments: args } }) });
    // All actors have valid service authentication. Rejection must come from
    // lookup ownership, independently of admission conflicts or malformed headers.
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await call('studio_run', f.input())).result.structuredContent.status, 'running');
  state.execution.status = 'success';
  const retained = (await call('studio_run_read', { runKey: 'run-one' })).result.structuredContent;
  assert.equal(retained.status, 'succeeded');
  assert.deepEqual(retained.output.items, [{ value: 'private-output' }]);
  assert.equal(retained.steps.length, 1);
  assert.equal(retained.steps[0].node, f.compiled.grant.result.traceNodes[0]);
  const verifyLookup = async () => {
    const before = f.repository.mcp.run(owner.accountId, 'run-one');
    assert.equal(before.status, 'succeeded');
    const refused = await call('studio_run_read', { runKey: 'run-one' }, { ...agentHeaders, ['x-nos-workflows-' + field]: different });
    assert.deepEqual(refused, { jsonrpc: '2.0', id: 1, result: { isError: true,
      content: [{ type: 'text', text: 'STUDIO_RUN_NOT_FOUND' }], structuredContent: { code: 'STUDIO_RUN_NOT_FOUND' } } });
    assert.deepEqual(refused, await call('studio_run_read', { runKey: 'missing-run' }));
    assert.deepEqual(f.repository.mcp.run(owner.accountId, 'run-one'), before);
    for (const headers of [agentHeaders, ownerHeaders]) {
      const allowed = (await call('studio_run_read', { runKey: 'run-one' }, headers)).result.structuredContent;
      assert.equal(allowed.status, 'succeeded');
      assert.deepEqual(allowed.output, retained.output);
      assert.deepEqual(allowed.steps, retained.steps);
      for (const key of ['startedBy', 'agentVersion', 'toolDigest', 'approvalDecisionId']) assert.equal(allowed[key], actor[key]);
      assert.equal(allowed.approvedBy, owner.id);
    }
    assert.equal(state.posts, 1);
  };
  await verifyLookup();
  f.restart(); handle = open();
  await verifyLookup();
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
