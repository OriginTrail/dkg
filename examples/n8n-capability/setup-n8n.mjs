import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { normalizeWorkflow, textSchema } from './workflow.mjs';
import { n8nWorkflowSha256 } from '../../packages/cli/dist/semantic-runtime-n8n-contract.js';

// This bootstrap is for a fresh, owned local n8n instance. It refuses to replace
// an existing PoC configuration or an already-configured instance owner.
const state = resolve(process.argv[2] ?? '');
const origin = new URL(process.argv[3] ?? 'http://127.0.0.1:45679');
if (!process.argv[2] || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
  || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Supply a new state directory and a loopback n8n origin');
const configFile = join(state, 'n8n.json');
if (existsSync(configFile)) throw new Error('PoC already configured; reuse its state directory');
mkdirSync(state, { recursive: true, mode: 0o700 });
let cookie = '';
async function request(path, body, apiKey, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(new URL(path, origin), { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}), ...(apiKey ? { 'X-N8N-API-KEY': apiKey } : {}), 'browser-id': 'dkg-ka-poc' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(value => value.split(';')[0]).join('; ');
  if (!response.ok) throw new Error(`n8n setup ${path}: HTTP ${response.status}`);
  const value = await response.json();
  return path.startsWith('/rest/') ? value.data : value;
}
const password = randomBytes(24).toString('base64url') + 'aA1!';
await request('/rest/owner/setup', { email: 'poc@localhost.invalid', firstName: 'DKG', lastName: 'PoC', password });
writeFileSync(join(state, 'n8n-owner.json'), JSON.stringify({ email: 'poc@localhost.invalid', password }), { mode: 0o600 });
const scopes = await request('/rest/api-keys/scopes');
const apiKey = (await request('/rest/api-keys', { label: 'Local DKG KA PoC', scopes, expiresAt: Math.floor(Date.now() / 1000) + 86400 })).rawApiKey;
if (typeof apiKey !== 'string') throw new Error('n8n did not return an API credential');
const webhookToken = randomBytes(32).toString('base64url');
const credential = await request('/api/v1/credentials', { name: 'DKG KA PoC webhook', type: 'httpHeaderAuth',
  data: { name: 'Authorization', value: `Bearer ${webhookToken}` } }, apiKey);
const draft = await request('/api/v1/workflows', normalizeWorkflow(credential, 'dkg-capability-unpublished-' + randomUUID()), apiKey);
const workflow = normalizeWorkflow(credential, 'dkg-capability-' + draft.id);
await request('/api/v1/workflows/' + draft.id, workflow, apiKey, 'PUT');
await request(`/api/v1/workflows/${draft.id}/publish`, {}, apiKey);
const published = await request('/api/v1/workflows/' + draft.id, undefined, apiKey);
const active = published.activeVersion ? { ...published.activeVersion, settings: published.settings } : published;
const apiTokenFile = join(state, 'n8n-api-token'), webhookTokenFile = join(state, 'n8n-webhook-token');
writeFileSync(apiTokenFile, apiKey, { mode: 0o600 }); writeFileSync(webhookTokenFile, webhookToken, { mode: 0o600 });
const grant = { toolIri: 'urn:dkg:tool:n8n', workflowId: draft.id, workflowSha256: n8nWorkflowSha256(active), inputSchema: textSchema, outputSchema: textSchema };
writeFileSync(configFile, JSON.stringify({ baseUrl: origin.origin, apiTokenFile, webhookTokenFile, grant }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ configured: true, workflowId: grant.workflowId, workflowSha256: grant.workflowSha256, configFile }));
