import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { Worker, type ResourceLimits } from 'node:worker_threads';

import { ABI_VERSION, SCHEMA_VERSION } from './codec.js';
import { defaultArtifactRoot, verifyRuntimeArtifacts } from './integrity.js';
import type {
  RuntimeWorkerBootstrap,
  RuntimeWorkerMessage,
  RuntimeWorkerRequest,
  WorkerOperation,
} from './worker-protocol.js';

const EXPECTED_COMBINED_ABI = (ABI_VERSION << 16) | SCHEMA_VERSION;

export interface WorkerSupervisorOptions {
  artifactRoot?: string;
  workerUrl?: URL;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  allowTestOperations?: boolean;
  resourceLimits?: ResourceLimits;
  log?: (message: string) => void;
}

export interface WorkerCallOptions {
  handle?: number;
  timeoutMs?: number;
}

export interface WorkerCallResult {
  body: Uint8Array;
  wasmBytes: number;
}

export class WorkerRequestTimeoutError extends Error {
  constructor(
    public readonly operation: WorkerOperation,
    public readonly timeoutMs: number,
  ) {
    super(`semantic runtime Worker ${operation} exceeded ${timeoutMs}ms`);
    this.name = 'WorkerRequestTimeoutError';
  }
}

export class WorkerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerUnavailableError';
  }
}

export class WorkerOperationError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: string,
  ) {
    super(`semantic runtime Worker operation failed: ${code} (${category})`);
    this.name = 'WorkerOperationError';
  }
}

interface PendingRequest {
  generation: number;
  operation: WorkerOperation;
  timer: NodeJS.Timeout;
  resolve: (value: WorkerCallResult) => void;
  reject: (reason: Error) => void;
}

export class WorkerSupervisor {
  private readonly options: Required<
    Pick<WorkerSupervisorOptions, 'requestTimeoutMs' | 'startupTimeoutMs' | 'allowTestOperations'>
  > & WorkerSupervisorOptions;
  private worker: Worker | null = null;
  private generation = 0;
  private requestSequence = 0n;
  private readonly pending = new Map<bigint, PendingRequest>();
  private replacement: Promise<void> | null = null;
  private stopping = false;
  private ready = false;
  private restartCounter = 0;

