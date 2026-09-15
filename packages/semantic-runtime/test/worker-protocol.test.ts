import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from '../src/worker-protocol.js';

// The real worker integration tests exercise Wasm in a separate isolate. These
// tests run the same source handler with controlled transport/native bindings so
// malformed envelopes and fatal paths can be checked without exiting the runner.
const harness = vi.hoisted(() => ({
  listener: undefined as ((message: unknown) => void) | undefined,
  messages: [] as RuntimeWorkerMessage[],
  bootstrap: { artifactRoot: '/verified', expectedModuleHash: 'verified-hash', expectedAbi: 1, allowTestOperations: false },
  bindings: {} as Record<string, ReturnType<typeof vi.fn>>,
  port: {
    on: vi.fn(),
    postMessage: vi.fn(),
  },
}));

vi.mock('node:worker_threads', () => ({ parentPort: harness.port, workerData: harness.bootstrap }));
vi.mock('node:module', () => ({ createRequire: () => () => harness.bindings }));
vi.mock('../src/integrity.js', () => ({
  verifyRuntimeArtifacts: () => ({ wasmSha256: 'verified-hash', gluePath: '/verified/runtime.cjs' }),
}));

const operations = {
  create: 'runtime_create', apply: 'runtime_apply_event', snapshot: 'runtime_snapshot',
  restore: 'runtime_restore', inspect: 'runtime_inspect', drop: 'runtime_drop',
  compile: 'runtime_compile_strategy', admit: 'runtime_admit_plan', start_plan: 'runtime_start_plan',
  apply_plan: 'runtime_apply_plan', inspect_plan: 'runtime_inspect_plan', drop_plan: 'runtime_drop_plan',
} as const;
const withHandle = new Set(['apply', 'snapshot', 'inspect', 'drop', 'apply_plan', 'inspect_plan', 'drop_plan']);

beforeEach(() => {
  vi.resetModules();
  harness.messages.length = 0;
  harness.listener = undefined;
  Object.assign(harness.bootstrap, { expectedModuleHash: 'verified-hash', expectedAbi: 1, allowTestOperations: false });
  harness.bindings = Object.fromEntries(Object.values(operations).map((name) => [name, vi.fn(() => new Uint8Array([8, 9]))]));
  Object.assign(harness.bindings, {
    runtime_abi_version: vi.fn(() => 1), runtime_memory_bytes: vi.fn(() => 65536),
    runtime_v1_conformance_vector: vi.fn(() => new Uint8Array([1])),
    runtime_phase0_test_hang: vi.fn(), runtime_phase0_test_trap: vi.fn(),
  });
  harness.port.on.mockImplementation((_event, callback) => { harness.listener = callback; });
  harness.port.postMessage.mockImplementation((message) => { harness.messages.push(message); });
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});
afterEach(() => vi.restoreAllMocks());

function request(op: RuntimeWorkerRequest['op'], extra: Partial<RuntimeWorkerRequest> = {}): RuntimeWorkerRequest {
  return { type: 'request', requestId: 7n, op, body: new Uint8Array([3, 4]), deadlineMonotonicMs: Infinity, ...extra };
}

async function boot() { await import('../src/worker.js'); }

describe('runtime worker protocol boundary', () => {
  it('announces the independently checked ABI, module identity and memory size', async () => {
    await boot();
    expect(harness.messages).toEqual([{ type: 'ready', abi: 1, moduleHash: 'verified-hash', wasmBytes: 65536 }]);
  });

  it.each(['expectedModuleHash', 'expectedAbi'] as const)('rejects a mismatched %s before becoming ready', async (field) => {
    if (field === 'expectedModuleHash') harness.bootstrap.expectedModuleHash = 'other-hash';
    else harness.bootstrap.expectedAbi = 2;
    await expect(boot()).rejects.toThrow(field === 'expectedAbi' ? /ABI mismatch/ : /module hash/);
    expect(harness.messages).toEqual([]);
  });

  it.each(Object.entries(operations))('dispatches %s with copied bytes and the required handle', async (op, binding) => {
    await boot();
    const input = request(op as RuntimeWorkerRequest['op'], { handle: 42 });
    harness.listener!(input);
    const expectedArgs = withHandle.has(op) ? [42, input.body] : [input.body];
    expect(harness.bindings[binding]).toHaveBeenCalledWith(...expectedArgs);
    const passedBody = harness.bindings[binding].mock.calls[0].at(-1);
    expect(passedBody).not.toBe(input.body);
    expect(harness.messages.at(-1)).toEqual({ type: 'response', requestId: 7n, ok: true, body: new Uint8Array([8, 9]), wasmBytes: 65536 });
    const [message, transfers] = harness.port.postMessage.mock.calls.at(-1)!;
    expect(transfers).toEqual([message.body.buffer]);
  });

  it.each([null, {}, { type: 'request', requestId: 3 }])('terminates on a malformed envelope: %j', async (input) => {
    await boot();
    harness.listener!(input);
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', message: expect.stringContaining('malformed request') });
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(harness.bindings.runtime_create).not.toHaveBeenCalled();
  });

  it('rejects an expired deadline without entering Wasm or terminating the worker', async () => {
    await boot();
    harness.listener!(request('create', { deadlineMonotonicMs: -1 }));
    expect(harness.messages.at(-1)).toEqual({ type: 'response', requestId: 7n, ok: false, code: 'WORKER_DEADLINE_EXPIRED', category: 'worker' });
    expect(harness.bindings.runtime_create).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5])('rejects invalid handle %s before entering Wasm', async (handle) => {
    await boot();
    harness.listener!(request('apply', { handle }));
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', requestId: 7n, message: expect.stringContaining('valid handle') });
    expect(harness.bindings.runtime_apply_event).not.toHaveBeenCalled();
  });

  it.each(['v1_conformance', 'phase0_test_hang', 'phase0_test_trap'] as const)('denies disabled test operation %s', async (op) => {
    await boot();
    harness.listener!(request(op));
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', message: 'phase0 test operation is disabled' });
  });

  it('returns an explicitly enabled conformance vector', async () => {
    harness.bootstrap.allowTestOperations = true;
    await boot();
    harness.listener!(request('v1_conformance'));
    expect(harness.messages.at(-1)).toMatchObject({ type: 'response', ok: true, body: new Uint8Array([1]) });
  });

  it.each(['phase0_test_hang', 'phase0_test_trap'] as const)('fails closed if enabled %s unexpectedly returns', async (op) => {
    harness.bootstrap.allowTestOperations = true;
    await boot();
    harness.listener!(request(op));
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', message: expect.stringContaining('unexpectedly returned') });
  });

  it.each([new WebAssembly.RuntimeError('trap'), 'native failure'])('reports binding failures as fatal without returning a success', async (error) => {
    harness.bindings.runtime_create.mockImplementation(() => { throw error; });
    await boot();
    harness.listener!(request('create'));
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', requestId: 7n, message: error instanceof Error ? error.message : error });
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('fails closed on an unknown operation', async () => {
    await boot();
    harness.listener!(request('unrecognized' as RuntimeWorkerRequest['op']));
    expect(harness.messages.at(-1)).toMatchObject({ type: 'fatal', message: expect.stringContaining('unsupported') });
  });
});
