import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ExecutionReceiptJournal, ProgramTraceRecorder, readProgramTrace, readProgramCallHistory } from '@origintrail-official/dkg-semantic-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as nativeAdapter from '../src/semantic-runtime-n8n-native-adapter.js';
import { n8nResultSha256, n8nWorkflowSha256 } from '../src/semantic-runtime-n8n-contract.js';
import { cleanupRuntimeFixtures, toolFixture, toolApi, graph, sourceGraph, owner, caller, SR,
  restartNode, invalidateExecutionCapability } from './_helpers/semantic-runtime-api-fixture.js';

afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await cleanupRuntimeFixtures(); });

const n8nTool = 'urn:dkg:tool:n8n';
const nativeSource = `import { invoke_tool } from '${toolApi}';
  export async function run(input: unknown) { return invoke_tool('${n8nTool}', input); }`;
const run = (value: unknown) => ({ data: { main: [[{ json: { value } }]] } });
async function nativeFixture({ traceNodes = [] as string[], sinks = undefined as any, source = nativeSource, status = 'success' } = {}) {
  const workflowId = 'native-inspection';
  const definition = { versionId: 'published-native-1', nodes: ['Component', ...traceNodes].map(name => ({ id: name, name,
    type: 'n8n-nodes-base.set', typeVersion: 3.4, parameters: { hidden: 'reviewed' } })),
    connections: {}, settings: { executionOrder: 'v1' } };
  const string = { type: 'string', maxLength: 8192 };
  const outputSchema = { type: 'object', additionalProperties: false, required: ['ok', 'itemsJson', 'portsJson', 'error'],
    properties: { ok: { type: 'boolean' }, itemsJson: string, portsJson: string, error: string, ...(traceNodes.length ? { traceJson: string } : {}) } };
  const inputSchema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: string } };
  const n8n = { toolIri: n8nTool, workflowId, workflowSha256: n8nWorkflowSha256(definition), inputSchema, outputSchema,
    result: { nodes: ['Component'], ...(traceNodes.length ? { traceNodes } : {}), ...(sinks ? { sinks } : {}) } };
  const f = await toolFixture(source, { graphId: graph, n8n }, [n8nTool]);
  const apiTokenFile = join(f.target.dir, 'native-api'), webhookTokenFile = join(f.target.dir, 'native-webhook');
  writeFileSync(apiTokenFile, 'unit-native-api-fixture'); writeFileSync(webhookTokenFile, 'unit-native-webhook-fixture');
  f.target.config.semanticRuntime.n8nNative = { baseUrl: 'http://127.0.0.1:5679', apiTokenFile, webhookTokenFile,
    workflows: [{ contextGraphId: graph, executorAgentAddress: owner, workflowId, workflowSha256: n8n.workflowSha256, resultSha256: n8nResultSha256(n8n as any) }] };
  const state = { status, dispatches: 0, interrupted: true, loseAcknowledgement: false, publishedVersion: definition.versionId,
    runs: [run(12)] as any[] };
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    const u = new URL(String(url));
    if (u.pathname.startsWith('/api/v1/workflows/')) return Response.json({ ...definition, versionId: state.publishedVersion, id: workflowId, active: true });
    if (u.pathname.startsWith('/webhook/')) {
      state.dispatches++;
      if (state.loseAcknowledgement) throw new Error('acknowledgement-lost');
      return Response.json({ executionId: '42' });
    }
    if (state.interrupted) throw new Error('interrupted-after-durable-ack');
    const snapshot = structuredClone(definition); snapshot.nodes[0]!.parameters = {} as any;
    return Response.json({ id: '42', workflowId, workflowVersionId: definition.versionId, status: state.status, workflowData: snapshot,
      data: { resultData: { runData: { Component: state.runs } } } });
  }));
  return { ...f, n8n, state, definition, webhookTokenFile,
    async start(overrides = {}) {
      await f.approve(overrides);
      await f.client.routes.create({ ...f.operation, targetPeerId: f.agent.peerId });
      return f.client.programs.prepareInvocation({ ...f.operation, inputs: [{ text: 'original' }] });
    } };
}
type NativeFixture = Awaited<ReturnType<typeof nativeFixture>>;
type Invocation = Awaited<ReturnType<NativeFixture['start']>>;

