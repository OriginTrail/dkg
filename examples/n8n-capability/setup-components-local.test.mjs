import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { normalizeWorkflow } from './workflow.mjs';
import { n8nWorkflowSha256, n8nResultSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { createNativeN8nWorkflowAdapter } from '../../packages/cli/dist/semantic-runtime-n8n-native-adapter.js';
import { loadStudioCredentials } from './studio-credentials.mjs';
import { createStudioProvider } from './studio-provider.mjs';
import { createStudioRepository } from './studio-repository.mjs';

const profile = fileURLToPath(new URL('./test-support/measurement-profile.mjs', import.meta.url));
const nativeSchema = `CREATE TABLE IF NOT EXISTS workflow_entity(id TEXT PRIMARY KEY,nodes TEXT,connections TEXT,settings TEXT,activeVersionId TEXT,versionId TEXT);
  CREATE TABLE IF NOT EXISTS workflow_history(versionId TEXT PRIMARY KEY,workflowId TEXT,nodes TEXT,connections TEXT);`;
function fixture({ authenticated = false, reverse = false } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'component-install-')), cli = join(state, 'fixture-cli.mjs');
  // Fake only the external CLI. The real installer, templates, manifest and SQLite
  // verification all run unchanged in a fresh process for each invocation.
  writeFileSync(cli, `
    import {mkdirSync,readFileSync,readdirSync,appendFileSync} from 'node:fs';
    import {join} from 'node:path'; import {DatabaseSync} from 'node:sqlite';
    const dir=join(process.env.N8N_USER_FOLDER,'.n8n');mkdirSync(dir,{recursive:true});
    const db=new DatabaseSync(join(dir,'database.sqlite'));
    db.exec(${JSON.stringify(nativeSchema)});
    const args=process.argv.slice(2);
    appendFileSync(join(process.env.N8N_USER_FOLDER,'commands.log'),JSON.stringify(args)+'\\n');
    if(args[0]==='import:workflow') {
      const input=args.find(a=>a.startsWith('--input=')).slice(8);
      for(const file of readdirSync(input)) {
        const w=JSON.parse(readFileSync(join(input,file),'utf8'));
        if(process.env.FIXTURE_SKIP_COMPONENT && w.id.startsWith(process.env.FIXTURE_SKIP_COMPONENT))continue;
        db.prepare('INSERT OR REPLACE INTO workflow_entity VALUES(?,?,?,?,NULL,?)').run(w.id,JSON.stringify(w.nodes),JSON.stringify(w.connections),JSON.stringify(w.settings??{}),w.versionId);
        db.prepare('INSERT INTO workflow_history VALUES(?,?,?,?)').run(w.versionId,w.id,JSON.stringify(w.nodes),JSON.stringify(w.connections));
      }
      console.log('Successfully imported workflows');
    } else if(args[0]==='publish:workflow') {
      const id=args.find(a=>a.startsWith('--id=')).slice(5);
      if(process.env.FIXTURE_FAIL_PUBLICATION && id.startsWith(process.env.FIXTURE_FAIL_PUBLICATION))throw new Error('publication interrupted');
      db.prepare('UPDATE workflow_entity SET activeVersionId=versionId WHERE id=?').run(id);
      console.log('Publishing workflow');
    } else throw new Error('Unsupported fixture command');
    db.close();
  `);
  const manifestFile = join(state, 'components.json');
  const run = (only, selectedProfile, extraEnv = {}) => {
    const env = { ...process.env, ...extraEnv }; delete env.NOS_DKG_PROFILE_MODULE; delete env.NOS_STUDIO_SESSION_FILE;
    if (selectedProfile) env.NOS_DKG_PROFILE_MODULE = selectedProfile;
    const result = execFileSync(process.execPath, [fileURLToPath(new URL('./setup-components-local.mjs', import.meta.url)), state,
      ...(!authenticated ? ['--fixture'] : []), '--install', '--n8n-cli', cli, ...(only ? ['--only', only] : [])], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return JSON.parse(result);
  };
  const native = () => {
    const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'), { readOnly: true });
    try { return new Map(db.prepare('SELECT * FROM workflow_entity').all().map(row => [row.id, row])); } finally { db.close(); }
  };
  if (authenticated) seedConnections(state, reverse);
  return { state, run, native, manifestFile, manifest: () => JSON.parse(readFileSync(manifestFile, 'utf8')),
    commands: () => readFileSync(join(state, 'n8n/commands.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    close: () => rmSync(state, { recursive: true, force: true }) };
}

const refs = account => Object.fromEntries(['httpHeaderAuth', 'googleSheetsOAuth2Api', 'googleDriveOAuth2Api']
  .map(kind => [kind, { id: kind + '-' + account, name: kind + ' account ' + account }]));
const selected = refs('A');
function editNative(state, change) {
  const db = new DatabaseSync(join(state, 'n8n/.n8n/database.sqlite'));
  try { return change(db); } finally { db.close(); }
}
function seedConnections(state, reverse) {
  mkdirSync(join(state, 'runtime'), { recursive: true });
  const runtime = new DatabaseSync(join(state, 'runtime/semantic-runtime.sqlite'));
  runtime.exec('CREATE TABLE program_configuration(kind TEXT,context_graph_id TEXT,payload TEXT)');
  runtime.prepare('INSERT INTO program_configuration VALUES(?,?,?)').run('binding', 'n8n-capability-poc', JSON.stringify({ executorAgentAddress: '0x' + '1'.repeat(40) }));
  runtime.close();
  mkdirSync(join(state, 'n8n/.n8n'), { recursive: true });
  const bootstrap = { id: 'bootstrap', ...normalizeWorkflow(selected.httpHeaderAuth, 'dkg-capability-bootstrap') };
  const unrelated = { id: 'unrelated', nodes: [{ type: 'n8n-nodes-base.httpRequest', credentials: refs('B') }], connections: {}, settings: {} };
  editNative(state, db => {
    db.exec(nativeSchema + 'CREATE TABLE credentials_entity(id TEXT PRIMARY KEY,name TEXT,type TEXT)');
    for (const account of ['A', 'B']) for (const [kind, ref] of Object.entries(refs(account)))
      db.prepare('INSERT INTO credentials_entity VALUES(?,?,?)').run(ref.id, ref.name, kind);
    for (const w of reverse ? [unrelated, bootstrap] : [bootstrap, unrelated])
      db.prepare('INSERT INTO workflow_entity VALUES(?,?,?,?,?,?)').run(w.id, JSON.stringify(w.nodes), JSON.stringify(w.connections), JSON.stringify(w.settings), w.id + '-v1', w.id + '-v1');
  });
  writeFileSync(join(state, 'n8n.json'), JSON.stringify({ grant: { workflowId: bootstrap.id, workflowSha256: n8nWorkflowSha256(bootstrap) } }));
  writeFileSync(join(state, 'studio-connections.json'), JSON.stringify({ googleSheetsOAuth2Api: selected.googleSheetsOAuth2Api, googleDriveOAuth2Api: selected.googleDriveOAuth2Api }));
}
function assertSelectedCredentials(workflow) {
  const webhook = workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.deepEqual(webhook.credentials.httpHeaderAuth, selected.httpHeaderAuth);
  const connections = workflow.nodes.flatMap(node => Object.entries(node.credentials ?? {}));
  assert.ok(connections.some(([kind]) => kind.startsWith('google')));
  for (const [kind, ref] of connections) assert.deepEqual(ref, selected[kind]);
}

for (const reverse of [false, true]) test(`authenticated installation pins connections despite unrelated workflows (reverse order: ${reverse})`, () => {
  const f = fixture({ authenticated: true, reverse });
  try {
    f.run('google-sheets,google-drive');
    const before = f.manifest(), native = f.native();
    assert.equal(before.components.length, 2);
    for (const item of before.components) {
      assert.equal(item.enabled, true);
      assertSelectedCredentials({ nodes: JSON.parse(native.get(item.grant.workflowId).nodes) });
    }
    // A later unrelated reference must not change either installed or newly saved pins.
    editNative(f.state, db => db.prepare('INSERT INTO workflow_entity (id,nodes,connections,settings) VALUES(?,?,?,?)')
      .run('later-unrelated', JSON.stringify([{ credentials: refs('B') }]), '{}', '{}'));
    f.run('google-sheets');
    assert.deepEqual(f.manifest().components.find(item => item.descriptor.id === 'google-sheets'), before.components[0]);
    assert.deepEqual(f.manifest().components.find(item => item.descriptor.id === 'google-drive'), before.components[1]);
    for (const item of before.components) assert.deepEqual(f.native().get(item.grant.workflowId), native.get(item.grant.workflowId));
    assert.deepEqual(loadStudioCredentials(f.state), { headerCredential: selected.httpHeaderAuth, credentials: selected });
  } finally { f.close(); }
});

test('unchanged reinstall recovers an acknowledged spreadsheet execution without replacing its version or dispatching again', async t => {
  const f = fixture({ authenticated: true });
  try {
    f.run('google-sheets');
    const item = f.manifest().components[0], grant = item.grant;
    const stored = f.native().get(grant.workflowId);
    const definition = { id: stored.id, versionId: stored.activeVersionId, nodes: JSON.parse(stored.nodes),
      connections: JSON.parse(stored.connections), settings: JSON.parse(stored.settings) };
    const apiTokenFile = join(f.state, 'api-token'), webhookTokenFile = join(f.state, 'webhook-token');
    for (const path of [apiTokenFile, webhookTokenFile]) writeFileSync(path, 'fictional-recovery-test-only');
    const graph = 'n8n-capability-poc', executor = '0x' + '1'.repeat(40);
    const config = { baseUrl: 'http://127.0.0.1:45670', apiTokenFile, webhookTokenFile,
      workflows: [{ contextGraphId: graph, executorAgentAddress: executor, workflowId: grant.workflowId,
        workflowSha256: grant.workflowSha256, resultSha256: n8nResultSha256(grant) }] };
    const authorization = { effectId: 'reinstall-recovery', attemptId: 'first', requestDigest: new Uint8Array(32).fill(1),
      capabilityId: 'fixture-capability', policyDecisionId: 'fixture-policy' };
    const checkpointFile = join(f.state, 'checkpoint.json');
    const adapter = () => createNativeN8nWorkflowAdapter(graph, executor, grant, config, async () => {}, {
      adapterCheckpoint() { return existsSync(checkpointFile) ? { version: 1, payload: readFileSync(checkpointFile) } : undefined; },
      writeAdapterCheckpoint(id, digest, payload) {
        assert.equal(id, authorization.effectId); assert.deepEqual(digest, authorization.requestDigest);
        writeFileSync(checkpointFile, payload); return 1;
      },
    });
    let posts = 0, interrupted = true, changedVersion = false;
    const spreadsheet = { spreadsheetId: 'already-created-sheet' };
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const path = new URL(url).pathname;
      if (options?.method === 'POST') { posts++; assert.match(path, /^\/webhook\//); return Response.json({ executionId: '42' }); }
      if (path.startsWith('/api/v1/workflows/')) {
        const current = f.native().get(grant.workflowId);
        return Response.json({ ...definition, active: true, versionId: changedVersion ? 'foreign-version' : current.activeVersionId });
      }
      assert.match(path, /^\/api\/v1\/executions\/42$/);
      assert.ok(existsSync(checkpointFile), 'acknowledgement must be durable before inspection');
      if (interrupted) throw new Error('terminal readback interrupted after creating spreadsheet');
      return Response.json({ id: '42', workflowId: grant.workflowId, workflowVersionId: definition.versionId,
        workflowData: definition, status: 'success', data: { resultData: { runData: {
          [grant.result.nodes[0]]: [{ data: { main: [[{ json: spreadsheet }]] } }],
        } } } });
    });
    const input = { itemsJson: '[{"value":1}]', paramsJson: '{"title":"Recovery fixture"}', executionId: '' };
    await assert.rejects(adapter().dispatch(authorization, input), /N8N_INVOCATION_FAILED/);
    const checkpoint = readFileSync(checkpointFile, 'utf8'), commands = f.commands();
    assert.equal(JSON.parse(checkpoint).versionId, definition.versionId);
    assert.equal(posts, 1);
    f.run('google-sheets');
    interrupted = false;
    const result = await adapter().resume(authorization, input);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(JSON.parse(JSON.parse(result.output).output.itemsJson), [spreadsheet]);
    assert.equal(JSON.parse(result.output).n8nExecutionId, '42');
    assert.equal(posts, 1);
    assert.equal(readFileSync(checkpointFile, 'utf8'), checkpoint);
    assert.deepEqual(f.native().get(grant.workflowId), stored);
    assert.deepEqual(f.commands(), commands, 'unchanged components and echo must not be imported or republished');
    changedVersion = true;
    await assert.rejects(adapter().resume(authorization, input), /N8N_EXECUTION_NOT_VERIFIED/);
    assert.equal(posts, 1, 'the strict recovery version fence must remain intact');
  } finally { f.close(); }
});

test('retry after interrupted publication publishes the already imported version without another import', () => {
  const f = fixture();
  try {
    assert.throws(() => f.run('edit-fields', undefined, { FIXTURE_FAIL_PUBLICATION: 'nos_edit_fields_' }), /publication interrupted/);
    const stored = [...f.native().values()].find(w => w.id.startsWith('nos_edit_fields_'));
    assert.ok(stored.versionId); assert.equal(stored.activeVersionId, null);
    assert.equal(existsSync(f.manifestFile), false);
    const commands = f.commands();
    f.run('edit-fields');
    assert.deepEqual({ ...f.native().get(stored.id) }, { ...stored, activeVersionId: stored.versionId });
    assert.deepEqual(f.commands().slice(commands.length), [['publish:workflow', '--id=' + stored.id]]);
    assert.equal(f.manifest().components[0].grant.workflowId, stored.id);
  } finally { f.close(); }
});

for (const changed of ['stored definition', 'published definition', 'manifest pin']) test(`reinstall rejects changed ${changed} before any native mutation`, () => {
  const f = fixture();
  try {
    f.run('edit-fields');
    const item = f.manifest().components[0];
    if (changed === 'manifest pin') {
      const manifest = f.manifest(); manifest.components[0].grant.workflowSha256 = 'b'.repeat(64);
      writeFileSync(f.manifestFile, JSON.stringify(manifest));
    } else editNative(f.state, db => {
      const row = f.native().get(item.grant.workflowId), nodes = JSON.parse(row.nodes);
      nodes[0].parameters.changed = true;
      if (changed === 'stored definition') db.prepare('UPDATE workflow_entity SET nodes=? WHERE id=?').run(JSON.stringify(nodes), row.id);
      else db.prepare('UPDATE workflow_history SET nodes=? WHERE versionId=?').run(JSON.stringify(nodes), row.activeVersionId);
    });
    const before = f.native(), manifest = readFileSync(f.manifestFile, 'utf8'), commands = f.commands();
    assert.throws(() => f.run('edit-fields,limit'), /native revision|Native component revision/);
    assert.deepEqual(f.native(), before);
    assert.deepEqual(f.commands(), commands);
    assert.equal(readFileSync(f.manifestFile, 'utf8'), manifest);
  } finally { f.close(); }
});

test('companion connection reload keeps operator pins when provisioning a new Studio export', async () => {
  const f = fixture({ authenticated: true });
  let repository;
  try {
    f.run('google-sheets');
    const cap = f.manifest().components[0];
    const before = loadStudioCredentials(f.state);
    editNative(f.state, db => db.prepare('INSERT INTO workflow_entity (id,nodes,connections,settings) VALUES(?,?,?,?)')
      .run('later-unrelated', JSON.stringify([{ credentials: refs('B') }]), '{}', '{}'));
    const reloaded = loadStudioCredentials(f.state);
    assert.deepEqual(reloaded, before);
    const tokenFile = join(f.state, 'synthetic-api-token'); writeFileSync(tokenFile, 'synthetic-test-token');
    repository = createStudioRepository(join(f.state, 'studio'));
    let native;
    const provider = createStudioProvider({ repository, ...reloaded, graphId: 'test', owner: '0x' + '1'.repeat(40),
      config: { n8nNative: { workflows: [], baseUrl: 'http://127.0.0.1:1', apiTokenFile: tokenFile } },
      fetchImpl: async (url, { method, body }) => {
        if (url.search) return Response.json({ data: [] });
        if (method === 'POST' && url.pathname === '/api/v1/workflows') native = { ...JSON.parse(body), id: 'saved-export', active: false };
        else if (method === 'PUT') native = { ...JSON.parse(body), id: native.id, active: false };
        else if (url.pathname.endsWith('/publish')) native.active = true;
        return Response.json(native);
      } });
    await provider.provision({ id: '123e4567-e89b-42d3-a456-426614174099', name: 'Pinned export', entryId: 'export',
      nodes: [{ id: 'export', componentId: cap.descriptor.id, kaRef: cap.kaRef, sourceHash: 'a'.repeat(64), x: 0, y: 0,
        params: { title: 'Synthetic export' } }], edges: [] });
    assertSelectedCredentials(native);
    assert.equal(native.active, true);
  } finally { repository?.close(); f.close(); }
});

for (const mode of ['missing bootstrap', 'changed bootstrap', 'ambiguous bootstrap', 'missing OAuth', 'wrong OAuth type'])
  test(`authenticated installation rejects ${mode} before replacing existing pins`, () => {
    const f = fixture({ authenticated: true });
    try {
      f.run('google-sheets');
      const manifest = readFileSync(f.manifestFile, 'utf8');
      editNative(f.state, db => {
        if (mode === 'missing bootstrap') db.prepare('DELETE FROM workflow_entity WHERE id=?').run('bootstrap');
        if (mode === 'changed bootstrap' || mode === 'ambiguous bootstrap') {
          const w = normalizeWorkflow(selected.httpHeaderAuth, 'dkg-capability-bootstrap');
          if (mode === 'changed bootstrap') w.nodes[0].credentials.httpHeaderAuth = refs('B').httpHeaderAuth;
          else w.nodes.push({ ...w.nodes[0], id: 'other', name: 'Other webhook', credentials: { httpHeaderAuth: refs('B').httpHeaderAuth } });
          db.prepare('UPDATE workflow_entity SET nodes=? WHERE id=?').run(JSON.stringify(w.nodes), 'bootstrap');
          if (mode === 'ambiguous bootstrap') writeFileSync(join(f.state, 'n8n.json'), JSON.stringify({ grant: { workflowId: 'bootstrap', workflowSha256: n8nWorkflowSha256(w) } }));
        }
        if (mode === 'missing OAuth') db.prepare('DELETE FROM credentials_entity WHERE id=?').run(selected.googleSheetsOAuth2Api.id);
        if (mode === 'wrong OAuth type') db.prepare('UPDATE credentials_entity SET type=? WHERE id=?').run('httpHeaderAuth', selected.googleSheetsOAuth2Api.id);
      });
      const native = f.native();
      assert.throws(() => f.run('google-sheets'), /bootstrap workflow|credential reference/);
      assert.throws(() => loadStudioCredentials(f.state), /bootstrap workflow|credential reference/);
      assert.equal(readFileSync(f.manifestFile, 'utf8'), manifest);
      assert.deepEqual(f.native(), native);
    } finally { f.close(); }
  });

test('OAuth requires explicit selection; the earlier operator-selected CSV connection is a supported fallback', () => {
  const f = fixture({ authenticated: true });
  try {
    rmSync(join(f.state, 'studio-connections.json'));
    f.run('google-sheets,google-drive');
    assert.ok(f.manifest().components.every(item => !item.enabled));
    assert.deepEqual(Object.keys(loadStudioCredentials(f.state).credentials), ['httpHeaderAuth']);
    const csv = id => ({ kind: 'google-sheets-export', enabled: true, googleCredentialId: id });
    writeFileSync(join(f.state, 'csv-components.json'), JSON.stringify({ components: [csv(selected.googleSheetsOAuth2Api.id)] }));
    assert.deepEqual(loadStudioCredentials(f.state).credentials.googleSheetsOAuth2Api,
      { id: selected.googleSheetsOAuth2Api.id, name: 'Google Sheets OAuth connection' });
    writeFileSync(join(f.state, 'csv-components.json'), JSON.stringify({ components: [csv(selected.googleSheetsOAuth2Api.id), csv(refs('B').googleSheetsOAuth2Api.id)] }));
    assert.throws(() => loadStudioCredentials(f.state), /Ambiguous Google Sheets connection/);
    writeFileSync(join(f.state, 'studio-connections.json'), '{}');
    assert.deepEqual(Object.keys(loadStudioCredentials(f.state).credentials), ['httpHeaderAuth']);
  } finally { f.close(); }
});

test('partial profile installation adds Read/Write while preserving unselected components and their pins', () => {
  const f = fixture();
  try {
    f.run();
    const original = f.manifest().components, native = f.native();
    assert.equal(original.length, 31);
    assert.equal(f.run('dkg-read,dkg-write', profile).prepared, 2);
    const installed = f.manifest().components;
    assert.equal(installed.length, 33);
    assert.equal(installed.some(c => c.descriptor.id === 'invoke-dkg-program'), false);
    for (const old of original) {
      assert.deepEqual(installed.find(c => c.kaRef === old.kaRef), old);
      assert.deepEqual(f.native().get(old.grant.workflowId), native.get(old.grant.workflowId));
    }
    const write = installed.find(c => c.descriptor.id === 'dkg-write');
    const oldRead = installed.find(c => c.descriptor.id === 'dkg-read');
    const changedProfile = join(f.state, 'changed-profile.mjs');
    writeFileSync(changedProfile, `import p from ${JSON.stringify(new URL('./test-support/measurement-profile.mjs', import.meta.url).href)};export default {...p,revision:'${'d'.repeat(64)}'};`);
    f.run('dkg-read', changedProfile);
    const updated = f.manifest().components;
    assert.deepEqual(updated.find(c => c.kaRef === write.kaRef), write);
    assert.deepEqual(updated.find(c => c.kaRef === oldRead.kaRef), { ...oldRead, retired: true });
    assert.equal(updated.filter(c => c.descriptor.id === 'dkg-read' && !c.retired).length, 1);
    assert.equal(updated.some(c => c.descriptor.id === 'invoke-dkg-program'), false);
    assert.ok(readdirSync(f.state).some(file => file.startsWith('n8n-before-components-')));
  } finally { f.close(); }
});

test('partial installation verifies selected components before replacing the manifest and rejects unknown ids', () => {
  const f = fixture();
  try {
    f.run('dkg-read,dkg-write', profile);
    assert.deepEqual(f.manifest().components.map(c => c.descriptor.id).sort(), ['dkg-read', 'dkg-write']);
    const before = readFileSync(f.manifestFile, 'utf8');
    assert.throws(() => f.run('invoke-dkg-program', profile, { FIXTURE_SKIP_COMPONENT: 'nos_invoke_dkg_program_' }), /Native component was not stored: invoke-dkg-program/);
    assert.equal(readFileSync(f.manifestFile, 'utf8'), before);
    assert.throws(() => f.run('dkg-read,unknown', profile), /known component ids/);
    assert.equal(readFileSync(f.manifestFile, 'utf8'), before);
    f.run('invoke-dkg-program', profile);
    assert.deepEqual(f.manifest().components.map(c => c.descriptor.id).sort(), ['dkg-read', 'dkg-write', 'invoke-dkg-program']);
  } finally { f.close(); }
});
