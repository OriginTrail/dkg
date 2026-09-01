import { createHash } from 'node:crypto';

import {
  MESSAGE_TYPE,
  decodeAbiSuccess,
  decodeHandle,
  decodeInspection,
  decodeStatus,
  decodeStepOutput,
  encodeCreateRequest,
  encodeEmptyRequest,
  encodeEventRequest,
  encodeRestoreRequest,
  type Phase0Inspection,
  type Phase0RuntimeEvent,
  type Phase0StepOutput,
  type StartedPlanInspection,
  type StartedPlanReceipt,
} from './codec.js';
import {
  ComponentExecutionPool,
  type ComponentExecutionPoolOptions,
} from './component-supervisor.js';
import type {
  ComponentExecutionResult,
  ComponentToolDispatcher,
  ExecutionCapabilityDescriptor,
} from './component-types.js';
import {
  WorkerRequestTimeoutError,
  WorkerSupervisor,
  WorkerUnavailableError,
  type WorkerSupervisorOptions,
} from './worker-supervisor.js';

export interface SemanticRuntimeConfig {
  enabled?: boolean;
  /** Operator-owned policy selected locally; Programs cannot override it. */
  operatorPolicyIri?: string;
  watchdogMs?: number;
  startupTimeoutMs?: number;
  maxEvents?: number;
  maxAccumulator?: bigint | number | string;
  partitionId?: string;
  maxActiveExecutions?: number;
  maxOperationsPerExecution?: number;
}

export interface SemanticRuntimeHostOptions {
  config?: SemanticRuntimeConfig;
  artifactRoot?: string;
  workerUrl?: URL;
  componentWorkerUrl?: URL;
  allowTestOperations?: boolean;
  initialSnapshot?: Uint8Array;
  log?: (message: string) => void;
}

export class SemanticRuntimeHost {
  private readonly supervisor: WorkerSupervisor;
  private readonly componentPool: ComponentExecutionPool;
  private readonly config: SemanticRuntimeConfig;
  private readonly allowTestOperations: boolean;
  private readonly initialSnapshot: Uint8Array | null;
  private handle: number | null = null;
  private snapshot: Uint8Array | null = null;
  private expectedStateDigest: Uint8Array | null = null;
  private abiRequestSequence = 0n;
  private recovery: Promise<void> | null = null;
  private stateOperationTail: Promise<void> = Promise.resolve();

  constructor(options: SemanticRuntimeHostOptions = {}) {
    this.config = options.config ?? {};
    this.allowTestOperations = options.allowTestOperations ?? false;
    this.initialSnapshot = options.initialSnapshot
      ? Uint8Array.from(options.initialSnapshot)
      : null;
    const supervisorOptions: WorkerSupervisorOptions = {
      artifactRoot: options.artifactRoot,
      workerUrl: options.workerUrl,
      requestTimeoutMs: this.config.watchdogMs ?? 100,
      startupTimeoutMs: this.config.startupTimeoutMs ?? 10_000,
      allowTestOperations: this.allowTestOperations,
      log: options.log,
    };
    this.supervisor = new WorkerSupervisor(supervisorOptions);
    const componentOptions: ComponentExecutionPoolOptions = {
      artifactRoot: options.artifactRoot,
      workerUrl: options.componentWorkerUrl,
      requestTimeoutMs: Math.max(this.config.watchdogMs ?? 100, 1_000),
      startupTimeoutMs: this.config.startupTimeoutMs ?? 10_000,
      allowTestOperations: this.allowTestOperations,
      maxActiveExecutions: this.config.maxActiveExecutions ?? 8,
      maxOperations: this.config.maxOperationsPerExecution ?? 10_000,
      log: options.log,
    };
    this.componentPool = new ComponentExecutionPool(componentOptions);
  }

  get workerRestartCount(): number {
    return this.supervisor.restartCount;
  }

  get activeComponentExecutions(): number {
    return this.componentPool.activeCount;
  }

