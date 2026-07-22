import type { ChainIdV1 } from '@origintrail-official/dkg-core';

import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import { createNonqueueingAdmissionGateV1 } from './nonqueueing-admission.js';
import {
  cancelled,
  isAnchorDependentResourceLimit,
  isPreDeadlineTerminalFailure,
  isTerminalAttemptFailure,
  markPreDeadlineTerminalFailure,
  timedOut,
  unavailable,
} from './strict-current-finalized-evm-errors.js';
import type {
  CurrentFinalizedEvmBlockReferenceProfileV1,
  DeadlineScopeV1,
  FinalizedAnchorV1,
} from './strict-current-finalized-evm-types.js';

type StrictFinalizedEndpointRunnerModeV1 = 'read' | 'snapshot-preflight';

export interface StrictFinalizedEndpointRunnerProfileV1 {
  readonly mode: StrictFinalizedEndpointRunnerModeV1;
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly maxConcurrentPerChain: number;
  readonly totalDeadlineMs: number;
  readonly attemptTimeoutMs: number;
}

interface StrictFinalizedEndpointRunInputV1<AttemptResult, Result> {
  readonly chainId: ChainIdV1;
  readonly signal: AbortSignal;
  readonly attempt: (
    endpoint: string,
    attempt: number,
    deadline: DeadlineScopeV1,
  ) => Promise<AttemptResult>;
  /** Runs once, outside the retry catch. Snapshot consumers are never replayed. */
  readonly accept: (
    endpoint: string,
    attemptResult: AttemptResult,
    totalDeadline: DeadlineScopeV1,
  ) => Promise<Result>;
}

export interface StrictFinalizedEndpointRunnerV1 {
  <AttemptResult, Result>(
    input: StrictFinalizedEndpointRunInputV1<AttemptResult, Result>,
  ): Promise<Result>;
}

/**
 * Canonical non-queueing endpoint lifecycle shared by one-shot reads and
 * snapshot preflight. Only `attempt` participates in failover; `accept` runs
 * once after the attempt deadline is closed and therefore cannot replay a
 * snapshot consumer.
 */
export function createStrictFinalizedEndpointRunnerV1(
  profile: StrictFinalizedEndpointRunnerProfileV1,
): StrictFinalizedEndpointRunnerV1 {
  const messages = endpointRunnerMessages(profile.mode, profile.chainId);
  const admission = createNonqueueingAdmissionGateV1<ChainIdV1>(
    profile.maxConcurrentPerChain,
  );
  const run: StrictFinalizedEndpointRunnerV1 = async <AttemptResult, Result>(
    input: StrictFinalizedEndpointRunInputV1<AttemptResult, Result>,
  ): Promise<Result> => {
    if (input.chainId !== profile.chainId) {
      throw new CurrentFinalizedEvmCallErrorV1(
        'chain-mismatch',
        messages.chainMismatch(input.chainId),
      );
    }
    if (input.signal.aborted) {
      throw cancelled(messages.cancelledBeforeAdmission);
    }
    return admission.run(input.chainId, async () => {
      const totalDeadline = createDeadlineScopeV1(
        input.signal,
        profile.totalDeadlineMs,
        messages.totalDeadlineLabel,
      );
      let lastRetryableFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
      try {
        for (let index = 0; index < profile.endpoints.length; index += 1) {
          const attemptNumber = index + 1;
          const attemptDeadline = createDeadlineScopeV1(
            totalDeadline.signal,
            profile.attemptTimeoutMs,
            messages.attemptDeadlineLabel(attemptNumber),
          );
          let attemptResult!: AttemptResult;
          let accepted = false;
          try {
            attemptResult = await input.attempt(
              profile.endpoints[index]!,
              attemptNumber,
              attemptDeadline,
            );
            if (
              input.signal.aborted
              || totalDeadline.timedOut()
              || attemptDeadline.timedOut()
            ) {
              throw classifyEndpointAttemptFailureV1(
                new Error('Endpoint attempt completed after its lifecycle ended'),
                input.signal,
                totalDeadline,
                attemptDeadline,
                profile,
              );
            }
            accepted = true;
          } catch (cause) {
            const failure = classifyEndpointAttemptFailureV1(
              cause,
              input.signal,
              totalDeadline,
              attemptDeadline,
              profile,
            );
            if (isTerminalAttemptFailure(failure)) throw failure;
            lastRetryableFailure = failure;
          } finally {
            attemptDeadline.close();
          }
          if (accepted) {
            return input.accept(
              profile.endpoints[index]!,
              attemptResult,
              totalDeadline,
            );
          }
        }
        throw classifyEndpointAttemptFailureV1(
          lastRetryableFailure ?? unavailable(messages.noEndpoint),
          input.signal,
          totalDeadline,
          null,
          profile,
        );
      } finally {
        totalDeadline.close();
      }
    }, (active) => new CurrentFinalizedEvmCallErrorV1(
      'concurrency-saturated',
      messages.saturated(active),
    ));
  };
  return Object.freeze(run);
}

