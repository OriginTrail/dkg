import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';
import { createNativeN8nWorkflowAdapter } from '../src/semantic-runtime-n8n-native-adapter.js';
import { collectN8nExecutionResult } from '../src/semantic-runtime-n8n-results.js';
import { decodeNativeN8nCheckpoint, encodeNativeN8nCheckpoint } from '../src/semantic-runtime-n8n-checkpoint.js';
import { normalizeN8nResult, type NativeN8nGrant, n8nObservationScope, n8nResultSha256, n8nPinnedExecutionMatches, n8nWorkflowSha256, validateN8nGrant } from '../src/semantic-runtime-n8n-contract.js';

const graph = 'native-n8n-poc', owner = '0x' + '1'.repeat(40), workflowId = 'native';
const objectSchema = (properties: Record<string, any>) => ({ type: 'object' as const, properties, required: Object.keys(properties), additionalProperties: false as const });
const string = { type: 'string' as const, maxLength: 8192 };
const inputSchema = objectSchema({ itemsJson: string, paramsJson: string, executionId: string });
const outputSchema = objectSchema({ ok: { type: 'boolean' }, itemsJson: string, portsJson: string, error: string });
const input = { itemsJson: '[{"name":"Ana"}]', paramsJson: '{}', executionId: '' };
const authorization = { effectId: 'effect-native', attemptId: 'a', requestDigest: new Uint8Array(32).fill(1), capabilityId: 'cap', policyDecisionId: 'policy' };
const dirs: string[] = [];
afterEach(() => { vi.unstubAllGlobals(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'native-n8n-unit-')); dirs.push(dir);
  const apiTokenFile = join(dir, 'fixture-api'), webhookTokenFile = join(dir, 'fixture-webhook');
  writeFileSync(apiTokenFile, 'unit-api-fixture-only'); writeFileSync(webhookTokenFile, 'unit-webhook-fixture-only');
  const scope = n8nObservationScope(graph, owner, workflowId);
  const definition = { versionId: 'v1', nodes: [
    { id: 'component', name: 'Component', type: 'n8n-nodes-base.filter', typeVersion: 2.3, parameters: {} },
    { id: 'scope', name: scope, type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: {} },
  ], connections: {}, settings: { executionOrder: 'v1' } };
  const grant: NativeN8nGrant = { toolIri: 'urn:dkg:tool:n8n', workflowId, workflowSha256: n8nWorkflowSha256(definition),
    inputSchema, outputSchema, result: { nodes: ['Component'], allowObservation: true } };
  const config = { baseUrl: 'http://127.0.0.1:45670', apiTokenFile, webhookTokenFile,
    workflows: [{ contextGraphId: graph, executorAgentAddress: owner, workflowId, workflowSha256: grant.workflowSha256, resultSha256: n8nResultSha256(grant) }] };
  let execution: any = { id: '42', workflowId, status: 'success', workflowVersionId: 'v1', workflowData: structuredClone(definition),
    data: { resultData: { runData: { Component: [{ data: { main: [[{ json: { name: 'Ana' } }]] } }], [scope]: [{ data: { main: [[{ json: {} }]] } }],
      'Receive input': [{ data: { main: [[{ json: { headers: { authorization: 'never-leak-fixture' } } }]] } }] } } } };
  let failRead = false;
  const file = join(dir, 'checkpoint.json');
  const store = {
    adapterCheckpoint() { return existsSync(file) ? { version: 1, payload: Buffer.from(readFileSync(file)) } : undefined; },
    writeAdapterCheckpoint(_id: string, digest: Uint8Array, payload: Uint8Array) {
      expect(digest).toEqual(authorization.requestDigest); writeFileSync(file, payload, { mode: 0o600 }); return 1;
    },
  } as unknown as SemanticRuntimeStore;
  const fetch = vi.fn(async (url: URL | RequestInfo, options?: RequestInit) => {
    if (String(url).includes('/webhook/')) return Response.json({ executionId: '42' });
    if (String(url).includes('/executions/')) {
      expect(existsSync(file)).toBe(true);
      if (failRead) throw new Error('network-interrupted');
      return Response.json(execution);
    }
    expect(options?.method).toBe('GET');
    return Response.json({ id: workflowId, active: true, ...definition });
  });
  vi.stubGlobal('fetch', fetch);
  const authorize = vi.fn(async () => {});
  const adapter = () => createNativeN8nWorkflowAdapter(graph, owner, grant, config, authorize, store);
  return { adapter, grant, config, definition, execution, fetch, authorize, store, setFailRead(v: boolean) { failRead = v; },
    setExecution(v: any) { execution = v; }, posts: () => fetch.mock.calls.filter(c => c[1]?.method === 'POST').length };
}

