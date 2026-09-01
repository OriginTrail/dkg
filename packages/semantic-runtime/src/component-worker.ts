import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { parentPort, workerData } from 'node:worker_threads';

import type {
  AdmittedPlanSummary,
  AdmissionDiagnostic,
  PlanApplyResult,
  StartedPlanInspection,
} from './codec.js';
import type { ExecutionCapabilityDescriptor } from './component-types.js';
import type {
  ComponentWorkerBootstrap,
  ComponentWorkerMessage,
  ComponentWorkerRequest,
} from './component-worker-protocol.js';
import { verifyRuntimeArtifacts } from './integrity.js';

interface ComponentDiagnostic {
  code: string;
  message: string;
  category: string;
  retryable: boolean;
}

interface ComponentExecution {
  advance(effect?: {
    effectId: bigint;
    outcome: { tag: 'ok'; val: string } | { tag: 'err'; val: ComponentDiagnostic };
  }): Promise<unknown>;
  inspect(): unknown;
  [Symbol.dispose](): void;
}

interface ComponentRuntime {
  abiVersion(): number;
  compile(source: string): unknown;
  admit(plan: Uint8Array): unknown;
  start(
    capability: ExecutionCapability,
    plan: Uint8Array,
    logicalTime: bigint,
  ): [ComponentExecution, unknown];
  testHang(): void;
  testTrap(): void;
}

interface ComponentModule {
  instantiate(
    getCoreModule: (relativePath: string) => Promise<WebAssembly.Module>,
    imports: object,
  ): Promise<{ runtime: ComponentRuntime }>;
}

class ExecutionCapability {
  readonly descriptor: Readonly<ExecutionCapabilityDescriptor>;

  constructor(descriptor: ExecutionCapabilityDescriptor) {
    this.descriptor = freezeCapability(descriptor);
  }
}

if (!parentPort) throw new Error('semantic component Worker requires parentPort');
const port = parentPort;
const bootstrap = workerData as ComponentWorkerBootstrap;
const artifacts = verifyRuntimeArtifacts(bootstrap.artifactRoot);
if (
  artifacts.componentSha256 !== bootstrap.componentHash
  || artifacts.witSha256 !== bootstrap.witHash
) {
  throw new Error('semantic component artifact identity differs from parent verification');
}
const jspi = WebAssembly as typeof WebAssembly & {
  Suspending?: unknown;
  promising?: unknown;
};
if (typeof jspi.Suspending !== 'function' || typeof jspi.promising !== 'function') {
  throw new Error('semantic component host requires Node WebAssembly JSPI support');
}

const instanceId = randomUUID();
const componentRoot = artifacts.componentRoot;
const componentModule = await import(pathToFileURL(artifacts.componentJsPath).href) as ComponentModule;
const component = await componentModule.instantiate(loadCoreModule, componentImports());
const abi = component.runtime.abiVersion();
if (abi !== bootstrap.expectedAbi) {
  throw new Error(`semantic component ABI mismatch: expected ${bootstrap.expectedAbi}, got ${abi}`);
}

let execution: ComponentExecution | null = null;
let capability: Readonly<ExecutionCapabilityDescriptor> | null = null;
let operationCount = 0;
let requestTail = Promise.resolve();

post({
  type: 'ready',
  abi,
  componentHash: artifacts.componentSha256,
  witHash: artifacts.witSha256,
  instanceId,
});

port.on('message', (value: unknown) => {
  const request = value as ComponentWorkerRequest;
  requestTail = requestTail.then(
    () => handle(request),
    () => handle(request),
  );
});

