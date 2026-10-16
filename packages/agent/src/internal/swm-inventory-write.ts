/** Throwing inventory domain boundary, independent of promotion/queue policy. */
export interface SwmInventoryWriteOutcome {
  status: 'applied' | 'existing' | 'dormant';
  attempts: number;
  headObjectDigest: string | null;
  kaUal: string | null;
  dormantReason?: 'inactive-lane' | 'authority-transition' | 'policy-mismatch' | 'vm-confirmed';
}

export class SwmInventoryWriteFailure extends Error {
  constructor(readonly phase: 'authority' | 'preparation-read' | 'inventory-commit',
    readonly kaUal: string | null, cause: unknown) {
    super('SWM inventory write did not complete', { cause });
  }
}