async function interruptInspection(f: NativeFixture, prepared: Invocation) {
  await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION' });
  expect(f.state.dispatches).toBe(1);
}
async function rejectChangedInput(f: NativeFixture, prepared: Invocation) {
  await expect(f.client.programs.invoke({ ...prepared, inputs: [{ text: 'changed' }] })).rejects.toMatchObject({ code: 'INVOCATION_LAYER_CONFLICT' });
}
async function resumeInspection(f: NativeFixture, prepared: Invocation) {
  f.state.interrupted = false;
  f.state.publishedVersion = 'foreign-version';
  await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION' });
  expect(f.state.dispatches).toBe(1);
  f.state.publishedVersion = f.definition.versionId;
}
async function expectCompleted(f: NativeFixture, prepared: Invocation, output: unknown = { ok: true, itemsJson: '[{"value":12}]' }) {
  const result = await f.client.programs.invoke(prepared);
  expect(result.invocationId).toBe(prepared.invocationId);
  expect(result.executionIri).toBe(`urn:sr:execution:${prepared.invocationId}`);
  expect(result.outputs).toMatchObject([{ n8nExecutionId: '42', output }]);
  expect(await f.client.programs.invoke(prepared)).toEqual(result);
  const stored = await f.store.query(`SELECT ?output WHERE { GRAPH ?g { <${result.executionIri}> <${SR}output> ?output } }`);
  expect(JSON.stringify(stored)).toContain('n8nExecutionId');
  expect(f.state.dispatches).toBe(1);
}
async function interruptReceipt(f: NativeFixture, prepared: Invocation) {
  const executionIri = `urn:sr:execution:${prepared.invocationId}`;
  const prepare = vi.spyOn(ExecutionReceiptJournal.prototype, 'prepare').mockImplementationOnce(() => { throw new Error('stopped-before-parent-receipt'); });
  try { await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'TYPESCRIPT_EXECUTION_FAILED' }); }
  finally { prepare.mockRestore(); }
  const store = f.target.runtime!.store, effects = store.effectsForExecution(executionIri);
  expect(effects).toHaveLength(1);
  expect(effects[0].state).toBe('succeeded');
  expect(store.adapterCheckpoint(effects[0].effectId)).toBeDefined();
  expect(new ExecutionReceiptJournal(store, executionIri).terminal).toBeUndefined();
  return { store, executionIri };
}
async function declareChild(f: NativeFixture, parentSource: (childIri: string) => string) {
  const child = await f.manager.programs.upload({ graphId: sourceGraph, language: 'typescript-v1', requiredTools: [], source: 'export function run() { return 42; }' });
  const childOperation = { graphId: graph, operationIri: 'urn:child:declared-only' };
  await f.manager.programs.approve({ ...childOperation, program: child, allowedCallers: [caller], typescript: { children: [] } });
  const program = await f.manager.programs.upload({ graphId: sourceGraph, language: 'typescript-v1', source: parentSource(child.programIri),
    requiredTools: [n8nTool], permittedPrograms: [child.programIri], requestedPermissions: { graphId: graph, n8n: f.n8n } });
  return { program, typescript: { children: [childOperation] } };
}

