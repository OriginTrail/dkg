import type { ManagedOxigraphRecoveryHandleV1, ManagedOxigraphRecoveryPhaseV1 }
  from '@origintrail-official/dkg-storage';

/** The supervisor alone publishes physical recovery progress for one process. */
export function createOxigraphRecoveryProgress(generation: number) {
  let phase: ManagedOxigraphRecoveryPhaseV1 = 'verifying';
  const observers = new Set<(phase: ManagedOxigraphRecoveryPhaseV1) => void>();
  const terminal = () => phase === 'cancelled' || phase === 'reopened' || phase === 'stopped';
  const notify = (observe: (phase: ManagedOxigraphRecoveryPhaseV1) => void) => {
    try { observe(phase); } catch { /* Observation cannot change supervision. */ }
  };
  const handle: ManagedOxigraphRecoveryHandleV1 = Object.freeze({
    generation,
    subscribe(observe: (phase: ManagedOxigraphRecoveryPhaseV1) => void) {
      if (!terminal()) observers.add(observe);
      notify(observe);
      return () => { observers.delete(observe); };
    },
  });
  return {
    handle,
    get phase() { return phase; },
    publish(next: ManagedOxigraphRecoveryPhaseV1) {
      if (terminal() || phase === next) return false;
      phase = next;
      for (const observe of Array.from(observers)) notify(observe);
      if (terminal()) observers.clear();
      return true;
    },
  };
}

/** Retains each handle's identity across cancellation, reclamation and reopen. */
export class OxigraphRecoveryProgressOwner {
  #current: ReturnType<typeof createOxigraphRecoveryProgress> | undefined;
  // Generations increase monotonically in this supervisor lifetime. A restart
  // publishes termination only after a successful replacement launch whose
  // serialized reclaim ran first: no older physical holder can survive it.
  // Retain that confirmed prefix in constant space, not cancelled/signalled exits.
  #terminatedThrough = -1;
  constructor(private readonly generation: () => number, private readonly start: (reason: string) => boolean) {}
  get phase() { return this.#current?.phase; }
  begin(generation: number): void { this.#current = createOxigraphRecoveryProgress(generation); }
  childExited(generation: number): void {
    if (!this.#current || this.phase === 'cancelled' || this.phase === 'reopened') this.begin(generation);
  }
  publish(phase: ManagedOxigraphRecoveryPhaseV1): boolean {
    const current = this.#current;
    const accepted = current?.publish(phase) ?? false;
    if (current && accepted && phase === 'terminated') {
      this.#terminatedThrough = Math.max(this.#terminatedThrough, current.handle.generation);
    }
    return accepted;
  }
  request(generation: number, reason: string): ManagedOxigraphRecoveryHandleV1 | undefined {
    if (!Number.isSafeInteger(generation) || generation < 0) return undefined;
    if (this.#current?.handle.generation === generation
      && this.phase !== 'cancelled' && this.phase !== 'stopped') return this.#current.handle;
    if (generation <= this.#terminatedThrough) {
      const completed = createOxigraphRecoveryProgress(generation);
      completed.publish('terminated');
      return completed.handle;
    }
    return this.generation() === generation && this.start(reason) ? this.#current?.handle : undefined;
  }
}