async function handle(request: ComponentWorkerRequest): Promise<void> {
  if (request?.type !== 'request' || typeof request.requestId !== 'bigint') {
    fatal(undefined, 'semantic component Worker received a malformed request envelope');
    return;
  }
  try {
    let result;
    switch (request.op) {
      case 'compile': {
        if (typeof request.source !== 'string') throw new Error('compile source is missing');
        try {
          result = { ok: true as const, plan: normalizeAdmittedPlan(component.runtime.compile(request.source)) };
        } catch (error) {
          const diagnostics = componentErrorPayload(error);
          if (!Array.isArray(diagnostics)) throw error;
          result = { ok: false as const, diagnostics: normalizeAdmissionDiagnostics(diagnostics) };
        }
        break;
      }
      case 'admit':
        result = normalizeAdmittedPlan(component.runtime.admit(requirePlan(request)));
        break;
      case 'start': {
        if (execution) throw componentFailure('COMPONENT_ALREADY_STARTED', 'lifecycle');
        const descriptor = validateCapability(request.capability);
        const [created, receiptValue] = component.runtime.start(
          new ExecutionCapability(descriptor),
          requirePlan(request),
          request.logicalTime ?? 0n,
        );
        const receipt = normalizeInspection(receiptValue);
        if (hex(receipt.canonicalHash) !== descriptor.planHash) {
          created[Symbol.dispose]();
          throw componentFailure('CAPABILITY_PLAN_HASH_MISMATCH', 'capability');
        }
        execution = created;
        capability = descriptor;
        result = { ...receipt, instanceId };
        break;
      }
      case 'advance': {
        const active = requireExecution();
        assertCapabilityActive();
        operationCount += 1;
        if (operationCount > Math.min(bootstrap.maxOperations, capability!.budgets.maxOperations)) {
          throw componentFailure('COMPONENT_OPERATION_BUDGET_EXHAUSTED', 'limit');
        }
        result = normalizeStep(await active.advance(request.effect
          ? {
            effectId: request.effect.effectId,
            outcome: request.effect.ok
              ? { tag: 'ok', val: request.effect.value }
              : {
                tag: 'err',
                val: {
                  code: request.effect.value,
                  message: 'host effect failed',
                  category: 'effect',
                  retryable: false,
                },
              },
          }
          : undefined));
        break;
      }
      case 'inspect':
        assertCapabilityActive();
        result = normalizeInspection(requireExecution().inspect());
        break;
      case 'drop':
        execution?.[Symbol.dispose]();
        execution = null;
        capability = null;
        result = { dropped: true as const };
        break;
      case 'test_hang':
        requireTestOperations();
        component.runtime.testHang();
        throw new Error('component hang operation unexpectedly returned');
      case 'test_trap':
        requireTestOperations();
        component.runtime.testTrap();
        throw new Error('component trap operation unexpectedly returned');
      default:
        throw new Error(`unsupported semantic component operation: ${String(request.op)}`);
    }
    post({ type: 'response', requestId: request.requestId, ok: true, result });
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError || request.op === 'test_trap') {
      fatal(request.requestId, error instanceof Error ? error.message : String(error));
      return;
    }
    const failure = normalizeFailure(error);
    post({ type: 'response', requestId: request.requestId, ok: false, ...failure });
  }
}

async function loadCoreModule(relativePath: string): Promise<WebAssembly.Module> {
  const absolute = path.resolve(componentRoot, relativePath);
  if (!absolute.startsWith(`${componentRoot}${path.sep}`)) {
    throw new Error('semantic component core module escaped the verified artifact root');
  }
  const bytes = fs.readFileSync(absolute);
  return WebAssembly.compile(bytes);
}

function componentImports(): object {
  const deny = () => {
    throw componentFailure('AMBIENT_WASI_DENIED', 'capability');
  };
  const deniedInterface = new Proxy(Object.create(null) as object, {
    get: () => deny,
  });
  const allowedCarrierImports = [
    'wasi:cli/environment',
    'wasi:cli/exit',
    'wasi:cli/stderr',
    'wasi:cli/stdin',
    'wasi:cli/stdout',
    'wasi:cli/terminal-input',
    'wasi:cli/terminal-output',
    'wasi:cli/terminal-stderr',
    'wasi:cli/terminal-stdin',
    'wasi:cli/terminal-stdout',
    'wasi:clocks/monotonic-clock',
    'wasi:io/error',
    'wasi:io/poll',
    'wasi:io/streams',
  ];
  return new Proxy(Object.create(null) as object, {
    get: (_target, property) => {
      const name = String(property);
      if (name.startsWith('origintrail:semantic-runtime/capability')) {
        return { ExecutionCapability };
      }
      if (allowedCarrierImports.some((entry) => name.startsWith(entry))) {
        return deniedInterface;
      }
      throw componentFailure('UNKNOWN_COMPONENT_IMPORT', 'component');
    },
  });
}

