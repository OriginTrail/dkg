import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const { default: profile, calls } = await import('./test-support/agent-read-profile.mjs');
const { measurements } = await import('./test-support/measurement-profile.mjs');
const { profileParameters } = await import('./dkg-profile.mjs');
import { createStudioContext } from './studio-context.mjs';
const { compiler } = createStudioContext({ profile });
const { compileStudio } = compiler;
const { createStudioRepository } = await import('./studio-repository.mjs');
const { createStudioProvider } = await import('./studio-provider.mjs');
const { createStudioMcpService } = await import('./studio-mcp-service.mjs');
const { createStudioNativeRunner } = await import('./studio-native-runner.mjs');
const { dkgComponentStore } = await import('./dkg-components.mjs');
const { handleDkgComponentCallback } = await import('./bridge.mjs');

function readWorkflow() {
  const node = { id: 'read', componentId: 'dkg-read', kaRef: 'urn:demo:n8n:component:dkg-read:test', sourceHash: 'a'.repeat(64), x: 0, y: 0,
    params: Object.fromEntries(Object.entries(profileParameters(profile, 'dkg-read')).map(([key, value]) => [key, value.default])) };
  return compileStudio({ id: '123e4567-e89b-42d3-a456-426614174099', name: 'Read a sample', entryId: 'read', nodes: [node], edges: [] },
    { graphId: 'test', owner: '0x' + 'a'.repeat(40), fixture: true, headerCredential: { id: 'test', name: 'test' }, providerId: 'native-read' });
}

test('withdrawal while a DKG callback awaits account authorization prevents transport', async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-withdraw-callback-'));
  const repository = createStudioRepository(state);
  t.after(() => { repository.close(); rmSync(state, { recursive: true, force: true }); });
  const compiled = readWorkflow();
  repository.mcp.recordSavedNative(compiled, { ...compiled.workflow, id: 'native-read', versionId: 'v1', active: true });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let transports = 0, received;
  const checkedProfile = { ...profile,
    async authorize(actor) { await profile.authorize(actor); entered.resolve(); await release.promise; },
    operations: { 'dkg-read': { ...profile.operations['dkg-read'],
      transport() { transports++; throw new Error('withdrawn callback reached transport'); } } } };
  const s = createStudioMcpService({ repository, accountId: profile.accountId, compiler: createStudioContext({ profile: checkedProfile }).compiler,
    dkg: dkgComponentStore(repository.db, checkedProfile),
    runner: { async prepare() { return 'v1'; }, async dispatch(_workflow, invocationId, input) {
      received = { invocationId, input }; return '42';
    }, async inspect() { return { status: 'running' }; }, async verifyCallback() { return received; } } });
  const actor = { id: 'owner', role: 'owner', accountId: profile.accountId };
  const pin = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256 };
  const runKey = 'withdraw-during-authorization';
  await s.run({ ...pin, runKey, arguments: { sample: 'a' } }, actor);
  const pending = s.dkgComponent({ effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] });
  await entered.promise;
  try { s.withdraw(pin, actor); } finally { release.resolve(); }
  await assert.rejects(pending, { code: 'STUDIO_WORKFLOW_WITHDRAWN' });
  assert.equal(transports, 0);
  assert.equal(repository.db.prepare('SELECT COUNT(*) AS n FROM dkg_component_calls').get().n, 0);
});

