import {
  MESSAGE_TYPE,
  decodeAbiSuccess,
  decodeAdmittedPlan,
  decodeCompileResult,
  encodeAdmitRequest,
  encodeCompileRequest,
  type AdmittedPlanSummary,
  type CompileStrategyResult,
} from './codec.js';
import {
  WorkerSupervisor,
  type WorkerSupervisorOptions,
} from './worker-supervisor.js';

export interface WasmStrategyAdmissionOptions extends Pick<
  WorkerSupervisorOptions,
  'artifactRoot' | 'workerUrl' | 'requestTimeoutMs' | 'startupTimeoutMs' | 'resourceLimits' | 'log'
> {}

/**
 * Runs source compilation in a disposable Worker and re-admits the immutable
 * result in a fresh Worker. This keeps parser failures out of active execution
 * partitions and proves that canonical bytes, not graph metadata, determine
 * the admitted upper bounds.
 */
export class WasmStrategyAdmissionClient {
  private requestSequence = 0n;

  constructor(private readonly options: WasmStrategyAdmissionOptions = {}) {}

  async compileStrategy(source: string): Promise<CompileStrategyResult> {
    return this.withDisposableWorker(async (supervisor) => {
      const requestId = this.nextRequestId();
      const response = await supervisor.call('compile', encodeCompileRequest(requestId, source));
      return decodeCompileResult(
        decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.compile),
      );
    });
  }

  async admitPlan(canonicalPlan: Uint8Array): Promise<AdmittedPlanSummary> {
    return this.withDisposableWorker(async (supervisor) => {
      const requestId = this.nextRequestId();
      const response = await supervisor.call(
        'admit',
        encodeAdmitRequest(requestId, canonicalPlan),
      );
      return decodeAdmittedPlan(
        decodeAbiSuccess(response.body, requestId, MESSAGE_TYPE.admit),
      );
    });
  }

  async compileAndAdmit(source: string): Promise<CompileStrategyResult> {
    const compiled = await this.compileStrategy(source);
    if (!compiled.ok) return compiled;
    const admitted = await this.admitPlan(compiled.plan.canonicalPlan);
    if (!bytesEqual(admitted.canonicalHash, compiled.plan.canonicalHash)) {
      throw new Error('fresh execution Worker admitted a different strategy hash');
    }
    return { ok: true, plan: admitted };
  }

  private async withDisposableWorker<T>(
    operation: (supervisor: WorkerSupervisor) => Promise<T>,
  ): Promise<T> {
    const supervisor = new WorkerSupervisor({
      ...this.options,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 5_000,
    });
    await supervisor.start();
    try {
      return await operation(supervisor);
    } finally {
      await supervisor.stop();
    }
  }

  private nextRequestId(): bigint {
    this.requestSequence += 1n;
    return this.requestSequence;
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}
