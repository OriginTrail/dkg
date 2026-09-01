import { createHash } from 'node:crypto';
import process from 'node:process';
import { Worker, type ResourceLimits } from 'node:worker_threads';

import { ABI_VERSION, SCHEMA_VERSION, type StartedPlanInspection, type StartedPlanReceipt } from './codec.js';
import {
  defaultExecutionCapability,
  type ComponentExecutionResult,
  type ComponentOperationResult,
  type ComponentToolDispatcher,
  type ExecutionCapabilityDescriptor,
} from './component-types.js';
import type {
  ComponentWorkerBootstrap,
  ComponentWorkerMessage,
  ComponentWorkerOperation,
  ComponentWorkerRequest,
  ComponentWorkerToolCall,
} from './component-worker-protocol.js';
import { verifyRuntimeArtifacts } from './integrity.js';

const EXPECTED_COMBINED_ABI = (ABI_VERSION << 16) | SCHEMA_VERSION;

export interface ComponentSupervisorOptions {
  artifactRoot?: string;
  workerUrl?: URL;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  allowTestOperations?: boolean;
  maxOperations?: number;
  resourceLimits?: ResourceLimits;
  log?: (message: string) => void;
}

export interface ComponentExecutionPoolOptions extends ComponentSupervisorOptions {
  maxActiveExecutions?: number;
}

interface PendingRequest {
  timer: NodeJS.Timeout | null;
  operation: ComponentWorkerOperation;
  timeoutMs: number;
  resolve: (result: ComponentOperationResult) => void;
  reject: (error: Error) => void;
}

export class ComponentWorkerClient {
  private readonly options: Required<Pick<
    ComponentSupervisorOptions,
    'requestTimeoutMs' | 'startupTimeoutMs' | 'allowTestOperations' | 'maxOperations' | 'resourceLimits'
  >> & ComponentSupervisorOptions;
  private worker: Worker | null = null;
  private requestSequence = 0n;
  private pending = new Map<bigint, PendingRequest>();
  private ready = false;
  private stopped = false;
  private instanceIdValue: string | null = null;

