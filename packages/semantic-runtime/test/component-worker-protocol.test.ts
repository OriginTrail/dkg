import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultExecutionCapability } from '../src/component-types.js';
import type { ExecutionCapabilityDescriptor } from '../src/component-types.js';
import type { ComponentWorkerMessage, ComponentWorkerRequest } from '../src/component-worker-protocol.js';

// Keep the guest executor and transport controlled while testing the production
// source boundary. Real JSPI/Wasm execution is covered by the existing host and
// component-concurrency suites; this suite injects hostile guest/parent values.
const harness = vi.hoisted(() => ({
  listener: undefined as ((message: unknown) => void) | undefined,
  messages: [] as ComponentWorkerMessage[],
  bootstrap: { artifactRoot: '/verified', componentHash: 'component', witHash: 'wit', expectedAbi: 1, allowTestOperations: false, maxOperations: 2, resourceLimits: {} },
  componentPath: '',
  imports: {} as Record<string, Record<string, (...args: unknown[]) => unknown>>,
  loadCore: undefined as ((path: string) => Promise<WebAssembly.Module>) | undefined,
  resource: undefined as unknown,
  toolResult: undefined as unknown,
  instantiate: vi.fn(),
  executor: { abiVersion: vi.fn(), compile: vi.fn(), admit: vi.fn(), start: vi.fn() },
  execution: { advance: vi.fn(), inspect: vi.fn(), [Symbol.dispose]: vi.fn() },
  port: { on: vi.fn(), postMessage: vi.fn() },
  onToolCall: undefined as ((message: Extract<ComponentWorkerMessage, { type: 'tool-call' }>) => void) | undefined,
}));

vi.mock('node:worker_threads', () => ({ parentPort: harness.port, workerData: harness.bootstrap }));
vi.mock('../src/integrity.js', () => ({
  verifyRuntimeArtifacts: () => ({ componentSha256: 'component', witSha256: 'wit', componentRoot: '/verified/component', componentJsPath: harness.componentPath }),
}));
vi.mock('../generated/component/runtime.js', () => ({ instantiate: harness.instantiate }));

const hash = new Uint8Array(32).fill(0x11);
const hashHex = Buffer.from(hash).toString('hex');
const plan = {
  canonicalPlan: new Uint8Array([1, 2]), canonicalHash: hash, strategyRef: 'test/strategy', scope: 'test', goal: 'test',
  requiredCapabilities: ['query'], effectUpperBound: ['dkg/query'], approvalRequirements: [],
  adapterVersions: [{ operation: 'dkg/query', version: 1 }], bounds: { processes: 1, hostCommands: 1, retryAttempts: 0, depth: 1 },
};
const inspection = { canonicalHash: hash, strategyRef: 'test/strategy', logicalTime: 5n, stateDigest: hash, agents: [{ role: 'worker', processId: hash, status: 'runnable' }] };
const completion = { tag: 'completed', val: { events: [{ role: 'worker', processId: hash, value: 'event' }], outputs: [{ role: 'worker', processId: hash, value: 'output' }] } };
let requestId = 0n;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.messages.length = 0;
  harness.listener = undefined;
  harness.onToolCall = undefined;
  harness.resource = undefined;
  harness.toolResult = undefined;
  requestId = 0n;
  Object.assign(harness.bootstrap, { componentHash: 'component', witHash: 'wit', expectedAbi: 1, allowTestOperations: false, maxOperations: 2 });
  harness.componentPath = fileURLToPath(new URL('../generated/component/runtime.js', import.meta.url));
  harness.port.on.mockImplementation((_event, callback) => { harness.listener = callback; });
  harness.port.postMessage.mockImplementation((message: ComponentWorkerMessage) => {
    harness.messages.push(message);
    if (message.type === 'tool-call') harness.onToolCall?.(message);
  });
  harness.instantiate.mockImplementation(async (loadCore, imports) => {
    harness.loadCore = loadCore;
    harness.imports = imports;
    return { executor: harness.executor };
  });
  harness.executor.abiVersion.mockReturnValue(1);
  harness.executor.compile.mockReturnValue(plan);
  harness.executor.admit.mockReturnValue(plan);
  harness.executor.start.mockImplementation((resource) => { harness.resource = resource; return [harness.execution, inspection]; });
  harness.execution.inspect.mockReturnValue(inspection);
  harness.execution.advance.mockResolvedValue(completion);
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

