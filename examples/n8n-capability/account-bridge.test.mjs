import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

// Select account mode before importing the real bridge or any profile consumer.
const setup = mkdtempSync(join(tmpdir(), 'account-bridge-'));
const sessionFile = join(setup, 'session.json'), secretFile = join(setup, 'secret'), profileFile = join(setup, 'profile.mjs');
const secret = 'fictional-bridge-test-service-secret', accountId = 'account-bridge-test';
writeFileSync(secretFile, secret, { mode: 0o600 });
writeFileSync(sessionFile, JSON.stringify({ accountId, controlPlaneUrl: 'http://127.0.0.1:4610', secretFile, adoptExistingState: true }));
writeFileSync(profileFile, `import profile from ${JSON.stringify(new URL('./test-support/measurement-profile.mjs', import.meta.url).href)};
  export default {...profile, requiresNosActor:true, accountId:${JSON.stringify(accountId)}, authorize:async()=>{}};`);
process.env.NOS_STUDIO_SESSION_FILE = sessionFile;
process.env.NOS_DKG_PROFILE_MODULE = profileFile;
const { createCapabilityBridge } = await import('./bridge.mjs');
const { environment, definition, catalog, graphId, owner } = await import('./test-support/studio-service-fixture.mjs');
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
    program: { sourceHash: c.sourceHash }, n8n: {} }));
  for (const c of catalog) f.sources.set(c.kaRef, { programIri: c.kaRef, sourceHash: c.sourceHash, source: '', version: '1' });
  return { graphId, owner, config: f.config, client: f.client, definitions: catalog, exportTokenFile: f.exportTokenFile,
    studioOptions: { state: f.state, headerCredential: { id: 'fixture-header', name: 'Fixture' }, credentials: {} },
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
    assert.equal(f.provider.db.prepare('SELECT count(*) AS n FROM dkg_component_runs').get().n, 0);
    const view = await request(bridge, prefix, 'GET', { ...headers, 'x-nos-workflows-role': 'viewer' });
    assert.equal(view.status, 200); assert.equal(view.body.canInvoke, false);
    const result = await request(bridge, prefix + '/run', 'POST', headers, value);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.readbackVerified, true);
    assert.equal(f.invocations.length, 1); assert.equal(f.invocations[0].invocationId, invocationId);
    assert.deepEqual(JSON.parse(f.provider.db.prepare('SELECT actor FROM dkg_component_actors WHERE id=?').get(invocationId).actor),
      { id: 'owner-one', accountId, role: 'owner' });
    const changedActor = await request(bridge, prefix + '/run', 'POST', { ...headers, 'x-nos-workflows-principal': 'owner-two' }, value);
    assert.notEqual(changedActor.status, 200); assert.equal(f.invocations.length, 1);
    assert.equal((await request(bridge, prefix + '/activation', 'POST', headers, { active: true })).status, 403);
    assert.equal((await request(bridge, '/spike/ka/events/' + randomUUID(), 'POST', headers, {})).status, 403);
    assert.equal(f.invocations.length, 1);
  } finally { bridge?.close(); f.close(); }
});

test('rejected account adoption leaves legacy state reopenable; successful adoption retains account fences', async () => {
  const f = environment(); let bridge;
  try {
    const workflow = await f.service.save(definition(['schedule', 'edit-fields'], [[0,0,1,0]]), () => {});
    await f.service.activate({ kaRef: workflow.kaRef, active: true, activationId: randomUUID() }, () => {});
    const before = f.provider.row(workflow.kaRef), marker = join(f.state, 'nos-account.json');
    assert.throws(() => createCapabilityBridge(options(f)), /Deactivate legacy schedules/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(f.provider.row(workflow.kaRef), before);
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
      const {options,existing}=JSON.parse(readFileSync(0,'utf8')); options.agent={};options.client={};
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
