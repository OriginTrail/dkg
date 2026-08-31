import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';

import { verifyRuntimeArtifacts } from './integrity.js';
import type {
  RuntimeWorkerBootstrap,
  RuntimeWorkerMessage,
  RuntimeWorkerRequest,
} from './worker-protocol.js';

interface RuntimeBindings {
  runtime_abi_version(): number;
  runtime_compile_strategy(input: Uint8Array): Uint8Array;
  runtime_admit_plan(input: Uint8Array): Uint8Array;
  runtime_start_plan(input: Uint8Array): Uint8Array;
  runtime_apply_plan(handle: number, input: Uint8Array): Uint8Array;
  runtime_inspect_plan(handle: number, input: Uint8Array): Uint8Array;
  runtime_drop_plan(handle: number, input: Uint8Array): Uint8Array;
  runtime_create(input: Uint8Array): Uint8Array;
  runtime_apply_event(handle: number, input: Uint8Array): Uint8Array;
  runtime_snapshot(handle: number, input: Uint8Array): Uint8Array;
  runtime_restore(input: Uint8Array): Uint8Array;
  runtime_inspect(handle: number, input: Uint8Array): Uint8Array;
  runtime_drop(handle: number, input: Uint8Array): Uint8Array;
  runtime_memory_bytes(): number;
  runtime_v1_conformance_vector(): Uint8Array;
  runtime_phase0_test_hang(): void;
  runtime_phase0_test_trap(): void;
}

if (!parentPort) throw new Error('semantic runtime Worker requires parentPort');
const port = parentPort;
const bootstrap = workerData as RuntimeWorkerBootstrap;
const artifacts = verifyRuntimeArtifacts(bootstrap.artifactRoot);
if (artifacts.wasmSha256 !== bootstrap.expectedModuleHash) {
  throw new Error('semantic runtime Worker module hash differs from parent verification');
}

const require = createRequire(import.meta.url);
const bindings = require(artifacts.gluePath) as RuntimeBindings;
const abi = bindings.runtime_abi_version();
if (abi !== bootstrap.expectedAbi) {
  throw new Error(`semantic runtime Worker ABI mismatch: expected ${bootstrap.expectedAbi}, got ${abi}`);
}

post({
  type: 'ready',
  abi,
  moduleHash: artifacts.wasmSha256,
  wasmBytes: bindings.runtime_memory_bytes(),
});

port.on('message', (value: unknown) => {
  const request = value as RuntimeWorkerRequest;
  if (request?.type !== 'request' || typeof request.requestId !== 'bigint') {
    fatal(undefined, 'semantic runtime Worker received a malformed request envelope');
    return;
  }
  if (performance.now() > request.deadlineMonotonicMs) {
    post({
      type: 'response',
      requestId: request.requestId,
      ok: false,
      code: 'WORKER_DEADLINE_EXPIRED',
      category: 'worker',
    });
    return;
  }
  try {
    const body = Uint8Array.from(request.body);
    let result: Uint8Array;
    switch (request.op) {
      case 'create':
        result = bindings.runtime_create(body);
        break;
      case 'apply':
        result = bindings.runtime_apply_event(requireHandle(request), body);
        break;
      case 'snapshot':
        result = bindings.runtime_snapshot(requireHandle(request), body);
        break;
      case 'restore':
        result = bindings.runtime_restore(body);
        break;
      case 'inspect':
        result = bindings.runtime_inspect(requireHandle(request), body);
        break;
      case 'drop':
        result = bindings.runtime_drop(requireHandle(request), body);
        break;
      case 'compile':
        result = bindings.runtime_compile_strategy(body);
        break;
      case 'admit':
        result = bindings.runtime_admit_plan(body);
        break;
      case 'start_plan':
        result = bindings.runtime_start_plan(body);
        break;
      case 'apply_plan':
        result = bindings.runtime_apply_plan(requireHandle(request), body);
        break;
      case 'inspect_plan':
        result = bindings.runtime_inspect_plan(requireHandle(request), body);
        break;
      case 'drop_plan':
        result = bindings.runtime_drop_plan(requireHandle(request), body);
        break;
      case 'v1_conformance':
        requireTestOperations();
        result = bindings.runtime_v1_conformance_vector();
        break;
      case 'phase0_test_hang':
        requireTestOperations();
        bindings.runtime_phase0_test_hang();
        throw new Error('phase0 hang operation unexpectedly returned');
      case 'phase0_test_trap':
        requireTestOperations();
        bindings.runtime_phase0_test_trap();
        throw new Error('phase0 trap operation unexpectedly returned');
      default:
        throw new Error(`unsupported semantic runtime Worker operation: ${String(request.op)}`);
    }
    const copied = Uint8Array.from(result);
    port.postMessage(
      {
        type: 'response',
        requestId: request.requestId,
        ok: true,
        body: copied,
        wasmBytes: bindings.runtime_memory_bytes(),
      } satisfies RuntimeWorkerMessage,
      [copied.buffer],
    );
  } catch (error) {
    fatal(request.requestId, error instanceof Error ? error.message : String(error));
  }
});

function requireHandle(request: RuntimeWorkerRequest): number {
  if (!Number.isInteger(request.handle) || (request.handle ?? 0) <= 0) {
    throw new Error('semantic runtime Worker request is missing a valid handle');
  }
  return request.handle as number;
}

function requireTestOperations(): void {
  if (!bootstrap.allowTestOperations) {
    throw new Error('phase0 test operation is disabled');
  }
}

function post(message: RuntimeWorkerMessage): void {
  port.postMessage(message);
}

function fatal(requestId: bigint | undefined, message: string): void {
  post({ type: 'fatal', requestId, message });
  process.exit(1);
}