test('shared callback preserves MCP routing and does not fall back after an MCP rejection', async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-callback-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const webhookTokenFile = join(state, 'token'), token = 'fixture-callback-token'.repeat(3);
  writeFileSync(webhookTokenFile, token);
  const config = { n8nNative: { webhookTokenFile } };
  let manualCalls = 0, nativeCalls = 0;
  const studio = { dkgComponent: async () => { manualCalls++; return { route: 'manual' }; } };
  async function send(mcp) {
    const req = { method: 'POST', headers: { authorization: 'Bearer ' + token },
      async *[Symbol.asyncIterator]() { yield Buffer.from('{"effectId":"run-one"}'); } };
    let status, body;
    await handleDkgComponentCallback(req, { writeHead(s) { status = s; }, end(s) { body = JSON.parse(s); } }, studio, config, mcp);
    return { status, body };
  }
  assert.deepEqual(await send({ dkgComponent: async () => { nativeCalls++; return { route: 'native' }; } }),
    { status: 200, body: { route: 'native' } });
  assert.equal(manualCalls, 0); assert.equal(nativeCalls, 1);
  assert.deepEqual(await send({ dkgComponent: async () => undefined }), { status: 200, body: { route: 'manual' } });
  const rejected = await send({ dkgComponent: async () => { throw Object.assign(new Error('Denied'), { status: 403 }); } });
  assert.equal(rejected.status, 403); assert.equal(manualCalls, 1);
});

