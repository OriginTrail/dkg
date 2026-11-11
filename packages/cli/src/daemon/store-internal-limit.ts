import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import { createWarningGate } from './warning-gate.js';

/**
 * A node-side limit: the node's own state, not the caller's request, passed one
 * of the store's internal bounds (for example the bound on one full read of the
 * graph catalog). The caller can only retry later, so it is answered as a
 * retryable 503 and never as a request-size error (413/422).
 *
 * Recognized by its `code`, not by class: it reaches the daemon across package
 * and worker boundaries. The storage package owns the error itself.
 */
export const STORE_INTERNAL_LIMIT_CODE = 'STORE_INTERNAL_LIMIT';

export interface StoreInternalLimitLike {
  readonly code: typeof STORE_INTERNAL_LIMIT_CODE;
  readonly limitName?: unknown;
  readonly limitBytes?: unknown;
  readonly actualBytes?: unknown;
}

export function isStoreInternalLimit(err: unknown): err is StoreInternalLimitLike {
  if ((typeof err !== 'object' && typeof err !== 'function') || err === null) return false;
  try {
    return Reflect.get(err, 'code') === STORE_INTERNAL_LIMIT_CODE;
  } catch {
    return false;
  }
}

const LIMIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

interface StoreInternalLimitFields {
  readonly limitName: string;
  readonly limitBytes?: number;
  readonly actualBytes?: number;
}

/** Each field is read defensively; a limit name that is not a short token is `unknown`. */
function storeInternalLimitFields(err: StoreInternalLimitLike): StoreInternalLimitFields {
  const read = (key: 'limitName' | 'limitBytes' | 'actualBytes'): unknown => {
    try {
      return Reflect.get(err, key);
    } catch {
      return undefined;
    }
  };
  const limitName = read('limitName');
  const limitBytes = read('limitBytes');
  const actualBytes = read('actualBytes');
  return {
    limitName: typeof limitName === 'string' && LIMIT_NAME.test(limitName) ? limitName : 'unknown',
    ...(isByteCount(limitBytes) ? { limitBytes } : {}),
    ...(isByteCount(actualBytes) ? { actualBytes } : {}),
  };
}

function isByteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export interface StoreInternalLimitDiagnosticsOptions {
  readonly logger?: Pick<Logger, 'info' | 'warn'>;
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  readonly now?: () => number;
  /** How often one limit may raise a warning. */
  readonly intervalMs?: number;
}

/**
 * One log line per answered node-side limit, naming the limit. The first answer
 * for a limit in a window is a warning that reports how many repeats it held
 * back since the previous one; repeats in between are info lines.
 */
export function createStoreInternalLimitDiagnostics(
  options: StoreInternalLimitDiagnosticsOptions = {},
): (fields: StoreInternalLimitFields) => void {
  const logger = options.logger ?? new Logger('store-internal-limit');
  const warningDue = createWarningGate(
    options.now ?? (() => performance.now()),
    options.intervalMs ?? 60_000,
    32,
  );
  return (fields) => {
    const detail = `limit=${fields.limitName}`
      + (fields.limitBytes === undefined ? '' : ` limitBytes=${fields.limitBytes}`)
      + (fields.actualBytes === undefined ? '' : ` actualBytes=${fields.actualBytes}`);
    const ctx = createOperationContext('query');
    const decision = warningDue(fields.limitName);
    if (decision.warn) {
      logger.warn(ctx, `Node-side store limit reached, answered 503 ${STORE_INTERNAL_LIMIT_CODE}: ${detail}`
        + (decision.heldBack > 0 ? ` (${decision.heldBack} more since the last warning)` : ''));
    } else {
      logger.info(ctx, `Node-side store limit reached, answered 503 ${STORE_INTERNAL_LIMIT_CODE} (repeat): ${detail}`);
    }
  };
}

const recordStoreInternalLimit = createStoreInternalLimitDiagnostics();

/**
 * The retryable 503 body for a node-side limit, and its log line. Every route
 * that renders a store-unavailable answer reaches this through
 * `classifyStoreUnavailable`, so one answered failure logs one line.
 */
export function storeInternalLimitResponseBody(err: StoreInternalLimitLike): Record<string, unknown> {
  const fields = storeInternalLimitFields(err);
  recordStoreInternalLimit(fields);
  return {
    error: 'The node reached one of its internal store limits; retry later',
    code: STORE_INTERNAL_LIMIT_CODE,
    retryable: true,
    outcome: 'indeterminate',
    ...fields,
    hint: 'A node-side condition, not the size of this request. The node operator can see it in the node log.',
  };
}