describe('native n8n component execution receipts', () => {
  it.each([
    { name: 'extra output', body: { executionId: '42', output: {} } },
    { name: 'numeric ID', body: { executionId: 42 } },
    { name: 'non-decimal ID', body: { executionId: '42/other' } },
    { name: 'missing ID', body: {} },
  ])('does not checkpoint an acknowledgement with $name', async ({ body }) => {
    const f = fixture(), adapter = f.adapter(), send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url, options) => String(url).includes('/webhook/') ? Promise.resolve(Response.json(body)) : send(url, options));
    const error = await adapter.dispatch(authorization, input).catch(error => error);
    expect(error.message).toBe('N8N_RESPONSE_INVALID');
    expect(adapter.couldHaveReachedTarget(error)).toBe(true);
    expect(f.store.adapterCheckpoint(authorization.effectId)).toBeUndefined();
    expect(f.posts()).toBe(1);
  });
  it.each([1_048_576, 1_048_577])('preserves the runtime acknowledgement byte ceiling at %i bytes', async size => {
    const f = fixture(), adapter = f.adapter(), send = f.fetch.getMockImplementation()!;
    let body: ReadableStream<Uint8Array>, cancelled = false;
    f.fetch.mockImplementation(async (url, options) => {
      if (!String(url).includes('/webhook/')) return send(url, options);
      expect(JSON.parse(options!.body as string)).toEqual({ invocationId: authorization.effectId, input });
      expect(options!.redirect).toBe('error');
      const bytes = Buffer.from(JSON.stringify({ executionId: '42' }).padEnd(size));
      let sent = false;
      body = new ReadableStream({ pull(controller) {
        if (sent) controller.close(); else { sent = true; controller.enqueue(bytes); }
      }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
      return new Response(body);
    });
    if (size === 1_048_576) {
      expect((await adapter.dispatch(authorization, input)).status).toBe('succeeded');
      expect(f.store.adapterCheckpoint(authorization.effectId)).toBeDefined();
    } else {
      const error = await adapter.dispatch(authorization, input).catch(error => error);
      expect(error.message).toBe('N8N_RESPONSE_TOO_LARGE');
      expect(adapter.couldHaveReachedTarget(error)).toBe(true);
      expect(f.store.adapterCheckpoint(authorization.effectId)).toBeUndefined();
    }
    expect(cancelled).toBe(size > 1_048_576); expect(body!.locked).toBe(false);
    expect(f.posts()).toBe(1);
  });
  it.each(['missing', 'short', 'multiline', 'oversized'])('classifies a %s webhook credential as a local pre-dispatch failure', async mode => {
    const f = fixture(), adapter = f.adapter();
    if (mode === 'missing') rmSync(f.config.webhookTokenFile);
    else writeFileSync(f.config.webhookTokenFile, mode === 'short' ? 'short'
      : mode === 'multiline' ? 'fictional-first-line\nfictional-second-line' : 'x'.repeat(8193));
    const error = await adapter.dispatch(authorization, input).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(adapter.couldHaveReachedTarget(error)).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(1); // The valid API credential completed workflow preflight.
    expect(f.posts()).toBe(0);
    expect(f.store.adapterCheckpoint(authorization.effectId)).toBeUndefined();
  });
  it('keeps a lost acknowledgement after dispatch uncertain without inventing a checkpoint', async () => {
    const f = fixture(), adapter = f.adapter(), send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, options) => {
      if (String(url).includes('/webhook/')) throw new Error('acknowledgement lost');
      return send(url, options);
    });
    const error = await adapter.dispatch(authorization, input).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(adapter.couldHaveReachedTarget(error)).toBe(true);
    expect(f.posts()).toBe(1);
    expect(f.store.adapterCheckpoint(authorization.effectId)).toBeUndefined();
    await expect(adapter.resume!(authorization, input)).rejects.toThrow('INSPECTION_REQUIRED');
    expect(f.posts()).toBe(1);
  });
  it('does not require a webhook credential to inspect an already observed execution', async () => {
    const f = fixture(); rmSync(f.config.webhookTokenFile);
    expect((await f.adapter().dispatch(authorization, { ...input, executionId: '42' })).status).toBe('succeeded');
    expect(f.posts()).toBe(0);
  });
  it('journals the provider ID before reading native output and returns actual records', async () => {
    const f = fixture(), value = await f.adapter().dispatch(authorization, input);
    const result = JSON.parse(value.output);
    expect(result.n8nExecutionId).toBe('42');
    expect(JSON.parse(result.output.itemsJson)).toEqual([{ name: 'Ana' }]);
    expect(result.output.ok).toBe(true); expect(f.posts()).toBe(1);
    expect(value.output).not.toContain('fixture');
  });
  it('aborts pending inspection at its deadline and resumes the recorded execution without another POST', async () => {
    const f = fixture(), adapter = f.adapter(), deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const send = f.fetch.getMockImplementation()!;
    f.execution.status = 'running';
    f.fetch.mockImplementation(async (url, options) => {
      const response = await send(url, options);
      if (String(url).includes('/executions/')) deadline.abort(new DOMException('Inspection expired', 'TimeoutError'));
      return response;
    });
    try {
      const error = await adapter.dispatch(authorization, input).catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(adapter.couldHaveReachedTarget(error)).toBe(true);
      expect(f.store.adapterCheckpoint(authorization.effectId)).toBeDefined();
    } finally { timeout.mockRestore(); }
    f.fetch.mockImplementation(send); f.execution.status = 'success';
    expect((await adapter.resume!(authorization, input)).status).toBe('succeeded');
    expect(f.posts()).toBe(1);
  });
  it.each(['canceled', 'crashed'])('reconciles pinned %s execution as a failed workflow without redispatch', async status => {
    const f = fixture(), adapter = f.adapter();
    f.setFailRead(true);
    await expect(adapter.dispatch(authorization, input)).rejects.toThrow();
    f.setFailRead(false); f.execution.status = status;
    const result = await adapter.reconcile({ effectId: authorization.effectId } as any);
    expect(result.status).toBe('applied');
    expect(JSON.parse((result as any).output)).toMatchObject({ n8nExecutionId: '42', output: { ok: false, itemsJson: '[]', portsJson: '{}' } });
    f.execution.workflowVersionId = 'foreign';
    expect((await adapter.reconcile({ effectId: authorization.effectId } as any)).status).toBe('unknown');
    await expect(adapter.resume!(authorization, input)).rejects.toThrow('N8N_EXECUTION_NOT_VERIFIED');
    expect(f.posts()).toBe(1);
  });
  it('reads empty native output without requiring a downstream response node', async () => {
    const f = fixture(); f.execution.data.resultData.runData.Component[0].data.main = [[]];
    const result = JSON.parse((await f.adapter().dispatch(authorization, input)).output);
    expect(result.output).toMatchObject({ ok: true, itemsJson: '[]', portsJson: '{}' });
  });
  it('verifies normalized native parameters through the full published pin and acknowledged version', async () => {
    const f = fixture();
    f.definition.nodes[0]!.parameters = { selector: '={{ false }}', inactive: { value: 'reviewed' } };
    f.grant.workflowSha256 = n8nWorkflowSha256(f.definition);
    f.config.workflows[0]!.workflowSha256 = f.grant.workflowSha256;
    // n8n may strip expression prefixes, omit hidden properties and fill defaults.
    f.execution.workflowData.nodes[0].parameters = { selector: '{{ false }}', addedDefault: false };
    const result = JSON.parse((await f.adapter().dispatch(authorization, input)).output);
    expect(result.output.ok).toBe(true);
    expect(f.posts()).toBe(1);
  });
  it.each(['type', 'credentials', 'connections', 'settings', 'node-count'])('rejects normalized snapshots with changed %s', async changed => {
    const f = fixture(), snapshot = f.execution.workflowData;
    if (changed === 'type') snapshot.nodes[0].type = 'n8n-nodes-base.httpRequest';
    if (changed === 'credentials') snapshot.nodes[0].credentials = { httpHeaderAuth: { id: 'foreign' } };
    if (changed === 'connections') snapshot.connections = { Component: { main: [[{ node: 'foreign', type: 'main', index: 0 }]] } };
    if (changed === 'settings') snapshot.settings.executionOrder = 'v0';
    if (changed === 'node-count') snapshot.nodes.pop();
    await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('EXECUTION_NOT_VERIFIED');
    expect(f.posts()).toBe(1);
  });
  it('rejects changed reviewed parameters before dispatch even if the provider reuses its version ID', async () => {
    const f = fixture();
    f.definition.nodes[0]!.parameters = { changed: true };
    await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('WORKFLOW_NOT_PINNED');
    expect(f.posts()).toBe(0);
  });
  it('collects both native branch ports and excludes unselected transport data', () => {
    const f = fixture(); f.grant.result.ports = ['true', 'false'];
    f.execution.data.resultData.runData.Component[0].data.main = [[{ json: { name: 'Ana' } }], [{ json: { name: 'Luka' } }]];
    const result = collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution);
    expect(result.itemsJson).toBe('[]');
    expect(JSON.parse(result.portsJson as string)).toEqual({ true: [{ name: 'Ana' }], false: [{ name: 'Luka' }] });
    expect(JSON.stringify(result)).not.toContain('never-leak');
  });
  it('selects terminal graph ports without mixing records from connected branches', () => {
    const f = fixture();
    f.grant.result = { nodes: ['Component'], sinks: [{ node: 'Component', port: 1, name: 'unconnected false' }], traceNodes: ['Component'] };
    f.execution.data.resultData.runData.Component[0].data.main = [[{ json: { connected: true } }], [{ json: { terminal: true } }]];
    const output = collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution);
    expect(JSON.parse(output.itemsJson as string)).toEqual([{ terminal: true }]);
    expect(output.itemsJson).not.toContain('connected');
    expect(JSON.parse(output.traceJson as string)[0].items).toEqual([1, 1]);
    expect(() => validateN8nGrant({ ...f.grant, result: { ...f.grant.result, sinks: [{ node: 'Receive input', port: 0, name: 'headers' }] } })).toThrow();
    expect(() => validateN8nGrant({ ...f.grant, result: { ...f.grant.result, sinks: [{ node: 'Component', port: 4, name: 'bad' }] } })).toThrow();
  });
  it.each([
    { name: 'one node', wire: { nodes: ['Component'] }, items: [{ value: 'a' }], ports: {} },
    { name: 'multiple nodes', wire: { nodes: ['Component', 'Other'] }, items: [{ value: 'a' }, { value: 'c' }], ports: {} },
    { name: 'one legacy named port', wire: { nodes: ['Component'], ports: ['first'] }, items: [{ value: 'a' }], ports: {} },
    { name: 'multiple legacy ports', wire: { nodes: ['Component'], ports: ['first', 'second'] }, items: [],
      ports: { first: [{ value: 'a' }], second: [{ value: 'b' }] } },
    { name: 'one sink', wire: { nodes: ['Component'], sinks: [{ node: 'Component', port: 1, name: 'selected' }] }, items: [{ value: 'b' }], ports: {} },
    { name: 'multiple sinks', wire: { nodes: ['Component', 'Other'], sinks: [{ node: 'Component', port: 0, name: 'first' }, { node: 'Other', port: 0, name: 'second' }] },
      items: [], ports: { first: [{ value: 'a' }], second: [{ value: 'c' }] } },
    { name: 'two names for one sink', wire: { nodes: ['Component'], sinks: [{ node: 'Component', port: 0, name: 'first' }, { node: 'Component', port: 0, name: 'copy' }] },
      items: [], ports: { first: [{ value: 'a' }], copy: [{ value: 'a' }] } },
  ])('preserves $name presentation and wire pins when normalizing selectors', ({ wire, items, ports }) => {
    const f = fixture(); f.grant.result = wire;
    validateN8nGrant(f.grant);
    const original = JSON.stringify(f.grant), hash = n8nResultSha256(f.grant);
    f.execution.data.resultData.runData = {
      Component: [{ data: { main: [[{ json: { value: 'a' } }], [{ json: { value: 'b' } }]] } }],
      Other: [{ data: { main: [[{ json: { value: 'c' } }]] } }],
    };
    const projection = normalizeN8nResult(f.grant.result);
    const output = collectN8nExecutionResult(projection, f.execution);
    expect(output.ok).toBe(true);
    expect(JSON.parse(output.itemsJson as string)).toEqual(items);
    expect(JSON.parse(output.portsJson as string)).toEqual(ports);
    expect(JSON.stringify(f.grant)).toBe(original);
    expect(n8nResultSha256(f.grant)).toBe(hash);
    // The validated projection retains its own snapshot, independent of the wire object.
    f.grant.result.nodes[0] = 'changed-after-normalization';
    expect(collectN8nExecutionResult(projection, f.execution)).toEqual(output);
  });
  it('retains preflight checks for declared nodes not used by a sink selector', async () => {
    const f = fixture();
    f.grant.result = { nodes: ['Component', 'Missing'], sinks: [{ node: 'Component', port: 0, name: 'only' }] };
    f.config.workflows[0]!.resultSha256 = n8nResultSha256(f.grant);
    await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('N8N_WORKFLOW_NOT_PINNED');
    expect(f.posts()).toBe(0);
  });
  it('continues the same acknowledged execution after restart without another POST', async () => {
    const f = fixture(); f.setFailRead(true);
    await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('N8N_INVOCATION_FAILED');
    expect(f.posts()).toBe(1); f.setFailRead(false);
    expect((await f.adapter().resume!(authorization, input)).status).toBe('succeeded');
    expect(f.posts()).toBe(1);
  });
  it('preserves existing checkpoint bytes and rejects an empty or invalid version on adapter resume', async () => {
    const f = fixture();
    const saved = { kind: 'n8n-native-v1' as const, workflowId, workflowSha256: f.grant.workflowSha256,
      executionId: '42', versionId: 'v1', observed: false };
    const originalBytes = new TextEncoder().encode(JSON.stringify(saved));
    expect(encodeNativeN8nCheckpoint(saved)).toEqual(originalBytes);
    expect(decodeNativeN8nCheckpoint(originalBytes, f.grant)).toEqual(saved);
    f.store.writeAdapterCheckpoint(authorization.effectId, authorization.requestDigest, originalBytes, 0);
    expect((await f.adapter().resume!(authorization, input)).status).toBe('succeeded');
    expect(f.posts()).toBe(0);
    expect(f.store.adapterCheckpoint(authorization.effectId)!.payload).toEqual(Buffer.from(originalBytes));
    for (const versionId of ['', null, 42]) {
      const invalidBytes = new TextEncoder().encode(JSON.stringify({ ...saved, versionId }));
      f.store.writeAdapterCheckpoint(authorization.effectId, authorization.requestDigest, invalidBytes, 0);
      expect(() => decodeNativeN8nCheckpoint(invalidBytes, f.grant)).toThrow('N8N_CHECKPOINT_INVALID');
      await expect(f.adapter().resume!(authorization, input)).rejects.toThrow('N8N_CHECKPOINT_INVALID');
    }
    expect(f.posts()).toBe(0);
  });
  it('collects every terminal branch iteration once and reports aggregate trace counts', () => {
    const f = fixture();
    f.grant.result = { nodes: ['Component'], sinks: [{ node: 'Component', port: 1, name: 'terminal false' }], traceNodes: ['Component'] };
    f.execution.data.resultData.runData.Component = [1, 2].map(iteration => ({ data: { main: [
      [{ json: { connected: iteration } }], [{ json: { terminal: iteration } }, { json: { repeated: true } }],
    ] } }));
    const result = collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.itemsJson as string)).toEqual([{ terminal: 1 }, { repeated: true }, { terminal: 2 }, { repeated: true }]);
    expect(JSON.parse(result.traceJson as string)[0].items).toEqual([2, 4]);
    expect(JSON.stringify(result)).not.toContain('connected');
  });
  it('keeps Loop Over Items done records separate from its per-iteration loop port', () => {
    const f = fixture();
    f.grant.result = { nodes: ['Component'], sinks: [{ node: 'Component', port: 0, name: 'done' }], traceNodes: ['Component'] };
    const done = [{ value: 'first processed' }, { value: 'second processed' }];
    f.execution.data.resultData.runData.Component = [
      { data: { main: [[], [{ json: { input: 'first' } }]] } },
      { data: { main: [[], [{ json: { input: 'second' } }]] } },
      { data: { main: [done.map(json => ({ json })), []] } },
    ];
    const result = collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution);
    expect(result.ok).toBe(true); expect(JSON.parse(result.itemsJson as string)).toEqual(done);
    expect(JSON.parse(result.traceJson as string)[0].items).toEqual([2, 2]);
  });
  it.each([20, 21, 201])('enforces the aggregate %s-record result across repeated runs', count => {
    const f = fixture(); f.grant.result.traceNodes = ['Component'];
    f.execution.data.resultData.runData.Component = [Math.floor(count / 2), Math.ceil(count / 2)]
      .map(length => ({ data: { main: [Array.from({ length }, () => ({ json: { value: 1 } }))] } }));
    const result = collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution);
    expect(result.ok).toBe(count <= 20);
    expect(JSON.parse(result.itemsJson as string)).toHaveLength(count <= 20 ? count : 0);
    expect(JSON.parse(result.traceJson as string)[0].items).toEqual([count]);
    if (count > 200) expect(JSON.parse(result.traceJson as string)[0]).toMatchObject({ outputOmitted: 'record-limit' });
  });
  it('enforces byte and record limits across runs and named output ports', () => {
    const f = fixture();
    f.execution.data.resultData.runData.Component = [1, 2].map(() => ({ data: { main: [[{ json: { text: 'x'.repeat(4200) } }]] } }));
    expect(collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution)).toMatchObject({ ok: false, itemsJson: '[]' });
    f.execution.data.resultData.runData.Component = [{ data: { main: [[{ json: { text: '💫'.repeat(2200) } }]] } }];
    expect(collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution)).toMatchObject({ ok: false, itemsJson: '[]' });
    f.grant.result.ports = ['true', 'false'];
    f.execution.data.resultData.runData.Component = [{ data: { main: [10, 11].map(length => Array.from({ length }, () => ({ json: { value: 1 } }))) } }];
    expect(collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution)).toMatchObject({ ok: false, portsJson: '{}' });
  });
  it('does not silently discard malformed records from an earlier iteration', () => {
    const f = fixture();
    f.execution.data.resultData.runData.Component.unshift({ data: { main: [[{ invalid: true }]] } });
    expect(() => collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution)).toThrow('N8N_EXECUTION_DATA_INVALID');
  });
  it('keeps an unacknowledged outcome unresolved and never redispatches on resume', async () => {
    const f = fixture();
    await expect(f.adapter().resume!(authorization, input)).rejects.toThrow('INSPECTION_REQUIRED');
    expect(f.posts()).toBe(0);
  });
  it('observes only a completed execution in the bound graph/executor scope', async () => {
    const f = fixture();
    const result = await f.adapter().dispatch(authorization, { ...input, executionId: '42' });
    expect(JSON.parse(result.output).n8nExecutionId).toBe('42'); expect(f.posts()).toBe(0);
  });
  it('refuses observation of another tenant scope without returning its data', async () => {
    const f = fixture(); delete f.execution.data.resultData.runData[n8nObservationScope(graph, owner, workflowId)];
    await expect(f.adapter().dispatch(authorization, { ...input, executionId: '42' })).rejects.toThrow('OBSERVATION_SCOPE_MISMATCH');
    expect(f.posts()).toBe(0);
  });
  it('withholds a mismatched executed version and rechecks authorization on continuation', async () => {
    const f = fixture(); f.execution.workflowVersionId = 'foreign';
    await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('EXECUTION_NOT_VERIFIED');
    f.authorize.mockRejectedValue(new Error('revoked'));
    await expect(f.adapter().resume!(authorization, input)).rejects.toThrow('revoked'); expect(f.posts()).toBe(1);
  });
  it('withholds output if the published version changes after the durable acknowledgement', async () => {
    const f = fixture(); f.setFailRead(true);
    await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow();
    f.setFailRead(false); f.definition.versionId = 'new-published-version';
    f.execution.workflowVersionId = 'new-published-version';
    await expect(f.adapter().resume!(authorization, input)).rejects.toThrow('EXECUTION_NOT_VERIFIED');
    expect(f.posts()).toBe(1);
  });
  it('reports confirmed native errors and oversized results as controlled rejection', () => {
    const f = fixture(); f.execution.status = 'error';
    expect(collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution)).toMatchObject({ ok: false, itemsJson: '[]' });
    f.execution.status = 'success'; f.execution.data.resultData.runData.Component[0].data.main = [Array.from({ length: 21 }, () => ({ json: { name: 'Ana' } }))];
    expect(collectN8nExecutionResult(normalizeN8nResult(f.grant.result), f.execution)).toMatchObject({ ok: false, itemsJson: '[]' });
  });
  it('validates result selectors as part of the reviewed grant', () => {
    const f = fixture();
    for (const result of [{ nodes: [] }, { nodes: ['Component'], url: 'foreign' }, { nodes: ['A', 'B'], ports: ['a', 'b'] }, { nodes: ['Component'], traceNodes: ['../secret'] }])
      expect(() => validateN8nGrant({ ...f.grant, result })).toThrow('INVALID_N8N_GRANT');
  });
});