  constructor(
    options: ComponentSupervisorOptions = {},
    private readonly toolDispatcher?: ComponentToolDispatcher,
  ) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      allowTestOperations: options.allowTestOperations ?? false,
      maxOperations: options.maxOperations ?? 10_000,
      resourceLimits: options.resourceLimits ?? {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4,
      },
    };
  }

  get instanceId(): string | null {
    return this.instanceIdValue;
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.stopped) throw new ComponentUnavailableError('component Worker is stopped');
    const artifacts = verifyRuntimeArtifacts(this.options.artifactRoot);
    const bootstrap: ComponentWorkerBootstrap = {
      artifactRoot: artifacts.root,
      componentHash: artifacts.componentSha256,
      witHash: artifacts.witSha256,
      expectedAbi: EXPECTED_COMBINED_ABI,
      allowTestOperations: this.options.allowTestOperations,
      maxOperations: this.options.maxOperations,
      resourceLimits: this.options.resourceLimits,
    };
    const worker = new Worker(
      this.options.workerUrl ?? new URL('./component-worker.js', import.meta.url),
      {
        workerData: bootstrap,
        resourceLimits: this.options.resourceLimits,
        execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      },
    );
    this.worker = worker;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new ComponentUnavailableError('component Worker startup timed out'));
        }, this.options.startupTimeoutMs);
        timer.unref?.();
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };
        worker.on('message', (message: ComponentWorkerMessage) => {
          if (message.type === 'ready') {
            if (settled) return;
            if (
              message.abi !== EXPECTED_COMBINED_ABI
              || message.componentHash !== artifacts.componentSha256
              || message.witHash !== artifacts.witSha256
              || !message.instanceId
            ) {
              fail(new ComponentUnavailableError('component Worker READY mismatch'));
              return;
            }
            settled = true;
            clearTimeout(timer);
            this.ready = true;
            this.instanceIdValue = message.instanceId;
            this.options.log?.(`semantic-component-ready instance=${message.instanceId}`);
            resolve();
            return;
          }
          this.handleMessage(message);
        });
        worker.on('error', (error) => {
          fail(new ComponentUnavailableError(`component Worker error: ${error.message}`));
          this.failAll(new ComponentUnavailableError(error.message));
        });
        worker.on('exit', (code) => {
          this.ready = false;
          if (!settled) fail(new ComponentUnavailableError(`component Worker exited during startup (${code})`));
          if (!this.stopped) {
            this.failAll(new ComponentUnavailableError(`component Worker exited with code ${code}`));
          }
        });
      });
    } catch (error) {
      this.worker = null;
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  call(
    op: ComponentWorkerOperation,
    body: Omit<ComponentWorkerRequest, 'type' | 'requestId' | 'op'> = {},
    timeoutMs = this.options.requestTimeoutMs,
  ): Promise<ComponentOperationResult> {
    if (!this.worker || !this.ready) {
      return Promise.reject(new ComponentUnavailableError('component Worker is unavailable'));
    }
    const requestId = ++this.requestSequence;
    const request: ComponentWorkerRequest = { type: 'request', requestId, op, ...body };
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        timer: null,
        operation: op,
        timeoutMs,
        resolve,
        reject,
      };
      this.pending.set(requestId, pending);
      this.armRequestTimer(requestId, pending);
      try {
        this.worker!.postMessage(request);
      } catch (error) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(new ComponentUnavailableError(errorMessage(error)));
      }
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    this.failAll(new ComponentUnavailableError('component Worker stopped'));
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }

  private handleMessage(message: ComponentWorkerMessage): void {
    if (message.type === 'fatal') {
      this.options.log?.(`semantic-component-fatal: ${message.message}`);
      return;
    }
    if (message.type === 'tool-call') {
      void this.handleToolCall(message);
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new ComponentOperationError(
      message.code,
      message.category,
      message.message,
      message.retryable,
    ));
  }

  private async handleToolCall(message: ComponentWorkerToolCall): Promise<void> {
    const pending = this.pending.get(message.requestId);
    const worker = this.worker;
    if (!pending || !worker) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
    try {
      if (!this.toolDispatcher) throw toolDispatchError('COMPONENT_TOOL_NOT_CONFIGURED');
      const result = await this.toolDispatcher(message.call);
      if (!this.pending.has(message.requestId) || this.worker !== worker) return;
      worker.postMessage({
        type: 'tool-result',
        toolCallId: message.toolCallId,
        ok: true,
        result,
      });
    } catch (error) {
      if (!this.pending.has(message.requestId) || this.worker !== worker) return;
      worker.postMessage({
        type: 'tool-result',
        toolCallId: message.toolCallId,
        ok: false,
        code: toolErrorCode(error),
        message: errorMessage(error),
        retryable: false,
      });
    } finally {
      const active = this.pending.get(message.requestId);
      if (active && active.timer === null) this.armRequestTimer(message.requestId, active);
    }
  }

  private armRequestTimer(requestId: bigint, pending: PendingRequest): void {
    const timer = setTimeout(() => {
      if (!this.pending.delete(requestId)) return;
      const error = new ComponentRequestTimeoutError(pending.operation, pending.timeoutMs);
      pending.reject(error);
      void this.stopWithFailure(error);
    }, pending.timeoutMs);
    timer.unref?.();
    pending.timer = timer;
  }

  private async stopWithFailure(error: Error): Promise<void> {
    this.ready = false;
    this.failAll(error);
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => undefined);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

class ComponentExecutionPartition {
  private tail = Promise.resolve();
  private stopped = false;

  constructor(
    readonly handle: number,
    readonly client: ComponentWorkerClient,
  ) {}

  advance(): Promise<ComponentExecutionResult> {
    return this.ordered(async () => {
      const result = await this.client.call('advance');
      return result as ComponentExecutionResult;
    });
  }

  inspect(): Promise<StartedPlanInspection> {
    return this.ordered(async () => {
      const result = await this.client.call('inspect');
      return result as StartedPlanInspection;
    });
  }

