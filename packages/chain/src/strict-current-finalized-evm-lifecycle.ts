import type { ChainIdV1 } from '@origintrail-official/dkg-core';

import { CurrentFinalizedEvmCallErrorV1 } from './current-finalized-evm-read-profile.js';
import type { EndpointAdmissionPolicyV1 } from './nonqueueing-admission.js';
import {
  cancelled,
  isAnchorDependentResourceLimit,
  isTerminalAttemptFailure,
  timedOut,
  unavailable,
} from './strict-current-finalized-evm-errors.js';
import type {
  CurrentFinalizedEvmBlockReferenceProfileV1,
  DeadlineScopeV1,
  FinalizedAnchorV1,
} from './strict-current-finalized-evm-types.js';

export interface StrictFinalizedEndpointRunnerProfileV1 {
  readonly chainId: ChainIdV1;
  readonly endpoints: readonly string[];
  readonly totalDeadlineMs: number;
  readonly attemptTimeoutMs: number;
  readonly messages: StrictFinalizedEndpointRunnerMessagesV1;
  /**
   * The admission policy to run under. The runner does not know, and must not
   * know, whether this is a per-instance gate or the process-wide per-chain
   * registry — that is the caller's decision, and keeping it here would put a
   * feature-specific owner vocabulary inside a generic endpoint lifecycle.
   *
   * Heavyweight pinned snapshots inject the shared policy, because their
   * invariant is "one per chain across every caller". The one-shot read
   * primitive injects a local gate: its limit is 4, and folding it into the
   * snapshot's single lane would throttle an unrelated path.
   */
  readonly admission: EndpointAdmissionPolicyV1<ChainIdV1>;
}

export interface StrictFinalizedEndpointRunnerMessagesV1 {
  readonly chainMismatch: (requested: ChainIdV1) => string;
  readonly cancelledBeforeAdmission: string;
  readonly cancelled: string;
  readonly totalDeadlineLabel: string;
  readonly totalDeadline: (timeoutMs: number) => string;
  readonly attemptDeadlineLabel: (attempt: number) => string;
  readonly attemptDeadline: (timeoutMs: number) => string;
  readonly attemptFailure: string;
  readonly noEndpoint: string;
  /** `holder` is supplied by policies that track one; a local gate passes none. */
  readonly saturated: (active: number, holder?: string) => string;
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
  const { messages, admission } = profile;
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
    const admitted = async (): Promise<Result> => {
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
            try {
              return await input.accept(
                profile.endpoints[index]!,
                attemptResult,
                totalDeadline,
              );
            } catch (cause) {
              rethrowEndpointAcceptanceFailureV1(
                cause,
                input.signal,
                totalDeadline,
                profile,
              );
            }
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
    };
    return admission.run(
      input.chainId,
      admitted,
      (active, holder) => new CurrentFinalizedEvmCallErrorV1(
        'concurrency-saturated',
        messages.saturated(active, holder),
      ),
    );
  };
  return Object.freeze(run);
}

function rethrowEndpointAcceptanceFailureV1(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScopeV1,
  profile: StrictFinalizedEndpointRunnerProfileV1,
): never {
  if (callerSignal.aborted) throw cancelled(profile.messages.cancelled);
  if (cause instanceof StrictFinalizedPreDeadlineTerminalBatchFailureV1) {
    throw cause.failure;
  }
  if (totalDeadline.timedOut()) {
    throw timedOut(profile.messages.totalDeadline(profile.totalDeadlineMs));
  }
  throw cause;
}

