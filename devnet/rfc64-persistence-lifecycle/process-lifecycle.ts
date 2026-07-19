export interface ProcessExitEvidence {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ManagedChildProcess {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface TrackedChildProcess {
  readonly child: ManagedChildProcess;
  readonly closed: Promise<ProcessExitEvidence>;
}

interface TerminationAttempt {
  readonly exit: ProcessExitEvidence | null;
  readonly failures: readonly unknown[];
}

function throwCollectedFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}

function reportSecondaryFailureSafely(
  reportSecondaryFailure: (primaryFailure: unknown, secondaryFailure: unknown) => void,
  primaryFailure: unknown,
  secondaryFailure: unknown,
): void {
  try {
    reportSecondaryFailure(primaryFailure, secondaryFailure);
  } catch {
    // Reporting is best-effort and must never replace the failure being preserved.
  }
}

export class ChildProcessRegistry {
  readonly #active = new Set<TrackedChildProcess>();
  readonly #closeDeadlineMs: number;

  constructor(closeDeadlineMs = 15_000) {
    if (!Number.isSafeInteger(closeDeadlineMs) || closeDeadlineMs < 1) {
      throw new TypeError('closeDeadlineMs must be a positive safe integer');
    }
    this.#closeDeadlineMs = closeDeadlineMs;
  }

  track(child: ManagedChildProcess): TrackedChildProcess {
    let tracked: TrackedChildProcess;
    const closed = new Promise<ProcessExitEvidence>((resolveClose) => {
      child.once('close', (code, signal) => resolveClose({ code, signal }));
    });
    tracked = Object.freeze({ child, closed });
    this.#active.add(tracked);
    void closed.then(() => this.#active.delete(tracked));
    return tracked;
  }

  async #terminateAndInspect(
    tracked: TrackedChildProcess,
    signal: NodeJS.Signals = 'SIGKILL',
  ): Promise<TerminationAttempt> {
    const { child } = tracked;
    const failures: unknown[] = [];
    if (child.exitCode === null && child.signalCode === null) {
      try {
        const delivered = child.kill(signal);
        if (!delivered && child.exitCode === null && child.signalCode === null) {
          failures.push(new Error(`failed to deliver ${signal} to a tracked child process`));
        }
      } catch (error) {
        failures.push(error);
      }
    }
    let exit: ProcessExitEvidence | null = null;
    try {
      exit = await new Promise<ProcessExitEvidence>((resolveClose, rejectClose) => {
        let settled = false;
        const deadline = setTimeout(() => {
          if (settled) return;
          settled = true;
          rejectClose(new Error(
            `tracked child did not emit close within ${this.#closeDeadlineMs}ms after ${signal}`,
          ));
        }, this.#closeDeadlineMs);
        void tracked.closed.then((evidence) => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
          resolveClose(evidence);
        });
      });
    } catch (error) {
      failures.push(error);
    }
    return Object.freeze({ exit, failures: Object.freeze(failures) });
  }

  async terminateAndWait(
    tracked: TrackedChildProcess,
    signal: NodeJS.Signals = 'SIGKILL',
  ): Promise<ProcessExitEvidence> {
    const attempt = await this.#terminateAndInspect(tracked, signal);
    throwCollectedFailures(attempt.failures, 'tracked child process failed to terminate');
    return attempt.exit!;
  }

  async terminateAllThenCleanup(cleanup: () => void | Promise<void>): Promise<void> {
    const attempts = await Promise.all(
      [...this.#active].map((tracked) => this.#terminateAndInspect(tracked)),
    );
    const failures = attempts.flatMap((attempt) => attempt.failures);
    if (attempts.every((attempt) => attempt.exit !== null)) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    throwCollectedFailures(failures, 'child termination or ordered cleanup failed');
  }
}

export async function terminateBeforeRejecting(
  registry: ChildProcessRegistry,
  tracked: TrackedChildProcess,
  primaryFailure: unknown,
  reportSecondaryFailure: (primaryFailure: unknown, secondaryFailure: unknown) => void,
): Promise<never> {
  try {
    await registry.terminateAndWait(tracked);
  } catch (secondaryFailure) {
    reportSecondaryFailureSafely(
      reportSecondaryFailure,
      primaryFailure,
      secondaryFailure,
    );
  }
  throw primaryFailure;
}

export async function cleanupPreservingPrimaryFailure(input: {
  readonly operationFailed: boolean;
  readonly primaryFailure: unknown;
  readonly cleanup: () => Promise<void>;
  readonly reportSecondaryFailure: (
    primaryFailure: unknown,
    secondaryFailure: unknown,
  ) => void;
}): Promise<void> {
  try {
    await input.cleanup();
  } catch (cleanupFailure) {
    if (!input.operationFailed) throw cleanupFailure;
    reportSecondaryFailureSafely(
      input.reportSecondaryFailure,
      input.primaryFailure,
      cleanupFailure,
    );
  }
  if (input.operationFailed) throw input.primaryFailure;
}