describe('native dispatch and durable recovery', () => {
  it.each([
    { name: 'complete result', options: {}, runs: [run(12)], output: { ok: true, itemsJson: '[{"value":12}]' } },
    ...['canceled', 'crashed'].map(status => ({ name: status + ' execution', options: { status }, runs: [run(12)],
      output: { ok: false, itemsJson: '[]', portsJson: '{}', error: expect.stringContaining('stopped this workflow') } })),
    { name: 'oversized result', options: {}, runs: [{ data: { main: [Array.from({ length: 201 }, () => ({ json: { value: 12 } }))] } }],
      output: { ok: false, itemsJson: '[]', error: expect.stringContaining('twenty records') } },
    { name: 'escaped result envelope', options: { traceNodes: Array.from({ length: 8 }, (_, i) => 'Trace' + i) }, runs: [run('\\'.repeat(4000))],
      output: { ok: false, itemsJson: '[]', error: expect.stringContaining('complete result') } },
    { name: 'loop terminal ports', options: { sinks: [{ node: 'Component', port: 1, name: 'terminal false' }] },
      runs: [1, 2].map(value => ({ data: { main: [[], [{ json: { value } }]] } })), output: { ok: true, itemsJson: '[{"value":1},{"value":2}]' } },
  ])('reconciles $name after restart without a second dispatch', async ({ options, runs, output }) => {
    const f = await nativeFixture(options); f.state.runs = runs;
    const prepared = await f.start();
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await resumeInspection(f, prepared);
    await expectCompleted(f, prepared, output);
  });

  it('recovers the original acknowledgement after a restart before the first callback', async () => {
    const f = await nativeFixture(), prepared = await f.start();
    await interruptInspection(f, prepared);
    const runtime = await restartNode(f.target);
    const execute = vi.spyOn(runtime.typescript!, 'execute').mockRejectedValueOnce(new Error('stopped-before-first-callback'));
    try { await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'TYPESCRIPT_EXECUTION_FAILED' }); }
    finally { execute.mockRestore(); }
    const executionIri = `urn:sr:execution:${prepared.invocationId}`;
    expect(readProgramTrace(runtime.store, executionIri)?.calls).toEqual([]);
    expect(readProgramCallHistory(runtime.store, executionIri).calls).toHaveLength(1);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await resumeInspection(f, prepared);
    await expectCompleted(f, prepared);
  });

  it('recovers a succeeded effect after a hard stop before the parent receipt', async () => {
    const f = await nativeFixture(), prepared = await f.start();
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await resumeInspection(f, prepared);
    const { store, executionIri } = await interruptReceipt(f, prepared);
    store.setExecutionStatus(executionIri, 'active');
    await restartNode(f.target);
    await expectCompleted(f, prepared);
  });

  it('rechecks revocation after the native effect succeeded but before the parent receipt', async () => {
    const f = await nativeFixture(), prepared = await f.start();
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await resumeInspection(f, prepared);
    await interruptReceipt(f, prepared);
    invalidateExecutionCapability(f.target, prepared.invocationId, 'revoke');
    await restartNode(f.target);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ status: 403 });
    expect(f.state.dispatches).toBe(1);
  });

  it('permits recovery when a child is declared but never called', async () => {
    const f = await nativeFixture();
    const prepared = await f.start(await declareChild(f, () => nativeSource));
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await resumeInspection(f, prepared);
    await expectCompleted(f, prepared);
  });

  it('retains earlier child-call history when a later diagnostic attempt writes an empty trace', async () => {
    const f = await nativeFixture();
    const prepared = await f.start(await declareChild(f, childIri => `import { invoke_tool, invoke_program } from '${toolApi}';
      export async function run(input: unknown) { await invoke_program('${childIri}', []); return invoke_tool('${n8nTool}', input); }`));
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    const executionIri = `urn:sr:execution:${prepared.invocationId}`;
    f.target.runtime!.store.setExecutionStatus(executionIri, 'active');
    new ProgramTraceRecorder(f.target.runtime!.store, executionIri);
    await restartNode(f.target);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_NOT_RETRYABLE' });
    expect(f.state.dispatches).toBe(1);
  });

  it('rejects a corrupt call journal entry after restart without dispatching again', async () => {
    const f = await nativeFixture(), prepared = await f.start();
    await interruptInspection(f, prepared);
    const store = f.target.runtime!.store, executionIri = `urn:sr:execution:${prepared.invocationId}`;
    store.setExecutionStatus(executionIri, 'active'); // Model a journal write interrupted by a hard stop.
    const bytes = new Uint8Array([0xa1]); // Truncated CBOR map, not a valid v1 event.
    const seq = store.execution(executionIri)!.nextEventSeq;
    store.commitRuntimeTransition({ executionId: executionIri, expectedNextSeq: seq, eventId: `trace:${seq}`,
      eventType: 'typescript-call-trace-v1', eventCbor: bytes, stateDigest: createHash('sha256').update(bytes).digest() });
    await restartNode(f.target);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_NOT_RETRYABLE' });
    expect(f.state.dispatches).toBe(1);
  });

  it('never admits an additional native call while reconciling the acknowledged effect', async () => {
    const f = await nativeFixture({ source: `import { invoke_tool } from '${toolApi}';
      export async function run(input: unknown) { const value = await invoke_tool('${n8nTool}', input);
        await invoke_tool('${n8nTool}', input); return value; }` });
    const prepared = await f.start();
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await resumeInspection(f, prepared);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION' });
    const effects = f.target.runtime!.store.effectsForExecution(`urn:sr:execution:${prepared.invocationId}`);
    expect(effects).toHaveLength(1); expect(effects[0].state).toBe('succeeded');
    await restartNode(f.target);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_REQUIRES_RECONCILIATION' });
    expect(f.state.dispatches).toBe(1);
  });

  it('never redispatches an execution whose acknowledgement was lost', async () => {
    const f = await nativeFixture(); f.state.loseAcknowledgement = true;
    const prepared = await f.start();
    await interruptInspection(f, prepared);
    const effects = f.target.runtime!.store.effectsForExecution(`urn:sr:execution:${prepared.invocationId}`);
    expect(effects).toHaveLength(1); expect(effects[0].state).toBe('unknown');
    expect(f.target.runtime!.store.adapterCheckpoint(effects[0].effectId)).toBeNull();
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_NOT_RETRYABLE' });
    expect(f.state.dispatches).toBe(1);
  });

  it('refuses continuation with an invalid persisted native version without redispatching', async () => {
    const f = await nativeFixture(), prepared = await f.start();
    await interruptInspection(f, prepared);
    const store = f.target.runtime!.store;
    const effect = store.effectsForExecution('urn:sr:execution:' + prepared.invocationId)[0];
    const checkpoint = store.adapterCheckpoint(effect.effectId)!;
    const saved = JSON.parse(new TextDecoder().decode(checkpoint.payload));
    store.writeAdapterCheckpoint(effect.effectId, effect.requestDigest,
      new TextEncoder().encode(JSON.stringify({ ...saved, versionId: '' })), checkpoint.version);
    await restartNode(f.target);
    f.state.interrupted = false;
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ code: 'INVOCATION_NOT_RETRYABLE' });
    expect(f.state.dispatches).toBe(1);
  });

  it.each([
    { name: 'missing', damage: (path: string) => rmSync(path) },
    { name: 'short', damage: (path: string) => writeFileSync(path, 'short') },
  ])('keeps a definitive failure for a $name credential after repair and restart', async ({ damage }) => {
    const f = await nativeFixture(), prepared = await f.start();
    damage(f.webhookTokenFile);
    const error = await f.client.programs.invoke(prepared).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).not.toBe('INVOCATION_REQUIRES_RECONCILIATION');
    const executionIri = `urn:sr:execution:${prepared.invocationId}`;
    const effects = f.target.runtime!.store.effectsForExecution(executionIri);
    expect(effects).toHaveLength(1); expect(effects[0].state).toBe('failed');
    expect(f.target.runtime!.store.effectTransitions(effects[0].effectId).at(-1)).toMatchObject({ state: 'failed', evidenceRef: 'adapter-definitive-failure' });
    expect(f.target.runtime!.store.adapterCheckpoint(effects[0].effectId)).toBeNull();
    expect(f.state.dispatches).toBe(0);
    writeFileSync(f.webhookTokenFile, 'unit-native-webhook-fixture');
    await restartNode(f.target);
    await expect(f.client.programs.invoke(prepared)).rejects.toBeInstanceOf(Error);
    expect(f.target.runtime!.store.effectsForExecution(executionIri)[0].state).toBe('failed');
    expect(f.state.dispatches).toBe(0);
    f.state.interrupted = false;
    const fresh = f.client.programs.prepareInvocation({ ...f.operation, inputs: [{ text: 'original' }] });
    expect((await f.client.programs.invoke(fresh)).outputs).toMatchObject([{ n8nExecutionId: '42' }]);
    expect(f.state.dispatches).toBe(1);
  });

  it.each(['revoke', 'expire', 'epoch'] as const)('rechecks %s before recovery after restart', async change => {
    const f = await nativeFixture(), prepared = await f.start();
    await interruptInspection(f, prepared);
    await restartNode(f.target);
    await rejectChangedInput(f, prepared);
    invalidateExecutionCapability(f.target, prepared.invocationId, change);
    await restartNode(f.target);
    await expect(f.client.programs.invoke(prepared)).rejects.toMatchObject({ status: 403 });
    expect(f.state.dispatches).toBe(1);
  });
});


