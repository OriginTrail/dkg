import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fixtureProgramAuthority } from './test-support/studio-authority-fixture.mjs';
import { withDkgTestDependencies } from './test-support/dkg-component-store-fixture.mjs';
import { streamedBodyOverflow } from './test-support/http-body-overflow.mjs';

// Load account mode explicitly at startup.
const setup = mkdtempSync(join(tmpdir(), 'account-bridge-'));
const sessionFile = join(setup, 'session.json'), secretFile = join(setup, 'secret'), profileFile = join(setup, 'profile.mjs');
const secret = 'fictional-bridge-test-service-secret', accountId = 'account-bridge-test';
writeFileSync(secretFile, secret, { mode: 0o600 });
writeFileSync(sessionFile, JSON.stringify({ accountId, controlPlaneUrl: 'http://127.0.0.1:4610', secretFile, adoptExistingState: true }));
writeFileSync(profileFile, `import profile from ${JSON.stringify(new URL('./test-support/measurement-profile.mjs', import.meta.url).href)};
  export default {...profile, requiresNosActor:true, accountId:${JSON.stringify(accountId)}, authorize:async()=>{}};`);
const { loadStudioContext, createStudioContext } = await import('./studio-context.mjs');
const context = await loadStudioContext({ NOS_STUDIO_SESSION_FILE: sessionFile, NOS_DKG_PROFILE_MODULE: profileFile });
const { createCapabilityBridge, handleDkgComponentCallback } = await import('./bridge.mjs');
const { createStudioFixtureContext, graphId, owner } = await import('./test-support/studio-service-fixture.mjs');
const { definition, catalog } = createStudioFixtureContext(context.profile);
const environment = () => createStudioFixtureContext({ ...context.profile }).environment();
after(() => rmSync(setup, { recursive: true, force: true }));

const headers = { 'x-nos-workflows-secret': secret, 'x-nos-workflows-account': accountId,
  'x-nos-workflows-principal': 'owner-one', 'x-nos-workflows-role': 'owner' };