function requirePlan(request: ComponentWorkerRequest): Uint8Array {
  if (!(request.plan instanceof Uint8Array) || request.plan.byteLength > 4 * 1024 * 1024) {
    throw componentFailure('PLAN_BYTES_INVALID', 'input');
  }
  return request.plan;
}

function requireExecution(): ComponentExecution {
  if (!execution) throw componentFailure('COMPONENT_NOT_STARTED', 'lifecycle');
  return execution;
}

function assertCapabilityActive(): void {
  if (!capability) throw componentFailure('CAPABILITY_MISSING', 'capability');
  if (capability.revoked) throw componentFailure('CAPABILITY_REVOKED', 'capability');
  if (Date.now() > capability.expiresAt) {
    throw componentFailure('CAPABILITY_EXPIRED', 'capability');
  }
}

function validateCapability(
  value: ExecutionCapabilityDescriptor | undefined,
): Readonly<ExecutionCapabilityDescriptor> {
  if (
    !value
    || !value.executionId
    || !value.invocationId
    || !value.contextGraphId
    || !value.callerPrincipal
    || !value.programIri
    || !isHash(value.sourceHash)
    || !isHash(value.planHash)
    || !['WM', 'SWM', 'VM'].includes(value.outputLayer)
    || !value.policy?.iri
    || typeof value.policy.epoch !== 'bigint'
    || !isHash(value.policy.hash)
    || !Number.isSafeInteger(value.expiresAt)
    || !Number.isInteger(value.budgets?.maxOperations)
    || value.budgets.maxOperations <= 0
    || value.tools.some((tool) => !tool.operation || !tool.version || !tool.witInterface)
  ) {
    throw componentFailure('CAPABILITY_DESCRIPTOR_INVALID', 'capability');
  }
  return freezeCapability(value);
}

function freezeCapability(value: ExecutionCapabilityDescriptor): Readonly<ExecutionCapabilityDescriptor> {
  const tools = value.tools.map((tool) => Object.freeze({ ...tool }));
  return Object.freeze({
    ...value,
    tools: Object.freeze(tools) as unknown as ExecutionCapabilityDescriptor['tools'],
    policy: Object.freeze({ ...value.policy }),
    budgets: Object.freeze({ ...value.budgets }),
    approvals: Object.freeze([...value.approvals]) as unknown as string[],
  });
}

function normalizeAdmittedPlan(value: unknown): AdmittedPlanSummary {
  const plan = value as {
    canonicalPlan: Uint8Array;
    canonicalHash: Uint8Array;
    strategyRef: string;
    scope: string;
    goal: string;
    requiredCapabilities: string[];
    effectUpperBound: string[];
    approvalRequirements: string[];
    adapterVersions: Array<{ operation: string; version: number }>;
    bounds: { processes: number; hostCommands: number; retryAttempts: number; depth: number };
  };
  return {
    canonicalPlan: Uint8Array.from(plan.canonicalPlan),
    canonicalHash: Uint8Array.from(plan.canonicalHash),
    strategyRef: plan.strategyRef,
    scope: plan.scope,
    goal: plan.goal,
    requiredCapabilities: [...plan.requiredCapabilities],
    effectUpperBound: [...plan.effectUpperBound],
    approvalRequirements: [...plan.approvalRequirements],
    adapterVersions: new Map(plan.adapterVersions.map((entry) => [entry.operation, entry.version])),
    resourceBounds: { ...plan.bounds },
  };
}