async function boot() { await import('../src/component-worker.js'); }
async function send(op: ComponentWorkerRequest['op'], extra: Partial<ComponentWorkerRequest> = {}) {
  const id = ++requestId;
  harness.listener!({ type: 'request', requestId: id, op, ...extra });
  await vi.waitFor(() => expect(harness.messages.some((message) => 'requestId' in message && message.requestId === id && message.type !== 'tool-call')).toBe(true), { interval: 1 });
  return harness.messages.find((message) => 'requestId' in message && message.requestId === id && message.type !== 'tool-call')!;
}
function capability(): ExecutionCapabilityDescriptor {
  return { ...defaultExecutionCapability(hashHex), tools: [
    { operation: 'agent/investigate', version: '1', witInterface: 'origintrail:semantic-runtime/investigator@0.1.0' },
    { operation: 'dkg/query', version: '1', witInterface: 'origintrail:semantic-runtime/query-catalog@0.1.0' },
    { operation: 'llm/safe', version: '1', witInterface: 'origintrail:semantic-runtime/safe-llm@0.1.0' },
    { operation: 'remote-execute', version: '1', witInterface: 'origintrail:semantic-runtime/remote-execute@0.1.0' },
  ] };
}
async function start(descriptor = capability()) {
  return send('start', { plan: plan.canonicalPlan, capability: descriptor, logicalTime: 5n });
}
type ToolKind = 'investigator' | 'query-catalog' | 'safe-llm' | 'remote-execute';
function importedTool(kind: ToolKind) {
  const api = harness.imports[`origintrail:semantic-runtime/${kind}@0.1.0`];
  return api[{ investigator: 'investigate', 'query-catalog': 'query', 'safe-llm': 'run', 'remote-execute': 'execute' }[kind]];
}
function invokeDuringAdvance(kind: ToolKind, argument: unknown, resource?: unknown) {
  harness.execution.advance.mockImplementation(async () => {
    harness.toolResult = await importedTool(kind)(resource ?? harness.resource, argument);
    return completion;
  });
}