  async start(): Promise<void> {
    if (this.handle !== null) return;
    await this.supervisor.start();
    const requestId = this.nextAbiRequestId();
    const restoring = this.initialSnapshot !== null;
    const response = restoring
      ? await this.supervisor.call(
        'restore',
        encodeRestoreRequest(requestId, this.initialSnapshot),
      )
      : await this.supervisor.call(
        'create',
        encodeCreateRequest(requestId, {
          partitionId: resolvePartitionId(this.config.partitionId),
          maxEvents: this.config.maxEvents ?? 10_000,
          maxAccumulator: parseU64(this.config.maxAccumulator ?? '9007199254740991'),
        }),
      );
    this.handle = decodeHandle(
      decodeAbiSuccess(
        response.body,
        requestId,
        restoring ? MESSAGE_TYPE.restore : MESSAGE_TYPE.create,
      ),
    );
    const inspection = await this.inspectInternal();
    this.expectedStateDigest = inspection.stateDigest;
    await this.refreshSnapshot();
  }

  async applyEvent(event: Phase0RuntimeEvent): Promise<Phase0StepOutput> {
    return this.runExclusive(() => this.applyEventInternal(event));
  }

  /** Re-admits and materializes a narrowly supported executable plan in Wasm. */
  async startPlan(
    canonicalPlan: Uint8Array,
    logicalTime = 0n,
    capability?: ExecutionCapabilityDescriptor,
    toolDispatcher?: ComponentToolDispatcher,
  ): Promise<StartedPlanReceipt> {
    this.requireHandle();
    return this.componentPool.startPlan(canonicalPlan, logicalTime, capability, toolDispatcher);
  }

  async applyPlan(handle: number): Promise<ComponentExecutionResult> {
    this.requireHandle();
    return this.componentPool.applyPlan(handle);
  }

  async inspectPlan(handle: number): Promise<StartedPlanInspection> {
    this.requireHandle();
    return this.componentPool.inspectPlan(handle);
  }

  async dropPlan(handle: number): Promise<void> {
    await this.componentPool.dropPlan(handle);
  }

  async componentTestTrap(handle: number): Promise<void> {
    if (!this.allowTestOperations) throw new Error('component test operations are disabled');
    await this.componentPool.testTrap(handle);
  }

  async componentTestHang(handle: number): Promise<void> {
    if (!this.allowTestOperations) throw new Error('component test operations are disabled');
    await this.componentPool.testHang(handle);
  }

