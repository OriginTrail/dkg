// SPDX-License-Identifier: Apache-2.0
/** Foreground snapshot ownership pauses VM passes for that graph only. */
export class VmReconcilePauses {
  private readonly holds = new Map<string, number>();
  private readonly active = new Map<string, number>();
  private readonly drained = new Map<string, Set<() => void>>();
  private readonly resumed = new Set<() => void>();

  isPaused(key: string): boolean { return this.holds.has(key); }
  onResume(wake: () => void): () => void {
    this.resumed.add(wake);
    return () => { this.resumed.delete(wake); };
  }
  started(key: string): void {
    if (this.isPaused(key)) throw new Error('Paused VM work cannot start');
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
  }
  finished(key: string): void {
    const remaining = (this.active.get(key) ?? 1) - 1;
    if (remaining > 0) { this.active.set(key, remaining); return; }
    this.active.delete(key);
    const waiters = this.drained.get(key);
    this.drained.delete(key);
    for (const done of waiters ?? []) done();
  }

  acquire(key: string): { wait(signal: AbortSignal): Promise<void>; release(): void } {
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1);
    let released = false;
    return {
      wait: signal => this.waitForActive(key, signal),
      release: () => {
        if (released) return;
        released = true;
        const remaining = this.holds.get(key)! - 1;
        if (remaining > 0) { this.holds.set(key, remaining); return; }
        this.holds.delete(key);
        for (const wake of this.resumed) wake();
      },
    };
  }

  private async waitForActive(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.active.has(key)) return;
    await new Promise<void>((resolve, reject) => {
      const waiters = this.drained.get(key) ?? new Set<() => void>();
      this.drained.set(key, waiters);
      const clean = () => {
        waiters.delete(done);
        if (!waiters.size) this.drained.delete(key);
        signal.removeEventListener('abort', abort);
      };
      const done = () => { clean(); resolve(); };
      const abort = () => { clean(); reject(signal.reason); };
      waiters.add(done);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}

const owners = new WeakMap<object, VmReconcilePauses>();
/** Shared even when a snapshot starts before the scheduling runtime is created. */
export function vmReconcilePausesFor(owner: object): VmReconcilePauses {
  let pauses = owners.get(owner);
  if (!pauses) { pauses = new VmReconcilePauses(); owners.set(owner, pauses); }
  return pauses;
}
