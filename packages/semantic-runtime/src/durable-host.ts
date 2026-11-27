import { decode, encode } from 'cborg';

import {
  ABI_VERSION,
  SCHEMA_VERSION,
  type Phase0RuntimeEvent,
  type Phase0StepOutput,
} from './codec.js';
import {
  SemanticRuntimeHost,
  type SemanticRuntimeHostOptions,
} from './host.js';
import {
  SemanticRuntimeStore,
  type StrategyArtifactRecord,
} from './persistence.js';

const COMBINED_ABI = (ABI_VERSION << 16) | SCHEMA_VERSION;

export interface DurableRuntimeExecution {
  executionId: string;
  partitionId: string;
  graphRevision: string;
  policyEpoch: bigint;
  rootProcessId: string;
  leaseEpoch: bigint;
  artifact: StrategyArtifactRecord;
}

export interface DurableSemanticRuntimeOptions {
  databasePath?: string;
  dataDirectory?: string;
  execution: DurableRuntimeExecution;
  host?: Omit<SemanticRuntimeHostOptions, 'initialSnapshot'>;
  snapshotEveryEvents?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export class DurableSemanticRuntimeHost {
  private readonly store: SemanticRuntimeStore;
  private readonly options: DurableSemanticRuntimeOptions;
  private host: SemanticRuntimeHost | null = null;
  private poisoned = false;

  constructor(options: DurableSemanticRuntimeOptions) {
    if (!options.databasePath && !options.dataDirectory) {
      throw new Error('durable semantic runtime requires databasePath or dataDirectory');
    }
    this.options = options;
    this.store = options.databasePath
      ? new SemanticRuntimeStore(options.databasePath)
      : SemanticRuntimeStore.openInDataDirectory(options.dataDirectory!);
  }

  get persistence(): SemanticRuntimeStore {
    return this.store;
  }

  async start(): Promise<void> {
    if (this.host) return;
    this.store.registerStrategyArtifact(this.options.execution.artifact);
    let execution = this.store.execution(this.options.execution.executionId);
    if (!execution) {
      this.store.createExecution({
        executionId: this.options.execution.executionId,
        planId: this.options.execution.artifact.artifactHash,
        partitionId: this.options.execution.partitionId,
        status: 'active',
        graphRevision: this.options.execution.graphRevision,
        policyEpoch: this.options.execution.policyEpoch,
        rootProcessId: this.options.execution.rootProcessId,
        leaseEpoch: this.options.execution.leaseEpoch,
      });
      execution = requireValue(
        this.store.execution(this.options.execution.executionId),
        'durable execution was not created',
      );
    } else {
      this.assertExecutionBinding(execution);
      this.store.verifyRuntimeEventChain(execution.executionId);
    }

    const snapshot = this.store.newestValidSnapshot(execution.partitionId);
    const compatibleSnapshot = snapshot
      && snapshot.schemaVersion === SCHEMA_VERSION
      && snapshot.wasmAbiVersion === COMBINED_ABI
      ? snapshot
      : null;
    const host = new SemanticRuntimeHost({
      ...this.options.host,
      log: this.options.host?.log ?? this.options.log,
      initialSnapshot: compatibleSnapshot?.cbor,
    });
    try {
      await host.start();
      const replayAfter = compatibleSnapshot?.seq ?? 0n;
      for (const event of this.store.runtimeEventsAfter(execution.executionId, replayAfter)) {
        await host.applyEvent(decodeDurableEvent(event.cbor));
      }
      const inspection = await host.inspect();
      if (execution.stateDigest && !bytesEqual(inspection.stateDigest, execution.stateDigest)) {
        throw new Error('durable replay state digest does not match the persisted checkpoint');
      }
      this.host = host;
      this.poisoned = false;
      this.options.log?.(
        `semantic-runtime-durable-ready execution=${execution.executionId} replayAfter=${replayAfter}`,
      );
    } catch (error) {
      await host.stop().catch(() => undefined);
      throw error;
    }
  }

  async applyEvent(event: Phase0RuntimeEvent): Promise<Phase0StepOutput> {
    if (this.poisoned) {
      throw new Error('durable semantic runtime is quarantined after a persistence failure');
    }
    const host = requireValue(this.host, 'durable semantic runtime is not started');
    const execution = requireValue(
      this.store.execution(this.options.execution.executionId),
      'durable execution disappeared',
    );
    const eventId = Buffer.from(event.eventId).toString('hex');
    if (this.store.hasRuntimeEvent(execution.executionId, eventId)) {
      return host.applyEvent(event);
    }
    const output = await host.applyEvent(event);
    const interval = this.options.snapshotEveryEvents ?? 1_000;
    if (!Number.isInteger(interval) || interval <= 0) {
      throw new Error('snapshotEveryEvents must be a positive integer');
    }
    const shouldSnapshot = execution.nextEventSeq % BigInt(interval) === 0n;
    try {
      this.store.commitRuntimeTransition({
        executionId: execution.executionId,
        expectedNextSeq: execution.nextEventSeq,
        eventId,
        eventType: event.kind,
        eventCbor: encodeDurableEvent(event),
        stateDigest: output.stateDigest,
        snapshot: shouldSnapshot ? {
          partitionId: execution.partitionId,
          schemaVersion: SCHEMA_VERSION,
          wasmAbiVersion: COMBINED_ABI,
          cbor: await host.snapshotBytes(),
          createdAt: (this.options.now ?? Date.now)(),
        } : undefined,
      });
      return output;
    } catch (error) {
      this.poisoned = true;
      this.store.setExecutionStatus(execution.executionId, 'quarantined');
      await host.stop().catch(() => undefined);
      this.host = null;
      throw new Error('semantic runtime persistence failed after transition; execution quarantined', {
        cause: error,
      });
    }
  }

  async stop(): Promise<void> {
    const host = this.host;
    this.host = null;
    if (host) await host.stop();
    this.store.close();
  }

  private assertExecutionBinding(execution: {
    planId: string;
    partitionId: string;
    graphRevision: string;
    policyEpoch: bigint;
  }): void {
    if (
      execution.planId !== this.options.execution.artifact.artifactHash
      || execution.partitionId !== this.options.execution.partitionId
      || execution.graphRevision !== this.options.execution.graphRevision
      || execution.policyEpoch !== this.options.execution.policyEpoch
    ) {
      throw new Error('durable execution binding does not match current activation context');
    }
  }
}

function encodeDurableEvent(event: Phase0RuntimeEvent): Uint8Array {
  if (event.kind === 'advance') {
    return encode([1, 0, event.eventId, event.logicalTime, event.delta]);
  }
  return encode([1, 1, event.eventId, event.logicalTime, event.deadline]);
}

function decodeDurableEvent(bytes: Uint8Array): Phase0RuntimeEvent {
  const value = decode(bytes);
  if (!Array.isArray(value) || value.length !== 5 || value[0] !== 1) {
    throw new Error('invalid durable runtime event envelope');
  }
  const [, kind, eventId, logicalTime, payload] = value;
  if (!(eventId instanceof Uint8Array) || eventId.byteLength !== 32) {
    throw new Error('durable runtime event id must be 32 bytes');
  }
  const time = toBigInt(logicalTime, 'logical time');
  if (kind === 0) {
    return {
      kind: 'advance',
      eventId,
      logicalTime: time,
      delta: toBigInt(payload, 'delta'),
    };
  }
  if (kind === 1) {
    return {
      kind: 'set-deadline',
      eventId,
      logicalTime: time,
      deadline: payload === null ? null : toBigInt(payload, 'deadline'),
    };
  }
  throw new Error('unknown durable runtime event kind');
}

function toBigInt(value: unknown, name: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error(`durable runtime event ${name} must be an unsigned integer`);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