  private async applyEventInternal(event: Phase0RuntimeEvent): Promise<Phase0StepOutput> {
    const handle = this.requireHandle();
    const requestId = this.nextAbiRequestId();
    try {
      const response = await this.supervisor.call(
        'apply',
        encodeEventRequest(requestId, event),
        { handle },
      );
      const output = decodeStepOutput(
        decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.apply),
      );
      this.expectedStateDigest = output.stateDigest;
      await this.refreshSnapshot();
      return output;
    } catch (error) {
      if (isPartitionFailure(error)) await this.recoverFromSnapshot();
      throw error;
    }
  }

  async inspect(): Promise<Phase0Inspection> {
    return this.runExclusive(() => this.inspectInternal());
  }

  private async inspectInternal(): Promise<Phase0Inspection> {
    const handle = this.requireHandle();
    const requestId = this.nextAbiRequestId();
    const response = await this.supervisor.call(
      'inspect',
      encodeEmptyRequest(requestId, MESSAGE_TYPE.inspect),
      { handle },
    );
    return decodeInspection(
      decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.inspect),
    );
  }

  async snapshotBytes(): Promise<Uint8Array> {
    return this.runExclusive(async () => {
      await this.refreshSnapshot();
      return Uint8Array.from(this.snapshot!);
    });
  }

  async phase0TestHang(): Promise<void> {
    return this.runExclusive(() => this.phase0TestHangInternal());
  }

  private async phase0TestHangInternal(): Promise<void> {
    if (!this.allowTestOperations) throw new Error('phase0 test operations are disabled');
    try {
      await this.supervisor.call('phase0_test_hang', new Uint8Array());
      throw new Error('phase0 hang operation unexpectedly returned');
    } catch (error) {
      if (isPartitionFailure(error)) await this.recoverFromSnapshot();
      throw error;
    }
  }

  async phase0TestTrap(): Promise<void> {
    return this.runExclusive(() => this.phase0TestTrapInternal());
  }

  private async phase0TestTrapInternal(): Promise<void> {
    if (!this.allowTestOperations) throw new Error('phase0 test operations are disabled');
    try {
      await this.supervisor.call('phase0_test_trap', new Uint8Array());
      throw new Error('phase0 trap operation unexpectedly returned');
    } catch (error) {
      if (isPartitionFailure(error)) await this.recoverFromSnapshot();
      throw error;
    }
  }

  async stop(): Promise<void> {
    return this.runExclusive(() => this.stopInternal());
  }

  private async stopInternal(): Promise<void> {
    await this.componentPool.stop();
    const handle = this.handle;
    this.handle = null;
    this.snapshot = null;
    this.expectedStateDigest = null;
    if (handle !== null) {
      const requestId = this.nextAbiRequestId();
      try {
        const response = await this.supervisor.call(
          'drop',
          encodeEmptyRequest(requestId, MESSAGE_TYPE.drop),
          { handle },
        );
        decodeStatus(decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.drop));
      } catch {
        // Worker termination below is the ownership boundary if drop cannot run.
      }
    }
    await this.supervisor.stop();
  }

  private async refreshSnapshot(): Promise<void> {
    const handle = this.requireHandle();
    const requestId = this.nextAbiRequestId();
    const response = await this.supervisor.call(
      'snapshot',
      encodeEmptyRequest(requestId, MESSAGE_TYPE.snapshot),
      { handle },
    );
    this.snapshot = Uint8Array.from(
      decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.snapshot),
    );
  }

  private recoverFromSnapshot(): Promise<void> {
    if (this.recovery) return this.recovery;
    const snapshot = this.snapshot;
    const expectedDigest = this.expectedStateDigest;
    if (!snapshot || !expectedDigest) {
      return Promise.reject(new WorkerUnavailableError('no Phase 0 snapshot is available for recovery'));
    }
    this.recovery = (async () => {
      await this.supervisor.waitUntilReady();
      const requestId = this.nextAbiRequestId();
      const response = await this.supervisor.call(
        'restore',
        encodeRestoreRequest(requestId, snapshot),
      );
      this.handle = decodeHandle(
        decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.restore),
      );
      const inspection = await this.inspectInternal();
      if (!bytesEqual(inspection.stateDigest, expectedDigest)) {
        this.handle = null;
        throw new WorkerUnavailableError('restored Phase 0 state digest did not match checkpoint');
      }
    })().finally(() => {
      this.recovery = null;
    });
    return this.recovery;
  }

  private requireHandle(): number {
    if (this.handle === null) throw new WorkerUnavailableError('semantic runtime host is not started');
    return this.handle;
  }

  private nextAbiRequestId(): bigint {
    this.abiRequestSequence += 1n;
    return this.abiRequestSequence;
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateOperationTail.then(operation, operation);
    this.stateOperationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function startSemanticRuntimeHost(
  options: SemanticRuntimeHostOptions = {},
): Promise<SemanticRuntimeHost> {
  const host = new SemanticRuntimeHost(options);
  try {
    await host.start();
    return host;
  } catch (error) {
    await host.stop().catch(() => undefined);
    throw error;
  }
}

function resolvePartitionId(configured: string | undefined): Uint8Array {
  if (configured !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
      throw new Error('semanticRuntime.partitionId must be 64 hexadecimal characters');
    }
    return Uint8Array.from(Buffer.from(configured, 'hex'));
  }
  return Uint8Array.from(
    createHash('sha256').update('DKG-SEMANTIC-RUNTIME-PHASE0-DEFAULT-PARTITION\0').digest(),
  );
}

function parseU64(value: bigint | number | string): bigint {
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error('semanticRuntime.maxAccumulator must be an unsigned 64-bit integer');
  }
  if (parsed <= 0n || parsed > 0xffff_ffff_ffff_ffffn) {
    throw new Error('semanticRuntime.maxAccumulator must be an unsigned 64-bit integer');
  }
  return parsed;
}

function isPartitionFailure(error: unknown): boolean {
  return error instanceof WorkerRequestTimeoutError || error instanceof WorkerUnavailableError;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