// The installation pin is independent of tenant-controlled approval fields.
it.each(['nodes', 'ports', 'sinks', 'trace', 'schema'])('rejects altered native output contract before provider dispatch (%s)', async kind => {
  const f = fixture();
  if (kind === 'nodes') f.grant.result.nodes = ['Receive input'];
  if (kind === 'ports') f.grant.result.ports = ['first', 'second'];
  if (kind === 'sinks') f.grant.result.sinks = [{ node: 'Component', port: 1, name: 'copy' }];
  if (kind === 'trace') f.grant.result.traceNodes = ['Receive input'];
  if (kind === 'schema') f.grant.outputSchema = { ...f.grant.outputSchema, required: ['ok'] };
  await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('N8N_WORKFLOW_NOT_INSTALLED');
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each(['database', 'url', 'localFile', 'expression', 'nested', 'embedded-id'])('refuses unpinned %s helpers before effects', async source => {
  const f = fixture();
  const child = { nodes: [{ name: 'effect', type: 'n8n-nodes-base.executeWorkflow', parameters: { source: 'database', workflowId: 'mutable' } }], connections: {} };
  f.definition.nodes.push({ id: 'child', name: 'Child', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4,
    parameters: source === 'expression' ? { source: 'parameter', workflowJson: '={{ $json.workflow }}' }
      : source === 'nested' ? { source: 'parameter', workflowJson: JSON.stringify(child) }
        : source === 'embedded-id' ? { source: 'parameter', workflowJson: JSON.stringify({ id: 'mutable', nodes: [], connections: {} }) } : { source, workflowId: 'mutable' } });
  f.grant.workflowSha256 = n8nWorkflowSha256(f.definition); f.config.workflows[0]!.workflowSha256 = f.grant.workflowSha256;
  await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('N8N_SUBWORKFLOW_NOT_PINNED');
  expect(f.posts()).toBe(0);
});

it('withholds acknowledged output after the operator output policy changes', async () => {
  const f = fixture(); f.setFailRead(true);
  await expect(f.adapter().dispatch(authorization, input)).rejects.toThrow('N8N_INVOCATION_FAILED');
  expect(f.posts()).toBe(1); f.setFailRead(false);
  f.config.workflows[0]!.resultSha256 = 'f'.repeat(64);
  f.fetch.mockClear();
  await expect(f.adapter().resume!(authorization, input)).rejects.toThrow('N8N_WORKFLOW_NOT_INSTALLED');
  expect(f.fetch).not.toHaveBeenCalled();
});

it.each([201, 10000])('confirms a completed %s-record rejection with bounded output and truthful trace', async count => {
  const f = fixture();
  f.execution.data.resultData.runData.Component[0].data.main = [Array.from({length:count}, () => ({json:{value:1}}))];
  const result = await f.adapter().dispatch(authorization, input);
  expect(JSON.parse(result.output).output).toMatchObject({ok:false,itemsJson:'[]',portsJson:'{}',error:expect.stringContaining('twenty records')});
  expect(await f.adapter().resume!(authorization,input)).toEqual(result);expect(f.posts()).toBe(1);
  f.grant.result.traceNodes=['Component'];
  const traced=collectN8nExecutionResult(normalizeN8nResult(f.grant.result),f.execution);
  expect(JSON.parse(traced.traceJson as string)).toEqual([{node:'Component',status:'completed',items:[count],outputOmitted:'record-limit'}]);
});
it('rejects malformed native port shapes independently of overflow', () => {
  const f=fixture(); f.execution.data.resultData.runData.Component[0].data.main=[{invalid:true}];
  expect(()=>collectN8nExecutionResult(normalizeN8nResult(f.grant.result),f.execution)).toThrow('N8N_EXECUTION_DATA_INVALID');
});

it('verifies the captured n8n 2.43.8 Studio Read Write execution with the published definition pin', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/n8n-2.43.8-studio-read-write.json', import.meta.url), 'utf8'));
  const { published, execution } = fixture;
  const approved = { workflowId: execution.workflowId, workflowSha256: n8nWorkflowSha256(published) };
  expect(n8nPinnedExecutionMatches(published, execution, approved, published.versionId)).toBe(true);
  const normalized = structuredClone(execution);
  const request = normalized.workflowData.nodes.find((n: any) => n.name === 'Block read request');
  expect(request.parameters.jsonBody.startsWith('=')).toBe(true);
  request.parameters.jsonBody = request.parameters.jsonBody.slice(1);
  expect(n8nPinnedExecutionMatches(published, normalized, approved, published.versionId)).toBe(true);
  request.credentials.httpHeaderAuth.id = 'other-credential';
  expect(n8nPinnedExecutionMatches(published, normalized, approved, published.versionId)).toBe(false);
  expect(n8nPinnedExecutionMatches(published, execution, approved, 'another-version')).toBe(false);
});