describe('component worker trust boundary', () => {
  it.each(['componentHash', 'witHash', 'expectedAbi'] as const)('refuses a mismatched %s before announcing readiness', async (field) => {
    if (field === 'expectedAbi') harness.bootstrap.expectedAbi = 9;
    else harness.bootstrap[field] = 'wrong';
    await expect(boot()).rejects.toThrow(field === 'expectedAbi' ? /ABI mismatch/ : /artifact identity/);
    expect(harness.messages).toEqual([]);
  });

  it('loads only core modules within the verified root and denies ambient or unknown imports', async () => {
    await boot();
    await expect(harness.loadCore!('../outside.wasm')).rejects.toThrow(/escaped/);
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
    await expect(harness.loadCore!('core.wasm')).resolves.toBeInstanceOf(WebAssembly.Module);
    expect(read).toHaveBeenCalledWith('/verified/component/core.wasm');
    expect(() => harness.imports['wasi:cli/environment@0.2.12'].getEnvironment()).toThrow('AMBIENT_WASI_DENIED');
    expect(() => harness.imports['wasi:filesystem/types']).toThrow('UNKNOWN_COMPONENT_IMPORT');
    expect(harness.imports['origintrail:semantic-runtime/capability']).toHaveProperty('ExecutionCapability');
  });

  it('normalizes admitted plans and diagnostic locations without dropping correlation', async () => {
    await boot();
    expect(await send('compile', { source: '(strategy valid)' })).toMatchObject({ type: 'response', ok: true, result: { ok: true, plan: { adapterVersions: new Map([['dkg/query', 1]]), resourceBounds: plan.bounds } } });
    expect(await send('admit', { plan: plan.canonicalPlan })).toMatchObject({ ok: true, result: { canonicalPlan: plan.canonicalPlan } });
    harness.executor.compile.mockImplementation(() => { throw { payload: [{ code: 'INVALID', primary: { start: { line: 1n, column: 2n }, end: { line: 3n, column: 4n } }, message: 'invalid syntax' }] }; });
    expect(await send('compile', { source: '(' })).toMatchObject({ ok: true, result: { ok: false, diagnostics: [{ code: 'INVALID', primary: { start: { line: 1, column: 2 }, end: { line: 3, column: 4 } }, message: 'invalid syntax', help: null }] } });
    expect(await send('compile')).toMatchObject({ ok: false, code: 'COMPONENT_FAILURE', message: 'compile source is missing' });
  });

  it.each([undefined, new Uint8Array(4 * 1024 * 1024 + 1)])('rejects missing or oversized plans before calling the guest', async (bytes) => {
    await boot();
    expect(await send('admit', { plan: bytes })).toMatchObject({ ok: false, code: 'PLAN_BYTES_INVALID', category: 'input' });
    expect(harness.executor.admit).not.toHaveBeenCalled();
  });

  it('freezes execution authority and binds the guest receipt to the authorized plan', async () => {
    await boot();
    const descriptor = capability();
    expect(await start(descriptor)).toMatchObject({ ok: true, result: { canonicalHash: hash, instanceId: expect.any(String) } });
    const resource = harness.resource as { descriptor: ExecutionCapabilityDescriptor };
    descriptor.tools.length = 0;
    descriptor.policy.epoch = 99n;
    expect(resource.descriptor.tools).toHaveLength(4);
    expect(resource.descriptor.policy.epoch).toBe(0n);
    expect(Object.isFrozen(resource.descriptor)).toBe(true);
    expect(Object.isFrozen(resource.descriptor.budgets)).toBe(true);
    expect(await start()).toMatchObject({ ok: false, code: 'COMPONENT_ALREADY_STARTED' });
    expect(await send('inspect')).toMatchObject({ ok: true, result: { agents: inspection.agents } });
    expect(await send('advance')).toMatchObject({ ok: true, result: { kind: 'completed', events: completion.val.events, outputs: completion.val.outputs } });
    expect(await send('drop')).toMatchObject({ ok: true, result: { dropped: true } });
    expect(harness.execution[Symbol.dispose]).toHaveBeenCalledOnce();
    expect(await send('advance')).toMatchObject({ ok: false, code: 'COMPONENT_NOT_STARTED' });
    expect(await send('inspect')).toMatchObject({ ok: false, code: 'CAPABILITY_MISSING' });
    const wrong = capability(); wrong.planHash = '0'.repeat(64);
    expect(await start(wrong)).toMatchObject({ ok: false, code: 'CAPABILITY_PLAN_HASH_MISMATCH' });
    expect(harness.execution[Symbol.dispose]).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['execution id', (value: ExecutionCapabilityDescriptor) => { value.executionId = ''; }],
    ['source hash', (value: ExecutionCapabilityDescriptor) => { value.sourceHash = 'bad'; }],
    ['policy epoch', (value: ExecutionCapabilityDescriptor) => { value.policy.epoch = 1 as unknown as bigint; }],
    ['expiry', (value: ExecutionCapabilityDescriptor) => { value.expiresAt = Infinity; }],
    ['budget', (value: ExecutionCapabilityDescriptor) => { value.budgets.maxOperations = 0; }],
    ['tool version', (value: ExecutionCapabilityDescriptor) => { value.tools[0].version = ''; }],
  ] as const)('rejects an invalid capability %s before starting the guest', async (_label, mutate) => {
    await boot();
    const descriptor = capability(); mutate(descriptor);
    expect(await start(descriptor)).toMatchObject({ ok: false, code: 'CAPABILITY_DESCRIPTOR_INVALID' });
    expect(harness.executor.start).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'expired', 'budget'] as const)('enforces %s authority before executing the next step', async (kind) => {
    await boot();
    const descriptor = capability();
    if (kind === 'revoked') descriptor.revoked = true;
    if (kind === 'expired') descriptor.expiresAt = 1;
    if (kind === 'budget') descriptor.budgets.maxOperations = 1;
    await start(descriptor);
    if (kind === 'budget') expect(await send('advance')).toMatchObject({ ok: true });
    expect(await send('advance')).toMatchObject({ ok: false, code: { revoked: 'CAPABILITY_REVOKED', expired: 'CAPABILITY_EXPIRED', budget: 'COMPONENT_OPERATION_BUDGET_EXHAUSTED' }[kind] });
    expect(harness.execution.advance).toHaveBeenCalledTimes(kind === 'budget' ? 1 : 0);
  });

  it.each(['investigator', 'query-catalog', 'safe-llm', 'remote-execute'] as const)('correlates %s requests and returns the matching host result', async (kind) => {
    await boot(); await start();
    const argument = kind === 'query-catalog'
      ? { effectId: 1n, queryId: 'catalog/items', parameters: [{ name: 'limit', value: '2' }] }
      : kind === 'remote-execute'
        ? { effectId: 1n, nodeId: 'peer-b', programIri: 'urn:sr:program:child' }
        : { effectId: 1n, prompt: 'investigate' };
    const result = kind === 'query-catalog' ? { kind, json: '[]' }
      : kind === 'remote-execute' ? { kind, executionIri: 'urn:sr:execution:child', executionUal: 'did:dkg:child' }
        : { kind, output: 'done' };
    invokeDuringAdvance(kind, argument);
    harness.onToolCall = (message) => {
      expect(message.call).toEqual({ kind, ...argument });
      harness.listener!({ type: 'tool-result', toolCallId: message.toolCallId, ok: true, result });
    };
    expect(await send('advance')).toMatchObject({ ok: true, result: { kind: 'completed' } });
    expect(harness.messages.filter((message) => message.type === 'tool-call')).toHaveLength(1);
    expect(harness.toolResult).toEqual(kind === 'query-catalog' ? { json: '[]' }
      : kind === 'remote-execute' ? { executionIri: 'urn:sr:execution:child', executionUal: 'did:dkg:child' }
        : 'done');
  });

  it.each([
    ['safe-llm', { effectId: 0n, prompt: 'x' }, 'INVALID_SAFE_LLM_EFFECT_ID'],
    ['safe-llm', { effectId: 1n, prompt: 9 }, 'INVALID_SAFE_LLM_ARGUMENT'],
    ['remote-execute', { effectId: 0n, nodeId: 'peer-b', programIri: 'urn:sr:program:child' }, 'INVALID_REMOTE_EXECUTE_EFFECT_ID'],
    ['remote-execute', { effectId: 1n, nodeId: '', programIri: 'urn:sr:program:child' }, 'INVALID_REMOTE_EXECUTE_ARGUMENT'],
    ['remote-execute', { effectId: 1n, nodeId: 'λ'.repeat(257), programIri: 'urn:sr:program:child' }, 'INVALID_REMOTE_EXECUTE_ARGUMENT'],
    ['remote-execute', { effectId: 1n, nodeId: 'peer-b', programIri: '' }, 'INVALID_REMOTE_EXECUTE_ARGUMENT'],
    ['remote-execute', { effectId: 1n, nodeId: 'peer-b', programIri: 'λ'.repeat(1025) }, 'INVALID_REMOTE_EXECUTE_ARGUMENT'],
    ['investigator', { effectId: 0n, prompt: 'x' }, 'INVALID_LLM_EFFECT_ID'],
    ['investigator', { effectId: 1n, prompt: 9 }, 'INVALID_LLM_ARGUMENT'],
    ['query-catalog', { effectId: 0n, queryId: 'q', parameters: [] }, 'INVALID_QUERY_EFFECT_ID'],
    ['query-catalog', { effectId: 1n, queryId: 'q', parameters: [{ name: 'x', value: '1' }, { name: 'x', value: '2' }] }, 'INVALID_QUERY_ARGUMENT'],
  ] as const)('rejects invalid %s arguments with %s', async (kind, argument, code) => {
    await boot(); await start(); invokeDuringAdvance(kind, argument);
    expect(await send('advance')).toMatchObject({ ok: false, code });
    expect(harness.messages.filter((message) => message.type === 'tool-call')).toEqual([]);
  });

  it.each(['resource', 'permission'] as const)('rejects a tool call lacking the bound %s', async (kind) => {
    await boot(); const descriptor = capability();
    if (kind === 'permission') descriptor.tools = [];
    await start(descriptor);
    invokeDuringAdvance('investigator', { effectId: 1n, prompt: 'x' }, kind === 'resource' ? {} : undefined);
    expect(await send('advance')).toMatchObject({ ok: false, code: kind === 'resource' ? 'CAPABILITY_RESOURCE_MISMATCH' : 'COMPONENT_TOOL_NOT_AUTHORIZED' });
    expect(harness.messages.filter((message) => message.type === 'tool-call')).toEqual([]);
  });

  it.each(['host failure', 'wrong kind'] as const)('rejects a tool result with %s', async (kind) => {
    await boot(); await start(); invokeDuringAdvance('investigator', { effectId: 1n, prompt: 'x' });
    harness.onToolCall = (message) => harness.listener!({ type: 'tool-result', toolCallId: message.toolCallId, ...(kind === 'host failure' ? { ok: false, code: 'DENIED', message: 'host denied', retryable: true } : { ok: true, result: { kind: 'query-catalog', json: '[]' } }) });
    expect(await send('advance')).toMatchObject({ ok: false, code: kind === 'host failure' ? 'DENIED' : 'COMPONENT_TOOL_RESULT_MISMATCH', retryable: kind === 'host failure' });
  });

  it.each(['safe-llm', 'remote-execute'] as const)('requires the exact %s authority and result kind', async (kind) => {
    await boot();
    const descriptor = capability();
    descriptor.tools = descriptor.tools.filter((tool) => !tool.witInterface.includes(kind));
    await start(descriptor);
    const argument = kind === 'safe-llm' ? { effectId: 1n, prompt: 'x' }
      : { effectId: 1n, nodeId: 'peer-b', programIri: 'urn:sr:program:child' };
    invokeDuringAdvance(kind, argument);
    expect(await send('advance')).toMatchObject({ ok: false, code: 'COMPONENT_TOOL_NOT_AUTHORIZED' });
    expect(harness.messages.filter((message) => message.type === 'tool-call')).toEqual([]);
    await send('drop'); await start();
    harness.onToolCall = (message) => harness.listener!({ type: 'tool-result', toolCallId: message.toolCallId, ok: true, result: { kind: 'investigator', output: 'wrong tool' } });
    expect(await send('advance')).toMatchObject({ ok: false, code: 'COMPONENT_TOOL_RESULT_MISMATCH' });
  });

  it.each([
    { kind: 'remote-execute', executionIri: '' },
    { kind: 'remote-execute', executionIri: 123 },
    { kind: 'remote-execute', executionIri: 'urn:sr:execution:child', executionUal: 123 },
  ])('rejects malformed remote execution receipts: %j', async (result) => {
    await boot(); await start();
    invokeDuringAdvance('remote-execute', { effectId: 1n, nodeId: 'peer-b', programIri: 'urn:sr:program:child' });
    harness.onToolCall = (message) => harness.listener!({ type: 'tool-result', toolCallId: message.toolCallId, ok: true, result });
    expect(await send('advance')).toMatchObject({ ok: false, code: 'COMPONENT_TOOL_RESULT_MISMATCH' });
    expect(harness.toolResult).toBeUndefined();
  });

  it('accepts a remote execution receipt without inventing an optional UAL', async () => {
    await boot(); await start();
    invokeDuringAdvance('remote-execute', { effectId: 1n, nodeId: 'peer-b', programIri: 'urn:sr:program:child' });
    harness.onToolCall = (message) => harness.listener!({ type: 'tool-result', toolCallId: message.toolCallId, ok: true, result: { kind: 'remote-execute', executionIri: 'urn:sr:execution:child' } });
    expect(await send('advance')).toMatchObject({ ok: true });
    expect(harness.toolResult).toEqual({ executionIri: 'urn:sr:execution:child' });
  });

  it('rejects imported tools outside an active request and unknown tool-result ids', async () => {
    await boot(); await start();
    await expect(importedTool('investigator')(harness.resource, { effectId: 1n, prompt: 'x' })).rejects.toMatchObject({ payload: { code: 'COMPONENT_TOOL_OUTSIDE_EXECUTION' } });
    harness.listener!({ type: 'tool-result', toolCallId: 999n, ok: true, result: { kind: 'investigator', output: 'unsolicited' } });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', message: expect.stringContaining('unknown tool result') });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('rejects unknown guest states and normalizes guest failures without accepting output', async () => {
    await boot(); await start();
    harness.execution.inspect.mockReturnValue({ ...inspection, agents: [{ ...inspection.agents[0], status: 'unknown' }] });
    expect(await send('inspect')).toMatchObject({ ok: false, code: 'UNKNOWN_AGENT_STATUS' });
    harness.execution.advance.mockResolvedValue({ tag: 'unknown' });
    expect(await send('advance')).toMatchObject({ ok: false, code: 'UNKNOWN_COMPONENT_STEP' });
    harness.executor.compile.mockImplementation(() => { throw 'guest failure'; });
    expect(await send('compile', { source: 'x' })).toMatchObject({ ok: false, code: 'COMPONENT_FAILURE', message: 'guest failure' });
    expect(await send('unknown' as ComponentWorkerRequest['op'])).toMatchObject({ ok: false, message: expect.stringContaining('unsupported') });
  });

  it('denies hang injection and terminates on a trap or malformed envelope', async () => {
    await boot();
    expect(await send('test_hang')).toMatchObject({ ok: false, code: 'TEST_OPERATION_DISABLED' });
    harness.bootstrap.allowTestOperations = true;
    expect(await send('test_trap')).toMatchObject({ type: 'fatal', message: expect.stringContaining('trap injection') });
    harness.listener!({ type: 'wrong' });
    await vi.waitFor(() => expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', message: expect.stringContaining('malformed request') }), { interval: 1 });
  });
});