  constructor(options: WorkerSupervisorOptions = {}) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? 100,
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      allowTestOperations: options.allowTestOperations ?? false,
      artifactRoot: options.artifactRoot ?? defaultArtifactRoot(),
      resourceLimits: options.resourceLimits ?? {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    };
  }

  get restartCount(): number {
    return this.restartCounter;
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.waitUntilReady();
  }

  async waitUntilReady(): Promise<void> {
    if (this.ready && this.worker) return;
    if (this.replacement) return this.replacement;
    this.replacement = this.spawnWorker().finally(() => {
      this.replacement = null;
    });
    return this.replacement;
  }

  async call(
    operation: WorkerOperation,
    body: Uint8Array,
    options: WorkerCallOptions = {},
  ): Promise<WorkerCallResult> {
    await this.waitUntilReady();
    const worker = this.worker;
    if (!worker || !this.ready) throw new WorkerUnavailableError('semantic runtime Worker is unavailable');

    const requestId = ++this.requestSequence;
    const timeoutMs = options.timeoutMs ?? this.options.requestTimeoutMs;
    const generation = this.generation;
    const request: RuntimeWorkerRequest = {
      type: 'request',
      requestId,
      op: operation,
      handle: options.handle,
      body: Uint8Array.from(body),
      deadlineMonotonicMs: performance.now() + timeoutMs,
    };

    return new Promise<WorkerCallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) return;
        this.pending.delete(requestId);
        const error = new WorkerRequestTimeoutError(operation, timeoutMs);
        const replacement = this.replaceWorker(`watchdog timeout during ${operation}`);
        pending.reject(error);
        void replacement.catch((replacementError) => {
          this.options.log?.(
            `semantic-runtime-worker-replacement-failed: ${errorMessage(replacementError)}`,
          );
        });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { generation, operation, timer, resolve, reject });
      try {
        const transfer = request.body.buffer instanceof ArrayBuffer ? [request.body.buffer] : [];
        worker.postMessage(request, transfer);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new WorkerUnavailableError(errorMessage(error)));
        void this.replaceWorker(`postMessage failed during ${operation}`);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    const worker = this.worker;
    this.worker = null;
    this.rejectPending(new WorkerUnavailableError('semantic runtime Worker stopped'));
    if (worker) await worker.terminate();
    if (this.replacement) {
      await this.replacement.catch(() => undefined);
      const replacement = this.worker as Worker | null;
      this.worker = null;
      this.ready = false;
      if (replacement) await replacement.terminate();
    }
  }

  private async spawnWorker(): Promise<void> {
    if (this.stopping) throw new WorkerUnavailableError('semantic runtime Worker is stopping');
    const artifacts = verifyRuntimeArtifacts(this.options.artifactRoot);
    const generation = ++this.generation;
    const bootstrap: RuntimeWorkerBootstrap = {
      artifactRoot: artifacts.root,
      expectedModuleHash: artifacts.wasmSha256,
      expectedAbi: EXPECTED_COMBINED_ABI,
      allowTestOperations: this.options.allowTestOperations,
    };
    const worker = new Worker(this.options.workerUrl ?? new URL('./worker.js', import.meta.url), {
      workerData: bootstrap,
      resourceLimits: this.options.resourceLimits,
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
    });
    this.worker = worker;
    this.ready = false;

    try {
      await new Promise<void>((resolve, reject) => {
      let settled = false;
      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new WorkerUnavailableError('semantic runtime Worker startup handshake timed out'));
      }, this.options.startupTimeoutMs);
      startupTimer.unref?.();

      const finishError = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        reject(error);
      };

      worker.on('message', (message: RuntimeWorkerMessage) => {
        if (this.worker !== worker || this.generation !== generation) return;
        if (message.type === 'ready') {
          if (settled) return;
          if (
            message.abi !== EXPECTED_COMBINED_ABI
            || message.moduleHash !== artifacts.wasmSha256
            || message.wasmBytes < 16 * 1024 * 1024
            || message.wasmBytes > 256 * 1024 * 1024
          ) {
            finishError(new WorkerUnavailableError('semantic runtime Worker READY mismatch'));
            return;
          }
          settled = true;
          clearTimeout(startupTimer);
          this.ready = true;
          this.options.log?.(
            `semantic-runtime-worker-ready generation=${generation} wasmBytes=${message.wasmBytes}`,
          );
          resolve();
          return;
        }
        this.handleWorkerMessage(generation, message);
      });
      worker.on('error', (error) => {
        finishError(new WorkerUnavailableError(`semantic runtime Worker error: ${error.message}`));
        this.handleUnexpectedWorkerFailure(worker, generation, error);
      });
      worker.on('exit', (code) => {
        if (!settled) {
          finishError(new WorkerUnavailableError(`semantic runtime Worker exited during startup (${code})`));
        }
        if (code !== 0 || !this.stopping) {
          this.handleUnexpectedWorkerFailure(
            worker,
            generation,
            new Error(`semantic runtime Worker exited with code ${code}`),
          );
        }
      });
      });
    } catch (error) {
      if (this.worker === worker && this.generation === generation) {
        this.worker = null;
        this.ready = false;
      }
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  private handleWorkerMessage(generation: number, message: RuntimeWorkerMessage): void {
    if (message.type === 'fatal') {
      this.options.log?.(`semantic-runtime-worker-fatal: ${message.message}`);
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.requestId);
    if (!pending || pending.generation !== generation) return;
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve({ body: Uint8Array.from(message.body), wasmBytes: message.wasmBytes });
    } else {
      pending.reject(new WorkerOperationError(message.code, message.category));
    }
  }

  private handleUnexpectedWorkerFailure(worker: Worker, generation: number, error: Error): void {
    if (this.worker !== worker || this.generation !== generation) return;
    this.options.log?.(`semantic-runtime-worker-failed: ${error.message}`);
    void this.replaceWorker(error.message).catch((replacementError) => {
      this.options.log?.(
        `semantic-runtime-worker-replacement-failed: ${errorMessage(replacementError)}`,
      );
    });
  }

  private replaceWorker(reason: string): Promise<void> {
    if (this.replacement) return this.replacement;
    this.replacement = (async () => {
      const worker = this.worker;
      this.worker = null;
      this.ready = false;
      this.rejectPending(new WorkerUnavailableError(`semantic runtime Worker replaced: ${reason}`));
      if (worker) await worker.terminate().catch(() => undefined);
      if (this.stopping) return;
      this.restartCounter += 1;
      await this.spawnWorker();
    })().finally(() => {
      this.replacement = null;
    });
    return this.replacement;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
