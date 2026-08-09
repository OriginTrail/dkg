import {
  resolveStoreChainCapabilityV1,
  resolveStoreChainTerminalV1,
} from './store-chain-capability.js';

/**
 * Optional TripleStore operations that a decorator may expose even when its
 * wrapped backend cannot perform them.
 */
export type TripleStoreCapability =
  | 'update'
  | 'replaceGraph'
  | 'replaceGraphAndSubject'
  | 'replaceSubject'
  | 'structuredMutation';

/** Explicit support override for decorators that add or constrain semantics. */
export const TRIPLE_STORE_CAPABILITY_SUPPORT: unique symbol = Symbol(
  'dkg.tripleStoreCapabilitySupport',
);

interface TripleStoreCapabilitySupport {
  [TRIPLE_STORE_CAPABILITY_SUPPORT](capability: TripleStoreCapability): boolean;
}

/** Return whether invoking an optional operation can reach a capable backend. */
export function supportsTripleStoreCapability(
  store: unknown,
  capability: TripleStoreCapability,
): boolean {
  const reporter = resolveStoreChainCapabilityV1(
    store,
    (candidate): candidate is TripleStoreCapabilitySupport => typeof (
      candidate as Partial<TripleStoreCapabilitySupport> | null | undefined
    )?.[TRIPLE_STORE_CAPABILITY_SUPPORT] === 'function',
  );
  if (reporter) {
    return reporter[TRIPLE_STORE_CAPABILITY_SUPPORT](capability);
  }
  const terminal = resolveStoreChainTerminalV1(store);
  return typeof (terminal as Partial<Record<TripleStoreCapability, unknown>> | null | undefined)
    ?.[capability] === 'function';
}

/**
 * Typed signal that an optional store capability is unavailable.
 *
 * Decorators use this instead of a generic Error when their public method is
 * present but the wrapped store lacks the corresponding optional operation.
 * Callers may then choose a compatibility fallback without accidentally
 * treating a genuine execution failure as "unsupported". Implementations
 * must raise it before starting the operation so a caller can safely fall back.
 */
export class UnsupportedTripleStoreCapabilityError extends Error {
  readonly capability: TripleStoreCapability;
  readonly storeName: string;

  constructor(capability: TripleStoreCapability, storeName: string) {
    super(`${storeName}: inner store does not support ${capability}()`);
    this.name = 'UnsupportedTripleStoreCapabilityError';
    this.capability = capability;
    this.storeName = storeName;
  }
}

export function isTripleStoreCapabilityRefusal(
  error: unknown,
  capability: TripleStoreCapability,
): boolean {
  return error instanceof UnsupportedTripleStoreCapabilityError
    && error.capability === capability;
}

/**
 * A capability refusal is a clean preflight outcome — the contract requires it
 * to be raised before the operation starts — so decorators that treat a failed
 * `replaceGraph` as an indeterminate (possibly committed) mutation must exempt
 * it from cache-dirtying and reconcile flagging.
 */
export function isReplaceGraphCapabilityRefusal(error: unknown): boolean {
  return isTripleStoreCapabilityRefusal(error, 'replaceGraph');
}

export function isReplaceGraphAndSubjectCapabilityRefusal(error: unknown): boolean {
  return isTripleStoreCapabilityRefusal(error, 'replaceGraphAndSubject');
}

export function isReplaceSubjectCapabilityRefusal(error: unknown): boolean {
  return isTripleStoreCapabilityRefusal(error, 'replaceSubject');
}
