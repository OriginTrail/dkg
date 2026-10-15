import { createHash } from 'node:crypto';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';

export type ClaimLockKind = 'claim' | 'admission' | 'transition' | 'recovery' | 'sweep' | 'admin';
type TraceFields = Readonly<Record<string, string | number | boolean | undefined>>;
export interface ClaimTraceSources {
  enabled(): boolean;
  clock(): number;
  wallClock(): number;
  write(line: string): void;
}
const logger = new Logger('AsyncLiftPublisher');
const sources: ClaimTraceSources = {
  enabled: () => process.env.DKG_ASYNC_PUBLISH_TRACE === '1',
  clock: () => performance.now(),
  wallClock: () => Date.now(),
  write: (line) => logger.info(createOperationContext('publish', 'claim-trace'), line),
};
let nextOperationId = 0;

/** Opt-in diagnostics only: no store reads, retained job state, or business clock changes. */
export class ClaimTrace {
  constructor(private readonly source: ClaimTraceSources = sources) {}

  emit(event: string, fields: TraceFields = {}, walletId?: string): number | undefined {
    try {
      if (!this.source.enabled()) return undefined;
      const monotonicMs = this.source.clock();
      this.source.write(`async_publish_claim_trace ${JSON.stringify({
        schemaVersion: 1, processId: process.pid, event,
        wallTimeMs: this.source.wallClock(), monotonicMs, ...fields,
        ...(typeof fields.acquiredAtMs === 'number' ? { holdMs: monotonicMs - fields.acquiredAtMs } : {}),
        ...(walletId === undefined ? {} : {
          walletHash: createHash('sha256').update(walletId).digest('hex'),
        }),
      })}`);
      return monotonicMs;
    } catch { return undefined; }
  }
}
export const claimTrace = new ClaimTrace();
export interface ClaimLockTrace {
  emit(event: string, fields?: TraceFields): void;
}

/** Preserve the coordinator's queue and release ordering, with monotonic boundary observations. */
export async function withObservedClaimLock<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  fn: (trace: ClaimLockTrace) => Promise<T>,
  kind: ClaimLockKind,
  walletId?: string,
  observer: ClaimTrace = claimTrace,
): Promise<T> {
  const operationId = ++nextOperationId;
  const fields = { operationId, kind };
  const trace: ClaimLockTrace = {
    emit: (event, detail = {}) => { observer.emit(event, { ...fields, ...detail }, walletId); },
  };
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, next);
  const waitingAt = observer.emit('claim_lock_wait', fields, walletId);
  await previous;
  const acquiredAt = observer.emit('claim_lock_acquired', fields, walletId);
  let result = 'error';
  try {
    const value = await fn(trace);
    result = 'success';
    return value;
  } finally {
    release();
    if (queues.get(key) === next) queues.delete(key);
    observer.emit('claim_lock_released', {
      ...fields, result,
      waitMs: waitingAt === undefined || acquiredAt === undefined ? undefined : acquiredAt - waitingAt,
      acquiredAtMs: acquiredAt,
    }, walletId);
  }
}

export async function traceProcessNext<T extends { readonly jobId: string }>(
  walletId: string,
  operation: () => Promise<T | null>,
): Promise<T | null> {
  const operationId = ++nextOperationId;
  claimTrace.emit('process_next_start', { operationId }, walletId);
  try {
    const job = await operation();
    claimTrace.emit('process_next_end', {
      operationId, result: job === null ? 'idle' : 'processed', jobId: job?.jobId,
    }, walletId);
    return job;
  } catch (error) {
    claimTrace.emit('process_next_end', { operationId, result: 'error' }, walletId);
    throw error;
  }
}