function normalizeAdmissionDiagnostics(value: unknown[]): AdmissionDiagnostic[] {
  return value.map((entry) => {
    const item = entry as {
      code: string;
      primary: {
        start: { line: bigint; column: bigint };
        end: { line: bigint; column: bigint };
      };
      message: string;
      help?: string;
    };
    return {
      code: item.code,
      primary: {
        start: { line: Number(item.primary.start.line), column: Number(item.primary.start.column) },
        end: { line: Number(item.primary.end.line), column: Number(item.primary.end.column) },
      },
      message: item.message,
      help: item.help ?? null,
    };
  });
}

function normalizeInspection(value: unknown): StartedPlanInspection {
  const receipt = value as {
    canonicalHash: Uint8Array;
    strategyRef: string;
    logicalTime: bigint;
    stateDigest: Uint8Array;
    agents: Array<{ role: string; processId: Uint8Array; status: string }>;
  };
  return {
    canonicalHash: Uint8Array.from(receipt.canonicalHash),
    strategyRef: receipt.strategyRef,
    logicalTime: receipt.logicalTime,
    stateDigest: Uint8Array.from(receipt.stateDigest),
    agents: receipt.agents.map((agent) => ({
      role: agent.role,
      processId: Uint8Array.from(agent.processId),
      status: normalizeStatus(agent.status),
    })),
  };
}

function normalizeStep(value: unknown): PlanApplyResult {
  const step = value as { tag: string; val: unknown };
  if (step.tag === 'effect-requested') {
    const effect = step.val as {
      effectId: bigint;
      processId: Uint8Array;
      operation: string;
      version: number;
      arguments: string[];
    };
    return {
      kind: 'effect-requested',
      effectId: effect.effectId,
      processId: Uint8Array.from(effect.processId),
      operation: effect.operation,
      version: effect.version,
      arguments: [...effect.arguments],
    };
  }
  if (step.tag !== 'completed') throw componentFailure('UNKNOWN_COMPONENT_STEP', 'component');
  const completion = step.val as {
    events: Array<{ role: string; processId: Uint8Array; value: string }>;
    outputs: Array<{ role: string; processId: Uint8Array; value: string }>;
  };
  const normalizeValues = (values: typeof completion.events) => values.map((entry) => ({
    role: entry.role,
    processId: Uint8Array.from(entry.processId),
    value: entry.value,
  }));
  return {
    kind: 'completed',
    events: normalizeValues(completion.events),
    outputs: normalizeValues(completion.outputs),
  };
}

function normalizeStatus(value: string): StartedPlanInspection['agents'][number]['status'] {
  if (['runnable', 'waiting', 'cancelling', 'terminated', 'missing'].includes(value)) {
    return value as StartedPlanInspection['agents'][number]['status'];
  }
  throw componentFailure('UNKNOWN_AGENT_STATUS', 'component');
}

function componentErrorPayload(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'payload' in error
    ? (error as { payload: unknown }).payload
    : undefined;
}

function normalizeFailure(error: unknown): {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
} {
  const payload = componentErrorPayload(error);
  if (payload && !Array.isArray(payload) && typeof payload === 'object') {
    const diagnostic = payload as Partial<ComponentDiagnostic>;
    if (typeof diagnostic.code === 'string') {
      return {
        code: diagnostic.code,
        category: diagnostic.category ?? 'component',
        message: diagnostic.message ?? diagnostic.code,
        retryable: diagnostic.retryable ?? false,
      };
    }
  }
  if (error instanceof ComponentWorkerError) {
    return {
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: false,
    };
  }
  return {
    code: 'COMPONENT_FAILURE',
    category: 'component',
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

class ComponentWorkerError extends Error {
  constructor(
    readonly code: string,
    readonly category: string,
  ) {
    super(code);
  }
}

function componentFailure(code: string, category: string): ComponentWorkerError {
  return new ComponentWorkerError(code, category);
}

function requireTestOperations(): void {
  if (!bootstrap.allowTestOperations) throw componentFailure('TEST_OPERATION_DISABLED', 'worker');
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function post(message: ComponentWorkerMessage): void {
  port.postMessage(message);
}

function fatal(requestId: bigint | undefined, message: string): void {
  post({ type: 'fatal', requestId, message });
  process.exit(1);
}