test('native DKG callback uses the admitted pins, typed profile and full agent actor; no Program path', async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-dkg-')); t.after(() => rmSync(state, { recursive: true, force: true }));
  const compiled = readWorkflow();
  const published = { ...compiled.workflow, id: 'native-read', versionId: 'v1', active: true };
  const repository = createStudioRepository(state);
  t.after(() => { if (repository.db.isOpen) repository.close(); });
  const runKey = '123e4567-e89b-42d3-a456-426614174088';
  let inputEvidence;
  let execution = { id: '42', workflowId: 'native-read', workflowVersionId: 'v1', status: 'running', workflowData: published };
  const nativeRunner = createStudioNativeRunner({ api: async () => ({ ...execution, data: inputEvidence }) });
  // Test fixture installs the same durable saved record that a completed owner save writes.
  repository.mcp.recordSavedNative(compiled, published);
  const actor = { id: 'owner', role: 'owner', accountId: 'account-test', startedBy: 'agent:a', agentVersion: 'v1', toolDigest: 'd'.repeat(64), approvalDecisionId: 'decision-1' };
  const dkg = dkgComponentStore(repository.db, profile);
  let earlyCallback;
  const s = createStudioMcpService({ repository, dkg, accountId: actor.accountId, compiler,
    runner: { ...nativeRunner, async prepare() { return 'v1'; }, async dispatch(_workflow, invocationId, input) {
      inputEvidence = { executionData: { nodeExecutionStack: [{ node: { name: 'Receive input' },
        data: { main: [[{ json: { body: { invocationId, input } } }]] } }] } };
      earlyCallback = s.dkgComponent({ effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] });
      return '42';
    }, async inspect() { return { status: 'running' }; } } });
  const input = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256, runKey, arguments: { sample: 'a' } };
  await assert.rejects(s.run({ ...input, arguments: { sample: 'a" } UNION { ?s ?p ?o' } }, actor));
  assert.equal((await s.run(input, actor)).status, 'running');
  const callback = { effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] };
  // Default n8n progress saving retains the webhook input on its pending stack.
  const result = await earlyCallback;
  assert.equal(result.items.length, 2); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context.actor, { ...actor, runKey });
  assert.equal(calls[0].operation, 'read');
  assert.deepEqual({ ...repository.db.prepare('SELECT id, source_hash FROM dkg_component_runs').get() },
    { id: runKey, source_hash: compiled.grant.workflowSha256 });
  assert.equal(repository.db.prepare('SELECT id FROM dkg_component_calls').get().id, runKey + ':read');
  const received = inputEvidence.executionData.nodeExecutionStack[0].data.main[0][0].json.body;
  const changedRevision = { invocationId: runKey, revisionDigest: 'b'.repeat(64) };
  assert.throws(() => dkg.grant(compiled, changedRevision, received.input, { ...actor, runKey }), /different workflow or inputs/);
  await assert.rejects(dkg.call(callback, compiled, changedRevision, 'native-read', received), /approved workflow/);
  await assert.rejects(dkg.call(callback, compiled,
    { invocationId: 'other-run', revisionDigest: compiled.grant.workflowSha256 }, 'native-read', received), /approved workflow/);
  assert.equal(calls.length, 1, 'scope mismatches cannot use a cached callback or dispatch');
  await assert.rejects(s.dkgComponent({ ...callback, executionId: '43' }));
  await assert.rejects(s.dkgComponent({ ...callback, blockId: 'write' }));
  await s.dkgComponent(callback); assert.equal(calls.length, 1); // retained read cache, no second node request
  const admittedEvidence = structuredClone(inputEvidence);
  inputEvidence.executionData.nodeExecutionStack[0].data.main[0][0].json.body.input.itemsJson = '[{"sample":"different"}]';
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  inputEvidence = undefined;
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  inputEvidence = admittedEvidence;
  await s.dkgComponent(callback); assert.equal(calls.length, 1);
  const admittedExecution = structuredClone(execution);
  for (const changed of [
    { id: '43' }, { workflowId: 'foreign-workflow' }, { workflowVersionId: 'v2' },
    { workflowData: { ...published, connections: {} } }, { status: 'unknown' },
    { status: 'success' }, // A terminal callback must have completed Receive input evidence.
  ]) {
    execution = { ...admittedExecution, ...changed };
    await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  }
  execution = admittedExecution;
  const completedInput = { data: structuredClone(admittedEvidence.executionData.nodeExecutionStack[0].data) };
  inputEvidence = { resultData: { runData: { 'Receive input': [completedInput] } } };
  await s.dkgComponent(callback); assert.equal(calls.length, 1); // The same decoder accepts saved progress.
  execution.status = 'success';
  await s.dkgComponent(callback); assert.equal(calls.length, 1); // A completed callback can replay its cache.
  execution.status = 'running';
  inputEvidence.executionData = structuredClone(admittedEvidence.executionData);
  inputEvidence.executionData.nodeExecutionStack[0].data.main[0][0].json.body.input.itemsJson = '[{"sample":"conflicting"}]';
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  inputEvidence.executionData = structuredClone(admittedEvidence.executionData);
  await s.dkgComponent(callback); assert.equal(calls.length, 1);
  inputEvidence = { resultData: { runData: { 'Receive input': [{ data: { main: [[{ json: { body: { invocationId: 'foreign-run' } } }]] } }] } } };
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  inputEvidence = undefined;
  repository.db.prepare("UPDATE studio_tool_runs SET execution_id=NULL, status='unconfirmed'").run();
  await assert.rejects(s.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  repository.db.prepare("UPDATE studio_tool_runs SET execution_id='42', status='running'").run();
  const revision = profile.revision;
  profile.revision = 'f'.repeat(64);
  await assert.rejects(s.dkgComponent(callback));
  const pin = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256 };
  assert.throws(() => s.withdraw({ ...pin, workflowSha256: '0'.repeat(64) }, actor));
  const owner = { id: actor.id, accountId: actor.accountId, role: 'owner' };
  assert.throws(() => s.withdraw({ ...pin, workflowSha256: '0'.repeat(64) }, owner), { code: 'STUDIO_NATIVE_PIN_CHANGED' });
  assert.equal(s.withdraw(pin, owner).approved, false);
  profile.revision = revision;
  repository.close();
  const reopenedRepository = createStudioRepository(state);
  const reopened = createStudioProvider({ compiler, repository: reopenedRepository, config: { n8nNative: { workflows: [] } }, graphId: 'test', owner: '0x' + 'a'.repeat(40) });
  t.after(() => reopenedRepository.close());
  const restored = createStudioMcpService({ repository: reopenedRepository, provider: reopened,
    dkg: dkgComponentStore(reopenedRepository.db, profile), accountId: actor.accountId, compiler,
    runner: { async inspect() { return { status: 'succeeded', output: { secret: 'retained' } }; } } });
  assert.equal(restored.list(owner).length, 0);
  await assert.rejects(restored.run({ ...input, runKey: 'new-run' }, actor), { code: 'STUDIO_WORKFLOW_WITHDRAWN' });
  await assert.rejects(restored.dkgComponent(callback), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  assert.equal((await restored.readRun({ runKey }, actor)).output, undefined);
  assert.equal(calls.length, 1);
});