  testTrap(): Promise<void> {
    return this.ordered(async () => {
      await this.client.call('test_trap');
    });
  }

  testHang(): Promise<void> {
    return this.ordered(async () => {
      await this.client.call('test_hang');
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.tail.catch(() => undefined);
    await this.client.call('drop').catch(() => undefined);
    await this.client.stop();
  }

  private ordered<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new ComponentUnavailableError('execution partition stopped'));
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class ComponentExecutionPool {
  private readonly options: ComponentExecutionPoolOptions;
  private readonly executions = new Map<number, ComponentExecutionPartition>();
  private nextHandle = 0;
  private starting = 0;

  constructor(options: ComponentExecutionPoolOptions = {}) {
    this.options = options;
  }

  get activeCount(): number {
    return this.executions.size;
  }

  async startPlan(
    plan: Uint8Array,
    logicalTime: bigint,
    suppliedCapability?: ExecutionCapabilityDescriptor,
    toolDispatcher?: ComponentToolDispatcher,
  ): Promise<StartedPlanReceipt> {
    const maxActive = this.options.maxActiveExecutions ?? 8;
    if (this.executions.size + this.starting >= maxActive) {
      throw new ComponentOverloadError(maxActive);
    }
    this.starting += 1;
    const handle = ++this.nextHandle;
    const client = new ComponentWorkerClient(this.options, toolDispatcher);
    try {
      await client.start();
      const planHash = canonicalPlanHash(plan);
      const capability = suppliedCapability ?? defaultExecutionCapability(
        planHash,
        this.options.maxOperations ?? 10_000,
      );
      const result = await client.call('start', { plan, logicalTime, capability }) as StartedPlanInspection & {
        instanceId: string;
      };
      const partition = new ComponentExecutionPartition(handle, client);
      this.executions.set(handle, partition);
      this.options.log?.(
        `semantic-component-execution-started handle=${handle} instance=${result.instanceId} `
          + `execution=${capability.executionId}`,
      );
      return { handle, ...result, componentInstanceId: result.instanceId };
    } catch (error) {
      await client.stop().catch(() => undefined);
      throw error;
    } finally {
      this.starting -= 1;
    }
  }

  async applyPlan(
    handle: number,
  ): Promise<ComponentExecutionResult> {
    return this.require(handle).advance();
  }

  inspectPlan(handle: number): Promise<StartedPlanInspection> {
    return this.require(handle).inspect();
  }

  testTrap(handle: number): Promise<void> {
    return this.require(handle).testTrap();
  }

  testHang(handle: number): Promise<void> {
    return this.require(handle).testHang();
  }

  async dropPlan(handle: number): Promise<void> {
    const execution = this.executions.get(handle);
    if (!execution) return;
    this.executions.delete(handle);
    await execution.stop();
  }

  async stop(): Promise<void> {
    const executions = [...this.executions.values()];
    this.executions.clear();
    await Promise.all(executions.map((execution) => execution.stop()));
  }

  private require(handle: number): ComponentExecutionPartition {
    const execution = this.executions.get(handle);
    if (!execution) throw new ComponentUnavailableError('unknown component execution handle');
    return execution;
  }
}

export class ComponentOperationError extends Error {
  constructor(
    readonly code: string,
    readonly category: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ComponentOperationError';
  }
}

export class ComponentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentUnavailableError';
  }
}

export class ComponentRequestTimeoutError extends Error {
  constructor(readonly operation: ComponentWorkerOperation, readonly timeoutMs: number) {
    super(`semantic component ${operation} exceeded ${timeoutMs}ms`);
    this.name = 'ComponentRequestTimeoutError';
  }
}

export class ComponentOverloadError extends Error {
  constructor(readonly limit: number) {
    super(`semantic component execution limit ${limit} reached`);
    this.name = 'ComponentOverloadError';
  }
}

function canonicalPlanHash(plan: Uint8Array): string {
  return createHash('sha256')
    .update('DKG-STRATEGY-PLAN-V1\0')
    .update(plan)
    .digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'COMPONENT_TOOL_FAILED';
}

function toolDispatchError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
