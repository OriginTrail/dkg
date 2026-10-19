/** Throwing inventory domain boundary, independent of promotion/queue policy. */
export type SwmInventoryDormantReason = 'inactive-lane' | 'authority-transition' | 'policy-mismatch' | 'vm-confirmed';
export type SwmInventoryWriteOutcome = {
  status: 'applied' | 'existing';
  attempts: number;
  headObjectDigest: string;
  kaUal: string;
  dormantReason?: never;
} | {
  status: 'dormant';
  attempts: 0;
  headObjectDigest: null;
  kaUal: string | null;
  dormantReason: SwmInventoryDormantReason;
};

export class SwmInventoryWriteFailure extends Error {
  constructor(readonly phase: 'authority' | 'preparation-read' | 'inventory-maintenance',
    readonly kaUal: string | null, cause: unknown) {
    super('SWM inventory write did not complete', { cause });
  }
}

/** A share replayed later whose seal or shared copy has moved on: its row can never be written. */
export class SwmInventoryShareSuperseded extends Error {
  readonly code = 'SWM_INVENTORY_SHARE_SUPERSEDED';
  constructor(readonly reason: 'missing-seal' | 'workspace-mismatch') {
    super(`The shared copy no longer matches the share (${reason})`);
  }
}

/** Local readiness only: accepted policy and catalog service may arrive after startup. */
export class SwmCatalogAuthorityNotReady extends Error {
  readonly code = 'SWM_CATALOG_AUTHORITY_NOT_READY';
  constructor(readonly reason: 'service-unavailable' | 'policy-not-accepted' | 'authority-inactive') {
    super('Catalog authority prerequisites are not ready');
  }
}

/** Missing readiness may recover; a deliberate policy exclusion cannot authorize removal. */
export function requireInventoryRemovalLane<T>(lane: T | null, authoringRequired: () => boolean): T {
  if (lane !== null) return lane;
  if (authoringRequired()) throw new SwmCatalogAuthorityNotReady('authority-inactive');
  throw new Error('RFC-64 SWM inventory policy excluded removal');
}
