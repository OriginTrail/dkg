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

/**
 * One executable phase of a signer write. The callback and its worst-case
 * occupancy are registered by the same method, so adding work to the
 * nonce-critical window necessarily changes the admission plan as well.
 */
interface SignerWriteOperationPhase<TContext, TState> extends SignerWritePhase {
  execute: (context: TContext, state: TState) => Promise<void>;
}

/**
 * Executable signer-write admission plan.
 *
 * `phase` is deliberately the only way to add work: a caller cannot append an
 * opaque callback without also declaring that callback's execution budget.
 * Operations are single-use because their ordered phase list is sealed as
 * soon as execution begins.
 */
export class SignerWriteOperation<TContext, TState, TResult> {
  private readonly admissionPlan = new SignerWritePlan();
  private readonly phases: SignerWriteOperationPhase<TContext, TState>[] = [];
  private started = false;

  constructor(
    private readonly createState: () => TState,
    // Result selection is synchronous by design. Any awaited post-processing
    // belongs in a named, budgeted phase rather than an invisible epilogue.
    private readonly selectResult: (state: TState) => TResult,
  ) {}

  phase(
    label: string,
    executionBudgetMs: number,
    execute: (context: TContext, state: TState) => Promise<void>,
  ): this {
    if (this.started) {
      throw new Error('Cannot add a signer write phase after execution has started');
    }
    this.admissionPlan.reserve(label, executionBudgetMs);
    this.phases.push({ label, executionBudgetMs, execute });
    return this;
  }

  get plan(): SignerWritePlan {
    return this.admissionPlan;
  }

  async execute(context: TContext): Promise<TResult> {
    if (this.started) throw new Error('Signer write operation can only execute once');
    this.started = true;
    const state = this.createState();
    for (const phase of this.phases) {
      await phase.execute(context, state);
    }
    return this.selectResult(state);
  }
}

type SignerWriteLaneEntryState = 'queued' | 'running' | 'timed-out' | 'skipped' | 'settled';

interface SignerWriteLaneEntry {
  executionBudgetMs: number;
  state: SignerWriteLaneEntryState;
}

interface SignerWriteLaneState {
  tail: Promise<void>;
  entries: Set<SignerWriteLaneEntry>;
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
      entries: new Set<SignerWriteLaneEntry>(),
    };
    if (!this.lanes.has(signerAddress)) this.lanes.set(signerAddress, lane);
    const prev = lane.tail;
    const queueDepth = lane.entries.size + 1;
    const waitMs = [...lane.entries]
      .filter((predecessor) => predecessor.state === 'queued' || predecessor.state === 'running')
      .reduce((total, predecessor) => total + predecessor.executionBudgetMs, 0);
    const laneEntry: SignerWriteLaneEntry = {
      executionBudgetMs,
      state: 'queued',
    };
    lane.entries.add(laneEntry);

    const entry = this.createEntry(signerAddress, queueDepth, waitMs, prev, laneEntry, fn);
    lane.tail = entry.tail;
    void entry.tail.then(() => {
      lane.entries.delete(laneEntry);
      if (lane.entries.size === 0 && this.lanes.get(signerAddress) === lane) {
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
    laneEntry: SignerWriteLaneEntry,
    fn: () => Promise<T>,
  ): { result: Promise<T>; tail: Promise<void> } {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const timeout = waitMs > 0
      ? setTimeout(() => {
        if (laneEntry.state !== 'queued') return;
        // Stop charging this abandoned entry to callers admitted after its
        // deadline. Its `tail` remains chained to `prev`, preserving the FIFO
        // ordering barrier until the real predecessor releases the lane.
        laneEntry.state = 'timed-out';
        rejectResult(new SignerWriteLaneAdmissionTimeoutError(
          signerAddress,
          waitMs,
          queueDepth,
        ));
      }, waitMs)
      : undefined;
    timeout?.unref?.();

    const execution = prev.then(async () => {
      if (laneEntry.state === 'timed-out') {
        laneEntry.state = 'skipped';
        return;
      }
      laneEntry.state = 'running';
      if (timeout) clearTimeout(timeout);
      try {
        resolveResult(await fn());
      } catch (error) {
        rejectResult(error);
      } finally {
        laneEntry.state = 'settled';
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
