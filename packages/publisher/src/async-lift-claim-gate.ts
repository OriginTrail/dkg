// SPDX-License-Identifier: Apache-2.0
/** Structural capability, shared by source and packaged publisher consumers. */
export interface AsyncLiftClaimControl {
  readonly state: 'running' | 'held' | 'closed';
  hold(): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
}

/** The publisher claim domain owns admission; runner and durable control only observe it. */
export class AsyncLiftClaimGate implements AsyncLiftClaimControl {
  private current: 'running' | 'held' | 'closed' = 'running';
  private revision = 0;

  constructor(private readonly drain: (commit?: () => void) => Promise<void>) {}

  get state(): 'running' | 'held' | 'closed' { return this.current; }

  /** Fence synchronously, acknowledge after claims already inside the domain have drained. */
  hold(): Promise<void> {
    this.revision++;
    if (this.current !== 'closed') this.current = 'held';
    return this.drain();
  }

  /** Terminal fencing precedes all asynchronous work, including queued resume commits. */
  close(): Promise<void> {
    this.revision++;
    this.current = 'closed';
    return this.drain();
  }

  release(): Promise<void> {
    if (this.current === 'closed') return Promise.reject(new Error('Publisher claim gate is closed'));
    const revision = this.revision;
    return this.drain(() => {
      if (this.current === 'closed') throw new Error('Publisher claim gate is closed');
      if (revision !== this.revision) throw new Error('Publisher claim release was superseded');
      this.current = 'running';
    });
  }
}
