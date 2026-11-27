/** Provision native templates with n8n's official local CLI; no API token is sent by this installer. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { componentContract } from './component-registry.mjs';
import { loadStudioContext } from './studio-context.mjs';
import { loadStudioCredentials } from './studio-credentials.mjs';
import { standaloneComponentWorkflow, echoSubworkflow } from './component-workflows.mjs';
import { n8nObservationScope, n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

const { registry } = await loadStudioContext();
const { componentRegistry, componentNeedsExport: needsExport, componentProgramSource } = registry;
const state = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the owned PoC state directory.');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const install = process.argv.includes('--install'), fixture = process.argv.includes('--fixture');
const cli = arg('--n8n-cli'), node = arg('--node') ?? process.execPath;
const only = arg('--only')?.split(',');
if (process.argv.includes('--only') && (!only?.length || only.some(id => !componentRegistry.some(c => c.id === id))))
  throw new Error('--only requires known component ids from the selected profile.');
const userFolder = join(state, 'n8n'), database = join(userFolder, '.n8n/database.sqlite');
mkdirSync(state, { recursive: true, mode: 0o700 });
const output = mkdtempSync(join(state, 'component-workflows-v1-')); chmodSync(output, 0o700);
let executor = '0x' + '1'.repeat(40);
const runtimeFile = join(state, 'runtime/semantic-runtime.sqlite');
if (existsSync(runtimeFile)) {
  const db = new DatabaseSync(runtimeFile, { readOnly: true });
  const row = db.prepare('SELECT payload FROM program_configuration WHERE kind=? AND context_graph_id=? LIMIT 1').get('binding', 'n8n-capability-poc');
  if (row) executor = JSON.parse(row.payload).executorAgentAddress;
  db.close();
} else if (!fixture) throw new Error('The existing PoC executor configuration is required.');
const scopeName = id => n8nObservationScope('n8n-capability-poc', executor, id);
const { headerCredential: header, credentials } = loadStudioCredentials(state, { fixture });
const components = [];
const file = join(state, install ? 'components.json' : 'components.prepared.json');
const previousComponents = install && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).components : [];
const componentRef = item => `urn:demo:n8n:component:${item.descriptor.id}:${item.grant.workflowSha256.slice(0, 12)}`
  + (item.descriptor.version >= 2 ? ':' + createHash('sha256').update(item.source).digest('hex').slice(0, 12) : '');
const echo = echoSubworkflow();
const nativeWorkflows = [{ workflow: echo, publish: true, label: 'echo' }];
for (const descriptor of componentRegistry.filter(c => !only || only.includes(c.id))) {
  const blueprint = standaloneComponentWorkflow(descriptor.id, 'template', header, { registry, credentials, scopeName: scopeName('template') });
  const { result: _result, ...template } = blueprint;
  const revision = createHash('sha256').update(JSON.stringify(template)).digest('hex').slice(0, 8);
  const id = `nos_${descriptor.id.replaceAll('-', '_')}_${revision}`;
  const { result, ...workflow } = standaloneComponentWorkflow(descriptor.id, id, header, { registry, credentials, scopeName: scopeName(id) });
  if (fixture) {
    for (const n of workflow.nodes) if (n.type === 'n8n-nodes-base.webhook') {
      n.parameters.authentication = 'none'; delete n.credentials;
    }
  }
  const item = { kind: 'component', descriptor, name: descriptor.name, source: componentProgramSource(descriptor.id),
    enabled: !descriptor.connection || !!credentials[descriptor.connection],
    requiresExportAuthorization: needsExport(descriptor),
    kaRef: `urn:demo:n8n:component:${descriptor.id}:${n8nWorkflowSha256(workflow).slice(0, 12)}`,
    grant: { toolIri: 'urn:dkg:tool:n8n', workflowId: id, workflowSha256: n8nWorkflowSha256(workflow), ...componentContract, result } };
  item.kaRef = componentRef(item); components.push(item);
  nativeWorkflows.push({ workflow, publish: item.enabled && descriptor.mode !== 'schedule', label: descriptor.id });
}

function storedWorkflow(db, id) {
  const row = db.prepare('SELECT nodes,connections,settings,activeVersionId FROM workflow_entity WHERE id=?').get(id);
  if (!row) return undefined;
  const definition = { nodes: JSON.parse(row.nodes), connections: JSON.parse(row.connections), settings: row.settings ? JSON.parse(row.settings) : {} };
  const digest = n8nWorkflowSha256(definition);
  if (row.activeVersionId) {
    const published = db.prepare('SELECT nodes,connections FROM workflow_history WHERE workflowId=? AND versionId=?').get(id, row.activeVersionId);
    if (!published || n8nWorkflowSha256({ nodes: JSON.parse(published.nodes), connections: JSON.parse(published.connections), settings: definition.settings }) !== digest)
      throw new Error('Published native revision differs from its stored definition: ' + id);
  }
  return { digest, activeVersionId: row.activeVersionId };
}
// Decide the whole import batch before touching n8n. Reusing an identity must
// preserve its published version, not just an equivalent content hash.
const existingDb = install && existsSync(database) ? new DatabaseSync(database, { readOnly: true }) : null;
let plans;
try {
  plans = nativeWorkflows.map(candidate => {
    const { workflow } = candidate, expected = n8nWorkflowSha256(workflow);
    const existing = existingDb ? storedWorkflow(existingDb, workflow.id) : undefined;
    if (existing && (existing.digest !== expected || previousComponents.some(item => item.grant.workflowId === workflow.id && item.grant.workflowSha256 !== existing.digest)))
      throw new Error('Native component revision changed; preserve the existing identity and install a new revision: ' + candidate.label);
    return { ...candidate, expected, existing };
  });
} finally { existingDb?.close(); }
const imports = plans.filter(plan => !plan.existing);
for (const { workflow } of imports)
  writeFileSync(join(output, workflow.id + '.json'), JSON.stringify({ ...workflow, versionId: randomUUID() }), { mode: 0o600 });
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
  if (imports.length) {
    const imported = run(['import:workflow', '--separate', '--input=' + output]);
    if (!imported.includes('Successfully imported')) throw new Error('n8n did not confirm the component import.');
  }
  for (const plan of plans.filter(plan => plan.publish && !plan.existing?.activeVersionId)) {
    const published = run(['publish:workflow', '--id=' + plan.workflow.id]);
    if (!published.includes('Publishing workflow')) throw new Error('n8n did not confirm publication.');
  }
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    for (const plan of plans) {
      const stored = storedWorkflow(db, plan.workflow.id);
      if (!stored) throw new Error('Native component was not stored: ' + plan.label);
      if (stored.digest !== plan.expected) throw new Error('Native component revision changed: ' + plan.label);
      if (plan.publish && !stored.activeVersionId) throw new Error('Native component was not published.');
      if (plan.existing?.activeVersionId && stored.activeVersionId !== plan.existing.activeVersionId)
        throw new Error('The existing native publication changed: ' + plan.label);
    }
  } finally { db.close(); }
}
// Existing saved graphs keep their original child pins and native definitions.
const retained = previousComponents
  .filter(old => !components.some(current => current.kaRef === old.kaRef))
  .map(old => only && !only.includes(old.descriptor.id) ? old : { ...old, retired: true });
writeFileSync(file + '.next', JSON.stringify({ version: 2, installed: install, components: [...components, ...retained] }, null, 2), { mode: 0o600 });
renameSync(file + '.next', file);
console.log(JSON.stringify({ installed: install, prepared: components.length, availableConnections: Object.keys(credentials),
  enabled: components.filter(c => c.enabled).length, scheduleActivationRequired: true, restartN8nRequired: install, manifest: file }));
