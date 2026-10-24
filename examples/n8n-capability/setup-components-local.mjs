/** Provision native templates with n8n's official local CLI; no API token is sent by this installer. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { componentRegistry, componentContract } from './component-registry.mjs';
import { standaloneComponentWorkflow, echoSubworkflow } from './component-workflows.mjs';
import { n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

const state = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the owned PoC state directory.');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const install = process.argv.includes('--install'), fixture = process.argv.includes('--fixture');
const cli = arg('--n8n-cli'), node = arg('--node') ?? process.execPath;
const only = arg('--only')?.split(',');
const userFolder = join(state, 'n8n'), database = join(userFolder, '.n8n/database.sqlite');
mkdirSync(state, { recursive: true, mode: 0o700 });
const output = mkdtempSync(join(state, 'component-workflows-v1-')); chmodSync(output, 0o700);
let header = { id: 'component-fixture-header', name: 'Component fixture' };
const credentials = {};
let executor = '0x' + '1'.repeat(40);
const runtimeFile = join(state, 'runtime/semantic-runtime.sqlite');
if (existsSync(runtimeFile)) {
  const db = new DatabaseSync(runtimeFile, { readOnly: true });
  const row = db.prepare('SELECT payload FROM program_configuration WHERE kind=? AND context_graph_id=? LIMIT 1').get('binding', 'n8n-capability-poc');
  if (row) executor = JSON.parse(row.payload).executorAgentAddress;
  db.close();
} else if (!fixture) throw new Error('The existing PoC executor configuration is required.');
const scopeName = id => 'nOS scope ' + createHash('sha256').update(JSON.stringify(['n8n-capability-poc', executor.toLowerCase(), id])).digest('hex').slice(0, 20);
if (existsSync(database)) {
  const db = new DatabaseSync(database, { readOnly: true });
  for (const row of db.prepare('SELECT nodes FROM workflow_entity').all()) {
    for (const item of JSON.parse(row.nodes)) {
      header = item.credentials?.httpHeaderAuth ?? header;
      for (const kind of ['googleSheetsOAuth2Api', 'googleDriveOAuth2Api']) {
        if (item.credentials?.[kind]) credentials[kind] = item.credentials[kind];
      }
    }
  }
  db.close();
}
if (!fixture && header.id === 'component-fixture-header') throw new Error('The existing PoC webhook credential reference was not found.');
const components = [];
const echo = echoSubworkflow();
writeFileSync(join(output, echo.id + '.json'), JSON.stringify({ ...echo, versionId: randomUUID() }), { mode: 0o600 });
for (const descriptor of componentRegistry) {
  const blueprint = standaloneComponentWorkflow(descriptor.id, 'template', header, { credentials, scopeName: scopeName('template') });
  const { result: _result, ...template } = blueprint;
  const revision = createHash('sha256').update(JSON.stringify(template)).digest('hex').slice(0, 8);
  const id = `nos_${descriptor.id.replaceAll('-', '_')}_${revision}`;
  const { result, ...workflow } = standaloneComponentWorkflow(descriptor.id, id, header, { credentials, scopeName: scopeName(id) });
  if (fixture) {
    for (const n of workflow.nodes) if (n.type === 'n8n-nodes-base.webhook') {
      n.parameters.authentication = 'none'; delete n.credentials;
    }
    if (descriptor.id === 'http-request') workflow.nodes.find(n => n.name === 'Component').parameters.url = 'http://127.0.0.1:45782/data';
  }
  if (!only || only.includes(descriptor.id)) writeFileSync(join(output, id + '.json'), JSON.stringify({ ...workflow, versionId: randomUUID() }), { mode: 0o600 });
  components.push({ kind: 'component', descriptor, name: descriptor.name,
    enabled: !descriptor.connection || !!credentials[descriptor.connection],
    requiresExportAuthorization: !!descriptor.writes,
    kaRef: `urn:demo:n8n:component:${descriptor.id}:${n8nWorkflowSha256(workflow).slice(0, 12)}`,
    grant: { toolIri: 'urn:dkg:tool:n8n', workflowId: id, workflowSha256: n8nWorkflowSha256(workflow), ...componentContract, result } });
}
if (install) {
  if (!cli) throw new Error('--install requires the installed n8n CLI path.');
  if (existsSync(database)) {
    const db = new DatabaseSync(database, { readOnly: true });
    const backupFile = join(state, 'n8n-before-components-' + Date.now() + '.sqlite');
    await backup(db, backupFile); chmodSync(backupFile, 0o600); db.close();
  }
  const env = { ...process.env, N8N_USER_FOLDER: userFolder, N8N_DIAGNOSTICS_ENABLED: 'false',
    N8N_VERSION_NOTIFICATIONS_ENABLED: 'false', N8N_RUNNERS_ENABLED: 'false', N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: 'true' };
  const run = args => execFileSync(node, [cli, ...args], { env, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const imported = run(['import:workflow', '--separate', '--input=' + output]);
  if (!imported.includes('Successfully imported')) throw new Error('n8n did not confirm the component import.');
  run(['publish:workflow', '--id=' + echo.id]);
  for (const item of components.filter(c => c.enabled && c.descriptor.mode !== 'schedule' && (!only || only.includes(c.descriptor.id)))) {
    const published = run(['publish:workflow', '--id=' + item.grant.workflowId]);
    if (!published.includes('Publishing workflow')) throw new Error('n8n did not confirm publication.');
  }
  const db = new DatabaseSync(database, { readOnly: true });
  for (const item of components) {
    const stored = db.prepare('SELECT nodes,connections,settings,activeVersionId FROM workflow_entity WHERE id=?').get(item.grant.workflowId);
    if (!stored) throw new Error('Native component was not stored: ' + item.descriptor.id);
    if (item.enabled && item.descriptor.mode !== 'schedule' && !stored.activeVersionId) throw new Error('Native component was not published.');
    const definition = { nodes: JSON.parse(stored.nodes), connections: JSON.parse(stored.connections), settings: stored.settings ? JSON.parse(stored.settings) : {} };
    item.grant.workflowSha256 = n8nWorkflowSha256(definition);
    item.kaRef = `urn:demo:n8n:component:${item.descriptor.id}:${item.grant.workflowSha256.slice(0, 12)}`;
  }
  db.close();
}
const file = join(state, install ? 'components.json' : 'components.prepared.json');
writeFileSync(file + '.next', JSON.stringify({ version: 1, installed: install, components }, null, 2), { mode: 0o600 });
renameSync(file + '.next', file);
console.log(JSON.stringify({ installed: install, prepared: components.length, availableConnections: Object.keys(credentials),
  enabled: components.filter(c => c.enabled).length, scheduleActivationRequired: true, restartN8nRequired: install, manifest: file }));
