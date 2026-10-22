import { createAbortError as asSyncFetchAbortError } from './bounded-operation.js';
import { withRetry } from '@origintrail-official/dkg-core';
import { createRpcTimeoutError, isChainRpcTransportError, type ChainAdapter } from '@origintrail-official/dkg-chain';
import { authenticateChallengePinnedGraphScopedAsset, authenticateVerifiedGraphScopedAsset,
  readGraphScopedAssetChainState, type ChallengePinnedGraphScopedAsset, type GraphScopedAssetChainState,
  type VerifiedGraphScopedAsset, type VerifyContextGraphBinding,
} from './sync/requester/graph-scoped-materialization.js';
import type { ExactAssetCommitment } from './sync/exact-assets.js';

const DURABLE_AUTHENTICATION_MAX_ATTEMPTS = 5;
const DURABLE_AUTHENTICATION_RETRY_BASE_MS = 1_000;
const DURABLE_AUTHENTICATION_RETRY_MAX_MS = 8_000;
const DURABLE_AUTHENTICATION_ATTEMPT_TIMEOUT_MS = 15_000;

function raceAuthenticationWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function runAuthenticationWithinDeadline<T>(params: {
  deadline: number;
  deadlineError: Error;
  signal?: AbortSignal;
  operation(signal: AbortSignal): Promise<T>;
}): Promise<T> {
  const { deadline, deadlineError, signal, operation } = params;
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError;

  const controller = new AbortController();
  const abortFromOperation = () => controller.abort(asSyncFetchAbortError(signal?.reason));
  if (signal?.aborted) abortFromOperation();
  else signal?.addEventListener('abort', abortFromOperation, { once: true });
  const timer = setTimeout(() => controller.abort(deadlineError), remaining);
  try {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? deadlineError;
    }
    return await raceAuthenticationWithSignal(
      operation(controller.signal),
      controller.signal,
    );
  } catch (error) {
    if (controller.signal.aborted) {
      throw controller.signal.reason ?? deadlineError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromOperation);
  }
}

export async function authenticateChallengePinnedGraphScopedAssetWithinDeadline(params: {
  chain: ChainAdapter;
  asset: VerifiedGraphScopedAsset;
  commitment: ExactAssetCommitment;
  verifyContextGraphBinding: VerifyContextGraphBinding;
  authenticationDeadline: number;
  signal?: AbortSignal;
}): Promise<ChallengePinnedGraphScopedAsset> {
  const {
    chain,
    asset,
    commitment,
    verifyContextGraphBinding,
    authenticationDeadline,
    signal,
  } = params;
  const deadlineError = createRpcTimeoutError(
    `Challenge-pinned authentication for ${asset.ual} exceeded its deadline`,
  );
  const authenticated = await runAuthenticationWithinDeadline({
    deadline: authenticationDeadline,
    deadlineError,
    signal,
    operation: (authenticationSignal) => authenticateChallengePinnedGraphScopedAsset(
      chain,
      asset,
      commitment,
      verifyContextGraphBinding,
      { signal: authenticationSignal },
    ),
  });
  if (Date.now() >= authenticationDeadline) throw deadlineError;
  return authenticated;
}

/** A held copy's chain views, under the authentication retry policy and the round's deadline. */
export function readHeldGraphScopedAssetChainStateWithinDeadline(params: {
  chain: ChainAdapter;
  copy: { readonly ual: string; readonly contextGraphId: string };
  verifyContextGraphBinding: VerifyContextGraphBinding;
  deadline: number;
  signal?: AbortSignal;
}): Promise<GraphScopedAssetChainState> {
  const { chain, copy, verifyContextGraphBinding, deadline, signal } = params;
  return runAuthenticationWithinDeadline({
    deadline,
    deadlineError: createRpcTimeoutError(
      `Chain check of held graph-scoped asset ${copy.ual} exceeded its context-graph deadline`,
    ),
    signal,
    operation: (deadlineSignal) => withRetry(
      () => readGraphScopedAssetChainState(chain, copy, verifyContextGraphBinding, { signal: deadlineSignal }),
      {
        maxAttempts: DURABLE_AUTHENTICATION_MAX_ATTEMPTS,
        baseDelayMs: DURABLE_AUTHENTICATION_RETRY_BASE_MS,
        maxDelayMs: DURABLE_AUTHENTICATION_RETRY_MAX_MS,
        isRetryable: isChainRpcTransportError,
        signal: deadlineSignal,
      },
    ),
  });
}

export async function authenticateDurableGraphScopedAsset(params: {
  chain: ChainAdapter;
  asset: VerifiedGraphScopedAsset;
  verifyContextGraphBinding: VerifyContextGraphBinding;
  deadline: number;
  signal?: AbortSignal;
  onRetry: (error: unknown, attempt: number, maxAttempts: number) => void;
}) {
  const { chain, asset, verifyContextGraphBinding, deadline, signal, onRetry } = params;
  const receivedAt = new Date();
  const deadlineError = createRpcTimeoutError(
    `Graph-scoped durable authentication for ${asset.ual} exceeded its context-graph deadline`,
  );
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw deadlineError;

  const deadlineController = new AbortController();
  const abortFromOperation = () => deadlineController.abort(
    asSyncFetchAbortError(signal?.reason),
  );
  if (signal?.aborted) abortFromOperation();
  else signal?.addEventListener('abort', abortFromOperation, { once: true });
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(deadlineError),
    remaining,
  );
  try {
    return await withRetry(
      async () => {
        const attemptRemaining = deadline - Date.now();
        if (attemptRemaining <= 0) throw deadlineError;
        const attemptError = createRpcTimeoutError(
          `Graph-scoped durable authentication attempt for ${asset.ual} timed out`,
        );
        const attemptController = new AbortController();
        const abortFromDeadline = () => attemptController.abort(deadlineController.signal.reason);
        deadlineController.signal.addEventListener('abort', abortFromDeadline, { once: true });
        const attemptTimer = setTimeout(
          () => attemptController.abort(attemptError),
          Math.min(DURABLE_AUTHENTICATION_ATTEMPT_TIMEOUT_MS, attemptRemaining),
        );
        if (deadlineController.signal.aborted) abortFromDeadline();
        try {
          return await raceAuthenticationWithSignal(
            authenticateVerifiedGraphScopedAsset(
              chain,
              asset,
              verifyContextGraphBinding,
              receivedAt,
              { signal: attemptController.signal },
            ),
            attemptController.signal,
          );
        } finally {
          if (!attemptController.signal.aborted) attemptController.abort();
          clearTimeout(attemptTimer);
          deadlineController.signal.removeEventListener('abort', abortFromDeadline);
        }
      },
      {
        maxAttempts: DURABLE_AUTHENTICATION_MAX_ATTEMPTS,
        baseDelayMs: DURABLE_AUTHENTICATION_RETRY_BASE_MS,
        maxDelayMs: DURABLE_AUTHENTICATION_RETRY_MAX_MS,
        isRetryable: isChainRpcTransportError,
        signal: deadlineController.signal,
        onRetry: (attempt, _delayMs, error) => {
          onRetry(error, attempt, DURABLE_AUTHENTICATION_MAX_ATTEMPTS);
        },
      },
    );
  } catch (error) {
    if (deadlineController.signal.aborted) {
      throw deadlineController.signal.reason ?? deadlineError;
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', abortFromOperation);
  }
}
