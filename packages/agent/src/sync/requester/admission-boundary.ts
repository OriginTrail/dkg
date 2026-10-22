/** Physical work state, separate from progress and diagnostic accounting. */
export type DurableSyncAdmissionOutcome =
  | 'not-started'
  | 'work-started'
  | 'local-admission-deferred';

/** Owns the one-way boundary from waiting for capacity to admitted work. */
export class DurableSyncAdmissionBoundary {
  private outcome: DurableSyncAdmissionOutcome = 'not-started';

  constructor(private readonly onWorkStarted?: () => void) {}

  readonly startWork = (): void => {
    if (this.outcome === 'work-started') return;
    this.outcome = 'work-started';
    this.onWorkStarted?.();
  };

  defer(): void {
    if (this.outcome !== 'work-started') this.outcome = 'local-admission-deferred';
  }

  snapshot(): DurableSyncAdmissionOutcome {
    return this.outcome;
  }
}
