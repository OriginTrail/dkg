import type { AdmittedPlanSummary, CompileStrategyResult } from './codec.js';
import {
  ComponentWorkerClient,
  type ComponentSupervisorOptions,
} from './component-supervisor.js';
import type { ComponentCompileOutcome } from './component-types.js';

export interface WasmStrategyAdmissionOptions extends Pick<
  ComponentSupervisorOptions,
  'artifactRoot' | 'workerUrl' | 'requestTimeoutMs' | 'startupTimeoutMs' | 'resourceLimits' | 'log'
> {}

/**
 * Runs source compilation in a disposable Worker and re-admits the immutable
 * result in a fresh Worker. This keeps parser failures out of active execution
 * partitions and proves that canonical bytes, not graph metadata, determine
 * the admitted upper bounds.
 */
export class WasmStrategyAdmissionClient {
  constructor(private readonly options: WasmStrategyAdmissionOptions = {}) {}

  async compileStrategy(source: string): Promise<CompileStrategyResult> {
    return this.withDisposableWorker(async (worker) => {
      const result = await worker.call('compile', { source }) as ComponentCompileOutcome;
      return result;
    });
  }

  async admitPlan(canonicalPlan: Uint8Array): Promise<AdmittedPlanSummary> {
    return this.withDisposableWorker(async (worker) => {
      return await worker.call('admit', { plan: canonicalPlan }) as AdmittedPlanSummary;
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
    operation: (worker: ComponentWorkerClient) => Promise<T>,
  ): Promise<T> {
    const worker = new ComponentWorkerClient({
      ...this.options,
      requestTimeoutMs: this.options.requestTimeoutMs ?? 5_000,
    });
    await worker.start();
    try {
      return await operation(worker);
    } finally {
      await worker.stop();
    }
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index]);
}
