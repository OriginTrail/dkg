import { isChainRpcTransportError } from '@origintrail-official/dkg-chain';

const PROMOTE_REPLAY_SAFE_ERROR_CODE = 'PROMOTE_REPLAY_SAFE_FAILURE';
const agentPromotePreCommitBrand: unique symbol = Symbol('agent-promote-precommit-replay-safe');

type AgentPromotePreCommitReplaySafeError = object & {
  readonly [agentPromotePreCommitBrand]: true;
};

export interface AgentPromoteReplaySafeErrorDiagnostic {
  readonly name: 'PromoteReplaySafeError';
  readonly code: 'PROMOTE_REPLAY_SAFE_FAILURE';
}

function certify(error: unknown): unknown {
  try {
    Object.defineProperty(error, agentPromotePreCommitBrand, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    // Non-extensible or hostile values remain uncertified and fail closed.
  }
  return error;
}

/**
 * Execute only the agent-owned reads between finalization and the publisher's
 * first mutation boundary. A typed chain transport failure in this exact
 * window can be replayed; all other failures preserve their original contract.
 */
export async function runAgentPromotePreCommitReads<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw isChainRpcTransportError(error) ? certify(error) : error;
  }
}

export function isAgentPromotePreCommitReplaySafeError(
  error: unknown,
): error is AgentPromotePreCommitReplaySafeError {
  try {
    return error !== null
      && (typeof error === 'object' || typeof error === 'function')
      && (error as AgentPromotePreCommitReplaySafeError)[agentPromotePreCommitBrand] === true;
  } catch {
    return false;
  }
}

export function getAgentPromoteReplaySafeErrorDiagnostic(
  error: unknown,
): AgentPromoteReplaySafeErrorDiagnostic | undefined {
  return isAgentPromotePreCommitReplaySafeError(error)
    ? { name: 'PromoteReplaySafeError', code: PROMOTE_REPLAY_SAFE_ERROR_CODE }
    : undefined;
}