function classifyEndpointAttemptFailureV1(
  cause: unknown,
  callerSignal: AbortSignal,
  totalDeadline: DeadlineScopeV1,
  attemptDeadline: DeadlineScopeV1 | null,
  profile: StrictFinalizedEndpointRunnerProfileV1,
): CurrentFinalizedEvmCallErrorV1 {
  const { messages } = profile;
  if (callerSignal.aborted) return cancelled(messages.cancelled);
  if (cause instanceof StrictFinalizedPreDeadlineTerminalBatchFailureV1) {
    return cause.failure;
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

/**
 * Explicit package-internal batch outcome. A terminal failure observed before
 * the batch deadline must retain priority while slower siblings drain, without
 * mutating or side-registering the public error object.
 */
class StrictFinalizedPreDeadlineTerminalBatchFailureV1 extends Error {
  public constructor(
    public readonly failure: CurrentFinalizedEvmCallErrorV1,
  ) {
    super('A terminal finalized-read batch operation failed before its deadline', {
      cause: failure,
    });
    this.name = 'StrictFinalizedPreDeadlineTerminalBatchFailureV1';
  }
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
    | Readonly<{
      readonly ok: false;
      readonly failure:
        | CurrentFinalizedEvmCallErrorV1
        | StrictFinalizedPreDeadlineTerminalBatchFailureV1;
    }>;
  try {
    provisionalExecution = Object.freeze({
      ok: true,
      value: await options.executeAtReference(options.anchor.blockNumberQuantity),
    });
  } catch (cause) {
    const classifiedCause = cause instanceof StrictFinalizedPreDeadlineTerminalBatchFailureV1
      ? cause.failure
      : cause;
    if (
      classifiedCause instanceof CurrentFinalizedEvmCallErrorV1
      && (
        classifiedCause.code === 'no-code'
        || classifiedCause.code === 'revert'
        || classifiedCause.code === 'malformed-return'
        || isAnchorDependentResourceLimit(classifiedCause)
      )
    ) {
      provisionalExecution = Object.freeze({
        ok: false,
        failure: cause instanceof StrictFinalizedPreDeadlineTerminalBatchFailureV1
          ? cause
          : classifiedCause,
      });
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

/** Package-internal boundary helper for scoped snapshot reads. */
export function unwrapStrictFinalizedParallelBatchFailureV1(
  cause: unknown,
): unknown {
  return cause instanceof StrictFinalizedPreDeadlineTerminalBatchFailureV1
    ? cause.failure
    : cause;
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

/**
 * One resolved anchor's complete block-reference policy. Snapshot transport
 * owns phase orchestration; this capability owns every profile-specific
 * decision for preflight probing, dynamic batch execution, and scope exit.
 */
export interface StrictFinalizedAnchorProfilePolicyV1 {
  readonly anchor: FinalizedAnchorV1;
  readonly blockReferenceForProbe: unknown;
  readonly executeBatchAtAnchor: <T>(options: Readonly<{
    executeAtReference: (blockReference: unknown) => Promise<T>;
    readPostAnchor: () => Promise<FinalizedAnchorV1>;
    anchorMismatchMessage: string;
  }>) => Promise<T>;
  readonly assertScopeStillPinned: (
    readPostAnchor: () => Promise<FinalizedAnchorV1>,
    anchorMismatchMessage: string,
  ) => Promise<void>;
}

export function createStrictFinalizedAnchorProfilePolicyV1(
  blockReferenceProfile: CurrentFinalizedEvmBlockReferenceProfileV1,
  anchor: FinalizedAnchorV1,
): StrictFinalizedAnchorProfilePolicyV1 {
  const usesNumberedHashSandwich =
    blockReferenceProfile === 'trusted-block-number-hash-sandwich';
  const blockReferenceForProbe = blockReferenceProfile === 'eip1898'
    ? Object.freeze({ blockHash: anchor.blockHash, requireCanonical: true as const })
    : anchor.blockNumberQuantity;
  const assertScopeStillPinned = async (
    readPostAnchor: () => Promise<FinalizedAnchorV1>,
    anchorMismatchMessage: string,
  ): Promise<void> => {
    if (!usesNumberedHashSandwich) return;
    await assertStrictFinalizedAnchorStableV1(
      anchor,
      readPostAnchor,
      anchorMismatchMessage,
    );
  };
  return Object.freeze({
    anchor,
    blockReferenceForProbe,
    executeBatchAtAnchor: <T>(options: Readonly<{
      executeAtReference: (blockReference: unknown) => Promise<T>;
      readPostAnchor: () => Promise<FinalizedAnchorV1>;
      anchorMismatchMessage: string;
    }>): Promise<T> => executeStrictFinalizedAnchorPolicyV1({
      blockReferenceProfile,
      anchor,
      ...options,
    }),
    assertScopeStillPinned,
  });
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
      }
      throw cause;
    }
  });
  const settled = await Promise.allSettled(tracked);
  if (firstPreDeadlineTerminalFailure !== undefined) {
    throw new StrictFinalizedPreDeadlineTerminalBatchFailureV1(
      firstPreDeadlineTerminalFailure,
    );
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
