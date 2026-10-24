import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticN8nGrant, SemanticN8nConfig } from '@origintrail-official/dkg-semantic-runtime';
import { createN8nWorkflowAdapter } from '../src/semantic-runtime-n8n-adapter.js';
import { n8nWorkflowSha256, validateN8nConfig, validateN8nGrant } from '../src/semantic-runtime-n8n-contract.js';

const graph = 'n8n-poc', owner = '0x' + '1'.repeat(40);
const definition = { versionId: 'reviewed-version-1', nodes: [{ id: 'set', name: 'Normalize', type: 'n8n-nodes-base.set', typeVersion: 3.4,
  parameters: { mode: 'manual' }, credentials: { httpHeaderAuth: { id: 'private-reference', name: 'Webhook' } } }],
connections: {}, settings: { executionOrder: 'v1' } };
const schema = { type: 'object' as const, additionalProperties: false as const, required: ['text'],
  properties: { text: { type: 'string' as const, maxLength: 256 } } };
const grant: SemanticN8nGrant = { toolIri: 'urn:dkg:tool:n8n', workflowId: 'normalize',
  workflowSha256: n8nWorkflowSha256(definition), inputSchema: schema, outputSchema: schema };
const authorization = { effectId: 'urn:sr:effect:invocation:0' } as Parameters<ReturnType<typeof createN8nWorkflowAdapter>['dispatch']>[0];
const servers: Server[] = [], dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'n8n-adapter-')); dirs.push(dir);
  const secret = 'private-token-never-in-evidence';
  const apiTokenFile = join(dir, 'api-token'), webhookTokenFile = join(dir, 'webhook-token');
  writeFileSync(apiTokenFile, secret, { mode: 0o600 }); writeFileSync(webhookTokenFile, secret, { mode: 0o600 });
  let workflow = { ...structuredClone(definition), id: grant.workflowId, active: true };
  let executed = structuredClone(definition), output: unknown = { text: 'HELLO DKG' };
  let dispatches = 0, postBody: any;
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/v1/') && req.headers['x-n8n-api-key'] !== secret
      || req.url?.startsWith('/webhook/') && req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/workflows/normalize') res.end(JSON.stringify(workflow));
    else if (req.url === '/webhook/dkg-capability-normalize') {
      dispatches++; postBody = JSON.parse(body); res.end(JSON.stringify({ executionId: '42', output }));
    } else if (req.url === '/api/v1/executions/42?includeData=true') res.end(JSON.stringify({
      id: '42', workflowId: grant.workflowId, status: 'success', workflowVersionId: 'reviewed-version-1', workflowData: executed,
    }));
    else res.writeHead(404).end('{}');
  });
  servers.push(server); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as { port: number };
  const config: SemanticN8nConfig = { baseUrl: `http://127.0.0.1:${address.port}`, apiTokenFile, webhookTokenFile,
    workflows: [{ contextGraphId: graph, executorAgentAddress: owner, workflowId: grant.workflowId, workflowSha256: grant.workflowSha256 }] };
  const authorize = vi.fn(async () => {});
  const adapter = createN8nWorkflowAdapter(graph, owner, grant, config, authorize);
  return { config, authorize, adapter, get dispatches() { return dispatches; }, get postBody() { return postBody; },
    setWorkflow(value: typeof workflow) { workflow = value; }, setExecuted(value: typeof definition) { executed = value; },
    setOutput(value: unknown) { output = value; }, workflow };
}