async function retainedRead(t) {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-profile-readback-'));
  let repository = createStudioRepository(state), reads = 0, posts = 0;
  t.after(() => { repository.close(); rmSync(state, { recursive: true, force: true }); });
  const selected = { ...profile, workflowTools: { ...profile.workflowTools }, operations: {
    'dkg-read': { ...profile.operations['dkg-read'], transport() { reads++; return { graph: 'urn:test:measurements', measurements }; } },
  } };
  const compiled = readWorkflow(), published = { ...compiled.workflow, id: 'native-read', versionId: 'v1', active: true };
  repository.mcp.recordSavedNative(compiled, published);
  const actor = { id: 'owner', role: 'owner', accountId: profile.accountId, startedBy: 'agent:a',
    agentVersion: 'v1', toolDigest: 'd'.repeat(64), approvalDecisionId: 'decision-1' };
  const runKey = 'profile-readback', pin = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256 };
  const execution = { id: '42', workflowId: 'native-read', workflowVersionId: 'v1', status: 'running', workflowData: published };
  const native = createStudioNativeRunner({ api: async () => execution });
  const runner = { ...native, async prepare() { return 'v1'; }, async dispatch(_workflow, invocationId, input) {
    posts++;
    execution.data = { resultData: { runData: { 'Receive input': [{ data: { main: [[{ json: { body: { invocationId, input } } }]] } }] } } };
    return execution.id;
  } };
  const open = currentProfile => createStudioMcpService({ repository, runner, accountId: actor.accountId,
    compiler: createStudioContext({ profile: currentProfile }).compiler, dkg: dkgComponentStore(repository.db, currentProfile) });
  const service = open(selected);
  assert.equal((await service.run({ ...pin, runKey, arguments: { sample: 'a' } }, actor)).status, 'running');
  const result = await service.dkgComponent({ effectId: runKey, workflowId: 'native-read', executionId: '42', blockId: 'read', items: [{ sample: 'a' }] });
  execution.data.resultData.runData[compiled.grant.result.nodes[0]] = [{ data: { main: [result.items.map(json => ({ json }))] } }];
  execution.status = 'success';
  return { selected, actor, runKey, pin, service, runner, get repository() { return repository; },
    counts: () => ({ reads, posts }), restart(currentProfile) { repository.close(); repository = createStudioRepository(state); return open(currentProfile); } };
}
function assertSuppressed(result) {
  assert.equal(result.status, 'succeeded');
  assert.equal(Object.hasOwn(result, 'output'), false);
  assert.equal(Object.hasOwn(result, 'steps'), false);
}

for (const [name, change] of [
  ['changed revision', p => ({ ...p, revision: 'f'.repeat(64) })],
  ['removed profile', () => null],
  ['disabled read operation', p => ({ ...p, operations: { 'dkg-read': { ...p.operations['dkg-read'], enabled: () => false } } })],
  ['foreign profile account', p => ({ ...p, accountId: 'foreign-account' })],
  ['revoked account authorization', p => ({ ...p, async authorize() { throw new Error('owner revoked'); } })],
]) test(`MCP lookup suppresses DKG results for ${name} after restart while reconciling terminal capacity`, async t => {
  const f = await retainedRead(t);
  assert.ok(f.repository.mcp.activeAgentRun(f.actor.accountId));
  let service = f.restart(change(f.selected));
  assertSuppressed(await service.readRun({ runKey: f.runKey }, f.actor));
  assert.equal(f.repository.mcp.activeAgentRun(f.actor.accountId), undefined);
  assert.equal(f.repository.mcp.run(f.actor.accountId, f.runKey).status, 'succeeded');
  service = f.restart(change(f.selected));
  assertSuppressed(await service.readRun({ runKey: f.runKey }, f.actor));
  const authorizations = [];
  service = f.restart({ ...f.selected, async authorize(actor) { authorizations.push(actor); await profile.authorize(actor); } });
  const restored = await service.readRun({ runKey: f.runKey }, f.actor);
  assert.deepEqual(restored.output.items, measurements); assert.ok(restored.steps.length);
  assert.deepEqual(authorizations, [{ ...f.actor, runKey: f.runKey }]);
  assert.deepEqual(f.counts(), { reads: 1, posts: 1 });
});

