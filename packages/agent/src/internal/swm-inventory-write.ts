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

/** Local readiness only: accepted policy and catalog service may arrive after startup. */
export class SwmCatalogAuthorityNotReady extends Error {
  readonly code = 'SWM_CATALOG_AUTHORITY_NOT_READY';
  constructor(readonly reason: 'service-unavailable' | 'policy-not-accepted') {
    super('Catalog authority prerequisites are not ready');
  }
}