const prefix = '/spike/ka/accounts/' + accountId + '/capabilities/studio';
function options(f) {
  let rawOutputs = [];
  const invoke = f.client.programs.invoke;
  f.client.programs.invoke = async value => { const result = await invoke(value); rawOutputs = result.rawOutputs; return result; };
  f.client.programs.listApprovals = async () => [];
  f.config.programBindings = catalog.map(c => ({ operationIri: c.kaRef, contextGraphId: graphId, enabled: true,
    executorAgentAddress: owner, allowedCallerAgentAddresses: [owner],
    program: { contextGraphId: graphId, programIri: c.kaRef, programLayer: 'wm', authorAgentAddress: owner, sourceHash: c.sourceHash }, n8n: {} }));
  for (const binding of f.config.programBindings) f.approvals.set(binding.operationIri, { binding: structuredClone(binding) });
  for (const c of catalog) f.sources.set(c.kaRef, { programIri: c.kaRef, sourceHash: c.sourceHash, source: '', version: '1', authorAgentAddress: owner });
  return { context: createStudioContext({ profile: f.profile, session: context.session }), graphId, owner, config: f.config, client: f.client, definitions: catalog, exportTokenFile: f.exportTokenFile, programAuthority: fixtureProgramAuthority,
    studioOptions: { state: f.state, headerCredential: { id: 'fixture-header', name: 'Fixture' }, credentials: {}, fetchImpl: f.fetchImpl },
    agent: { query: async query => ({ bindings: query.includes('orderedOutputs')
      ? rawOutputs.map(value => ({ g: `did:dkg:context-graph:${graphId}/_working_memory/${owner}/1`, output: { value } }))
      : catalog.map(c => ({ program: c.kaRef })) }) } };
}
async function request(bridge, path, method, auth, value) {
  const req = Readable.from(value === undefined ? [] : [Buffer.from(JSON.stringify(value))]);
  req.url = path; req.method = method; req.headers = auth;
  let status, body;
  await bridge.handle(req, { writeHead: s => { status = s; }, end: text => { body = JSON.parse(text); } }, path.split('?')[0]);
  return { status, body };
}
function legacyReopen(f, expectedError) {
  const env = { ...process.env }; delete env.NOS_STUDIO_SESSION_FILE; delete env.NOS_DKG_PROFILE_MODULE;
  const script = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    const {createCapabilityBridge}=await import(${JSON.stringify(new URL('./bridge.mjs', import.meta.url).href)});
    const options=JSON.parse(readFileSync(0,'utf8')); options.agent={}; options.client={};
    ${expectedError ? `assert.throws(()=>createCapabilityBridge(options), /authenticated nOS account/);`
      : 'const bridge=createCapabilityBridge(options); bridge.close();'}
    console.log('verified');`;
  const input = JSON.stringify({ graphId, owner, config: f.config, studioOptions: { state: f.state,
    headerCredential: { id: 'fixture-header', name: 'Fixture' }, credentials: {} } });
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, input, encoding: 'utf8' }).trim(), 'verified');
}

const callbackPath = '/spike/ka/internal/dkg-component';
const nativeToken = 'fictional-native-callback-route-secret-at-least-32-characters';
const nativeHeaders = { authorization: 'Bearer ' + nativeToken };
function handlerFixture() {
  const tokenFile = join(setup, 'native-token-' + randomUUID()), calls = [];
  writeFileSync(tokenFile, nativeToken, { mode: 0o600 });
  return { calls, tokenFile, async send(chunks, auth = nativeHeaders, method = 'POST') {
    const req = Readable.from(chunks); req.headers = auth; req.method = method;
    let status, body;
    await handleDkgComponentCallback(req, { writeHead: value => { status = value; }, end: text => { body = JSON.parse(text); } },
      { dkgComponent: async value => { calls.push(value); return { accepted: true }; } },
      { n8nNative: { webhookTokenFile: tokenFile } });
    return { status, body };
  } };
}

test('callback handler rejects native authentication, Origin and method failures without service dispatch', async () => {
  const h = handlerFixture(), value = { items: [{ operation: 'test' }] }, bytes = Buffer.from(JSON.stringify(value));
  for (const auth of [{}, { authorization: 'Bearer wrong' }, { authorization: 'Bearer ' + 'x'.repeat(nativeToken.length) },
    { ...nativeHeaders, origin: 'http://localhost:4620' }, { ...nativeHeaders, origin: '' }])
    assert.equal((await h.send([bytes], auth)).status, 403);
  for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await h.send([bytes], nativeHeaders, method)).status, 403);
  writeFileSync(h.tokenFile, 'short');
  assert.equal((await h.send([bytes], { authorization: 'Bearer short' })).status, 403);
  assert.deepEqual(h.calls, []);
  writeFileSync(h.tokenFile, nativeToken);
  assert.deepEqual(await h.send([bytes]), { status: 200, body: { accepted: true } });
  assert.deepEqual(h.calls, [value]);
});

test('callback handler preserves UTF-8 characters split across Buffer chunks', async () => {
  const h = handlerFixture(), value = { items: [{ operation: 'Ébavurer', label: 'Đorđe — 鋼 🔧', combining: 'e\u0301' }] };
  const bytes = Buffer.from(JSON.stringify(value)), split = bytes.indexOf(Buffer.from('É')) + 1;
  assert.equal((await h.send([bytes.subarray(0, split), bytes.subarray(split)])).status, 200);
  assert.deepEqual(h.calls, [value]);
  const bytewise = Array.from(bytes, byte => Buffer.from([byte]));
  assert.equal((await h.send(bytewise)).status, 200);
  assert.deepEqual(h.calls, [value, value]);
});

test('native callback returns HTTP 413 for an unfinished upload without dispatching', async () => {
  const h = handlerFixture();
  const res = await streamedBodyOverflow((req, res) => handleDkgComponentCallback(req, res,
    { dkgComponent: async value => { h.calls.push(value); } }, { n8nNative: { webhookTokenFile: h.tokenFile } }),
  { headers: nativeHeaders });
  assert.equal(res.status, 413);
  assert.deepEqual(res.body, { code: 'DKG_COMPONENT_UNCONFIRMED', error: 'Bounded DKG batch required' });
  assert.equal(res.destroyedBeforeResponse, false); assert.equal(res.headers.connection, 'close');
  assert.deepEqual(h.calls, []);
});

test('callback handler enforces the 16 KiB byte limit before dispatching Unicode bodies', async () => {
  const h = handlerFixture(), limit = 16384, overhead = Buffer.byteLength(JSON.stringify({ text: '' }));
  const count = Math.floor((limit - overhead) / 3);
  const text = '€'.repeat(count) + 'x'.repeat(limit - overhead - count * 3);
  const bytes = Buffer.from(JSON.stringify({ text }));
  assert.equal(bytes.length, limit);
  assert.equal((await h.send([bytes.subarray(0, 4096), bytes.subarray(4096)])).status, 200);
  assert.deepEqual(h.calls, [{ text }]);
  const oversized = Buffer.from(JSON.stringify({ text: text + 'x' }));
  assert.equal(oversized.length, limit + 1);
  assert.deepEqual(await h.send([oversized.subarray(0, 4096), oversized.subarray(4096)]),
    { status: 413, body: { code: 'DKG_COMPONENT_UNCONFIRMED', error: 'Bounded DKG batch required' } });
  assert.deepEqual(h.calls, [{ text }]);
});

async function callbackFixture() {
  const { measurements } = await import('./test-support/measurement-profile.mjs');
  const f = environment(), effects = [], profile = f.profile;
  let bridge;
  try {
    const transport = async (payload, operation) => {
      effects.push(operation);
      if (operation === 'read') return { graph: 'urn:test:measurements', measurements };
      assert.equal(operation, 'write');
      return { contextGraphId: profile.operations['dkg-write'].targetGraph, name: payload.name, digest: payload.digest,
        readbackVerified: true, metadata: { status: 'wm-sealed', reservedUal: 'urn:test:callback-asset' } };
    };
    profile.operations = withDkgTestDependencies(profile, { transport }).operations;
    writeFileSync(f.config.n8nNative.webhookTokenFile, nativeToken);
    const workflow = await f.service.save(definition(['dkg-read', 'dkg-write'], [[0, 0, 1, 0]]), () => assert.fail('DKG Write uses account authority, not Google export authorization'));
    bridge = createCapabilityBridge(options(f));
    const invocationId = randomUUID();
    assert.equal((await request(bridge, prefix + '/run', 'POST', headers,
      { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, itemsJson: '[{}]', invocationId })).status, 200);
    const { compiled } = await f.service.get(workflow.kaRef);
    const installed = f.native.get(compiled.grant.workflowId);
    const effectId = `urn:sr:effect:${invocationId}:0`;
    const received = { invocationId: effectId, input: f.invocations.at(-1).inputs[0] };
    const execution = { id: '42', workflowId: installed.id, workflowVersionId: installed.activeVersion.versionId,
      workflowData: structuredClone(installed.activeVersion), status: 'running', data: { executionData: { nodeExecutionStack: [
        { node: installed.nodes.find(n => n.name === 'Receive input'), data: { main: [[{ json: { body: received } }]] } },
      ] }, resultData: { runData: {} } } };
    f.executions.set('42', execution);
    const value = { effectId, workflowId: installed.id, executionId: '42', blockId: 'n0', items: [{}] };
    return { f, effects, value, execution, received, measurements,
      send: (value, auth = nativeHeaders, method = 'POST') => request(bridge, callbackPath, method, auth, value),
      reopen() { bridge.close(); bridge = createCapabilityBridge(options(f)); },
      close() { bridge.close(); f.close(); } };
  } catch (error) { bridge?.close(); f.close(); throw error; }
}

test('internal DKG callback route rejects credentials, Origin, methods and oversized bodies before effects', async () => {
  const h = await callbackFixture();
  try {
    const calls = h.f.calls.length;
    for (const auth of [{}, { authorization: 'Bearer wrong-token' }, { authorization: 'Bearer ' + 'x'.repeat(nativeToken.length) }, { ...headers },
      { ...nativeHeaders, origin: 'http://localhost:4620' }, { ...nativeHeaders, origin: '' }])
      assert.equal((await h.send(h.value, auth)).status, 403);
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await h.send(h.value, nativeHeaders, method)).status, 403);
    writeFileSync(h.f.config.n8nNative.webhookTokenFile, 'short');
    assert.equal((await h.send(h.value, { authorization: 'Bearer short' })).status, 403);
    writeFileSync(h.f.config.n8nNative.webhookTokenFile, nativeToken);
    assert.equal((await h.send({ ...h.value, items: [{ text: 'x'.repeat(16384) }] })).status, 413);
    assert.deepEqual(h.effects, []); assert.equal(h.f.calls.length, calls);
    assert.equal(h.f.repository.db.prepare('SELECT count(*) AS n FROM dkg_component_calls').get().n, 0);
    assert.equal((await h.send(h.value)).status, 200);
    assert.equal((await h.send(h.value)).status, 200);
    assert.deepEqual(h.effects, ['read']);
  } finally { h.close(); }
});

test('DKG callback requires recorded grant input and one durable native execution across blocks', async () => {
  const h = await callbackFixture();
  try {
    const run = body => [{ data: { main: [[{ json: { body } }]] } }];
    for (const body of [
      { ...h.received, invocationId: 'urn:sr:effect:' + randomUUID() + ':0' },
      { ...h.received, invocationId: h.received.invocationId + '1' },
      ...['itemsJson', 'paramsJson', 'executionId'].map(key => ({ ...h.received, input: { ...h.received.input, [key]: 'changed' } })),
    ]) {
      h.execution.data = { resultData: { runData: { 'Receive input': run(body) } } };
      assert.equal((await h.send(h.value)).status, 409);
    }
    for (const runs of [[], [...run(h.received), ...run(h.received)]]) {
      h.execution.data = { resultData: { runData: { 'Receive input': runs } } };
      assert.equal((await h.send(h.value)).status, 400);
    }
    const pending = body => ({ node: { name: 'Receive input' }, ...run(body)[0] });
    for (const data of [
      { executionData: { nodeExecutionStack: {} } },
      { executionData: { nodeExecutionStack: [pending(h.received), pending(h.received)] } },
      { resultData: { runData: { 'Receive input': [{ ...run(h.received)[0], error: 'failed' }] } } },
      { resultData: { runData: { 'Receive input': run(h.received) } },
        executionData: { nodeExecutionStack: [pending({ ...h.received, invocationId: 'conflicting-effect' })] } },
    ]) {
      h.execution.data = data;
      assert.equal((await h.send(h.value)).status, 400);
    }
    h.execution.data = {};
    assert.equal((await h.send(h.value)).status, 400);
    assert.deepEqual(h.effects, []);
    h.execution.data = { resultData: { runData: { 'Receive input': run(h.received) } } };
    assert.equal((await h.send(h.value)).status, 200);
    h.execution.data.executionData = { nodeExecutionStack: [pending(h.received)] };
    assert.equal((await h.send(h.value)).status, 200, 'matching running and completed representations share one input');
    h.reopen();
    h.f.executions.set('43', { ...structuredClone(h.execution), id: '43' });
    const write = { ...h.value, blockId: 'n1', items: h.measurements };
    assert.equal((await h.send({ ...write, executionId: '43' })).status, 409);
    assert.deepEqual(h.effects, ['read']);
    assert.equal((await h.send(write)).status, 200);
    assert.equal((await h.send(write)).status, 200);
    assert.deepEqual(h.effects, ['read', 'write']);
    h.f.repository.db.prepare('DELETE FROM dkg_component_native_executions').run();
    assert.equal((await h.send(write)).status, 409, 'legacy calls cannot acquire a replacement execution binding');
  } finally { h.close(); }
});

test('provider callback verification refuses changed execution, publication and credential pins before effects', async () => {
  const h = await callbackFixture();
  try {
    const execution = structuredClone(h.execution), installed = structuredClone(h.f.native.get(h.value.workflowId));
    for (const change of [
      (e) => { e.id = '43'; },
      (e) => { e.workflowId = 'another-workflow'; },
      (e) => { e.workflowVersionId = 'another-version'; },
      (e) => { e.workflowData.nodes[0].credentials = { httpHeaderAuth: { id: 'another-credential' } }; },
      (_e, w) => { w.id = 'another-workflow'; },
      (_e, w) => { w.active = false; },
      (_e, w) => { w.activeVersion.nodes[0].parameters.changed = true; },
    ]) {
      const e = structuredClone(execution), w = structuredClone(installed); change(e, w);
      h.f.executions.set(h.value.executionId, e); h.f.native.set(h.value.workflowId, w);
      assert.equal((await h.send(h.value)).status, 400);
      assert.deepEqual(h.effects, []);
      assert.equal(h.f.repository.db.prepare('SELECT count(*) AS n FROM dkg_component_calls').get().n, 0);
    }
    h.f.executions.set(h.value.executionId, execution); h.f.native.set(h.value.workflowId, installed);
    assert.equal((await h.send(h.value)).status, 200); assert.deepEqual(h.effects, ['read']);
  } finally { h.close(); }
});

test('account bridge denies unauthorized runs and journals the authenticated owner at the invocation grant', async () => {
  const f = environment(); let bridge;
  try {
    const plain = await f.service.save(definition(['edit-fields'], []), () => {});
    const workflow = await f.service.save(definition(['dkg-read'], []), () => {});
    bridge = createCapabilityBridge(options(f));
    const invocationId = randomUUID(), value = { kaRef: workflow.kaRef, sourceHash: workflow.sourceHash, itemsJson: '[{}]', invocationId };
    for (const selected of [plain, workflow]) for (const auth of [
      { ...headers, 'x-nos-workflows-role': 'viewer' }, { ...headers, 'x-nos-workflows-role': 'operator' },
      { ...headers, 'x-nos-workflows-account': 'foreign' }, { authorization: 'Bearer l1-owner-a' },
      { ...headers, authorization: 'Bearer l1-owner-a' }, { ...headers, 'x-nos-workflows-secret': 'wrong' },
    ]) assert.equal((await request(bridge, prefix + '/run', 'POST', auth,
      { ...value, kaRef: selected.kaRef, sourceHash: selected.sourceHash })).status, 403);
    assert.equal((await request(bridge, prefix.replace(accountId, 'foreign') + '/run', 'POST', headers, value)).status, 403);
    assert.equal(f.invocations.length, 0);
    assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM dkg_component_runs').get().n, 0);
    const view = await request(bridge, prefix, 'GET', { ...headers, 'x-nos-workflows-role': 'viewer' });
    assert.equal(view.status, 200); assert.equal(view.body.canInvoke, false);
    const result = await request(bridge, prefix + '/run', 'POST', headers, value);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.readbackVerified, true);
    assert.equal(f.invocations.length, 1); assert.equal(f.invocations[0].invocationId, invocationId);
    assert.deepEqual(JSON.parse(f.repository.db.prepare('SELECT actor FROM dkg_component_runs WHERE id=?').get(invocationId).actor),
      { id: 'owner-one', accountId, role: 'owner' });
    const changedActor = await request(bridge, prefix + '/run', 'POST', { ...headers, 'x-nos-workflows-principal': 'owner-two' }, value);
    assert.notEqual(changedActor.status, 200); assert.equal(f.invocations.length, 1);
    assert.equal((await request(bridge, prefix + '/activation', 'POST', headers, { active: true })).status, 403);
    assert.equal((await request(bridge, '/spike/ka/events/' + randomUUID(), 'POST', headers, {})).status, 403);
    assert.equal(f.invocations.length, 1);
  } finally { bridge?.close(); f.close(); }
});

test('account route retains the original recovery identities in a pending-write response', async () => {
  const f = environment(); let bridge;
  try {
    bridge = createCapabilityBridge(options(f));
    const invocationId = randomUUID(), n8nExecutionId = '42', actors = [];
    bridge.studio.run = async (_value, _authorize, actor) => {
      actors.push(actor);
      throw Object.assign(new Error('write unconfirmed'), { status: 409, code: 'DKG_WRITE_PENDING', invocationId, n8nExecutionId });
    };
    const result = await request(bridge, prefix + '/run', 'POST', headers, { invocationId });
    assert.equal(result.status, 409); assert.equal(result.body.code, 'DKG_WRITE_PENDING');
    assert.equal(result.body.invocationId, invocationId); assert.equal(result.body.n8nExecutionId, n8nExecutionId);
    assert.match(result.body.error, /Retry this invocation/);
    assert.deepEqual(actors, [{ id: 'owner-one', accountId, role: 'owner' }]);
  } finally { bridge?.close(); f.close(); }
});

test('rejected account adoption leaves legacy state reopenable; successful adoption retains account fences', async () => {
  const f = environment(); let bridge;
  try {
    const workflow = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: workflow.kaRef, active: true, activationId: randomUUID() }, () => {});
    const before = f.repository.lifecycle(workflow.kaRef), marker = join(f.state, 'nos-account.json');
    assert.throws(() => createCapabilityBridge(options(f)), /Deactivate legacy schedules/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(f.repository.lifecycle(workflow.kaRef), before);
    legacyReopen(f, false);
    await f.service.activate({ kaRef: workflow.kaRef, active: false, activationId: randomUUID() }, () => {});
    bridge = createCapabilityBridge(options(f));
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { accountId });
    bridge.close(); bridge = undefined;
    legacyReopen(f, true);
    const bound = readFileSync(marker, 'utf8');
    writeFileSync(marker, JSON.stringify({ accountId: 'another-account' }));
    assert.throws(() => createCapabilityBridge(options(f)), /different account/);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).accountId, 'another-account');
    writeFileSync(marker, bound);
  } finally { bridge?.close(); f.close(); }
});

test('account bridge can bind fresh state without an adoption flag but refuses an existing unbound database', () => {
  const f = environment(), fresh = mkdtempSync(join(tmpdir(), 'fresh-account-state-'));
  try {
    const session = join(setup, 'no-adoption.json');
    writeFileSync(session, JSON.stringify({ accountId, controlPlaneUrl: 'http://127.0.0.1:4610', secretFile }));
    const script = `import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
      const {createCapabilityBridge}=await import(${JSON.stringify(new URL('./bridge.mjs', import.meta.url).href)});
      const {loadStudioContext}=await import(${JSON.stringify(new URL('./studio-context.mjs', import.meta.url).href)});
      const {options,existing}=JSON.parse(readFileSync(0,'utf8')); options.agent={};options.client={};options.context=await loadStudioContext();
      if(existing)assert.throws(()=>createCapabilityBridge(options),/explicit operator adoption/);
      else {const bridge=createCapabilityBridge(options);bridge.close();} console.log('verified');`;
    for (const [state, existing] of [[fresh, false], [f.state, true]]) {
      const input = JSON.stringify({ existing, options: { graphId, owner, config: f.config,
        studioOptions: { state, headerCredential: { id: 'fixture', name: 'Fixture' }, credentials: {} } } });
      assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], { input, encoding: 'utf8',
        env: { ...process.env, NOS_STUDIO_SESSION_FILE: session } }).trim(), 'verified');
      assert.equal(existsSync(join(state, 'nos-account.json')), !existing);
    }
  } finally { f.close(); rmSync(fresh, { recursive: true, force: true }); }
});

test('pending schedule unpublication blocks account adoption until legacy cleanup succeeds', async () => {
  const f = environment(); let bridge;
  try {
    const workflow = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: workflow.kaRef, active: true, activationId: randomUUID() }, () => {});
    f.setUnpublishFailure('reject');
    await assert.rejects(f.service.activate({ kaRef: workflow.kaRef, active: false, activationId: randomUUID() }, () => {}), /provisioning/);
    f.restart();
    const before = f.repository.lifecycle(workflow.kaRef), marker = join(f.state, 'nos-account.json');
    assert.equal(before.activation.active, false);
    assert.ok(before.pendingUnpublication);
    assert.equal(f.native.get(before.providerId).active, true);
    assert.throws(() => { bridge = createCapabilityBridge(options(f)); }, /schedule cleanup/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(f.repository.lifecycle(workflow.kaRef), before);
    legacyReopen(f, false);
    f.setUnpublishFailure(null);
    await f.service.poll();
    assert.equal(f.repository.lifecycle(workflow.kaRef).pendingUnpublication, null);
    assert.equal(f.native.get(before.providerId).active, false);
    bridge = createCapabilityBridge(options(f));
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { accountId });
    bridge.close(); bridge = undefined;
    legacyReopen(f, true);
  } finally { bridge?.close(); f.close(); }
});


test('manual-only account companion starts no event worker and retains read-only history', async t => {
  const f = environment(); let bridge;
  const interval = t.mock.method(globalThis, 'setInterval', () => assert.fail('Account Studio must not start an event worker'));
  try {
    bridge = createCapabilityBridge(options(f));
    const saved = await bridge.studio.save(definition(['edit-fields'], []), () => {});
    const history = await bridge.studio.history(saved.kaRef, () => assert.fail('No event capability may be disclosed'));
    assert.deepEqual(history, { activation: { active: false, count: 0, expiresAt: undefined }, executions: [] });
    await bridge.studio.poll();
    await assert.rejects(bridge.studio.activate({ kaRef: saved.kaRef, active: true, activationId: randomUUID() }, () => {}), /events are unavailable/);
    await assert.rejects(bridge.studio.event(randomUUID(), { invocationId: randomUUID(), items: [{}] }), /events are unavailable/);
    assert.equal(interval.mock.callCount(), 0);
    assert.equal(f.invocations.length, 0);
  } finally { interval.mock.restore(); bridge?.close(); f.close(); }
});