// These fixtures retain historical descriptor metadata while exercising the
// real checkpoint, effect and receipt stores. They do not alias v1 pins to v2.
function useHistoricalImplementationPin() {
  const create = nativeAdapter.createNativeN8nWorkflowAdapter;
  return vi.spyOn(nativeAdapter, 'createNativeN8nWorkflowAdapter').mockImplementation((...args) => ({
    ...create(...args), implementationVersion: 'n8n-native-components-v1', implementationHash: 'b'.repeat(64),
  }));
}

it('preserves a completed receipt with historical implementation pins across reopen', async () => {
  const f = await nativeFixture(), prepared = await f.start();
  f.state.interrupted = false;
  const oldImplementation = useHistoricalImplementationPin();
  const original = await f.client.programs.invoke(prepared);
  oldImplementation.mockRestore();
  const pins = async () => (await f.store.query(`SELECT ?version ?hash WHERE { GRAPH ?g {
    <${original.executionIri}> <${SR}adapterVersion> ?version ; <${SR}adapterHash> ?hash . } }`)).bindings
    .map(row => ({ version: JSON.parse(row.version!), hash: JSON.parse(row.hash!) }));
  const historical = await pins();
  expect(historical).toEqual([{ version: 'n8n-native-components-v1', hash: 'sha256:' + 'b'.repeat(64) }]);
  await restartNode(f.target);
  expect(await f.client.programs.invoke(prepared)).toEqual(original);
  expect(await pins()).toEqual(historical);
  expect(f.state.dispatches).toBe(1);
});

it('continues an acknowledged v1 effect under the v2 implementation without rewriting its identity', async () => {
  const f = await nativeFixture(), prepared = await f.start();
  const oldImplementation = useHistoricalImplementationPin();
  await interruptInspection(f, prepared);
  oldImplementation.mockRestore();
  const effect = f.target.runtime!.store.effectsForExecution('urn:sr:execution:' + prepared.invocationId)[0]!;
  const checkpoint = Buffer.from(f.target.runtime!.store.adapterCheckpoint(effect.effectId)!.payload);
  await restartNode(f.target);
  f.state.interrupted = false;
  await expectCompleted(f, prepared);
  const recovered = f.target.runtime!.store.effect(effect.effectId)!;
  expect(recovered).toMatchObject({ adapterId: effect.adapterId, adapterVersion: effect.adapterVersion,
    capabilityId: effect.capabilityId, requestDigest: effect.requestDigest, idempotencyKey: effect.idempotencyKey });
  expect(Buffer.from(f.target.runtime!.store.adapterCheckpoint(effect.effectId)!.payload)).toEqual(checkpoint);
  expect(f.state.dispatches).toBe(1);
});