test('a changed profile hides already completed DKG output and traces after repository reopen', async t => {
  const f = await retainedRead(t);
  const completed = await f.service.readRun({ runKey: f.runKey }, f.actor);
  assert.deepEqual(completed.output.items, measurements); assert.ok(completed.steps.length);
  const service = f.restart({ ...f.selected, revision: 'f'.repeat(64) });
  assert.throws(() => service.get(f.pin, f.actor));
  assertSuppressed(await service.readRun({ runKey: f.runKey }, f.actor));
  assert.deepEqual(f.counts(), { reads: 1, posts: 1 });
});

test('a profile change during native readback suppresses output and releases the verified terminal slot', async t => {
  const f = await retainedRead(t), started = Promise.withResolvers(), release = Promise.withResolvers();
  const inspect = f.runner.inspect;
  f.runner.inspect = async (...args) => { started.resolve(); await release.promise; return inspect(...args); };
  const pending = f.service.readRun({ runKey: f.runKey }, f.actor);
  await started.promise;
  try { f.selected.revision = 'f'.repeat(64); } finally { release.resolve(); }
  assertSuppressed(await pending);
  assert.equal(f.repository.mcp.activeAgentRun(f.actor.accountId), undefined);
  assert.deepEqual(f.counts(), { reads: 1, posts: 1 });
});

for (const change of ['profile revision', 'withdrawal']) test(`MCP lookup rechecks ${change} after asynchronous profile authorization`, async t => {
  const f = await retainedRead(t), started = Promise.withResolvers(), release = Promise.withResolvers();
  f.selected.authorize = async actor => { assert.deepEqual(actor, { ...f.actor, runKey: f.runKey }); started.resolve(); await release.promise; };
  const pending = f.service.readRun({ runKey: f.runKey }, f.actor);
  // A missing authorization call must fail the regression rather than hang it.
  assert.equal(await Promise.race([started.promise.then(() => 'authorized'), pending.then(() => 'disclosed')]), 'authorized');
  try {
    if (change === 'profile revision') f.selected.revision = 'f'.repeat(64);
    else f.service.withdraw(f.pin, { id: f.actor.id, accountId: f.actor.accountId, role: 'owner' });
  } finally { release.resolve(); }
  assertSuppressed(await pending);
  assert.equal(f.repository.mcp.activeAgentRun(f.actor.accountId), undefined);
  assert.deepEqual(f.counts(), { reads: 1, posts: 1 });
});

