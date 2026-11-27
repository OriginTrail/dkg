import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { n8nResultSha256, n8nWorkflowSha256 } from '../src/semantic-runtime-n8n-contract.js';
import { cleanupRuntimeFixtures, toolFixture, toolApi, graph, sourceGraph, owner, caller, SR } from './_helpers/semantic-runtime-api-fixture.js';

afterEach(cleanupRuntimeFixtures);

describe('signed n8n Program execution and output authority', () => {
  it('enforces native component limits for another approved Program using the same installed grant', async () => {
    const { standaloneComponentWorkflow } = await import('../../../examples/n8n-capability/component-workflows.mjs');
    const { componentContract, componentProgramSource } = await import('../../../examples/n8n-capability/component-registry.mjs');
    const workflowId = 'drive-component-limits', toolIri = 'urn:dkg:tool:n8n';
    const { result, ...workflow } = standaloneComponentWorkflow('google-drive', workflowId, { id: 'fixture', name: 'Fixture' });
    const definition = { ...workflow, versionId: 'guarded-drive-1' };
    const n8n = { toolIri, workflowId, workflowSha256: n8nWorkflowSha256(definition), ...componentContract, result };
    // This independently uploaded Program deliberately omits the supplied wrapper.
    const f = await toolFixture(`import { invoke_tool } from '${toolApi}';
      export function run(input: unknown) { return invoke_tool('${toolIri}', input); }`, { graphId: graph, n8n }, [toolIri]);
    const apiTokenFile = join(f.target.dir, 'limits-api'), webhookTokenFile = join(f.target.dir, 'limits-webhook');
    writeFileSync(apiTokenFile, 'fictional-limits-api-token'); writeFileSync(webhookTokenFile, 'fictional-limits-webhook-token');
    f.target.config.semanticRuntime.n8nNative = { baseUrl: 'http://127.0.0.1:5679', apiTokenFile, webhookTokenFile,
      workflows: [{ contextGraphId: graph, executorAgentAddress: owner, workflowId, workflowSha256: n8n.workflowSha256,
        resultSha256: n8nResultSha256(n8n) }] };
    let posts = 0, uploads = 0;
    const executions = new Map<string, unknown>();
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/api/v1/workflows/')) return Response.json({ ...definition, active: true });
      if (path.startsWith('/webhook/')) {
        const id = String(++posts), body = JSON.parse(String(init.body));
        const run = (json: unknown) => [{ data: { main: [[{ json }]] } }];
        const runData: Record<string, unknown> = { 'Receive input': run({ body }) };
        let status = 'success';
        // Execute the generated operator-pinned expression; only the provider
        // transport and upload are mocked. No guest normalizer runs here.
        try {
          const expression = workflow.nodes.find((n: any) => n.name === 'Prepare input').parameters.jsonOutput;
          const prepared = vm.runInNewContext(expression.slice(3, -2), {
            $: () => ({ first: () => ({ json: { body } }) }),
          }, { timeout: 1000 });
          runData['Prepare input'] = run(prepared);
          uploads += prepared.records.length;
          runData.Component = [{ data: { main: [prepared.records.map(() => ({ json: { uploaded: true } }))] } }];
        } catch (error) {
          status = 'error'; runData['Prepare input'] = [{ error: { message: String(error) } }];
        }
        executions.set(id, { id, workflowId, status, workflowVersionId: definition.versionId, workflowData: definition,
          data: { resultData: { runData } } });
        return Response.json({ executionId: id });
      }
      return Response.json(executions.get(path.split('/').pop()!));
    }));
    try {
      const wrapper = await f.manager.programs.upload({ graphId: sourceGraph, language: 'typescript-v1', requiredTools: [toolIri],
        requestedPermissions: { graphId: graph, n8n }, source: componentProgramSource('google-drive') });
      await f.manager.programs.approve({ graphId: graph, operationIri: 'urn:test:drive-wrapper', program: wrapper,
        allowedCallers: [caller], n8n, typescript: { children: [] } });
      await f.approve();
      await f.client.routes.create({ ...f.operation, targetPeerId: f.agent.peerId });
      const file = { file: { name: 'a', base64: 'YQ==' } };
      const oversized = { itemsJson: JSON.stringify(Array(100).fill(file)), paramsJson: '{}', executionId: '' };
      expect(oversized.itemsJson.length).toBeLessThan(8192);
      const rejected = await f.client.programs.invoke({ ...f.operation, inputs: [oversized] });
      expect(posts).toBe(1); expect(uploads).toBe(0);
      expect(rejected.outputs).toMatchObject([{ output: { ok: false, itemsJson: '[]' } }]);
      const accepted = await f.client.programs.invoke({ ...f.operation, inputs: [{ ...oversized, itemsJson: JSON.stringify(Array(20).fill(file)) }] });
      expect(posts).toBe(2); expect(uploads).toBe(20);
      expect(accepted.outputs).toMatchObject([{ output: { ok: true } }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it('invokes an n8n-backed Program KA from a signed client and a parent Program, with durable replay and revocation', async () => {
    const n8nTool = 'urn:dkg:tool:n8n';
    const definition = { versionId: 'reviewed-version-1', nodes: [{ id: 'normalize', name: 'Normalize', type: 'n8n-nodes-base.set', typeVersion: 3.4,
      parameters: {} }], connections: {}, settings: { executionOrder: 'v1' } };
    const schema = { type: 'object', required: ['text'], additionalProperties: false,
      properties: { text: { type: 'string', maxLength: 256 } } };
    const n8n = { toolIri: n8nTool, workflowId: 'normalize', workflowSha256: n8nWorkflowSha256(definition), inputSchema: schema, outputSchema: schema };
    const f = await toolFixture(`import { invoke_tool } from '${toolApi}';
      export function run(input: unknown) { return invoke_tool('${n8nTool}', input); }`, { graphId: graph, n8n }, [n8nTool]);
    const apiTokenFile = join(f.target.dir, 'n8n-api'), webhookTokenFile = join(f.target.dir, 'n8n-webhook');
    writeFileSync(apiTokenFile, 'private-api-token-for-local-test', { mode: 0o600 });
    writeFileSync(webhookTokenFile, 'private-webhook-token-for-local-test', { mode: 0o600 });
    f.target.config.semanticRuntime.n8n = { baseUrl: 'http://127.0.0.1:5679', apiTokenFile, webhookTokenFile,
      workflows: [{ contextGraphId: graph, executorAgentAddress: owner, workflowId: 'normalize', workflowSha256: n8n.workflowSha256 }] };
    let dispatches = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/workflows/normalize') return Response.json({ ...definition, id: 'normalize', active: true });
      if (u.pathname === '/webhook/dkg-capability-normalize') {
        dispatches++; const { input } = JSON.parse(String(init.body));
        return Response.json({ executionId: String(dispatches), output: { text: input.text.trim().toUpperCase() } });
      }
      return Response.json({ id: u.pathname.split('/').pop(), workflowId: 'normalize', status: 'success', workflowVersionId: 'reviewed-version-1', workflowData: definition });
    }));
    try {
      const approval = await f.approve();
      expect(approval.resolution?.executable).toBe(true);
      await f.client.routes.create({ ...f.operation, targetPeerId: f.agent.peerId });
      const prepared = f.client.programs.prepareInvocation({ ...f.operation, inputs: [{ text: '  hello dkg  ' }] });
      const result = await f.client.programs.invoke(prepared);
      expect(result.outputs).toMatchObject([{ kind: 'n8n-result', n8nExecutionId: '1', output: { text: 'HELLO DKG' } }]);
      expect(await f.client.programs.invoke(prepared)).toEqual(result); expect(dispatches).toBe(1);
      await expect(f.client.programs.invoke({ ...prepared, inputs: [{ text: 'different' }] })).rejects.toMatchObject({ status: 409 });
      await expect(f.client.programs.invoke({ ...f.operation, inputs: [{ text: 10 }] })).rejects.toMatchObject({ status: 422 });
      expect(dispatches).toBe(1);
      const parent = await f.manager.programs.upload({ graphId: sourceGraph, language: 'typescript-v1', requiredTools: [],
        permittedPrograms: [f.program.programIri], source: `import { invoke_program } from '${toolApi}';
          export function run(input: unknown) { return invoke_program('${f.program.programIri}', [input]); }` });
      const parentOperation = { graphId: graph, operationIri: 'urn:test:n8n-parent' };
      await f.manager.programs.approve({ ...parentOperation, program: parent, allowedCallers: [caller], typescript: { children: [f.operation] } });
      await f.client.routes.create({ ...parentOperation, targetPeerId: f.agent.peerId });
      const parentResult = await f.client.programs.invoke({ ...parentOperation, inputs: [{ text: '  composed  ' }] });
      expect(parentResult.outputs).toMatchObject([{ output: { text: 'COMPOSED' } }]); expect(dispatches).toBe(2);
      const receipt = await f.store.query(`SELECT ?output WHERE { GRAPH ?g { <${result.executionIri}> <${SR}output> ?output } }`);
      expect(JSON.stringify(receipt)).toContain('HELLO DKG');
      await f.manager.programs.revoke({ ...f.operation, expectedRevision: approval.revision });
      await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ status: 403 }); expect(dispatches).toBe(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['direct', 'copy', 'sink', 'trace', 'safe', 'safe-sink', 'safe-trace', 'missing-pin'])('binds native tenant output to operator authority (%s)', async mode => {
    const workflowId = 'output-authority', toolIri = 'urn:dkg:tool:n8n';
    const definition = { versionId: 'reviewed-1', nodes: ['Component', 'Receive input', 'Header copy'].map(name => ({
      id: name, name, type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} })), connections: {}, settings: {} };
    const string = { type: 'string', maxLength: 8192 };
    const outputSchema = { type: 'object', additionalProperties: false, required: ['ok', 'itemsJson', 'portsJson', 'error'],
      properties: { ok: { type: 'boolean' }, itemsJson: string, portsJson: string, error: string, traceJson: string } };
    const inputSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };
    const safeResult = { nodes: ['Component'], ...(mode === 'safe-sink' ? { sinks: [{ node: 'Component', port: 0, name: 'safe' }] } : {}),
      ...(mode === 'safe-trace' ? { traceNodes: ['Component'] } : {}) };
    const result = mode === 'direct' ? { nodes: ['Receive input'] } : mode === 'copy' ? { nodes: ['Header copy'] }
      : mode === 'sink' ? { nodes: ['Header copy'], sinks: [{ node: 'Header copy', port: 0, name: 'copied' }] }
      : mode === 'trace' ? { nodes: ['Component'], traceNodes: ['Header copy'] } : safeResult;
    const n8n = { toolIri, workflowId, workflowSha256: n8nWorkflowSha256(definition), inputSchema, outputSchema, result };
    const f = await toolFixture(`import { invoke_tool } from '${toolApi}';
      export function run(input: unknown) { return invoke_tool('${toolIri}', input); }`, { graphId: graph, n8n }, [toolIri]);
    const apiTokenFile = join(f.target.dir, 'output-api'), webhookTokenFile = join(f.target.dir, 'output-webhook');
    const credential = 'fictional-output-test-token';
    writeFileSync(apiTokenFile, 'fictional-output-api-token'); writeFileSync(webhookTokenFile, credential);
    f.target.config.semanticRuntime.n8nNative = { baseUrl: 'http://127.0.0.1:5679', apiTokenFile, webhookTokenFile,
      workflows: [{ contextGraphId: graph, executorAgentAddress: owner, workflowId, workflowSha256: n8n.workflowSha256,
        ...(mode === 'missing-pin' ? {} : { resultSha256: n8nResultSha256({ result: safeResult, outputSchema } as any) }) }] };
    let posts = 0;
    const fetch = vi.fn(async (url: URL, _init: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path.startsWith('/api/v1/workflows/')) return Response.json({ ...definition, id: workflowId, active: true });
      if (path.startsWith('/webhook/')) { posts++; return Response.json({ executionId: '42' }); }
      const run = (json: unknown) => [{ data: { main: [[{ json }]] } }];
      return Response.json({ id: '42', workflowId, workflowVersionId: definition.versionId, status: 'success', workflowData: definition,
        data: { resultData: { runData: { Component: run({ value: 'safe' }), 'Receive input': run({ headers: { authorization: 'Bearer ' + credential } }),
          'Header copy': run({ copied: credential }) } } } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      if (!mode.startsWith('safe')) {
        await expect(f.approve()).rejects.toThrow('adapter is unavailable');
        // Existing tenant approvals must also obey a subsequently tightened installation.
        const installed = f.target.config.semanticRuntime.n8nNative.workflows[0]!;
        const pin = installed.resultSha256;
        installed.resultSha256 = n8nResultSha256(n8n as any);
        await f.approve();
        installed.resultSha256 = pin;
      } else await f.approve();
      await f.client.routes.create({ ...f.operation, targetPeerId: f.agent.peerId });
      if (mode.startsWith('safe')) {
        const receipt = await f.client.programs.invoke({ ...f.operation, inputs: [{}] });
        expect(receipt.outputs).toMatchObject([{ output: { itemsJson: '[{"value":"safe"}]' } }]);
        expect(JSON.stringify(receipt)).not.toContain(credential); expect(posts).toBe(1);
      } else {
        const error = await f.client.programs.invoke({ ...f.operation, inputs: [{}] }).catch(e => e);
        expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(credential);
        expect(posts).toBe(0); expect(fetch).not.toHaveBeenCalled();
      }
      const rows = await f.store.query(`SELECT ?output WHERE { GRAPH ?g { ?s <${SR}output> ?output } }`);
      expect(JSON.stringify(rows)).not.toContain(credential);
    } finally { vi.unstubAllGlobals(); }
  });

});
