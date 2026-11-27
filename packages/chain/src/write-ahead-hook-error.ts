// SPDX-License-Identifier: Apache-2.0

/**
 * Typed boundary for a REJECTED pre-send write-ahead hook (`onBroadcast` / `onBeforeBroadcast`).
 *
 * The hook is awaited strictly before a signed transaction is sent and is fail-closed: a throw
 * aborts the broadcast with the transaction still local. The adapter used to re-throw that failure
 * as a bare `new Error(message)`, which discarded the hook's own error — so a caller that needed to
 * know WHY its durable write-ahead failed (for example a typed storage rejection that provably
 * never started) could only read the message text. This keeps the message byte-for-byte and carries
 * the original as `cause`.
 *
 * The guard is structural on the chain-NAMESPACED `code`, like the transport errors, so it survives
 * a bundle boundary. Consumers unwrap `cause` ONLY from this wrapper — never from an arbitrary
 * error's cause chain — so an unrelated error that merely happens to carry a cause cannot be
 * mistaken for a write-ahead failure.
 */
export const CHAIN_WRITE_AHEAD_HOOK_FAILED_CODE = 'CHAIN_WRITE_AHEAD_HOOK_FAILED' as const;

/** What the guard verifies: only the stable `code`. `cause` is the hook's own error, if retained. */
export interface ChainWriteAheadHookErrorLike {
  readonly code: typeof CHAIN_WRITE_AHEAD_HOOK_FAILED_CODE;
  readonly cause?: unknown;
}

export class ChainWriteAheadHookError extends Error implements ChainWriteAheadHookErrorLike {
  readonly code = CHAIN_WRITE_AHEAD_HOOK_FAILED_CODE;

  /** `message` is the adapter's full text (it names the operation); `cause` is the hook's error. */
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ChainWriteAheadHookError';
  }
}

export function isChainWriteAheadHookError(error: unknown): error is ChainWriteAheadHookErrorLike {
  if (typeof error !== 'object' || error === null) return false;
  try {
    return Reflect.get(error, 'code') === CHAIN_WRITE_AHEAD_HOOK_FAILED_CODE;
  } catch {
    // A hostile accessor must never turn a failure-classification read into a throw.
    return false;
  }
}

/** The error the write-ahead hook itself threw, read ONLY from the wrapper. Undefined otherwise. */
export function getChainWriteAheadHookCause(error: unknown): unknown {
  if (!isChainWriteAheadHookError(error)) return undefined;
  try {
    return error.cause;
  } catch {
    return undefined;
  }
}
