// SPDX-License-Identifier: Apache-2.0

/**
 * One explicitly-budgeted phase of a signer write. Keeping the phase label
 * beside its bound makes the queue admission plan auditable at the call site.
 */
export interface SignerWritePhase {
  label: string;
  executionBudgetMs: number;
}

/**
 * Ordered worst-case plan for one nonce-critical signer write.
 *
 * Callers reserve the actual phases their operation may execute, in execution
 * order. The lane derives its admission deadline from those phases instead of
 * accepting an opaque total or a free-form operation/profile name.
 */
export class SignerWritePlan {
  private readonly phases: SignerWritePhase[] = [];

  reserve(label: string, executionBudgetMs: number): this {
    if (!Number.isFinite(executionBudgetMs) || executionBudgetMs <= 0) {
      throw new Error(`Signer write phase ${label} must have a positive execution budget`);
    }
    this.phases.push({ label, executionBudgetMs });
    return this;
  }

  get executionBudgetMs(): number {
    return this.phases.reduce((total, phase) => total + phase.executionBudgetMs, 0);
  }

  get phaseLabels(): readonly string[] {
    return this.phases.map((phase) => phase.label);
  }
}

interface SignerWriteLaneState {
  tail: Promise<void>;
  depth: number;
  pendingExecutionBudgetMs: number;
}

/**
 * A queued signer write exceeded the cumulative advertised budgets of every
 * predecessor already occupying its wallet lane. Its callback is never run.
 */
export class SignerWriteLaneAdmissionTimeoutError extends Error {
  readonly code = 'SIGNER_WRITE_LANE_ADMISSION_TIMEOUT';

  constructor(
    readonly signerAddress: string,
    readonly waitMs: number,
    readonly queueDepth: number,
  ) {
    super(
      `Timed out after ${waitMs}ms waiting for signer transaction lane ` +
      `${signerAddress} (queue depth ${queueDepth})`,
    );
    this.name = 'SignerWriteLaneAdmissionTimeoutError';
  }
}

/**
 * Per-wallet admission queue for nonce-critical EVM writes.
 *
 * Entries under one signer address execute in FIFO order. A caller whose
 * cumulative predecessor budget expires is rejected and its abandoned
 * callback is skipped when it reaches the front. The lane itself remains held
 * until every real predecessor settles, so an admission timeout can never
 * permit overlapping nonce windows.
 */
export class SignerWriteLane {
  private readonly lanes = new Map<string, SignerWriteLaneState>();

  run<T>(
    signerAddress: string,
    plan: SignerWritePlan,
    fn: () => Promise<T>,
  ): Promise<T> {
    const executionBudgetMs = plan.executionBudgetMs;
    if (executionBudgetMs <= 0) {
      throw new Error('Signer write plan must reserve at least one phase');
    }
    const lane = this.lanes.get(signerAddress) ?? {
      tail: Promise.resolve(),
      depth: 0,
      pendingExecutionBudgetMs: 0,
    };
    if (!this.lanes.has(signerAddress)) this.lanes.set(signerAddress, lane);
    const prev = lane.tail;
    const queueDepth = ++lane.depth;
    const waitMs = lane.pendingExecutionBudgetMs;
    lane.pendingExecutionBudgetMs += executionBudgetMs;

    const entry = this.createEntry(signerAddress, queueDepth, waitMs, prev, fn);
    lane.tail = entry.tail;
    void entry.tail.then(() => {
      lane.depth -= 1;
      lane.pendingExecutionBudgetMs -= executionBudgetMs;
      if (lane.depth === 0 && this.lanes.get(signerAddress) === lane) {
        this.lanes.delete(signerAddress);
      }
    });
    return entry.result;
  }

  private createEntry<T>(
    signerAddress: string,
    queueDepth: number,
    waitMs: number,
    prev: Promise<void>,
    fn: () => Promise<T>,
  ): { result: Promise<T>; tail: Promise<void> } {
    let timedOut = false;
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = waitMs > 0
      ? setTimeout(() => {
        timedOut = true;
        rejectResult(new SignerWriteLaneAdmissionTimeoutError(
          signerAddress,
          waitMs,
          queueDepth,
        ));
      }, waitMs)
      : undefined;
    timeout?.unref?.();

    const execution = prev.then(async () => {
      if (timedOut) return;
      if (timeout) clearTimeout(timeout);
      try {
        resolveResult(await fn());
      } catch (error) {
        rejectResult(error);
      }
    });
    return {
      result,
      tail: execution.then(
        () => undefined,
        () => undefined,
      ),
    };
  }

  isActive(signerAddress: string): boolean {
    return this.lanes.has(signerAddress);
  }

  get activeSignerCount(): number {
    return this.lanes.size;
  }
}