describe('n8n workflow Program tool', () => {
  it('returns actual workflow output and exact execution identity after version verification', async () => {
    const f = await fixture();
    const result = await f.adapter.dispatch(authorization, f.adapter.validateInput({ text: ' hello dkg ' }));
    expect(JSON.parse(result.output)).toEqual({ kind: 'n8n-result', workflowId: 'normalize',
      workflowSha256: grant.workflowSha256, n8nExecutionId: '42', output: { text: 'HELLO DKG' } });
    expect(f.postBody).toEqual({ invocationId: authorization.effectId, input: { text: ' hello dkg ' } });
    expect(f.dispatches).toBe(1); expect(f.authorize).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('rejects malformed and excessive input before contacting n8n', async () => {
    const f = await fixture();
    for (const value of [null, { text: 12 }, { text: 'a'.repeat(257) }, { text: 'ok', url: 'http://foreign' }]) {
      expect(() => f.adapter.validateInput(value)).toThrow('INVALID_N8N_INPUT');
    }
    expect(f.dispatches).toBe(0);
  });

  it.each(['graph', 'executor', 'workflow'] as const)('requires operator installation for the exact %s', async change => {
    const f = await fixture();
    if (change === 'workflow') f.config.workflows[0].workflowSha256 = 'b'.repeat(64);
    const adapter = createN8nWorkflowAdapter(change === 'graph' ? 'foreign' : graph,
      change === 'executor' ? '0x' + '2'.repeat(40) : owner, grant, f.config, f.authorize);
    expect(adapter.enabled?.()).toBe(false);
    try { await adapter.dispatch(authorization, { text: 'ok' }); throw new Error('expected rejection'); }
    catch (error) { expect(adapter.couldHaveReachedTarget(error)).toBe(false); }
    expect(f.dispatches).toBe(0);
  });

  it('refuses an edited workflow or credential reference before dispatch', async () => {
    const f = await fixture();
    const edited = structuredClone(f.workflow); edited.nodes[0].credentials.httpHeaderAuth.id = 'other-credential';
    f.setWorkflow(edited);
    await expect(f.adapter.dispatch(authorization, { text: 'ok' })).rejects.toThrow('N8N_WORKFLOW_NOT_PINNED');
    expect(f.dispatches).toBe(0);
  });

  it('accepts n8n runtime defaults while retaining every reviewed parameter and graph edge', async () => {
    const f = await fixture();
    f.setExecuted({ ...definition, nodes: definition.nodes.map(node => ({ ...node,
      parameters: { ...node.parameters, runtimeDefault: false } })) });
    expect((await f.adapter.dispatch(authorization, { text: 'ok' })).status).toBe('succeeded');
  });

  it('withholds output when the actual execution used a different definition', async () => {
    const f = await fixture(); const changed = structuredClone(definition); changed.nodes[0].parameters.mode = 'changed'; f.setExecuted(changed);
    let error: unknown; try { await f.adapter.dispatch(authorization, { text: 'ok' }); } catch (e) { error = e; }
    expect(error).toMatchObject({ message: 'N8N_EXECUTION_NOT_VERIFIED' });
    expect(f.adapter.couldHaveReachedTarget(error)).toBe(true); expect(f.dispatches).toBe(1);
    expect(await f.adapter.reconcile({} as any, {})).toMatchObject({ status: 'unknown' });
  });

  it('withholds invalid outputs and results after revocation', async () => {
    const f = await fixture(); f.setOutput({ text: 10 });
    await expect(f.adapter.dispatch(authorization, { text: 'ok' })).rejects.toThrow('INVALID_N8N_OUTPUT');
    f.setOutput({ text: 'OK' });
    f.authorize.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await expect(f.adapter.dispatch(authorization, { text: 'ok' })).rejects.toThrow('N8N_INVOCATION_FAILED');
  });

  it('rejects remote origins, inline credentials and open-ended contracts', async () => {
    const f = await fixture();
    for (const baseUrl of ['https://external.example', 'http://localhost:5678', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path']) {
      expect(() => validateN8nConfig({ ...f.config, baseUrl })).toThrow('INVALID_N8N_CONFIGURATION');
    }
    expect(() => validateN8nGrant({ ...grant, url: 'http://127.0.0.1' })).toThrow('INVALID_N8N_GRANT');
    expect(() => validateN8nGrant({ ...grant, inputSchema: { type: 'object' } })).toThrow();
  });
});