function classifyEndpointAttemptFailureV1(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScopeV1,
  attemptDeadline: DeadlineScopeV1 | null,
  profile: StrictFinalizedEndpointRunnerProfileV1,
): CurrentFinalizedEvmCallErrorV1 {
  const messages = endpointRunnerMessages(profile.mode, profile.chainId);
  if (callerSignal.aborted) return cancelled(messages.cancelled);
  if (
    cause instanceof CurrentFinalizedEvmCallErrorV1
    && isPreDeadlineTerminalFailure(cause)
  ) {
    return cause;
  }
  if (totalDeadline.timedOut()) {
    return timedOut(messages.totalDeadline(profile.totalDeadlineMs));
  }
  if (attemptDeadline?.timedOut()) {
    return timedOut(messages.attemptDeadline(profile.attemptTimeoutMs));
  }
  if (cause instanceof CurrentFinalizedEvmCallErrorV1) return cause;
  return unavailable(messages.attemptFailure, cause);
}

interface StrictFinalizedEndpointRunnerMessagesV1 {
  readonly chainMismatch: (requested: ChainIdV1) => string;
  readonly cancelledBeforeAdmission: string;
  readonly cancelled: string;
  readonly totalDeadlineLabel: string;
  readonly totalDeadline: (timeoutMs: number) => string;
  readonly attemptDeadlineLabel: (attempt: number) => string;
  readonly attemptDeadline: (timeoutMs: number) => string;
  readonly attemptFailure: string;
  readonly noEndpoint: string;
  readonly saturated: (active: number) => string;
}

function endpointRunnerMessages(
  mode: StrictFinalizedEndpointRunnerModeV1,
  chainId: ChainIdV1,
): StrictFinalizedEndpointRunnerMessagesV1 {
  if (mode === 'snapshot-preflight') {
    return Object.freeze({
      chainMismatch: (requested: ChainIdV1) =>
        `Snapshot adapter is configured for chain ${chainId}, not ${requested}`,
      cancelledBeforeAdmission:
        'Current-finalized snapshot was cancelled before transport admission',
      cancelled: 'Current-finalized snapshot was cancelled',
      totalDeadlineLabel: 'current-finalized snapshot total deadline',
      totalDeadline: (timeoutMs: number) =>
        `Current-finalized snapshot deadline exceeded ${timeoutMs}ms`,
      attemptDeadlineLabel: (attempt: number) =>
        `current-finalized snapshot preflight ${attempt}`,
      attemptDeadline: (timeoutMs: number) =>
        `Current-finalized snapshot preflight exceeded ${timeoutMs}ms`,
      attemptFailure: 'Current-finalized snapshot preflight failed closed',
      noEndpoint: 'No configured endpoint completed finalized snapshot preflight',
      saturated: (active: number) =>
        `Chain ${chainId} already has ${active} finalized snapshot in flight`,
    });
  }
  return Object.freeze({
    chainMismatch: (requested: ChainIdV1) =>
      `Adapter is configured for chain ${chainId}, not ${requested}`,
    cancelledBeforeAdmission:
      'Current-finalized EVM call was cancelled before transport admission',
    cancelled: 'Current-finalized EVM call was cancelled',
    totalDeadlineLabel: 'current-finalized total deadline',
    totalDeadline: (timeoutMs: number) =>
      `Current-finalized total deadline exceeded ${timeoutMs}ms`,
    attemptDeadlineLabel: (attempt: number) => `current-finalized endpoint attempt ${attempt}`,
    attemptDeadline: (timeoutMs: number) =>
      `Current-finalized endpoint attempt exceeded ${timeoutMs}ms`,
    attemptFailure: 'Current-finalized endpoint attempt failed closed',
    noEndpoint: 'No configured current-finalized endpoint succeeded',
    saturated: (active: number) =>
      `Chain ${chainId} already has ${active} finalized reads in flight`,
  });
}

