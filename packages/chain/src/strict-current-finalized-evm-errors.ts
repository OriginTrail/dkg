import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';

const ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1 = new WeakSet<object>();
const AUTHENTICATED_REVERT_DATA_V1 = new WeakMap<CurrentFinalizedEvmCallErrorV1, string>();

/** Package-internal evidence available only for errors minted by this transport. */
export function readStrictCurrentFinalizedEvmRevertDataV1(error: unknown): string | undefined {
  return error instanceof CurrentFinalizedEvmCallErrorV1
    ? AUTHENTICATED_REVERT_DATA_V1.get(error)
    : undefined;
}

export function unavailable(message: string, cause?: unknown): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1(
    'rpc-unavailable',
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function timedOut(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('rpc-timeout', message);
}

export function resourceLimited(message: string): CurrentFinalizedEvmCallErrorV1 {
  return new CurrentFinalizedEvmCallErrorV1('resource-limit', message);
}

export function anchorDependentResourceLimited(
  message: string,
): CurrentFinalizedEvmCallErrorV1 {
  const error = resourceLimited(message);
  ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1.add(error);
  return error;
}

export function revertedAtFinalizedAnchor(data?: string): CurrentFinalizedEvmCallErrorV1 {
  const error = new CurrentFinalizedEvmCallErrorV1(
    'revert',
    'Contract call reverted at the resolved finalized anchor',
  );
  if (data !== undefined) AUTHENTICATED_REVERT_DATA_V1.set(error, data);
  return error;
}

export function isAnchorDependentResourceLimit(
  error: CurrentFinalizedEvmCallErrorV1,
): boolean {
  return error.code === 'resource-limit'
    && ANCHOR_DEPENDENT_RESOURCE_LIMITS_V1.has(error);
}

export function isTerminalAttemptFailure(error: CurrentFinalizedEvmCallErrorV1): boolean {
  return error.code === 'unsupported-chain'
    || error.code === 'resource-limit'
    || error.code === 'revert'
    || error.code === 'no-code'
    || error.code === 'malformed-return';
}

export function cancelled(message: string): CurrentFinalizedEvmCallErrorV1 {
  // Caller intent is authenticated by the verifier-owned AbortSignal. Keep
  // the adapter error retryable so a foreign gateway cannot forge a cancelled
  // disposition merely by throwing a public error code; the verifier observes
  // its caller signal first and maps this exact path to `cancelled`.
  return new CurrentFinalizedEvmCallErrorV1('rpc-unavailable', message);
}
