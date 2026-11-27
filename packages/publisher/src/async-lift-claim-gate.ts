// SPDX-License-Identifier: Apache-2.0
/** Structural capability, shared by source and packaged publisher consumers. */
export interface AsyncLiftClaimControl {
  readonly state: 'running' | 'held' | 'closed';
  hold(): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
}

/** The publisher claim domain owns admission and all release scheduling effects. */
export function createAsyncLiftClaimControl(
  drain: (commit?: () => void) => Promise<void>, notifyWorkAvailable: () => void,
): AsyncLiftClaimControl {
  let current: 'running' | 'held' | 'closed' = 'running';
  let revision = 0;
  return {
    get state() { return current; },
    /** Fence synchronously, acknowledge after claims already inside the domain have drained. */
    hold() {
      revision++;
      if (current !== 'closed') current = 'held';
      return drain();
    },
    /** Terminal fencing precedes all asynchronous work, including queued resume commits. */
    close() {
      revision++;
      current = 'closed';
      return drain();
    },
    async release() {
      if (current === 'closed') throw new Error('Publisher claim gate is closed');
      const releaseRevision = revision;
      await drain(() => {
        if (current === 'closed') throw new Error('Publisher claim gate is closed');
        if (releaseRevision !== revision) throw new Error('Publisher claim release was superseded');
        current = 'running';
      });
      notifyWorkAvailable();
    },
  };
}
