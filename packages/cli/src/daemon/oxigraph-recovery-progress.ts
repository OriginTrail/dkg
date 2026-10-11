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
    constructor(private readonly generation: () => number, private readonly start: (reason: string) => boolean) {}
  get phase() { return phase; },
    publish(next: ManagedOxigraphRecoveryPhaseV1) {
      if (terminal() || phase === next) return;
      phase = next;
      for (const observe of [...observers]) notify(observe);
      if (terminal()) observers.clear();
    },
  };
}

/** Retains each handle's identity across cancellation, reclamation and reopen. */
export class OxigraphRecoveryProgressOwner {
  #current: ReturnType<typeof createOxigraphRecoveryProgress> | undefined;
  constructor(private readonly generation: () => number, private readonly start: (reason: string) => boolean) {}
  get phase() { return this.#current?.phase; }
  begin(generation: number): void { this.#current = createOxigraphRecoveryProgress(generation); }
  childExited(generation: number): void {
    if (!this.#current || this.phase === 'cancelled' || this.phase === 'reopened') this.begin(generation);
  }
  publish(phase: ManagedOxigraphRecoveryPhaseV1): void { this.#current?.publish(phase); }
  request(generation: number, reason: string): ManagedOxigraphRecoveryHandleV1 | undefined {
    if (this.#current?.handle.generation === generation
      && this.phase !== 'cancelled' && this.phase !== 'stopped') return this.#current.handle;
    return this.generation() === generation && this.start(reason) ? this.#current?.handle : undefined;
  }
}
