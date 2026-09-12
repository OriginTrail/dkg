import type { OperationContext } from '@origintrail-official/dkg-core';

/** Publisher-owned context shared by an event lane and its domain callbacks. */
export interface ChainEventDispatchContext {
  readonly operation: OperationContext;
  readonly signal: AbortSignal;
}
