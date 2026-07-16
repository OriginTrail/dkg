/**
 * Shared error hierarchy for the DKG V9 stack.
 *
 * DKGError is the base class for all domain-specific errors. Subclasses
 * distinguish between user-facing errors (nice message, no stack) and
 * internal errors (full diagnostic info).
 */

/** Base class for all DKG domain errors. */
export class DKGError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DKGError';
  }
}

/**
 * Funded operational-wallet selection — cross-package error contract.
 *
 * Defined in this UI-safe shared package so every consumer references one
 * source: the chain adapter (which throws the error + builds the message), the
 * daemon route/lifecycle handlers, the publisher async-job classifier, and
 * node-ui. dkg-chain re-exports NO_FUNDED_PUBLISHER_WALLET_CODE for chain-side
 * imports.
 */
export const NO_FUNDED_PUBLISHER_WALLET_CODE = 'NO_FUNDED_PUBLISHER_WALLET';

/** The literal prefix every InsufficientPublisherFundsError message starts with.
 *  The chain formatter builds the message from this; consumers that only have a
 *  (possibly re-wrapped, code-stripped) message string match on it via
 *  {@link messageIndicatesNoFundedPublisherWallet}. */
export const NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX =
  'No operational wallet has enough funds';

const NO_FUNDED_PUBLISHER_WALLET_MARKER = new RegExp(
  NO_FUNDED_PUBLISHER_WALLET_MESSAGE_PREFIX,
  'i',
);

/** True iff a message string indicates a no-funded-wallet publish failure — the
 *  fallback used when the structured `.code` was lost to a re-wrap. */
export function messageIndicatesNoFundedPublisherWallet(message: unknown): boolean {
  return typeof message === 'string' && NO_FUNDED_PUBLISHER_WALLET_MARKER.test(message);
}

/**
 * An error caused by invalid user input or a pre-condition that the user
 * can fix. CLI handlers can show these messages directly without a stack trace.
 */
export class DKGUserError extends DKGError {
  constructor(message: string) {
    super(message);
    this.name = 'DKGUserError';
  }
}

/**
 * An internal/unexpected error. These should be logged with full context
 * and typically indicate a bug or infrastructure issue.
 */
export class DKGInternalError extends DKGError {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DKGInternalError';
  }
}

/** HTTP request body exceeded the size limit. */
export class PayloadTooLargeError extends DKGUserError {
  readonly code: string;
  readonly maxBytes?: number;

  constructor(maxBytes?: number, message?: string, code = 'PAYLOAD_TOO_LARGE') {
    super(
      message ??
      (maxBytes != null
        ? `Request body too large (>${maxBytes} bytes)`
        : 'Payload too large'),
    );
    this.name = 'PayloadTooLargeError';
    this.code = code;
    this.maxBytes = maxBytes;
  }
}

/** SWM gossip payload exceeded the network message size limit. */
export class SwmGossipPayloadTooLargeError extends PayloadTooLargeError {
  readonly actualBytes: number;
  readonly hint: string;
  readonly operation: 'share' | 'promote';

  constructor(args: {
    actualBytes: number;
    maxBytes: number;
    operation: 'share' | 'promote';
    message: string;
    hint: string;
  }) {
    super(args.maxBytes, args.message, 'SWM_GOSSIP_PAYLOAD_TOO_LARGE');
    this.name = 'SwmGossipPayloadTooLargeError';
    this.actualBytes = args.actualBytes;
    this.operation = args.operation;
    this.hint = args.hint;
  }
}

/**
 * Safely extract a human-readable error message from an unknown thrown value.
 * Prefer this over `catch (err: any) { err.message }` to maintain type safety.
 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return String(err);
}

/**
 * Check whether an unknown value is an Error with a specific `code` property
 * (common in Node.js system errors like ENOENT, ECONNREFUSED, etc.).
 */
export function hasErrorCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
