/** Explicit smoke against a fresh local n8n created by setup-n8n.mjs.
 * Native provisioning, MCP HTTP, webhook dispatch, callback and result reads
 * are real. DKG transport uses the fictional measurement profile only.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
const state = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw Error('Supply a fresh local setup-n8n state directory.');
const { default: profile, calls } = await import('./agent-read-profile.mjs');
import { createStudioContext } from '../studio-context.mjs';
const { compiler, registry: { component } } = createStudioContext({ profile });
const { createStudioRepository } = await import('../studio-repository.mjs');
const { createStudioProvider } = await import('../studio-provider.mjs');
const { createStudioMcpService } = await import('../studio-mcp-service.mjs');
const { dkgComponentStore } = await import('../dkg-components.mjs');
const { createStudioMcpHttp } = await import('../studio-mcp-http.mjs');
const { createStudioNativeRunner } = await import('../studio-native-runner.mjs');
const { loadNosStudioSession } = await import('../nos-studio-session.mjs');
const installation = JSON.parse(readFileSync(join(state, 'n8n.json')));
assert.equal(new URL(installation.baseUrl).hostname, '127.0.0.1');
const webhookToken = readFileSync(installation.webhookTokenFile, 'utf8').trim();
let service, mcpHttp, posts = 0, callbacks = 0, missingProgress = false;
const server = createServer(async (req, res) => {
  if (req.url === '/mcp') return mcpHttp(req, res);
  if (req.url !== '/spike/ka/internal/dkg-component' || req.headers.authorization !== 'Bearer ' + webhookToken) {
    res.writeHead(403); res.end(); return;
  }
  try {
    let text = ''; for await (const part of req) { text += part; assert.ok(text.length < 16384); }
    callbacks++;
    const value = await service.dkgComponent(JSON.parse(text));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
  } catch (error) { res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.code ?? error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const repository = createStudioRepository(join(state, 'mcp-smoke-' + randomUUID()));
const provider = createStudioProvider({ compiler, repository, graphId: 'mcp-smoke', owner: '0x' + 'a'.repeat(40),
  config: { n8nNative: { ...installation, workflows: [] } },
  // Resolve the credential already provisioned by setup, below.
  headerCredential: await (async () => {
    const result = await fetch(new URL('/api/v1/workflows/' + installation.grant.workflowId, installation.baseUrl),
      { headers: { 'X-N8N-API-KEY': readFileSync(installation.apiTokenFile, 'utf8').trim() } });
    assert.equal(result.ok, true);
    return (await result.json()).nodes.find(n => n.type === 'n8n-nodes-base.webhook').credentials.httpHeaderAuth;
  })(),
  async fetchImpl(url, options) {
    // Isolate the smoke from any running companion. The port change happens
    // before provisioning/pinning and is part of the saved native digest.
    if (options.body) options = { ...options, body: options.body.replaceAll('http://127.0.0.1:4631/spike/ka/internal/dkg-component', origin + '/spike/ka/internal/dkg-component') };
    const result = await fetch(url, options);
    if (new URL(url).pathname.startsWith('/api/v1/executions/')) {
      const execution = await result.clone().json();
      if (execution.status === 'running' && !execution.data?.resultData?.runData?.['Receive input']) missingProgress = true;
    }
    return result;
  } });
try {
  const descriptor = component('dkg-read');
  const compiled = await provider.provision({ id: randomUUID(), name: 'Fictional native MCP read', entryId: 'read', edges: [], nodes: [{
    id: 'read', componentId: descriptor.id, kaRef: 'urn:demo:n8n:component:dkg-read:smoke', sourceHash: 'a'.repeat(64), x: 0, y: 0,
    params: Object.fromEntries(Object.entries(descriptor.parameters).map(([key, p]) => [key, p.default])),
  }] });
  repository.completeSave(compiled, 'native-n8n', false, await provider.savedNativeSnapshot(compiled));
  // n8n publication returns before local webhook registration settles.
  await delay(1500);
  service = createStudioMcpService({ repository, provider, dkg: dkgComponentStore(repository.db, profile), accountId: profile.accountId, compiler,
    runner: createStudioNativeRunner(provider, installation, (url, options) => { posts++; return fetch(url, options); }) });
  const secret = randomBytes(32).toString('hex'), secretFile = join(state, 'smoke-service-key'), sessionFile = join(state, 'smoke-session.json');
  writeFileSync(secretFile, secret, { mode: 0o600 });
  writeFileSync(sessionFile, JSON.stringify({ accountId: profile.accountId, controlPlaneUrl: origin, secretFile }), { mode: 0o600 });
  mcpHttp = createStudioMcpHttp({ service, session: loadNosStudioSession(sessionFile), agentEnabled: true });
  const headers = { 'content-type': 'application/json', 'x-nos-workflows-secret': secret, 'x-nos-workflows-account': profile.accountId,
    'x-nos-workflows-principal': 'smoke-owner', 'x-nos-workflows-role': 'owner', 'x-nos-workflows-started-by': 'agent:smoke',
    'x-nos-workflows-agent-version': 'smoke-v1', 'x-nos-workflows-tool-digest': 'd'.repeat(64), 'x-nos-workflows-approval-decision': 'smoke-decision' };
  const call = async (name, args) => {
    const response = await fetch(origin + '/mcp', { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    assert.equal(response.status, 200); const { result } = await response.json();
    assert.ok(!result.isError, JSON.stringify(result)); return result.structuredContent;
  };
  const runKey = randomUUID(), input = { kaRef: compiled.kaRef, workflowSha256: compiled.grant.workflowSha256, runKey, arguments: { sample: 'a' } };
  let result = await call('studio_run', input);
  for (let i = 0; !['failed', 'succeeded'].includes(result.status) && i < 100; i++) {
    await delay(200); result = await call('studio_run_read', { runKey });
  }
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.deepEqual(result.output.items, [{ sample: 'a', value: 2 }, { sample: 'b', value: 5 }]);
  assert.equal(posts, 1); assert.equal(callbacks, 1); assert.equal(calls.length, 1);
  assert.equal(missingProgress, true, 'Smoke must exercise default absent in-progress runData');
  assert.equal(calls[0].context.actor.runKey, runKey);
  assert.equal(calls[0].context.actor.approvalDecisionId, 'smoke-decision');
  assert.equal((await call('studio_run', input)).status, 'succeeded'); assert.equal(posts, 1);
  const evidence = { kind: 'local-native-mcp-smoke', status: result.status, executionId: result.n8nExecutionId,
    workflowId: compiled.grant.workflowId, workflowSha256: compiled.grant.workflowSha256, posts, callbacks, dkgReads: calls.length,
    absentInProgressRunData: missingProgress, output: result.output, steps: result.steps };
  writeFileSync(join(state, 'mcp-smoke-result.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); repository.close(); }
