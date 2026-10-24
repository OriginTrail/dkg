import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';
import { csvContracts, csvLabels, csvWorkflow } from './csv-workflows.mjs';

const state = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Supply the existing owned PoC state directory');
const connection = JSON.parse(readFileSync(join(state, 'n8n.json'), 'utf8'));
const origin = new URL(connection.baseUrl);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') throw new Error('Owned loopback instance required');
const apiKey = readFileSync(connection.apiTokenFile, 'utf8').trim();
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'X-N8N-API-KEY': apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`n8n component setup ${path}: HTTP ${response.status}`);
  return response.json();
}
const file = join(state, 'csv-components.json');
const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { components: [] };
const credentialId = process.argv[3];
if (credentialId && !/^[A-Za-z0-9_-]{1,80}$/.test(credentialId)) throw new Error('Supply an existing n8n Google Sheets OAuth credential ID');
const current = await request('/api/v1/workflows/' + connection.grant.workflowId);
const webhookCredential = current.nodes.find(node => node.type === 'n8n-nodes-base.webhook').credentials.httpHeaderAuth;
const components = [];
for (const kind of Object.keys(csvContracts)) {
  const old = previous.components.find(item => item.kind === kind);
  if (old && (kind !== 'google-sheets-export' || !credentialId || old.googleCredentialId === credentialId)) { components.push(old); continue; }
  const enabled = kind !== 'google-sheets-export' || !!credentialId;
  const google = credentialId ? { id: credentialId, name: 'Google Sheets OAuth connection' } : undefined;
  const draft = await request('/api/v1/workflows', csvWorkflow(kind, webhookCredential, 'dkg-unpublished-' + randomUUID(), google));
  await request('/api/v1/workflows/' + draft.id, csvWorkflow(kind, webhookCredential, 'dkg-capability-' + draft.id, google), 'PUT');
  if (enabled) await request(`/api/v1/workflows/${draft.id}/publish`, {});
  const stored = await request('/api/v1/workflows/' + draft.id);
  const definition = enabled && stored.activeVersion ? { ...stored.activeVersion, settings: stored.settings } : stored;
  const workflowSha256 = n8nWorkflowSha256(definition);
  components.push({ kind, name: csvLabels[kind], enabled, kaRef: `urn:demo:n8n:${kind}:${workflowSha256.slice(0, 12)}`,
    ...(kind === 'google-sheets-export' && credentialId ? { googleCredentialId: credentialId } : {}),
    grant: { toolIri: 'urn:dkg:tool:n8n', workflowId: draft.id, workflowSha256, ...csvContracts[kind] } });
}
const exportTokenFile = previous.exportTokenFile ?? join(state, 'google-export-token');
if (credentialId && !existsSync(exportTokenFile)) writeFileSync(exportTokenFile, randomBytes(32).toString('base64url'), { mode: 0o600 });
writeFileSync(file, JSON.stringify({ components, exportTokenFile }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ components: components.map(({ kind, enabled, kaRef }) => ({ kind, enabled, kaRef })),
  googleConnectionRequired: !components.find(item => item.kind === 'google-sheets-export').enabled }));