for (const reopen of [false, true]) test(`colon-prefixed MCP run keys bind and read independently${reopen ? ' after repository reopen' : ''}`, async t => {
  const state = mkdtempSync(join(tmpdir(), 'studio-mcp-keys-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  let repository = createStudioRepository(state);
  t.after(() => repository.close());
  const compiled = readWorkflow(), published = { ...compiled.workflow, id: 'native-read', versionId: 'v1', active: true };
  repository.mcp.recordSavedNative(compiled, published);
  const actor = { id: 'owner', role: 'owner', accountId: profile.accountId };
  const executions = new Map(), reads = [];
  const scoped = { ...profile, operations: { 'dkg-read': { ...profile.operations['dkg-read'], transport(request, context) {
    reads.push({ request, actor: context.actor });
    return { graph: 'urn:test:measurements', measurements };
  } } } };
  const native = createStudioNativeRunner({ api: async path => executions.get(path.match(/\/executions\/(\d+)/)[1]) });
  const runner = { ...native, async prepare() { return 'v1'; }, async dispatch(_workflow, runKey, input) {
    const id = String(42 + executions.size);
    executions.set(id, { id, workflowId: 'native-read', workflowVersionId: 'v1', status: 'running', workflowData: published,
      data: { resultData: { runData: { 'Receive input': [{ data: { main: [[{ json: { body: { invocationId: runKey, input } } }]] } }] } } } });
    return id;
  } };
  const open = () => createStudioMcpService({ repository, runner, accountId: profile.accountId, compiler: createStudioContext({ profile: scoped }).compiler,
    dkg: dkgComponentStore(repository.db, scoped) });
  let service = open();
  async function admit(runKey, sample) {
    const run = await service.run({ kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256,
      runKey, arguments: { sample } }, actor);
    assert.equal(run.status, 'running');
    return { effectId: runKey, workflowId: 'native-read', executionId: run.n8nExecutionId, blockId: 'read', items: [{ sample }] };
  }
  async function complete(callback, result) {
    const execution = executions.get(callback.executionId);
    execution.status = 'success';
    execution.data.resultData.runData[compiled.grant.result.nodes[0]] = [{ data: { main: [result.items.map(json => ({ json }))] } }];
    assert.equal((await service.readRun({ runKey: callback.effectId }, actor)).status, 'succeeded');
  }
  const child = await admit('run-one:child', 'a'), childResult = await service.dkgComponent(child);
  await complete(child, childResult);
  assert.equal(reads.length, 1);
  if (reopen) {
    // Model a persisted journal from before explicit call ownership.
    repository.db.exec(`DROP INDEX dkg_component_call_owner;
      ALTER TABLE dkg_component_calls DROP COLUMN invocation_id;
      ALTER TABLE dkg_component_calls DROP COLUMN block_id;`);
    repository.close(); repository = createStudioRepository(state); service = open();
  }
  const retained = repository.db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get('run-one:child:read');
  assert.ok(retained.response);
  assert.equal(retained.invocation_id, 'run-one:child'); assert.equal(retained.block_id, 'read');
  const parent = await admit('run-one', 'b'), parentResult = await service.dkgComponent(parent);
  assert.deepEqual(parentResult, { items: measurements });
  assert.deepEqual(reads.map(read => [read.request.sample, read.actor.runKey]), [['a', 'run-one:child'], ['b', 'run-one']]);
  assert.deepEqual(await service.dkgComponent(parent), parentResult);
  assert.equal(reads.length, 2, 'a repeated callback uses only its own cached read');
  await assert.rejects(service.dkgComponent({ ...parent, executionId: child.executionId }), { code: 'STUDIO_NATIVE_UNCONFIRMED' });
  assert.deepEqual(repository.db.prepare('SELECT * FROM dkg_component_calls WHERE id=?').get('run-one:child:read'), retained);
  const bindings = repository.db.prepare('SELECT id, effect_id, workflow_id, execution_id FROM dkg_component_native_executions ORDER BY id').all();
  assert.deepEqual(bindings.map(row => ({ ...row })), [parent, child].map(callback => ({ id: callback.effectId,
    effect_id: callback.effectId, workflow_id: callback.workflowId, execution_id: callback.executionId })));
  await complete(parent, parentResult);
  repository.close(); repository = createStudioRepository(state); service = open();
  for (const runKey of ['run-one', 'run-one:child'])
    assert.equal((await service.readRun({ runKey }, actor)).status, 'succeeded');
  assert.equal(reads.length, 2);
  assert.equal(executions.size, 2);
});