/** Inputs for the shared EIP-1898 or authenticated-numbered-anchor policy. */
export interface StrictFinalizedAnchorPolicyOptionsV1<T> {
  readonly blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1;
  readonly anchor: FinalizedAnchorV1;
  readonly executeAtReference: (blockReference: unknown) => Promise<T>;
  readonly readPostAnchor: () => Promise<FinalizedAnchorV1>;
  readonly anchorMismatchMessage: string;
}

/** Canonical EIP-1898 / authenticated-numbered-anchor execution policy. */
export async function executeStrictFinalizedAnchorPolicyV1<T>(
  options: StrictFinalizedAnchorPolicyOptionsV1<T>,
): Promise<T> {
  if (options.blockReferenceProfile === 'eip1898') {
    return options.executeAtReference(Object.freeze({
      blockHash: options.anchor.blockHash,
      requireCanonical: true as const,
    }));
  }

  let provisionalExecution:
    | Readonly<{ readonly ok: true; readonly value: T }>
    | Readonly<{ readonly ok: false; readonly failure: CurrentFinalizedEvmCallErrorV1 }>;
  try {
    provisionalExecution = Object.freeze({
      ok: true,
      value: await options.executeAtReference(options.anchor.blockNumberQuantity),
    });
  } catch (cause) {
    if (
      cause instanceof CurrentFinalizedEvmCallErrorV1
      && (
        cause.code === 'no-code'
        || cause.code === 'revert'
        || cause.code === 'malformed-return'
        || isAnchorDependentResourceLimit(cause)
      )
    ) {
      provisionalExecution = Object.freeze({ ok: false, failure: cause });
    } else {
      throw cause;
    }
  }
  await assertStrictFinalizedAnchorStableV1(
    options.anchor,
    options.readPostAnchor,
    options.anchorMismatchMessage,
  );
  if (!provisionalExecution.ok) throw provisionalExecution.failure;
  return provisionalExecution.value;
}

export async function assertStrictFinalizedAnchorStableV1(
  anchor: FinalizedAnchorV1,
  readPostAnchor: () => Promise<FinalizedAnchorV1>,
  mismatchMessage: string,
): Promise<void> {
  const postAnchor = await readPostAnchor();
  if (
    postAnchor.blockNumber !== anchor.blockNumber
    || postAnchor.blockHash !== anchor.blockHash
  ) {
    throw new CurrentFinalizedEvmCallErrorV1(
      'finalized-state-unavailable',
      mismatchMessage,
    );
  }
}

export async function settleStrictFinalizedParallelBatchV1<T>(
  operations: readonly Promise<T>[],
  attemptDeadline: DeadlineScopeV1,
): Promise<readonly T[]> {
  let firstFailure: unknown;
  let hasFailure = false;
  let firstPreDeadlineTerminalFailure: CurrentFinalizedEvmCallErrorV1 | undefined;
  const tracked = operations.map(async (operation) => {
    try {
      return await operation;
    } catch (cause) {
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = cause;
      }
      if (
        firstPreDeadlineTerminalFailure === undefined
        && cause instanceof CurrentFinalizedEvmCallErrorV1
        && isTerminalAttemptFailure(cause)
        && !attemptDeadline.timedOut()
      ) {
        firstPreDeadlineTerminalFailure = cause;
        markPreDeadlineTerminalFailure(cause);
      }
      throw cause;
    }
  });
  const settled = await Promise.allSettled(tracked);
  if (firstPreDeadlineTerminalFailure !== undefined) {
    throw firstPreDeadlineTerminalFailure;
  }
  if (hasFailure) throw firstFailure;
  const values: T[] = [];
  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index]!;
    if (result.status === 'rejected') {
      throw unavailable('Parallel finalized-read operation failed without a recorded cause');
    }
    values.push(result.value);
  }
  return Object.freeze(values);
}

export function createDeadlineScopeV1(
  parent: AbortSignal,
  timeoutMs: number,
  label: string,
): DeadlineScopeV1 {
  const controller = new AbortController();
  let didTimeOut = false;
  const expiresAt = performance.now() + timeoutMs;
  const parentAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) parentAbort();
  else parent.addEventListener('abort', parentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error(`${label} exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    signal: controller.signal,
    timedOut: () => didTimeOut || performance.now() >= expiresAt,
    close: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', parentAbort);
    },
  });
}
