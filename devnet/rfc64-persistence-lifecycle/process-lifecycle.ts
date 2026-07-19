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

export class ChildProcessRegistry {
  readonly #active = new Set<TrackedChildProcess>();

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

  async terminateAndWait(
    tracked: TrackedChildProcess,
    signal: NodeJS.Signals = 'SIGKILL',
  ): Promise<ProcessExitEvidence> {
    const { child } = tracked;
    let deliveryFailure: Error | undefined;
    if (child.exitCode === null && child.signalCode === null) {
      const delivered = child.kill(signal);
      if (!delivered && child.exitCode === null && child.signalCode === null) {
        deliveryFailure = new Error(`failed to deliver ${signal} to a tracked child process`);
      }
    }
    const exit = await tracked.closed;
    if (deliveryFailure !== undefined) throw deliveryFailure;
    return exit;
  }

  async terminateAllAndWait(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#active].map((tracked) => this.terminateAndWait(tracked)),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'multiple child processes failed to terminate');
    }
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
    reportSecondaryFailure(primaryFailure, secondaryFailure);
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
    input.reportSecondaryFailure(input.primaryFailure, cleanupFailure);
  }
  if (input.operationFailed) throw input.primaryFailure;
}
