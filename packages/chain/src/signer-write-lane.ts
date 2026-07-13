// SPDX-License-Identifier: Apache-2.0

/**
 * Queue admission is intentionally a coarse operation-wide bound rather than
 * a second model of every RPC read, retry and backoff nested below the adapter.
 * The concrete helpers still own and enforce their individual deadlines; this
 * value only decides how long a successor may wait for the nonce lane.
 *
 * Thirty minutes is conservative enough for the supported V10
 * approve/re-approve, populate/sign, WAL and receipt-recovery path while still
 * bounding abandoned queued work. Because every executable phase is covered
 * by the same operation envelope, adding a nested retry cannot silently make a
 * hand-maintained admission formula stale.
 */
export const SIGNER_WRITE_OPERATION_ADMISSION_BUDGET_MS = 30 * 60 * 1000;

/**
 * Admission policy and an auditable list of the callbacks executed by one
 * nonce-critical signer write. Phase labels describe the real execution path;
 * the single coarse budget is deliberately independent of its nested helper
 * topology.
 */
export class SignerWritePlan {
  private readonly labels: string[] = [];

  constructor(readonly admissionBudgetMs: number) {
    if (!Number.isFinite(admissionBudgetMs) || admissionBudgetMs <= 0) {
      throw new Error('Signer write operation must have a positive admission budget');
    }
  }

  describePhase(label: string): this {
    if (!label.trim()) throw new Error('Signer write phase must have a label');
    this.labels.push(label);
    return this;
  }

  get phaseLabels(): readonly string[] {
    return [...this.labels];
  }
}

/**
 * One executable phase of a signer write. All phases share the operation-wide
 * coarse admission envelope above.
 */
interface SignerWriteOperationPhase<TContext, TState> {
  label: string;
  execute: (context: TContext, state: TState) => Promise<void>;
}

/**
 * Executable signer-write admission plan.
 *
 * `phase` is deliberately the only way to add work, so the plan's labels and
 * executable callbacks cannot drift. Operations are single-use because their
 * ordered phase list is sealed as soon as execution begins.
 */
export class SignerWriteOperation<TContext, TState, TResult> {
  private readonly admissionPlan: SignerWritePlan;
  private readonly phases: SignerWriteOperationPhase<TContext, TState>[] = [];
  private started = false;

  constructor(
    admissionBudgetMs: number,
    private readonly createState: () => TState,
    // Result selection is synchronous by design. Any awaited post-processing
    // belongs in a named phase inside the admission envelope rather than an
    // invisible epilogue.
    private readonly selectResult: (state: TState) => TResult,
  ) {
    this.admissionPlan = new SignerWritePlan(admissionBudgetMs);
  }

  phase(
    label: string,
    execute: (context: TContext, state: TState) => Promise<void>,
  ): this {
    if (this.started) {
      throw new Error('Cannot add a signer write phase after execution has started');
    }
    this.admissionPlan.describePhase(label);
    this.phases.push({ label, execute });
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
  admissionBudgetMs: number;
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
    const admissionBudgetMs = plan.admissionBudgetMs;
    if (admissionBudgetMs <= 0) {
      throw new Error('Signer write plan must define a positive admission budget');
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
      .reduce((total, predecessor) => total + predecessor.admissionBudgetMs, 0);
    const laneEntry: SignerWriteLaneEntry = {
      admissionBudgetMs,
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
