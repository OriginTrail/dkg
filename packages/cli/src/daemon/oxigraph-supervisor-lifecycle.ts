import { performance } from 'node:perf_hooks';

export type OxigraphLifecycleStateV1 =
  | 'starting'
  | 'ready'
  | 'reviving'
  | 'recovering'
  | 'stopping'
  | 'closed';

export function sleepOxigraphSupervisorV1(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function remainingOxigraphDeadlineMsV1(
  absoluteDeadlineMs: number | undefined,
): number | undefined {
  return absoluteDeadlineMs === undefined
    ? undefined
    : Math.max(0, absoluteDeadlineMs - performance.now());
}

export function boundedOxigraphPhaseDelayMsV1(
  wantedMs: number,
  absoluteDeadlineMs: number | undefined,
): number {
  const remaining = remainingOxigraphDeadlineMsV1(absoluteDeadlineMs);
  if (remaining !== undefined && remaining <= 0) {
    throw new Error('Managed Oxigraph clean-generation recovery deadline expired');
  }
  return Math.max(1, Math.ceil(Math.min(wantedMs, remaining ?? wantedMs)));
}

export function normalizePositiveOxigraphIntegerV1(
  value: number | undefined,
): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

export function parseOxigraphGenerationV1(value: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `Invalid managed Oxigraph child generation ${JSON.stringify(value)}; ` +
        'expected a canonical decimal string minted by the ownership lease',
    );
  }
  return BigInt(value);
}

/** One settle-chained lifecycle tail; rejected sections never poison later cleanup. */
export class SerializedOxigraphLifecycleV1 {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(section: () => Promise<T>): Promise<T> {
    const current = this.#tail.then(section, section);
    this.#tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}

/** Owns exactly the two pre-existing supervisor timer slots. */
export class OxigraphSupervisorTimersV1 {
  #revive: ReturnType<typeof setTimeout> | null = null;
  #handoffAbandon: ReturnType<typeof setTimeout> | null = null;

  clearRevive(): void {
    if (this.#revive === null) return;
    clearTimeout(this.#revive);
    this.#revive = null;
  }

  armRevive(delayMs: number, fire: () => void): void {
    this.clearRevive();
    const timer = setTimeout(() => {
      if (this.#revive !== timer) return;
      this.#revive = null;
      fire();
    }, delayMs);
    timer.unref?.();
    this.#revive = timer;
  }

  clearHandoffAbandon(): void {
    if (this.#handoffAbandon === null) return;
    clearTimeout(this.#handoffAbandon);
    this.#handoffAbandon = null;
  }

  armHandoffAbandon(delayMs: number, fire: () => void): void {
    this.clearHandoffAbandon();
    const timer = setTimeout(() => {
      if (this.#handoffAbandon !== timer) return;
      this.#handoffAbandon = null;
      fire();
    }, delayMs);
    timer.unref?.();
    this.#handoffAbandon = timer;
  }
}
