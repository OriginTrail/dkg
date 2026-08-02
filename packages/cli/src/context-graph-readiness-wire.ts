/** Serializable convergence planes shared by daemon and client contracts. */
export type ContextGraphConvergencePlane = 'metadata' | 'durable' | 'sharedMemory';

/** Pure wire shape for the independently verified state of one context graph. */
export interface ContextGraphConvergenceSnapshot {
  state: 'pending' | 'partial' | 'complete';
  required: {
    metadata: true;
    durable: true;
    sharedMemory: boolean;
  };
  verified: {
    metadata: boolean;
    durable: boolean;
    sharedMemory: boolean;
  };
  missing: ContextGraphConvergencePlane[];
  readinessUpdatedAt?: number;
  observedAt: number;
}
